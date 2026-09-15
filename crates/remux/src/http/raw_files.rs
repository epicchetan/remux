//! Authenticated path-addressed file bytes. Reads follow symlinks; uploads
//! atomically replace the named entry. Conditional versions are advisory and
//! do not lock out external writers. Route errors carry the same sandbox and
//! nosniff headers as successful responses, including upstream auth errors.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::Response;
use axum::routing::{get, MethodRouter};
use futures_util::StreamExt;
use hyper::body::{Body as HttpBody, Bytes, Frame, SizeHint};
use pin_project_lite::pin_project;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::{Instant, Sleep};

use super::HttpState;
use crate::fs::core::{atomic_rename, current_version, mime_type, stat_path, FsCore};
use crate::fs::file_window::file_version;

const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Copy)]
pub struct RawFileResponse;

pub struct RawFileService {
    pub max_upload_bytes: u64,
    core: Arc<FsCore>,
    downloads: Arc<Semaphore>,
    uploads: Arc<Semaphore>,
}

impl RawFileService {
    pub fn new(core: Arc<FsCore>, max_upload_bytes: u64) -> Arc<Self> {
        Arc::new(Self {
            max_upload_bytes,
            core,
            downloads: Arc::new(Semaphore::new(16)),
            uploads: Arc::new(Semaphore::new(4)),
        })
    }
}

pub fn routes(max_upload_bytes: u64) -> MethodRouter<Arc<HttpState>> {
    get(handle)
        .head(handle)
        .put(handle)
        .fallback(|| async { error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed") })
        .layer(DefaultBodyLimit::max(
            usize::try_from(max_upload_bytes).unwrap_or(usize::MAX),
        ))
        .layer(axum::middleware::map_response(secure_response))
}

/// Layer outside auth in the runtime so even rejected raw requests are marked.
pub async fn secure_raw_responses(request: Request, next: axum::middleware::Next) -> Response {
    let raw = request.uri().path() == "/remux/fs/raw";
    let response = next.run(request).await;
    if raw {
        secure_response(response).await
    } else {
        response
    }
}

async fn secure_response(mut response: Response) -> Response {
    response.extensions_mut().insert(RawFileResponse);
    // WebKit draws PDFs with a plugin, and a sandboxed document may not
    // instantiate plugins, so a sandboxed PDF renders blank in the Viewer's
    // iframe. PDFKit runs no document script, so the PDF keeps only nosniff.
    let pdf = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/pdf"));
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    if !pdf {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            header::HeaderValue::from_static("sandbox"),
        );
    }
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, no-cache"),
    );
    response
}

async fn handle(State(state): State<Arc<HttpState>>, request: Request) -> Response {
    let query: std::collections::HashMap<_, _> =
        url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    let Some(path) = query
        .get("path")
        .filter(|p| !p.is_empty() && Path::new(p).is_absolute() && !p.contains('\0'))
    else {
        return error(StatusCode::BAD_REQUEST, "Expected an absolute path");
    };
    let path = crate::paths::resolve(Path::new(path));
    if request.method() == Method::PUT {
        upload(
            &state.raw_files,
            path,
            query.get("overwrite").is_some_and(|v| v == "1"),
            request,
        )
        .await
    } else {
        download(
            &state.raw_files,
            &path,
            query.get("download").is_some_and(|v| v == "1"),
            request,
        )
        .await
    }
}

fn error(status: StatusCode, message: &str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::json!({"error": message}).to_string(),
        ))
        .unwrap()
}

fn io_error(e: std::io::Error) -> Response {
    let status = match e.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        std::io::ErrorKind::AlreadyExists => StatusCode::CONFLICT,
        std::io::ErrorKind::InvalidInput
        | std::io::ErrorKind::IsADirectory
        | std::io::ErrorKind::NotADirectory => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    error(status, &e.to_string())
}

async fn download(
    service: &RawFileService,
    path: &Path,
    force_download: bool,
    request: Request,
) -> Response {
    let Ok(permit) = service.downloads.clone().try_acquire_owned() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "Too many file streams");
    };
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true).custom_flags(nix::libc::O_NONBLOCK);
    let mut file = match options.open(path).await {
        Ok(f) => f,
        Err(e) => return io_error(e),
    };
    let metadata = match file.metadata().await {
        Ok(m) => m,
        Err(e) => return io_error(e),
    };
    if !metadata.is_file() {
        return error(StatusCode::BAD_REQUEST, "Expected a regular file");
    }
    let mut prefix = Vec::with_capacity(8192);
    if let Err(e) = (&mut file).take(8192).read_to_end(&mut prefix).await {
        return io_error(e);
    }
    let mime = mime_type(path, &prefix).unwrap_or("application/octet-stream");
    let etag = format!("\"{}\"", file_version(&metadata));
    let size = metadata.len();
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ETAG, &etag)
        .header(
            header::CONTENT_DISPOSITION,
            disposition(path, mime, force_download),
        );
    if let Ok(modified) = metadata.modified() {
        response = response.header(header::LAST_MODIFIED, httpdate::fmt_http_date(modified));
    }
    if etag_matches(request.headers(), &etag) {
        // A 304 has no body; Content-Length describes the selected representation.
        return response
            .status(StatusCode::NOT_MODIFIED)
            .header(header::CONTENT_LENGTH, size)
            .body(Body::empty())
            .unwrap();
    }
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|h| h.to_str().ok());
    let (start, length, partial) = match range {
        Some(range) => match parse_range(range, size) {
            Some((start, end)) => (start, end - start + 1, true),
            None => {
                return response
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                    .header(header::CONTENT_LENGTH, 0)
                    .body(Body::empty())
                    .unwrap()
            }
        },
        None => (0, size, false),
    };
    if partial {
        response = response.status(StatusCode::PARTIAL_CONTENT).header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{size}", start + length - 1),
        );
    }
    response = response.header(header::CONTENT_LENGTH, length);
    if request.method() == Method::HEAD {
        return response.body(Body::empty()).unwrap();
    }
    if let Err(e) = file.seek(std::io::SeekFrom::Start(start)).await {
        return io_error(e);
    }
    let stream = tokio_util::io::ReaderStream::new(file.take(length));
    response
        .body(Body::new(IdleBody::new(Body::from_stream(stream), permit)))
        .unwrap()
}

fn etag_matches(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|h| h.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .any(|candidate| {
            candidate == "*" || candidate.strip_prefix("W/").unwrap_or(candidate) == etag
        })
}

/// Exactly one byte range; multipart ranges and malformed ranges receive 416.
fn parse_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let value = value.strip_prefix("bytes=")?;
    let (start, end) = value.split_once('-')?;
    if size == 0 {
        return None;
    }
    let number = |s: &str| -> Option<u64> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            None
        } else {
            s.parse().ok()
        }
    };
    if start.is_empty() {
        let suffix = number(end)?;
        if suffix == 0 {
            return None;
        }
        Some((size.saturating_sub(suffix), size - 1))
    } else {
        let start = number(start)?;
        let end = if end.is_empty() {
            size - 1
        } else {
            number(end)?.min(size - 1)
        };
        (start < size && start <= end).then_some((start, end))
    }
}

fn disposition(path: &Path, mime: &str, force: bool) -> String {
    let inline = !force
        && mime != "image/svg+xml"
        && (["image/", "audio/", "video/", "font/"]
            .iter()
            .any(|prefix| mime.starts_with(prefix))
            || mime == "application/pdf");
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    // Conservative RFC 5987 attr-char subset; encode UTF-8 bytes, never '+' spaces.
    let mut encoded = String::new();
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            use std::fmt::Write;
            write!(encoded, "%{byte:02X}").unwrap();
        }
    }
    format!(
        "{}; filename*=UTF-8''{encoded}",
        if inline { "inline" } else { "attachment" }
    )
}

fn check_upload_target(
    path: &Path,
    overwrite: bool,
    expected: Option<&str>,
) -> Result<bool, Box<Response>> {
    let current = current_version(path).map_err(|e| Box::new(io_error(e)))?;
    let exists = current.is_some();
    if !overwrite {
        match (current, expected) {
            (Some(current), Some(expected)) if expected == format!("\"{current}\"") => {}
            (None, None) => {}
            _ => {
                return Err(Box::new(error(
                    StatusCode::CONFLICT,
                    "Target exists or version changed",
                )))
            }
        }
    }
    Ok(exists)
}

async fn upload(
    service: &RawFileService,
    path: PathBuf,
    overwrite: bool,
    request: Request,
) -> Response {
    let length = match request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        Some(length) => length,
        None => return error(StatusCode::LENGTH_REQUIRED, "Content-Length is required"),
    };
    if length > service.max_upload_bytes {
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Upload exceeds max_upload_bytes",
        );
    }
    let Ok(permit) = service.uploads.clone().try_acquire_owned() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "Too many uploads");
    };
    let expected = request
        .headers()
        .get(header::IF_MATCH)
        .map(|v| v.to_str().unwrap_or("").to_owned());
    let prepare_path = path.clone();
    let prepare_expected = expected.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        let parent = prepare_path.parent().unwrap_or(Path::new("/"));
        let metadata = std::fs::metadata(parent).map_err(|e| Box::new(io_error(e)))?;
        if !metadata.is_dir() {
            return Err(Box::new(error(
                StatusCode::BAD_REQUEST,
                "Parent is not a directory",
            )));
        }
        check_upload_target(&prepare_path, overwrite, prepare_expected.as_deref())?;
        tempfile::Builder::new()
            .prefix(".remux-upload-")
            .tempfile_in(parent)
            .map_err(|e| Box::new(io_error(e)))
    })
    .await;
    let temp = match prepared {
        Ok(Ok(temp)) => temp,
        Ok(Err(response)) => return *response,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    let clone = match temp.as_file().try_clone() {
        Ok(f) => f,
        Err(e) => return io_error(e),
    };
    let mut file = tokio::fs::File::from_std(clone);
    let mut body = request.into_body().into_data_stream();
    let mut received = 0u64;
    loop {
        match tokio::time::timeout(BODY_IDLE_TIMEOUT, body.next()).await {
            Ok(Some(Ok(bytes))) => {
                received = received.saturating_add(bytes.len() as u64);
                if received > length {
                    return error(StatusCode::PAYLOAD_TOO_LARGE, "Body exceeds Content-Length");
                }
                if let Err(e) = file.write_all(&bytes).await {
                    return io_error(e);
                }
            }
            Ok(Some(Err(_))) => return error(StatusCode::BAD_REQUEST, "Upload interrupted"),
            Ok(None) => break,
            Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "Upload body idle timeout"),
        }
    }
    if received != length {
        return error(
            StatusCode::BAD_REQUEST,
            "Body does not match Content-Length",
        );
    }
    if let Err(e) = file.flush().await {
        return io_error(e);
    }
    drop(file);
    let core = service.core.clone();
    // The blocking commit owns the tempfile, so cancellation cannot detach an
    // in-flight filesystem operation from the cleanup guard or relay hook.
    match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let _guard = core.mutation_lock.lock().unwrap();
        let existed = check_upload_target(&path, overwrite, expected.as_deref())?;
        temp.as_file()
            .sync_all()
            .map_err(|e| Box::new(io_error(e)))?;
        atomic_rename(temp.path(), &path, overwrite || expected.is_some())
            .map_err(|e| Box::new(io_error(e)))?;
        core.on_paths_mutated(std::slice::from_ref(&path));
        let descriptor = stat_path(&path).map_err(|e| Box::new(io_error(e)))?;
        let mut response = super::json_response(descriptor);
        *response.status_mut() = if existed {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        };
        Ok::<_, Box<Response>>(response)
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(response)) => *response,
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

pin_project! {
    struct IdleBody {
        #[pin]
        inner: Body,
        #[pin]
        idle: Sleep,
        permit: Option<OwnedSemaphorePermit>,
    }
}

impl IdleBody {
    fn new(inner: Body, permit: OwnedSemaphorePermit) -> Self {
        Self {
            inner,
            idle: tokio::time::sleep(BODY_IDLE_TIMEOUT),
            permit: Some(permit),
        }
    }
}

impl HttpBody for IdleBody {
    type Data = Bytes;
    type Error = std::io::Error;
    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let mut this = self.project();
        match this.inner.as_mut().poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                this.idle.as_mut().reset(Instant::now() + BODY_IDLE_TIMEOUT);
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(e))) => {
                this.permit.take();
                Poll::Ready(Some(Err(std::io::Error::other(e))))
            }
            Poll::Ready(None) => {
                this.permit.take();
                Poll::Ready(None)
            }
            Poll::Pending => {
                if this.idle.as_mut().poll(cx).is_ready() {
                    this.permit.take();
                    Poll::Ready(Some(Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "File body idle timeout",
                    ))))
                } else {
                    Poll::Pending
                }
            }
        }
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges() {
        for (input, expected) in [
            ("bytes=0-2", Some((0, 2))),
            ("bytes=2-", Some((2, 9))),
            ("bytes=-3", Some((7, 9))),
            ("bytes=-99", Some((0, 9))),
            ("bytes=8-99", Some((8, 9))),
            ("bytes=10-", None),
            ("bytes=-0", None),
            ("bytes=3-2", None),
            ("bytes=0-1,3-4", None),
            ("bytes=+1-3", None),
        ] {
            assert_eq!(parse_range(input, 10), expected, "{input}");
        }
        assert_eq!(parse_range("bytes=0-", 0), None);
    }
    #[test]
    fn dispositions_and_weak_etags() {
        let path = Path::new("/tmp/a é.html");
        for mime in [
            "text/html",
            "image/svg+xml",
            "application/xml",
            "text/plain",
            "application/octet-stream",
        ] {
            assert_eq!(
                disposition(path, mime, false),
                "attachment; filename*=UTF-8''a%20%C3%A9.html"
            );
        }
        for mime in [
            "image/png",
            "audio/mpeg",
            "video/mp4",
            "font/woff2",
            "application/pdf",
        ] {
            assert!(disposition(path, mime, false).starts_with("inline;"));
            assert!(disposition(path, mime, true).starts_with("attachment;"));
        }
        let mut headers = HeaderMap::new();
        headers.insert(
            header::IF_NONE_MATCH,
            "\"other\", W/\"version\"".parse().unwrap(),
        );
        assert!(etag_matches(&headers, "\"version\""));
        assert!(!etag_matches(&headers, "\"new\""));
    }
}

#[cfg(test)]
mod streaming_tests {
    use super::*;
    use std::sync::Mutex;

    #[tokio::test]
    async fn upload_notifies_relay_only_after_success() {
        let root = tempfile::tempdir().unwrap();
        let core = FsCore::new(root.path());
        let relay = crate::fs::relay::FsRelay::new(
            Default::default(),
            crate::fs::relay::FsRelay::production_hooks(Arc::new(|_| {})),
        );
        core.set_relay(&relay);
        let events = Arc::new(Mutex::new(Vec::new()));
        let notifications = events.clone();
        let invalidated_core = core.clone();
        relay.start(
            Arc::new(move |v| notifications.lock().unwrap().push(v)),
            Arc::new(move |p, r| invalidated_core.invalidate(p, r)),
        );
        let service = RawFileService::new(core, 100);
        let path = root.path().join("file");
        let request = Request::builder()
            .header(header::CONTENT_LENGTH, 3)
            .body(Body::from("abc"))
            .unwrap();
        assert_eq!(
            upload(&service, path.clone(), false, request)
                .await
                .status(),
            StatusCode::CREATED
        );
        assert_eq!(events.lock().unwrap().len(), 1);
        assert_eq!(
            events.lock().unwrap()[0]["params"]["changedPaths"],
            serde_json::json!([root.path()])
        );
        let request = Request::builder()
            .header(header::CONTENT_LENGTH, 3)
            .body(Body::from("abc"))
            .unwrap();
        assert_eq!(
            upload(&service, path, false, request).await.status(),
            StatusCode::CONFLICT
        );
        assert_eq!(events.lock().unwrap().len(), 1);
        relay.close();
    }

    #[tokio::test]
    async fn body_error_short_body_and_overrun_clean_temps() {
        let root = tempfile::tempdir().unwrap();
        let service = RawFileService::new(FsCore::new(root.path()), 100);
        for body in [
            Body::from("short"),
            Body::from("longer than ten"),
            Body::from_stream(futures_util::stream::iter(vec![
                Ok(Bytes::from_static(b"partial")),
                Err(std::io::Error::other("aborted")),
            ])),
        ] {
            let path = root.path().join("file");
            let request = Request::builder()
                .header(header::CONTENT_LENGTH, 10)
                .body(body)
                .unwrap();
            assert!(upload(&service, path.clone(), false, request)
                .await
                .status()
                .is_client_error());
            assert!(!path.exists());
            assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
            assert_eq!(service.uploads.available_permits(), 4);
        }
    }

    #[tokio::test]
    async fn cancelled_upload_cleans_temp_and_releases_slot() {
        let root = tempfile::tempdir().unwrap();
        let service = RawFileService::new(FsCore::new(root.path()), 100);
        let task_service = service.clone();
        let path = root.path().join("file");
        let task = tokio::spawn(async move {
            let stream = futures_util::stream::once(async {
                Ok::<_, std::io::Error>(Bytes::from_static(b"partial"))
            })
            .chain(futures_util::stream::pending());
            let request = Request::builder()
                .header(header::CONTENT_LENGTH, 10)
                .body(Body::from_stream(stream))
                .unwrap();
            upload(&task_service, path, false, request).await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if std::fs::read_dir(root.path())
                    .unwrap()
                    .any(|entry| entry.unwrap().metadata().unwrap().len() > 0)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        assert_eq!(service.uploads.available_permits(), 4);
    }

    #[tokio::test]
    async fn concurrency_limits_hold_permits_for_body_lifetime() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("file.txt");
        std::fs::write(&path, "data").unwrap();
        let service = RawFileService::new(FsCore::new(root.path()), 100);
        let mut responses = Vec::new();
        for _ in 0..16 {
            let response = download(&service, &path, false, Request::new(Body::empty())).await;
            assert_eq!(response.status(), StatusCode::OK);
            responses.push(response);
        }
        assert_eq!(service.downloads.available_permits(), 0);
        assert_eq!(
            download(&service, &path, false, Request::new(Body::empty()))
                .await
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        drop(responses);
        assert_eq!(service.downloads.available_permits(), 16);
        let permits: Vec<_> = (0..4)
            .map(|_| service.uploads.clone().try_acquire_owned().unwrap())
            .collect();
        let request = Request::builder()
            .header(header::CONTENT_LENGTH, 0)
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            upload(&service, root.path().join("new"), false, request)
                .await
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        drop(permits);
    }

    #[tokio::test]
    async fn idle_body_times_out_and_releases_permit() {
        let semaphore = Arc::new(Semaphore::new(1));
        let body =
            Body::from_stream(futures_util::stream::pending::<Result<Bytes, std::io::Error>>());
        let idle = IdleBody {
            inner: body,
            idle: tokio::time::sleep(Duration::ZERO),
            permit: Some(semaphore.clone().acquire_owned().await.unwrap()),
        };
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            axum::body::to_bytes(Body::new(idle), 100),
        )
        .await
        .unwrap();
        assert!(result.is_err());
        assert_eq!(semaphore.available_permits(), 1);
    }
}

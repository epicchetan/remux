//! Generic manifest-v3 extension data plane.
//!
//! Remux authenticates the public route, removes browser credentials, and
//! streams opaque HTTP/WebSocket traffic to the current generation's private
//! Unix socket. Application protocol and upstream authentication stay in the
//! extension bridge.

use std::collections::HashMap;
use std::future::Future;
use std::io::Read;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::Body;
use axum::http::{
    header, HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode, Uri, Version,
};
use axum::BoxError;
use hyper::body::{Body as HttpBody, Bytes, Frame, Incoming, SizeHint};
use hyper::client::conn::http1;
use hyper_util::rt::TokioIo;
use pin_project_lite::pin_project;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::{Instant, Sleep};
use tokio_util::sync::CancellationToken;

use crate::extensions::manifest::{ExtensionManifest, GatewaySpec};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const RESPONSE_HEADER_TIMEOUT: Duration = Duration::from_secs(30);
const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_HTTP_REQUESTS: usize = 128;
const MAX_WEBSOCKETS: usize = 32;
const INTERNAL_GENERATION_HEADER: &str = "x-remux-extension-generation";
static RUNTIME_NONCE: AtomicU64 = AtomicU64::new(1);

/// Response extension consumed by Remux's compression predicate. Gateway
/// payloads already have application-defined representation/range semantics.
#[derive(Debug, Clone, Copy)]
pub struct GatewayResponse;

#[derive(Clone)]
pub struct ExtensionGatewayRegistry {
    runtime_dir: Arc<PathBuf>,
    entries: Arc<HashMap<String, Arc<GatewayEntry>>>,
}

struct GatewayEntry {
    mount: String,
    spec: GatewaySpec,
    slot: Mutex<GatewaySlot>,
}

#[derive(Default)]
struct GatewaySlot {
    prepared: Option<Arc<GatewayGeneration>>,
    active: Option<Arc<GatewayGeneration>>,
}

struct GatewayGeneration {
    generation: u64,
    socket_path: PathBuf,
    http_permits: Arc<Semaphore>,
    websocket_permits: Arc<Semaphore>,
    cancelled: CancellationToken,
}

impl ExtensionGatewayRegistry {
    pub fn new(root_dir: &Path, extensions: &[ExtensionManifest]) -> Result<Self, String> {
        let runtime_parent = root_dir.join(".remux/run/extension-gateways");
        std::fs::create_dir_all(&runtime_parent).map_err(|error| {
            format!(
                "failed to create extension gateway runtime directory {}: {error}",
                runtime_parent.display()
            )
        })?;
        std::fs::set_permissions(&runtime_parent, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| {
                format!(
                    "failed to permission extension gateway runtime directory {}: {error}",
                    runtime_parent.display()
                )
            },
        )?;
        let runtime_dir = (0..100)
            .find_map(|_| {
                let candidate = runtime_parent.join(runtime_directory_token());
                match std::fs::create_dir(&candidate) {
                    Ok(()) => Some(Ok(candidate)),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                    Err(error) => Some(Err(error)),
                }
            })
            .transpose()
            .map_err(|error| {
                format!(
                    "failed to create a unique extension gateway runtime directory under {}: {error}",
                    runtime_parent.display()
                )
            })?
            .ok_or_else(|| {
                format!(
                    "failed to allocate a unique extension gateway runtime directory under {}",
                    runtime_parent.display()
                )
            })?;
        std::fs::set_permissions(&runtime_dir, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| {
                format!(
                    "failed to permission extension gateway runtime directory {}: {error}",
                    runtime_dir.display()
                )
            },
        )?;

        let entries = extensions
            .iter()
            .filter_map(|extension| {
                extension.gateway.clone().map(|spec| {
                    (
                        extension.id.clone(),
                        Arc::new(GatewayEntry {
                            mount: format!("/remux/extensions/{}/gateway", extension.id),
                            spec,
                            slot: Mutex::new(GatewaySlot::default()),
                        }),
                    )
                })
            })
            .collect();
        Ok(Self {
            runtime_dir: Arc::new(runtime_dir),
            entries: Arc::new(entries),
        })
    }

    /// Provisions a never-reused socket path before the extension process is
    /// spawned. The bridge owns bind/listen and must chmod the socket 0600.
    pub fn prepare_generation(
        &self,
        extension_id: &str,
        generation: u64,
    ) -> Result<Option<PathBuf>, String> {
        let Some(entry) = self.entries.get(extension_id) else {
            return Ok(None);
        };
        let socket_path = self
            .runtime_dir
            .join(format!("{extension_id}-{generation}.sock"));
        if socket_path.as_os_str().as_encoded_bytes().len() >= 104 {
            return Err(format!(
                "extension gateway socket path is too long: {}",
                socket_path.display()
            ));
        }
        if socket_path.exists() {
            return Err(format!(
                "extension gateway socket path already exists: {}",
                socket_path.display()
            ));
        }

        let prepared = Arc::new(GatewayGeneration {
            generation,
            socket_path: socket_path.clone(),
            http_permits: Arc::new(Semaphore::new(MAX_HTTP_REQUESTS)),
            websocket_permits: Arc::new(Semaphore::new(MAX_WEBSOCKETS)),
            cancelled: CancellationToken::new(),
        });
        let mut slot = entry.slot.lock().unwrap();
        if let Some(previous) = retire_slot_generation(&mut slot.prepared) {
            let _ = std::fs::remove_file(previous);
        }
        slot.prepared = Some(prepared);
        Ok(Some(socket_path))
    }

    /// Makes a prepared generation routable only after the stdio bridge has
    /// reported readiness and its private listener can be verified.
    pub fn activate_generation(&self, extension_id: &str, generation: u64) -> Result<(), String> {
        let entry = self
            .entries
            .get(extension_id)
            .ok_or_else(|| format!("extension {extension_id} does not declare a gateway"))?;
        let mut slot = entry.slot.lock().unwrap();
        let Some(prepared) = slot.prepared.as_ref() else {
            return Err(format!(
                "extension {extension_id} has no prepared gateway generation"
            ));
        };
        if prepared.generation != generation {
            return Err(format!(
                "stale gateway readiness for extension {extension_id} generation {generation}"
            ));
        }
        validate_private_socket(&prepared.socket_path)?;
        let prepared = slot.prepared.take().expect("checked");
        let _ = retire_slot_generation(&mut slot.active);
        slot.active = Some(prepared);
        Ok(())
    }

    pub fn retire_generation(&self, extension_id: &str, generation: u64) {
        let Some(entry) = self.entries.get(extension_id) else {
            return;
        };
        let mut slot = entry.slot.lock().unwrap();
        if slot
            .prepared
            .as_ref()
            .is_some_and(|candidate| candidate.generation == generation)
        {
            let _ = retire_slot_generation(&mut slot.prepared);
        }
        if slot
            .active
            .as_ref()
            .is_some_and(|candidate| candidate.generation == generation)
        {
            let _ = retire_slot_generation(&mut slot.active);
        }
    }

    /// Removes the generation's socket path after its child process has been
    /// reaped. Retirement and unlinking are deliberately separate so the
    /// supervisor's shutdown ordering remains observable and testable.
    pub fn cleanup_generation(&self, extension_id: &str, generation: u64) {
        if !self.entries.contains_key(extension_id) {
            return;
        }
        let path = self
            .runtime_dir
            .join(format!("{extension_id}-{generation}.sock"));
        let _ = std::fs::remove_file(path);
    }

    pub fn active_generation(&self, extension_id: &str) -> Option<u64> {
        self.entries
            .get(extension_id)
            .and_then(|entry| entry.slot.lock().unwrap().active.clone())
            .map(|generation| generation.generation)
    }

    fn route(&self, pathname: &str) -> Option<(Arc<GatewayEntry>, String)> {
        self.entries.values().find_map(|entry| {
            let suffix = pathname.strip_prefix(&entry.mount)?;
            if !suffix.is_empty() && !suffix.starts_with('/') {
                return None;
            }
            Some((entry.clone(), suffix.to_string()))
        })
    }
}

fn runtime_directory_token() -> String {
    let mut random = [0u8; 16];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut random))
        .is_ok()
    {
        return random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<Vec<_>>()
            .concat();
    }
    let nonce = RUNTIME_NONCE.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{nonce}", std::process::id(), crate::time::now_ms())
}

impl Drop for ExtensionGatewayRegistry {
    fn drop(&mut self) {
        if Arc::strong_count(&self.runtime_dir) == 1 {
            let _ = std::fs::remove_dir_all(self.runtime_dir.as_ref());
        }
    }
}

fn validate_private_socket(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        format!(
            "gateway listener {} is unavailable: {error}",
            path.display()
        )
    })?;
    if !metadata.file_type().is_socket() {
        return Err(format!(
            "gateway listener {} is not a Unix socket",
            path.display()
        ));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(format!(
            "gateway listener {} must not be accessible by group or other users",
            path.display()
        ));
    }
    let parent_owner = path
        .parent()
        .and_then(|parent| std::fs::symlink_metadata(parent).ok())
        .map(|metadata| metadata.uid());
    if parent_owner != Some(metadata.uid()) {
        return Err(format!(
            "gateway listener {} is not owned by the runtime user",
            path.display()
        ));
    }
    Ok(())
}

fn retire_slot_generation(slot: &mut Option<Arc<GatewayGeneration>>) -> Option<PathBuf> {
    if let Some(generation) = slot.take() {
        generation.cancelled.cancel();
        return Some(generation.socket_path.clone());
    }
    None
}

pub async fn handle_request(
    registry: &ExtensionGatewayRegistry,
    mut request: Request<Body>,
) -> Response<Body> {
    let Some((entry, suffix)) = registry.route(request.uri().path()) else {
        return gateway_error(
            StatusCode::NOT_FOUND,
            "extension_gateway_not_declared",
            false,
        );
    };
    if matches!(*request.method(), Method::CONNECT | Method::TRACE) {
        return gateway_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "extension_gateway_method_not_allowed",
            false,
        );
    }
    let generation = {
        let slot = entry.slot.lock().unwrap();
        slot.active.clone()
    };
    let Some(generation) = generation else {
        return gateway_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "extension_gateway_not_ready",
            true,
        );
    };
    if generation.cancelled.is_cancelled() {
        return gateway_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "extension_gateway_not_ready",
            true,
        );
    }

    let websocket = is_websocket_upgrade(request.headers());
    let permits = if websocket {
        generation.websocket_permits.clone()
    } else {
        generation.http_permits.clone()
    };
    let Ok(permit) = permits.try_acquire_owned() else {
        return gateway_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "extension_gateway_busy",
            true,
        );
    };

    if let Some(content_length) = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        if content_length > entry.spec.max_request_body_bytes {
            return gateway_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "extension_gateway_body_too_large",
                false,
            );
        }
    }

    let downstream_upgrade = websocket.then(|| hyper::upgrade::on(&mut request));
    let target = sanitized_target_uri(&suffix, request.uri().query());
    *request.uri_mut() = match target.parse::<Uri>() {
        Ok(uri) => uri,
        Err(_) => {
            return gateway_error(
                StatusCode::BAD_REQUEST,
                "extension_gateway_invalid_uri",
                false,
            )
        }
    };
    *request.version_mut() = Version::HTTP_11;
    sanitize_request_headers(request.headers_mut(), websocket, generation.generation);

    let exceeded = Arc::new(AtomicBool::new(false));
    let (parts, body) = request.into_parts();
    let request_body = GatewayRequestBody::new(
        body,
        entry.spec.max_request_body_bytes,
        exceeded.clone(),
        generation.cancelled.clone(),
    );
    let request = Request::from_parts(parts, request_body);

    let stream = match tokio::time::timeout(
        CONNECT_TIMEOUT,
        UnixStream::connect(&generation.socket_path),
    )
    .await
    {
        Ok(Ok(stream)) => stream,
        _ => {
            return gateway_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "extension_gateway_upstream_unavailable",
                true,
            )
        }
    };
    let (mut sender, connection) = match http1::handshake(TokioIo::new(stream)).await {
        Ok(parts) => parts,
        Err(_) => {
            return gateway_error(
                StatusCode::BAD_GATEWAY,
                "extension_gateway_handshake_failed",
                false,
            )
        }
    };
    tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    });

    let mut response =
        match tokio::time::timeout(RESPONSE_HEADER_TIMEOUT, sender.send_request(request)).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) if exceeded.load(Ordering::SeqCst) => {
                return gateway_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "extension_gateway_body_too_large",
                    false,
                )
            }
            Ok(Err(_)) => {
                return gateway_error(
                    StatusCode::BAD_GATEWAY,
                    "extension_gateway_upstream_failed",
                    false,
                )
            }
            Err(_) => {
                return gateway_error(
                    StatusCode::GATEWAY_TIMEOUT,
                    "extension_gateway_response_timeout",
                    false,
                )
            }
        };

    if let Err(code) = sanitize_response_headers(response.headers_mut(), &entry.mount, websocket) {
        return gateway_error(StatusCode::BAD_GATEWAY, code, false);
    }
    // Browser integrations use this trusted echo to detect that a suspended
    // page returned to a replaced extension generation. Always overwrite any
    // upstream value so an extension cannot spoof Remux lifecycle state.
    response.headers_mut().insert(
        HeaderName::from_static(INTERNAL_GENERATION_HEADER),
        HeaderValue::from_str(&generation.generation.to_string()).expect("u64 header"),
    );
    response.extensions_mut().insert(GatewayResponse);

    if websocket && response.status() == StatusCode::SWITCHING_PROTOCOLS {
        let upstream_upgrade = hyper::upgrade::on(&mut response);
        let (parts, _body) = response.into_parts();
        let cancelled = generation.cancelled.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let Some(downstream_upgrade) = downstream_upgrade else {
                return;
            };
            let Ok((Ok(downstream), Ok(upstream))) = tokio::time::timeout(
                CONNECT_TIMEOUT,
                futures_util::future::join(downstream_upgrade, upstream_upgrade),
            )
            .await
            else {
                return;
            };
            let mut downstream = TokioIo::new(downstream);
            let mut upstream = TokioIo::new(upstream);
            tokio::select! {
                _ = tokio::io::copy_bidirectional(&mut downstream, &mut upstream) => {}
                _ = cancelled.cancelled() => {
                    let _ = downstream.write_all(&service_restart_close_frame()).await;
                    let _ = downstream.flush().await;
                }
            }
            let _ = downstream.shutdown().await;
            let _ = upstream.shutdown().await;
        });
        return Response::from_parts(parts, Body::empty());
    }

    let (parts, body) = response.into_parts();
    let body = Body::new(GatewayResponseBody::new(
        body,
        permit,
        generation.cancelled.clone(),
    ));
    Response::from_parts(parts, body)
}

fn sanitized_target_uri(suffix: &str, query: Option<&str>) -> String {
    let path = if suffix.is_empty() { "/" } else { suffix };
    let Some(query) = query else {
        return path.to_string();
    };
    let filtered = url::form_urlencoded::parse(query.as_bytes())
        .filter(|(name, _)| name != "token")
        .collect::<Vec<_>>();
    if filtered.is_empty() {
        return path.to_string();
    }
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.extend_pairs(filtered);
    format!("{path}?{}", serializer.finish())
}

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    header_contains_token(headers, header::CONNECTION, "upgrade")
        && headers
            .get(header::UPGRADE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

fn header_contains_token(headers: &HeaderMap, name: HeaderName, token: &str) -> bool {
    headers.get_all(name).iter().any(|value| {
        value.to_str().ok().is_some_and(|value| {
            value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case(token))
        })
    })
}

fn sanitize_request_headers(headers: &mut HeaderMap, websocket: bool, generation: u64) {
    let connection_headers = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok())
        .collect::<Vec<_>>();
    for name in connection_headers {
        if !websocket || (name != header::UPGRADE && name != header::CONNECTION) {
            headers.remove(name);
        }
    }
    for name in [
        header::AUTHORIZATION,
        header::COOKIE,
        header::SET_COOKIE,
        header::PROXY_AUTHENTICATE,
        header::PROXY_AUTHORIZATION,
        header::TE,
        header::TRAILER,
    ] {
        headers.remove(name);
    }
    if !websocket {
        for name in [
            header::CONNECTION,
            HeaderName::from_static("keep-alive"),
            header::TRANSFER_ENCODING,
            header::UPGRADE,
        ] {
            headers.remove(name);
        }
    }
    let untrusted = headers
        .keys()
        .filter(|name| {
            let name = name.as_str();
            name == "forwarded" || name.starts_with("x-forwarded-") || name.starts_with("x-remux-")
        })
        .cloned()
        .collect::<Vec<_>>();
    for name in untrusted {
        headers.remove(name);
    }
    headers.insert(
        header::HOST,
        HeaderValue::from_static("remux-extension.invalid"),
    );
    headers.insert(
        HeaderName::from_static(INTERNAL_GENERATION_HEADER),
        HeaderValue::from_str(&generation.to_string()).expect("u64 header"),
    );
}

fn sanitize_response_headers(
    headers: &mut HeaderMap,
    mount: &str,
    websocket: bool,
) -> Result<(), &'static str> {
    for name in [
        header::SET_COOKIE,
        header::PROXY_AUTHENTICATE,
        header::PROXY_AUTHORIZATION,
    ] {
        headers.remove(name);
    }
    if !websocket {
        for name in [
            header::CONNECTION,
            HeaderName::from_static("keep-alive"),
            header::TRANSFER_ENCODING,
            header::UPGRADE,
        ] {
            headers.remove(name);
        }
    }
    let Some(location) = headers
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
    else {
        return Ok(());
    };
    if location.starts_with('/') {
        headers.insert(
            header::LOCATION,
            HeaderValue::from_str(&format!("{mount}{location}"))
                .map_err(|_| "extension_gateway_invalid_redirect")?,
        );
        return Ok(());
    }
    if let Ok(url) = url::Url::parse(&location) {
        if url.host_str().is_some_and(is_loopback_host) {
            return Err("extension_gateway_invalid_redirect");
        }
    }
    Ok(())
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

fn gateway_error(status: StatusCode, code: &'static str, retry: bool) -> Response<Body> {
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::json!({ "error": code }).to_string()))
        .expect("static gateway response");
    if retry {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
    }
    response.extensions_mut().insert(GatewayResponse);
    response
}

fn service_restart_close_frame() -> Vec<u8> {
    let reason = b"service restart";
    let payload_len = 2 + reason.len();
    let mut frame = Vec::with_capacity(payload_len + 2);
    frame.push(0x88);
    frame.push(payload_len as u8);
    frame.extend_from_slice(&1012u16.to_be_bytes());
    frame.extend_from_slice(reason);
    frame
}

#[derive(Debug)]
struct GatewayBodyError(&'static str);

impl std::fmt::Display for GatewayBodyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for GatewayBodyError {}

type CancelFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

pin_project! {
    struct GatewayRequestBody {
        #[pin]
        inner: Body,
        #[pin]
        idle: Sleep,
        cancelled: CancelFuture,
        seen: u64,
        limit: u64,
        exceeded: Arc<AtomicBool>,
    }
}

impl GatewayRequestBody {
    fn new(
        inner: Body,
        limit: u64,
        exceeded: Arc<AtomicBool>,
        cancelled: CancellationToken,
    ) -> Self {
        Self {
            inner,
            idle: tokio::time::sleep(BODY_IDLE_TIMEOUT),
            cancelled: Box::pin(cancelled.cancelled_owned()),
            seen: 0,
            limit,
            exceeded,
        }
    }
}

impl HttpBody for GatewayRequestBody {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let mut this = self.project();
        if this.cancelled.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Some(Err(Box::new(GatewayBodyError(
                "gateway generation retired",
            )))));
        }
        match this.inner.as_mut().poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                this.idle.as_mut().reset(Instant::now() + BODY_IDLE_TIMEOUT);
                if let Some(data) = frame.data_ref() {
                    *this.seen = this.seen.saturating_add(data.len() as u64);
                    if *this.seen > *this.limit {
                        this.exceeded.store(true, Ordering::SeqCst);
                        return Poll::Ready(Some(Err(Box::new(GatewayBodyError(
                            "gateway request body exceeded its declared limit",
                        )))));
                    }
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(error))) => Poll::Ready(Some(Err(Box::new(error)))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => {
                if this.idle.as_mut().poll(cx).is_ready() {
                    Poll::Ready(Some(Err(Box::new(GatewayBodyError(
                        "gateway request body idle timeout",
                    )))))
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

pin_project! {
    struct GatewayResponseBody {
        #[pin]
        inner: Incoming,
        #[pin]
        idle: Sleep,
        cancelled: CancelFuture,
        permit: Option<OwnedSemaphorePermit>,
    }
}

impl GatewayResponseBody {
    fn new(inner: Incoming, permit: OwnedSemaphorePermit, cancelled: CancellationToken) -> Self {
        Self {
            inner,
            idle: tokio::time::sleep(BODY_IDLE_TIMEOUT),
            cancelled: Box::pin(cancelled.cancelled_owned()),
            permit: Some(permit),
        }
    }
}

impl HttpBody for GatewayResponseBody {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let mut this = self.project();
        if this.cancelled.as_mut().poll(cx).is_ready() {
            this.permit.take();
            return Poll::Ready(Some(Err(Box::new(GatewayBodyError(
                "gateway generation retired",
            )))));
        }
        match this.inner.as_mut().poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                this.idle.as_mut().reset(Instant::now() + BODY_IDLE_TIMEOUT);
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(error))) => {
                this.permit.take();
                Poll::Ready(Some(Err(Box::new(error))))
            }
            Poll::Ready(None) => {
                this.permit.take();
                Poll::Ready(None)
            }
            Poll::Pending => {
                if this.idle.as_mut().poll(cx).is_ready() {
                    this.permit.take();
                    Poll::Ready(Some(Err(Box::new(GatewayBodyError(
                        "gateway response body idle timeout",
                    )))))
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
    fn removes_query_tokens_without_changing_the_mount_suffix() {
        assert_eq!(
            sanitized_target_uri("/ws", Some("wsTicket=ok&token=secret&x=a%20b")),
            "/ws?wsTicket=ok&x=a+b"
        );
        assert_eq!(sanitized_target_uri("", Some("token=x")), "/");
    }

    #[test]
    fn websocket_restart_frame_has_1012_and_reason() {
        let frame = service_restart_close_frame();
        assert_eq!(frame[0], 0x88);
        assert_eq!(u16::from_be_bytes([frame[2], frame[3]]), 1012);
        assert_eq!(&frame[4..], b"service restart");
    }
}

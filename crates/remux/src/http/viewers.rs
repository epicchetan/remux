//! Static viewer serving, ported from `cli/viewerProvider.cjs`. The
//! entry-fallback (SPA) and traversal-guard semantics are the contract —
//! hand-rolled rather than tower's ServeDir.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use sha2::{Digest, Sha256};

use crate::extensions::manifest::ExtensionManifest;
use crate::http::text_response;
use crate::http::viewer_bundles::ViewerBundleRegistry;
use crate::paths;

pub struct ViewerProvider {
    pub id: String,
    pub view_id: String,
    pub route: String,
    pub entry: PathBuf,
    pub bundles: Arc<ViewerBundleRegistry>,
}

impl ViewerProvider {
    pub fn for_extension(
        extension: &ExtensionManifest,
        bundles: Arc<ViewerBundleRegistry>,
    ) -> Vec<Self> {
        extension
            .views
            .iter()
            .map(|(view_id, view)| Self {
                id: extension.id.clone(),
                view_id: view_id.clone(),
                route: normalize_route(&view.route),
                entry: view.entry.clone(),
                bundles: bundles.clone(),
            })
            .collect()
    }

    /// Returns `None` when the request is not under this provider's route.
    pub async fn handle(&self, pathname: &str, headers: &HeaderMap) -> Option<Response> {
        if !is_viewer_request(&self.route, pathname) {
            return None;
        }
        let bundle_prefix = format!("{}/_bundle/", self.route);
        if let Some(rest) = pathname.strip_prefix(&bundle_prefix) {
            let mut parts = rest.splitn(2, '/');
            let revision = parts.next().unwrap_or_default();
            let suffix = parts.next().unwrap_or_default();
            let Some(bundle) = self.bundles.revision(&self.id, &self.view_id, revision) else {
                return Some(
                    Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(
                            serde_json::json!({
                                "error": {
                                    "code": "viewer_revision_unavailable",
                                    "message": "Viewer bundle revision unavailable."
                                }
                            })
                            .to_string(),
                        ))
                        .expect("static response"),
                );
            };
            let versioned_route = format!("{}/_bundle/{revision}", self.route);
            let entry = bundle.snapshot_root.join(&bundle.entry_relative_path);
            let request_path = if suffix.is_empty() {
                versioned_route.clone()
            } else {
                format!("{versioned_route}/{suffix}")
            };
            return Some(
                serve_static_viewer(
                    &entry,
                    &versioned_route,
                    &request_path,
                    true,
                    headers,
                    Some((&self.route, &versioned_route)),
                )
                .await,
            );
        }
        Some(
            serve_static_viewer(
                &self.entry,
                &self.route,
                pathname,
                false,
                headers,
                None,
            )
            .await,
        )
    }
}

pub fn is_viewer_request(route: &str, pathname: &str) -> bool {
    pathname == route || pathname.starts_with(&format!("{route}/"))
}

async fn serve_static_viewer(
    entry: &Path,
    route: &str,
    pathname: &str,
    immutable: bool,
    headers: &HeaderMap,
    entry_rebase: Option<(&str, &str)>,
) -> Response {
    let asset_path = static_asset_path(entry, route, pathname);
    let file_path = if asset_path.exists() {
        asset_path
    } else if immutable && request_looks_like_file(route, pathname) {
        return text_response(StatusCode::NOT_FOUND, "Viewer asset not found.");
    } else {
        entry.to_path_buf()
    };

    match tokio::fs::read(&file_path).await {
        Ok(mut contents) => {
            if file_path == entry {
                if let (Some((source_route, target_route)), Ok(html)) =
                    (entry_rebase, std::str::from_utf8(&contents))
                {
                    contents = rebase_entry_html(html, source_route, target_route).into_bytes();
                }
            }
            let content_hash = content_hash(&contents);
            let etag = if immutable {
                let revision = route.rsplit('/').next().unwrap_or("viewer");
                format!("\"{revision}:{content_hash}\"")
            } else {
                format!("\"{content_hash}\"")
            };
            if headers
                .get(header::IF_NONE_MATCH)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.split(',').any(|candidate| candidate.trim() == etag))
            {
                return Response::builder()
                    .status(StatusCode::NOT_MODIFIED)
                    .header(header::ETAG, etag)
                    .body(Body::empty())
                    .expect("static response");
            }
            let mut response = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type(&file_path))
                .header(header::ETAG, etag);
            if immutable {
                response = response.header(
                    header::CACHE_CONTROL,
                    "private, max-age=31536000, immutable",
                );
            } else {
                response = response.header(header::CACHE_CONTROL, "no-cache");
            }
            response
                .body(Body::from(contents))
                .expect("static response")
        }
        Err(_) => text_response(StatusCode::NOT_FOUND, "Viewer asset not found."),
    }
}

fn rebase_entry_html(html: &str, source_route: &str, target_route: &str) -> String {
    let mut output = html.to_string();
    for attribute in ["src", "href", "poster"] {
        for quote in ['\"', '\''] {
            let source = format!("{attribute}={quote}{source_route}/");
            let target = format!("{attribute}={quote}{target_route}/");
            output = output.replace(&source, &target);
        }
    }
    for quote in ['\"', '\''] {
        output = rebase_srcset_attributes(&output, quote, source_route, target_route);
    }
    output
}

fn rebase_srcset_attributes(
    html: &str,
    quote: char,
    source_route: &str,
    target_route: &str,
) -> String {
    let marker = format!("srcset={quote}");
    let mut remaining = html;
    let mut output = String::with_capacity(html.len());
    while let Some(start) = remaining.find(&marker) {
        let value_start = start + marker.len();
        let Some(value_end) = remaining[value_start..].find(quote) else {
            break;
        };
        let value_end = value_start + value_end;
        output.push_str(&remaining[..value_start]);
        let rebased = remaining[value_start..value_end]
            .split(',')
            .map(|candidate| {
                let trimmed = candidate.trim_start();
                let padding = &candidate[..candidate.len() - trimmed.len()];
                match trimmed.strip_prefix(&format!("{source_route}/")) {
                    Some(suffix) => format!("{padding}{target_route}/{suffix}"),
                    None => candidate.to_string(),
                }
            })
            .collect::<Vec<_>>()
            .join(",");
        output.push_str(&rebased);
        output.push(quote);
        remaining = &remaining[value_end + quote.len_utf8()..];
    }
    output.push_str(remaining);
    output
}

fn request_looks_like_file(route: &str, pathname: &str) -> bool {
    pathname
        .strip_prefix(route)
        .unwrap_or(pathname)
        .trim_start_matches('/')
        .rsplit('/')
        .next()
        .is_some_and(|name| name.contains('.'))
}

fn content_hash(contents: &[u8]) -> String {
    let digest = Sha256::digest(contents);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

/// Port of `staticAssetPath` (`viewerProvider.cjs:316-331`): exact route (with
/// or without trailing slash) serves the entry; deeper paths resolve under the
/// entry's directory; anything that lexically escapes that directory falls
/// back to the entry.
pub fn static_asset_path(entry: &Path, route: &str, pathname: &str) -> PathBuf {
    if !is_viewer_request(route, pathname) {
        return entry.to_path_buf();
    }
    if pathname == route || pathname == format!("{route}/") {
        return entry.to_path_buf();
    }

    let root = entry.parent().unwrap_or(Path::new("/"));
    let relative_path = pathname[route.len()..].trim_start_matches('/');
    let root_str = root.to_string_lossy();
    let candidate = paths::join(&root_str, relative_path);

    if escapes_root(&paths::normalize(&root_str), &candidate) {
        entry.to_path_buf()
    } else {
        PathBuf::from(candidate)
    }
}

/// Equivalent of Node `relative(root, candidate).startsWith('..')` for
/// normalized absolute paths.
fn escapes_root(root: &str, candidate: &str) -> bool {
    candidate != root && !candidate.starts_with(&format!("{}/", root.trim_end_matches('/')))
}

pub fn content_type(file_path: &Path) -> &'static str {
    let extension = file_path
        .extension()
        .map(|ext| ext.to_string_lossy().into_owned())
        .unwrap_or_default();
    match extension.as_str() {
        "css" => "text/css; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    }
}

fn normalize_route(route: &str) -> String {
    route.strip_suffix('/').unwrap_or(route).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRY: &str = "/tmp/remux/extensions/codex/viewer/dist/index.html";

    #[test]
    fn serves_the_entry_for_the_viewer_route() {
        assert_eq!(
            static_asset_path(Path::new(ENTRY), "/viewers/codex", "/viewers/codex/"),
            PathBuf::from(ENTRY)
        );
        assert_eq!(
            static_asset_path(Path::new(ENTRY), "/viewers/codex", "/viewers/codex"),
            PathBuf::from(ENTRY)
        );
    }

    #[test]
    fn resolves_assets_under_the_built_viewer_directory() {
        assert_eq!(
            static_asset_path(
                Path::new(ENTRY),
                "/viewers/codex",
                "/viewers/codex/assets/index.js"
            ),
            PathBuf::from("/tmp/remux/extensions/codex/viewer/dist/assets/index.js")
        );
    }

    #[test]
    fn falls_back_to_the_entry_on_traversal_attempts() {
        assert_eq!(
            static_asset_path(
                Path::new(ENTRY),
                "/viewers/codex",
                "/viewers/codex/../../secret.txt"
            ),
            PathBuf::from(ENTRY)
        );
    }

    #[test]
    fn content_type_maps_common_viewer_assets() {
        assert_eq!(
            content_type(Path::new("/tmp/index.html")),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            content_type(Path::new("/tmp/index.css")),
            "text/css; charset=utf-8"
        );
        assert_eq!(
            content_type(Path::new("/tmp/index.js")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type(Path::new("/tmp/icon.svg")), "image/svg+xml");
    }

    #[test]
    fn is_viewer_request_matches_only_the_mounted_route() {
        assert!(is_viewer_request("/viewers/codex", "/viewers/codex"));
        assert!(is_viewer_request(
            "/viewers/codex",
            "/viewers/codex/asset.js"
        ));
        assert!(!is_viewer_request("/viewers/codex", "/viewers/editor"));
    }

    #[test]
    fn rebases_only_local_entry_attributes() {
        let html = r#"<script src="/viewers/codex/assets/app.js"></script>
<link href='/viewers/codex/assets/app.css'>
<img srcset="/viewers/codex/a.png 1x, https://example.com/b.png 2x">
<a href="https://example.com/viewers/codex/nope">external</a>"#;
        let rebased = rebase_entry_html(
            html,
            "/viewers/codex",
            "/viewers/codex/_bundle/sha256-test",
        );
        assert!(rebased.contains("/viewers/codex/_bundle/sha256-test/assets/app.js"));
        assert!(rebased.contains("/viewers/codex/_bundle/sha256-test/assets/app.css"));
        assert!(rebased.contains("/viewers/codex/_bundle/sha256-test/a.png 1x"));
        assert!(rebased.contains("https://example.com/b.png 2x"));
        assert!(rebased.contains("https://example.com/viewers/codex/nope"));
    }
}

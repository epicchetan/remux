//! Static viewer serving, ported from `cli/viewerProvider.cjs`. The
//! entry-fallback (SPA) and traversal-guard semantics are the contract —
//! hand-rolled rather than tower's ServeDir.

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;

use crate::extensions::manifest::ExtensionManifest;
use crate::http::text_response;
use crate::paths;

pub struct ViewerProvider {
    pub id: String,
    pub route: String,
    pub entry: PathBuf,
}

impl ViewerProvider {
    pub fn new(extension: &ExtensionManifest) -> Self {
        let view = extension.main_view();
        Self {
            id: extension.id.clone(),
            route: normalize_route(&view.route),
            entry: view.entry.clone(),
        }
    }

    /// Returns `None` when the request is not under this provider's route.
    pub async fn handle(&self, pathname: &str) -> Option<Response> {
        if !is_viewer_request(&self.route, pathname) {
            return None;
        }
        Some(serve_static_viewer(&self.entry, &self.route, pathname).await)
    }
}

pub fn is_viewer_request(route: &str, pathname: &str) -> bool {
    pathname == route || pathname.starts_with(&format!("{route}/"))
}

async fn serve_static_viewer(entry: &Path, route: &str, pathname: &str) -> Response {
    let asset_path = static_asset_path(entry, route, pathname);
    let file_path = if asset_path.exists() {
        asset_path
    } else {
        entry.to_path_buf()
    };

    match tokio::fs::read(&file_path).await {
        Ok(contents) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type(&file_path))
            .body(Body::from(contents))
            .expect("static response"),
        Err(_) => text_response(StatusCode::NOT_FOUND, "Viewer asset not found."),
    }
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
        assert_eq!(content_type(Path::new("/tmp/index.html")), "text/html; charset=utf-8");
        assert_eq!(content_type(Path::new("/tmp/index.css")), "text/css; charset=utf-8");
        assert_eq!(
            content_type(Path::new("/tmp/index.js")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type(Path::new("/tmp/icon.svg")), "image/svg+xml");
    }

    #[test]
    fn is_viewer_request_matches_only_the_mounted_route() {
        assert!(is_viewer_request("/viewers/codex", "/viewers/codex"));
        assert!(is_viewer_request("/viewers/codex", "/viewers/codex/asset.js"));
        assert!(!is_viewer_request("/viewers/codex", "/viewers/editor"));
    }
}

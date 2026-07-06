//! `/remux/extensions/<id>/icon` resolution and serving
//! (`cli/httpServer.cjs:118-184`).

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;

use crate::extensions::manifest::ExtensionManifest;
use crate::http::catalog::icon_variant_path;
use crate::http::text_response;

pub fn icon_for_icon_path(
    pathname: &str,
    query: &str,
    extensions: &[ExtensionManifest],
) -> Option<PathBuf> {
    let rest = pathname.strip_prefix("/remux/extensions/")?;
    let (raw_id, tail) = rest.split_once('/')?;
    if tail != "icon" || raw_id.is_empty() {
        return None;
    }

    let extension_id = decode_uri_component(raw_id)?;
    let extension = extensions
        .iter()
        .find(|candidate| candidate.id == extension_id)?;

    let kind = query_param(query, "kind");
    let id = query_param(query, "id");
    let variant = match query_param(query, "variant").as_deref() {
        Some("dark") => Some("dark"),
        _ => None,
    };

    if kind.as_deref() == Some("launcher") {
        if let Some(id) = &id {
            let launcher = extension.launchers.iter().find(|entry| &entry.id == id);
            return launcher.and_then(|entry| {
                icon_variant_path(entry.icon.as_deref(), entry.icon_dark.as_deref(), variant)
            });
        }
    }

    if kind.as_deref() == Some("fileHandler") {
        if let Some(id) = &id {
            let handler = extension.file_handlers.iter().find(|entry| &entry.id == id);
            return handler.and_then(|entry| {
                icon_variant_path(entry.icon.as_deref(), entry.icon_dark.as_deref(), variant)
            });
        }
    }

    icon_variant_path(
        extension.display.icon.as_deref(),
        extension.display.icon_dark.as_deref(),
        variant,
    )
}

pub async fn serve_extension_icon(icon_path: &Path) -> Response {
    match tokio::fs::read(icon_path).await {
        Ok(icon) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CACHE_CONTROL, "no-cache")
            .header(header::CONTENT_TYPE, content_type_for_path(icon_path))
            .body(Body::from(icon))
            .expect("static response"),
        Err(_) => text_response(StatusCode::NOT_FOUND, "Extension icon not found."),
    }
}

fn content_type_for_path(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

/// `decodeURIComponent`: percent-decode UTF-8; malformed input returns `None`
/// (Node catches and treats the id as unmatched).
pub fn decode_uri_component(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut chars = value.bytes();
    while let Some(byte) = chars.next() {
        if byte == b'%' {
            let high = chars.next()?;
            let low = chars.next()?;
            let hex = [high, low];
            let hex = std::str::from_utf8(&hex).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).ok()
}

/// First-match query lookup with `URLSearchParams` decoding (`+` is a space).
pub fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (raw_key, raw_value) = match pair.split_once('=') {
            Some((key, value)) => (key, value),
            None => (pair, ""),
        };
        let decoded_key = decode_uri_component(&raw_key.replace('+', " "))?;
        if decoded_key == key {
            return decode_uri_component(&raw_value.replace('+', " "));
        }
    }
    None
}

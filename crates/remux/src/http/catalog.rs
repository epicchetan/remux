//! `/remux/extensions` catalog, ported from `extensionCatalog`
//! (`cli/httpServer.cjs:71-108`). The JSON shape — field names, null
//! fallbacks, and icon URL query construction — is app protocol surface.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::extensions::manifest::{ExtensionManifest, LauncherRoute};
use crate::http::viewer_bundles::ViewerBundleRegistry;

pub fn extension_catalog(
    default_extension: Option<&ExtensionManifest>,
    extensions: &[ExtensionManifest],
    bundles: &ViewerBundleRegistry,
) -> Value {
    let extensions: Vec<Value> = extensions
        .iter()
        .map(|extension| {
            let display_icon_url = extension
                .display
                .icon
                .as_deref()
                .map(|_| extension_icon_route(extension, None, None));
            let display_icon_dark_url = extension
                .display
                .icon_dark
                .as_deref()
                .map(|_| extension_icon_route(extension, None, Some("dark")));

            let file_handlers: Vec<Value> = extension
                .file_handlers
                .iter()
                .map(|handler| {
                    serde_json::json!({
                        "extensionId": extension.id,
                        "extensions": handler.extensions,
                        "iconDarkUrl": handler.icon_dark.as_deref().map(|_| {
                            extension_icon_route(
                                extension,
                                Some(("fileHandler", handler.id.as_str())),
                                Some("dark"),
                            )
                        }),
                        "iconUrl": handler.icon.as_deref().map(|_| {
                            extension_icon_route(
                                extension,
                                Some(("fileHandler", handler.id.as_str())),
                                None,
                            )
                        }),
                        "id": handler.id,
                        "label": handler.label,
                        "view": handler.view,
                    })
                })
                .collect();

            let launchers: Vec<Value> = extension
                .launchers
                .iter()
                .map(|launcher| {
                    serde_json::json!({
                        "extensionId": extension.id,
                        "iconDarkUrl": launcher.icon_dark.as_deref().map(|_| {
                            extension_icon_route(
                                extension,
                                Some(("launcher", launcher.id.as_str())),
                                Some("dark"),
                            )
                        }),
                        "iconUrl": launcher.icon.as_deref().map(|_| {
                            extension_icon_route(
                                extension,
                                Some(("launcher", launcher.id.as_str())),
                                None,
                            )
                        }),
                        "id": launcher.id,
                        "label": launcher.label,
                        "route": launcher_route_value(launcher.route.as_ref()),
                        "view": launcher.view,
                    })
                })
                .collect();

            let mut views = Map::new();
            for (view_id, view) in &extension.views {
                let published = bundles.current(&extension.id, view_id);
                let entry_url = published
                    .as_ref()
                    .map(|bundle| format!("{}/_bundle/{}/", view.route, bundle.revision))
                    .unwrap_or_else(|| format!("{}/", view.route.trim_end_matches('/')));
                views.insert(
                    view_id.clone(),
                    serde_json::json!({
                        "entryUrl": entry_url,
                        "revision": published.map(|bundle| bundle.revision),
                        "route": view.route,
                    }),
                );
            }

            serde_json::json!({
                "display": {
                    "iconDarkUrl": display_icon_dark_url,
                    "iconUrl": display_icon_url,
                    "title": extension.display.title,
                },
                "fileHandlers": file_handlers,
                "id": extension.id,
                "launchers": launchers,
                "name": extension.name,
                "views": views,
            })
        })
        .collect();

    serde_json::json!({
        "defaultExtensionId": default_extension.map(|extension| extension.id.clone()),
        "extensions": extensions,
        "service": "remux",
    })
}

pub fn launcher_route_value(route: Option<&LauncherRoute>) -> Value {
    match route {
        Some(route) => serde_json::json!({
            "kind": "launch",
            "launch": route.launch,
            "resourceKind": route.resource_kind,
        }),
        None => Value::Null,
    }
}

/// Port of `extensionIconRoute`: `format` is always first, then `kind`/`id`
/// for entry icons, then `variant=dark`, URLSearchParams-encoded.
fn extension_icon_route(
    extension: &ExtensionManifest,
    source: Option<(&str, &str)>,
    variant: Option<&str>,
) -> String {
    let icon_path = icon_path_for_source(extension, source, variant);
    let format = icon_path
        .as_deref()
        .and_then(extension_of)
        .unwrap_or_else(|| "asset".to_string());

    let mut params = vec![("format".to_string(), format)];
    if let Some((kind, id)) = source {
        params.push(("kind".to_string(), kind.to_string()));
        params.push(("id".to_string(), id.to_string()));
    }
    if variant == Some("dark") {
        params.push(("variant".to_string(), "dark".to_string()));
    }

    let query = params
        .iter()
        .map(|(key, value)| format!("{}={}", form_urlencode(key), form_urlencode(value)))
        .collect::<Vec<_>>()
        .join("&");

    format!(
        "/remux/extensions/{}/icon?{}",
        encode_uri_component(&extension.id),
        query
    )
}

fn icon_path_for_source(
    extension: &ExtensionManifest,
    source: Option<(&str, &str)>,
    variant: Option<&str>,
) -> Option<PathBuf> {
    match source {
        Some(("launcher", id)) => {
            let launcher = extension.launchers.iter().find(|entry| entry.id == id);
            launcher
                .and_then(|entry| icon_variant_path(entry.icon.as_deref(), entry.icon_dark.as_deref(), variant))
                .or_else(|| {
                    icon_variant_path(
                        extension.display.icon.as_deref(),
                        extension.display.icon_dark.as_deref(),
                        variant,
                    )
                })
        }
        Some(("fileHandler", id)) => {
            let handler = extension.file_handlers.iter().find(|entry| entry.id == id);
            handler
                .and_then(|entry| icon_variant_path(entry.icon.as_deref(), entry.icon_dark.as_deref(), variant))
                .or_else(|| {
                    icon_variant_path(
                        extension.display.icon.as_deref(),
                        extension.display.icon_dark.as_deref(),
                        variant,
                    )
                })
        }
        _ => icon_variant_path(
            extension.display.icon.as_deref(),
            extension.display.icon_dark.as_deref(),
            variant,
        ),
    }
}

// Falls back to the light icon when a dark variant is requested but missing,
// so a stale variant URL still resolves to something renderable.
pub fn icon_variant_path(
    icon: Option<&Path>,
    icon_dark: Option<&Path>,
    variant: Option<&str>,
) -> Option<PathBuf> {
    if variant != Some("dark") {
        return icon.map(Path::to_path_buf);
    }
    icon_dark.or(icon).map(Path::to_path_buf)
}

/// Node `extname(path).slice(1) || 'asset'` keeps the raw (case-preserved)
/// extension; empty/missing extensions fall back to `asset` at the call site.
fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .map(|ext| ext.to_string_lossy().into_owned())
        .filter(|ext| !ext.is_empty())
}

/// `encodeURIComponent`: unreserved chars are `A-Za-z0-9 - _ . ! ~ * ' ( )`.
pub fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~'
            | b'*' | b'\'' | b'(' | b')' => encoded.push(byte as char),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// `URLSearchParams` serialization (application/x-www-form-urlencoded):
/// space becomes `+`; unreserved chars are `A-Za-z0-9 * - . _`.
pub fn form_urlencode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                encoded.push(byte as char)
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

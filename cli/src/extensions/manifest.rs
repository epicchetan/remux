//! `remux-extension.json` loading and validation, ported from
//! `cli/extensionManifest.cjs`. Validation error messages and ordering are
//! preserved verbatim — they surface at startup and in tests.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::paths::resolve_manifest_path;

pub const MANIFEST_FILENAME: &str = "remux-extension.json";

#[derive(Debug, Clone, PartialEq)]
pub struct ExtensionManifest {
    pub id: String,
    pub name: String,
    pub root_dir: PathBuf,
    pub display: Display,
    pub server: Option<ServerSpec>,
    /// Views in manifest declaration order (`main` is guaranteed present).
    pub views: Vec<(String, View)>,
    pub launchers: Vec<Launcher>,
    pub file_handlers: Vec<FileHandler>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Display {
    pub icon: Option<PathBuf>,
    pub icon_dark: Option<PathBuf>,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ServerSpec {
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, PartialEq)]
pub struct View {
    pub entry: PathBuf,
    pub route: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LauncherRoute {
    pub launch: Option<String>,
    pub resource_kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Launcher {
    pub id: String,
    pub label: String,
    pub icon: Option<PathBuf>,
    pub icon_dark: Option<PathBuf>,
    pub route: Option<LauncherRoute>,
    pub view: String,
    pub view_route: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileHandler {
    pub id: String,
    pub label: String,
    pub extensions: Vec<String>,
    pub icon: Option<PathBuf>,
    pub icon_dark: Option<PathBuf>,
    pub view: String,
    pub view_route: String,
}

impl ExtensionManifest {
    pub fn view(&self, view_id: &str) -> Option<&View> {
        self.views
            .iter()
            .find(|(id, _)| id == view_id)
            .map(|(_, view)| view)
    }

    pub fn main_view(&self) -> &View {
        self.view("main").expect("validated manifest has views.main")
    }
}

pub fn load_extension_manifest(manifest_path: &Path) -> Result<ExtensionManifest, String> {
    let root_dir = manifest_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let source = std::fs::read_to_string(manifest_path)
        .map_err(|err| format!("{}: {err}", manifest_path.display()))?;
    let raw: Value = serde_json::from_str(&source)
        .map_err(|err| format!("{}: {err}", manifest_path.display()))?;

    validate_manifest(&raw, &manifest_path.to_string_lossy())?;
    Ok(parse_manifest(&raw, &root_dir))
}

/// Assumes `validate_manifest` has passed.
fn parse_manifest(raw: &Value, root_dir: &Path) -> ExtensionManifest {
    let id = raw["id"].as_str().expect("validated").to_string();
    let name = match raw.get("name").and_then(Value::as_str) {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => id.clone(),
    };

    let views = parse_views(&id, &raw["views"], root_dir);
    let empty = serde_json::Map::new();
    let display = raw.get("display").and_then(Value::as_object).unwrap_or(&empty);

    let title = match display.get("title").and_then(Value::as_str) {
        Some(title) if !title.trim().is_empty() => title.to_string(),
        _ => name.clone(),
    };

    ExtensionManifest {
        display: Display {
            icon: resolve_optional_path(display.get("icon"), root_dir),
            icon_dark: resolve_optional_path(display.get("iconDark"), root_dir),
            title,
        },
        launchers: parse_launchers(raw.get("launchers"), display, &id, root_dir, &views),
        file_handlers: parse_file_handlers(raw.get("fileHandlers"), display, root_dir, &views),
        server: parse_server(raw.get("server"), root_dir),
        id,
        name,
        root_dir: root_dir.to_path_buf(),
        views,
    }
}

fn resolve_optional_path(value: Option<&Value>, root_dir: &Path) -> Option<PathBuf> {
    value
        .and_then(Value::as_str)
        .map(|value| resolve_manifest_path(root_dir, value))
}

fn parse_views(extension_id: &str, raw_views: &Value, root_dir: &Path) -> Vec<(String, View)> {
    let mut views = Vec::new();
    for (view_id, raw_view) in raw_views.as_object().expect("validated") {
        let route = match raw_view.get("route").and_then(Value::as_str) {
            Some(route) if !route.is_empty() => route.to_string(),
            _ => default_view_route(extension_id, view_id),
        };
        views.push((
            view_id.clone(),
            View {
                entry: resolve_manifest_path(
                    root_dir,
                    raw_view["entry"].as_str().expect("validated"),
                ),
                route: normalize_route(&route),
            },
        ));
    }
    views
}

fn default_view_route(extension_id: &str, view_id: &str) -> String {
    if view_id == "main" {
        format!("/viewers/{extension_id}")
    } else {
        format!("/viewers/{extension_id}/{view_id}")
    }
}

fn normalize_route(route: &str) -> String {
    if route.ends_with('/') && route != "/" {
        route[..route.len() - 1].to_string()
    } else {
        route.to_string()
    }
}

fn parse_server(raw_server: Option<&Value>, root_dir: &Path) -> Option<ServerSpec> {
    let server = raw_server?.as_object().expect("validated");
    let args = server
        .get("args")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| value.as_str().expect("validated").to_string())
                .collect()
        })
        .unwrap_or_default();
    let cwd = server
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.is_empty())
        .unwrap_or(".");

    Some(ServerSpec {
        args,
        command: server["command"].as_str().expect("validated").to_string(),
        cwd: resolve_manifest_path(root_dir, cwd),
        transport: server["transport"].as_str().expect("validated").to_string(),
    })
}

fn parse_launchers(
    raw_launchers: Option<&Value>,
    extension_display: &serde_json::Map<String, Value>,
    extension_id: &str,
    root_dir: &Path,
    views: &[(String, View)],
) -> Vec<Launcher> {
    let Some(launchers) = raw_launchers.and_then(Value::as_array) else {
        return Vec::new();
    };

    launchers
        .iter()
        .map(|launcher| {
            let view = entry_view(launcher);
            let (icon, icon_dark) = icon_pair(launcher, extension_display, root_dir);
            let label = match launcher.get("label").and_then(Value::as_str) {
                Some(label) if !label.trim().is_empty() => label.to_string(),
                _ => match extension_display.get("title").and_then(Value::as_str) {
                    Some(title) if !title.is_empty() => title.to_string(),
                    _ => extension_id.to_string(),
                },
            };

            Launcher {
                icon,
                icon_dark,
                id: launcher["id"].as_str().expect("validated").to_string(),
                label,
                route: parse_launcher_route(launcher.get("route")),
                view_route: view_route(views, &view),
                view,
            }
        })
        .collect()
}

fn parse_launcher_route(route: Option<&Value>) -> Option<LauncherRoute> {
    let route = route?.as_object()?;
    let trimmed_string = |key: &str| {
        route
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
    };
    Some(LauncherRoute {
        launch: trimmed_string("launch"),
        resource_kind: trimmed_string("resourceKind"),
    })
}

fn parse_file_handlers(
    raw_handlers: Option<&Value>,
    extension_display: &serde_json::Map<String, Value>,
    root_dir: &Path,
    views: &[(String, View)],
) -> Vec<FileHandler> {
    let Some(handlers) = raw_handlers.and_then(Value::as_array) else {
        return Vec::new();
    };

    handlers
        .iter()
        .map(|handler| {
            let view = entry_view(handler);
            let (icon, icon_dark) = icon_pair(handler, extension_display, root_dir);
            let id = handler["id"].as_str().expect("validated").to_string();
            let label = match handler.get("label").and_then(Value::as_str) {
                Some(label) if !label.trim().is_empty() => label.to_string(),
                _ => id.clone(),
            };
            let extensions = handler
                .get("extensions")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .map(|value| value.as_str().expect("validated").to_lowercase())
                        .collect()
                })
                .unwrap_or_default();

            FileHandler {
                extensions,
                icon,
                icon_dark,
                id,
                label,
                view_route: view_route(views, &view),
                view,
            }
        })
        .collect()
}

fn entry_view(entry: &Value) -> String {
    match entry.get("view").and_then(Value::as_str) {
        Some(view) if !view.is_empty() => view.to_string(),
        _ => "main".to_string(),
    }
}

fn view_route(views: &[(String, View)], view: &str) -> String {
    views
        .iter()
        .find(|(id, _)| id == view)
        .map(|(_, view)| view.route.clone())
        .expect("validated view reference")
}

// An entry with its own icon never inherits display.iconDark — both variants
// must come from the same source so light/dark stay a matched pair.
fn icon_pair(
    entry: &Value,
    extension_display: &serde_json::Map<String, Value>,
    root_dir: &Path,
) -> (Option<PathBuf>, Option<PathBuf>) {
    if entry.get("icon").and_then(Value::as_str).is_some() {
        return (
            resolve_optional_path(entry.get("icon"), root_dir),
            resolve_optional_path(entry.get("iconDark"), root_dir),
        );
    }

    (
        resolve_optional_path(extension_display.get("icon"), root_dir),
        resolve_optional_path(extension_display.get("iconDark"), root_dir),
    )
}

pub fn validate_manifest(manifest: &Value, manifest_path: &str) -> Result<(), String> {
    if !is_record(manifest) {
        return Err(format!(
            "Invalid Remux extension at {manifest_path}: manifest must be an object"
        ));
    }

    let id = match manifest.get("id").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id,
        _ => {
            return Err(format!(
                "Invalid Remux extension at {manifest_path}: id must be a non-empty string"
            ))
        }
    };
    let invalid = |detail: &str| Err(format!("Invalid Remux extension {id}: {detail}"));

    if manifest.get("version").and_then(Value::as_f64) != Some(1.0) {
        return invalid("version must be 1");
    }

    if let Some(name) = manifest.get("name") {
        if !name.is_string() {
            return invalid("name must be a string");
        }
    }

    validate_server(manifest, id)?;
    validate_main_view(manifest, id)?;
    validate_display(manifest, id)?;
    validate_launchers(manifest, id)?;
    validate_file_handlers(manifest, id)?;
    Ok(())
}

fn validate_server(manifest: &Value, id: &str) -> Result<(), String> {
    let Some(server) = manifest.get("server") else {
        return Ok(());
    };
    let invalid = |detail: &str| Err(format!("Invalid Remux extension {id}: {detail}"));

    if !is_record(server) {
        return invalid("server must be an object");
    }
    if server.get("transport").and_then(Value::as_str) != Some("stdio") {
        return invalid("server.transport must be stdio");
    }
    match server.get("command").and_then(Value::as_str) {
        Some(command) if !command.is_empty() => {}
        _ => return invalid("server.command must be a non-empty string"),
    }
    if let Some(args) = server.get("args") {
        if !is_string_array(args) {
            return invalid("server.args must be an array of strings");
        }
    }
    if let Some(cwd) = server.get("cwd") {
        if !cwd.is_string() {
            return invalid("server.cwd must be a string");
        }
    }
    Ok(())
}

fn validate_main_view(manifest: &Value, id: &str) -> Result<(), String> {
    let invalid = |detail: String| Err(format!("Invalid Remux extension {id}: {detail}"));

    let views = manifest.get("views");
    if !views.map(is_record).unwrap_or(false)
        || !views
            .and_then(|views| views.get("main"))
            .map(is_record)
            .unwrap_or(false)
    {
        return invalid("views.main must be an object".to_string());
    }

    for (view_id, view) in views.unwrap().as_object().unwrap() {
        if !is_record(view) {
            return invalid(format!("views.{view_id} must be an object"));
        }
        if let Some(route) = view.get("route") {
            if !route.as_str().map(|route| route.starts_with('/')).unwrap_or(false) {
                return invalid(format!("views.{view_id}.route must start with /"));
            }
        }
        match view.get("entry").and_then(Value::as_str) {
            Some(entry) if !entry.is_empty() => {}
            _ => return invalid(format!("views.{view_id}.entry must be a non-empty string")),
        }
        if view.get("dev").is_some() {
            return invalid(format!("views.{view_id}.dev is not supported"));
        }
    }
    Ok(())
}

fn validate_display(manifest: &Value, id: &str) -> Result<(), String> {
    let Some(display) = manifest.get("display") else {
        return Ok(());
    };
    let invalid = |detail: &str| Err(format!("Invalid Remux extension {id}: {detail}"));

    if !is_record(display) {
        return invalid("display must be an object");
    }
    if let Some(title) = display.get("title") {
        if !title
            .as_str()
            .map(|title| !title.trim().is_empty())
            .unwrap_or(false)
        {
            return invalid("display.title must be a non-empty string");
        }
    }
    validate_icon_field(id, "display.icon", display.get("icon"))?;
    validate_icon_field(id, "display.iconDark", display.get("iconDark"))?;
    if display.get("iconDark").is_some() && display.get("icon").is_none() {
        return invalid("display.iconDark requires display.icon");
    }
    Ok(())
}

fn validate_icon_field(id: &str, field: &str, value: Option<&Value>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };

    match value.as_str() {
        Some(value) if !value.is_empty() => {
            if value.to_lowercase().ends_with(".svg") {
                Err(format!(
                    "Invalid Remux extension {id}: {field} must be a raster image (png, jpg, or webp) — the app cannot render svg icons"
                ))
            } else {
                Ok(())
            }
        }
        _ => Err(format!(
            "Invalid Remux extension {id}: {field} must be a non-empty string"
        )),
    }
}

fn validate_launchers(manifest: &Value, id: &str) -> Result<(), String> {
    let Some(launchers) = manifest.get("launchers") else {
        return Ok(());
    };
    let Some(launchers) = launchers.as_array() else {
        return Err(format!(
            "Invalid Remux extension {id}: launchers must be an array"
        ));
    };

    validate_entry_point_ids(launchers, id, "launchers")?;

    for launcher in launchers {
        validate_entry_point(launcher, id, "launchers", manifest.get("views"))?;
        if let Some(route) = launcher.get("route") {
            validate_launcher_route(route, id)?;
        }
    }
    Ok(())
}

fn validate_file_handlers(manifest: &Value, id: &str) -> Result<(), String> {
    let Some(handlers) = manifest.get("fileHandlers") else {
        return Ok(());
    };
    let Some(handlers) = handlers.as_array() else {
        return Err(format!(
            "Invalid Remux extension {id}: fileHandlers must be an array"
        ));
    };

    validate_entry_point_ids(handlers, id, "fileHandlers")?;

    for handler in handlers {
        validate_entry_point(handler, id, "fileHandlers", manifest.get("views"))?;
        if let Some(extensions) = handler.get("extensions") {
            if !is_string_array(extensions) {
                return Err(format!(
                    "Invalid Remux extension {id}: fileHandlers.extensions must be an array of strings"
                ));
            }
        }
    }
    Ok(())
}

fn validate_entry_point(
    entry: &Value,
    id: &str,
    field: &str,
    views: Option<&Value>,
) -> Result<(), String> {
    let invalid = |detail: String| Err(format!("Invalid Remux extension {id}: {detail}"));

    if !is_record(entry) {
        return invalid(format!("{field} entries must be objects"));
    }
    match entry.get("id").and_then(Value::as_str) {
        Some(entry_id) if !entry_id.is_empty() => {}
        _ => return invalid(format!("{field}.id must be a non-empty string")),
    }
    if let Some(view) = entry.get("view") {
        if !view.is_string() {
            return invalid(format!("{field}.view must be a string"));
        }
    }

    let view_id = match entry.get("view").and_then(Value::as_str) {
        Some(view) if !view.is_empty() => view,
        _ => "main",
    };
    if !views
        .and_then(|views| views.get(view_id))
        .map(is_record)
        .unwrap_or(false)
    {
        return invalid(format!("{field}.view must reference an existing view"));
    }

    if let Some(label) = entry.get("label") {
        if !label
            .as_str()
            .map(|label| !label.trim().is_empty())
            .unwrap_or(false)
        {
            return invalid(format!("{field}.label must be a non-empty string"));
        }
    }

    validate_icon_field(id, &format!("{field}.icon"), entry.get("icon"))?;
    validate_icon_field(id, &format!("{field}.iconDark"), entry.get("iconDark"))?;
    if entry.get("iconDark").is_some() && entry.get("icon").is_none() {
        return invalid(format!("{field}.iconDark requires {field}.icon"));
    }
    Ok(())
}

fn validate_entry_point_ids(entries: &[Value], id: &str, field: &str) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for entry in entries {
        let Some(entry_id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !seen.insert(entry_id) {
            return Err(format!(
                "Invalid Remux extension {id}: {field}.id values must be unique"
            ));
        }
    }
    Ok(())
}

fn validate_launcher_route(route: &Value, id: &str) -> Result<(), String> {
    let invalid = |detail: &str| Err(format!("Invalid Remux extension {id}: {detail}"));

    if !is_record(route) {
        return invalid("launchers.route must be an object");
    }
    if route.get("kind").and_then(Value::as_str) != Some("launch") {
        return invalid("launchers.route.kind must be launch");
    }
    if let Some(launch) = route.get("launch") {
        if !launch.is_null() && !launch.is_string() {
            return invalid("launchers.route.launch must be a string or null");
        }
    }
    if let Some(resource_kind) = route.get("resourceKind") {
        if !resource_kind.is_null() && !resource_kind.is_string() {
            return invalid("launchers.route.resourceKind must be a string or null");
        }
    }
    Ok(())
}

fn is_record(value: &Value) -> bool {
    value.is_object()
}

fn is_string_array(value: &Value) -> bool {
    value
        .as_array()
        .map(|values| values.iter().all(Value::is_string))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assert_invalid(manifest: Value, expected: &str) {
        let err = validate_manifest(&manifest, "/tmp/bad").unwrap_err();
        assert!(err.contains(expected), "expected {expected:?} in {err:?}");
    }

    #[test]
    fn rejects_invalid_manifests() {
        assert_invalid(Value::Null, "manifest must be an object");
        assert_invalid(
            json!({ "id": "", "version": 1, "server": {}, "views": {} }),
            "id must be a non-empty string",
        );
        assert_invalid(
            json!({ "id": "bad", "views": { "main": { "entry": "index.html" } } }),
            "version must be 1",
        );
        assert_invalid(
            json!({
                "version": 1, "id": "bad",
                "server": { "transport": "http", "command": "node" },
                "views": { "main": { "entry": "index.html" } }
            }),
            "server.transport must be stdio",
        );
        assert_invalid(
            json!({
                "version": 1, "id": "bad",
                "server": { "transport": "stdio", "command": "node" },
                "views": { "main": { "route": "viewers/bad", "entry": "index.html" } }
            }),
            "views.main.route must start with /",
        );
        assert_invalid(
            json!({
                "version": 1, "id": "bad",
                "server": { "transport": "stdio", "command": "node" },
                "views": { "main": { "entry": "index.html", "dev": { "command": "npm", "url": "" } } }
            }),
            "views.main.dev is not supported",
        );
        assert_invalid(
            json!({
                "version": 1, "display": { "icon": "" }, "id": "bad",
                "server": { "transport": "stdio", "command": "node" },
                "views": { "main": { "entry": "index.html" } }
            }),
            "display.icon must be a non-empty string",
        );
        assert_invalid(
            json!({
                "version": 1, "display": { "icon": "assets/icon.svg" }, "id": "bad",
                "server": { "transport": "stdio", "command": "node" },
                "views": { "main": { "entry": "index.html" } }
            }),
            "display.icon must be a raster image",
        );
        assert_invalid(
            json!({
                "version": 1, "display": { "iconDark": "assets/icon-dark.png" }, "id": "bad",
                "server": { "transport": "stdio", "command": "node" },
                "views": { "main": { "entry": "index.html" } }
            }),
            "display.iconDark requires display.icon",
        );
        assert_invalid(
            json!({
                "version": 1, "id": "bad",
                "launchers": [
                    { "id": "go", "icon": "assets/icon.png", "iconDark": "assets/icon-dark.svg", "view": "main" }
                ],
                "server": { "transport": "stdio", "command": "node" },
                "views": { "main": { "entry": "index.html" } }
            }),
            "launchers.iconDark must be a raster image",
        );
        assert_invalid(
            json!({
                "version": 1, "id": "bad",
                "launchers": [
                    { "id": "go", "iconDark": "assets/icon-dark.png", "view": "main" }
                ],
                "server": { "transport": "stdio", "command": "node" },
                "views": { "main": { "entry": "index.html" } }
            }),
            "launchers.iconDark requires launchers.icon",
        );
        assert_invalid(
            json!({
                "version": 1, "id": "bad",
                "launchers": [
                    { "id": "dup", "view": "main" },
                    { "id": "dup", "view": "main" }
                ],
                "views": { "main": { "entry": "index.html" } }
            }),
            "launchers.id values must be unique",
        );
        assert_invalid(
            json!({
                "version": 1, "id": "bad",
                "launchers": [ { "id": "go", "view": "missing" } ],
                "views": { "main": { "entry": "index.html" } }
            }),
            "launchers.view must reference an existing view",
        );
        assert_invalid(
            json!({
                "version": 1, "id": "bad",
                "launchers": [ { "id": "go", "route": { "kind": "open" } } ],
                "views": { "main": { "entry": "index.html" } }
            }),
            "launchers.route.kind must be launch",
        );
    }

    #[test]
    fn loads_full_manifest_with_icon_pair_rules() {
        let dir = tempfile::tempdir().unwrap();
        let ext_dir = dir.path().join("extensions/codex");
        std::fs::create_dir_all(&ext_dir).unwrap();
        let manifest = json!({
            "version": 1,
            "display": {
                "icon": "assets/codex.png",
                "iconDark": "assets/codex-dark.png",
                "title": "Codex Mobile"
            },
            "id": "codex",
            "name": "Codex",
            "launchers": [
                {
                    "id": "new-chat",
                    "icon": "assets/launcher.png",
                    "label": "New Chat",
                    "route": { "kind": "launch", "launch": "new-chat", "resourceKind": "draft" },
                    "view": "main"
                }
            ],
            "fileHandlers": [
                { "id": "text", "extensions": ["md", "TXT"], "label": "Text", "view": "main" }
            ],
            "server": {
                "transport": "stdio",
                "command": "node",
                "args": ["server.cjs"],
                "cwd": "."
            },
            "views": {
                "main": { "route": "/viewers/codex/", "entry": "viewer/dist/index.html" }
            }
        });
        let manifest_path = ext_dir.join(MANIFEST_FILENAME);
        std::fs::write(&manifest_path, manifest.to_string()).unwrap();

        let extension = load_extension_manifest(&manifest_path).unwrap();

        assert_eq!(extension.id, "codex");
        assert_eq!(extension.name, "Codex");
        assert_eq!(
            extension.display,
            Display {
                icon: Some(ext_dir.join("assets/codex.png")),
                icon_dark: Some(ext_dir.join("assets/codex-dark.png")),
                title: "Codex Mobile".to_string(),
            }
        );
        let server = extension.server.as_ref().unwrap();
        assert_eq!(server.cwd, ext_dir);
        assert_eq!(server.args, vec!["server.cjs".to_string()]);
        assert_eq!(extension.main_view().route, "/viewers/codex");
        assert_eq!(
            extension.main_view().entry,
            ext_dir.join("viewer/dist/index.html")
        );
        assert_eq!(
            extension.launchers,
            vec![Launcher {
                // Own icon: display.iconDark must NOT be inherited as its dark variant.
                icon: Some(ext_dir.join("assets/launcher.png")),
                icon_dark: None,
                id: "new-chat".to_string(),
                label: "New Chat".to_string(),
                route: Some(LauncherRoute {
                    launch: Some("new-chat".to_string()),
                    resource_kind: Some("draft".to_string()),
                }),
                view: "main".to_string(),
                view_route: "/viewers/codex".to_string(),
            }]
        );
        assert_eq!(
            extension.file_handlers,
            vec![FileHandler {
                extensions: vec!["md".to_string(), "txt".to_string()],
                // No own icon: inherits the display icon/iconDark pair.
                icon: Some(ext_dir.join("assets/codex.png")),
                icon_dark: Some(ext_dir.join("assets/codex-dark.png")),
                id: "text".to_string(),
                label: "Text".to_string(),
                view: "main".to_string(),
                view_route: "/viewers/codex".to_string(),
            }]
        );
    }

    #[test]
    fn defaults_route_name_and_optional_arrays() {
        let dir = tempfile::tempdir().unwrap();
        let ext_dir = dir.path().join("extensions/files");
        std::fs::create_dir_all(&ext_dir).unwrap();
        let manifest = json!({
            "version": 1,
            "id": "files",
            "views": { "main": { "entry": "viewer/dist/index.html" } }
        });
        let manifest_path = ext_dir.join(MANIFEST_FILENAME);
        std::fs::write(&manifest_path, manifest.to_string()).unwrap();

        let extension = load_extension_manifest(&manifest_path).unwrap();
        assert_eq!(extension.name, "files");
        assert_eq!(
            extension.display,
            Display {
                icon: None,
                icon_dark: None,
                title: "files".to_string()
            }
        );
        assert_eq!(extension.main_view().route, "/viewers/files");
        assert_eq!(extension.server, None);
        assert!(extension.launchers.is_empty());
        assert!(extension.file_handlers.is_empty());
    }

    #[test]
    fn launcher_label_falls_back_to_display_title_then_id() {
        let dir = tempfile::tempdir().unwrap();
        let ext_dir = dir.path().join("extensions/x");
        std::fs::create_dir_all(&ext_dir).unwrap();
        let manifest = json!({
            "version": 1,
            "id": "x",
            "display": { "title": "Xtension" },
            "launchers": [ { "id": "go" } ],
            "views": { "main": { "entry": "index.html" } }
        });
        let manifest_path = ext_dir.join(MANIFEST_FILENAME);
        std::fs::write(&manifest_path, manifest.to_string()).unwrap();

        let extension = load_extension_manifest(&manifest_path).unwrap();
        assert_eq!(extension.launchers[0].label, "Xtension");
        assert_eq!(extension.launchers[0].route, None);
    }
}

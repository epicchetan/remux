//! Pass-3a bearer-token auth (spec `docs/specs/cli-rust-port-pass-3-auth.md`):
//! token lifecycle for `.remux/auth-token` and the axum middleware guarding
//! the `/ws` upgrade plus the whole HTTP fallback tree.
//!
//! The token defends against the firewall-slip scenario only — transport
//! encryption stays with WireGuard, and on-box attackers can read the token
//! file. Health endpoints stay open so a locked-out client can distinguish
//! "server down" from "unauthorized".

use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::Arc;

use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::Response;

use crate::rpc::ws::WsLog;

pub const TOKEN_RELATIVE_PATH: &str = ".remux/auth-token";
pub const AUTH_COOKIE: &str = "remux_auth";
const TOKEN_BYTES: usize = 32;
/// Health trio stays unauthenticated (same exact-match set as the HTTP
/// handler): liveness only, and it lets probes and locked-out clients work.
const EXEMPT_PATHS: [&str; 3] = ["/readyz", "/healthz", "/health"];

pub struct AuthState {
    pub token: String,
    pub require_auth: bool,
    pub log: Arc<dyn WsLog>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenLoad {
    pub token: String,
    /// A fresh token was generated and persisted this call.
    pub generated: bool,
    /// The existing token file had group/other bits and was chmodded to 0600.
    pub perms_tightened: bool,
}

/// Resolution order (mirrors `load_runtime_values`' env-over-config shape):
/// `REMUX_AUTH_TOKEN` (non-empty, trimmed) over `.remux/auth-token` over
/// generate-and-persist.
pub fn resolve_token(env_token: Option<&str>, root_dir: &Path) -> Result<TokenLoad, String> {
    if let Some(token) = env_token {
        let token = token.trim();
        if !token.is_empty() {
            return Ok(TokenLoad {
                token: token.to_string(),
                generated: false,
                perms_tightened: false,
            });
        }
    }
    load_or_generate_token(root_dir)
}

fn load_or_generate_token(root_dir: &Path) -> Result<TokenLoad, String> {
    let path = root_dir.join(TOKEN_RELATIVE_PATH);
    match std::fs::read_to_string(&path) {
        Ok(source) => {
            let token = source.trim().to_string();
            if token.is_empty() {
                // An empty file is treated as absent rather than as a valid
                // (guessable) empty credential.
                return generate_and_persist(&path);
            }
            let perms_tightened = tighten_permissions(&path)?;
            Ok(TokenLoad {
                token,
                generated: false,
                perms_tightened,
            })
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => generate_and_persist(&path),
        Err(err) => Err(format!("{}: {err}", path.display())),
    }
}

fn generate_and_persist(path: &Path) -> Result<TokenLoad, String> {
    let token = generate_token()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("{}: {err}", parent.display()))?;
    }
    // Atomic temp + rename (the runstate.rs pattern) with 0600 from birth so
    // the token is never observable mid-write or group/other-readable.
    let temp = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|err| format!("{}: {err}", temp.display()))?;
    file.write_all(token.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|err| format!("{}: {err}", temp.display()))?;
    drop(file);
    std::fs::rename(&temp, path).map_err(|err| format!("{}: {err}", path.display()))?;
    Ok(TokenLoad {
        token,
        generated: true,
        perms_tightened: false,
    })
}

/// 32 bytes of `/dev/urandom` as 64 lowercase hex chars. std-only and
/// Linux-only, matching the runtime's platform.
fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|err| format!("failed to read /dev/urandom: {err}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn tighten_permissions(path: &Path) -> Result<bool, String> {
    let metadata = std::fs::metadata(path).map_err(|err| format!("{}: {err}", path.display()))?;
    let mode = metadata.permissions().mode();
    if mode & 0o077 == 0 {
        return Ok(false);
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|err| format!("{}: {err}", path.display()))?;
    Ok(true)
}

/// `remux token`: print the resolved token, generating it if absent — the
/// device-pairing story, and the rollout's answer to "the file doesn't exist
/// until auth-aware code first runs".
pub fn token_command(root_dir: &Path) -> Result<String, String> {
    let load = resolve_token(std::env::var("REMUX_AUTH_TOKEN").ok().as_deref(), root_dir)?;
    Ok(load.token)
}

/// Byte-wise XOR fold; runtime independent of where strings differ. Length is
/// not secret, so a length mismatch rejects immediately.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TokenSource {
    Header,
    Cookie,
    Query,
}

/// First present candidate wins — a request carrying a bad header plus a good
/// cookie is rejected rather than given extra guesses.
fn candidate_token(headers: &HeaderMap, query: &str) -> Option<(String, TokenSource)> {
    if let Some(value) = headers.get(header::AUTHORIZATION) {
        let token = value
            .to_str()
            .ok()
            .and_then(|value| value.strip_prefix("Bearer "))
            .unwrap_or("");
        return Some((token.trim().to_string(), TokenSource::Header));
    }
    if let Some(token) = cookie_token(headers) {
        return Some((token, TokenSource::Cookie));
    }
    for pair in query.split('&') {
        if let Some(token) = pair.strip_prefix("token=") {
            return Some((token.to_string(), TokenSource::Query));
        }
    }
    None
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    cookies.split(';').find_map(|cookie| {
        cookie
            .trim()
            .strip_prefix(AUTH_COOKIE)?
            .strip_prefix('=')
            .map(|token| token.to_string())
    })
}

/// The single auth choke point, layered over the merged `/ws` + HTTP router
/// in `run_worker`. Header-authenticated responses get the `Set-Cookie`
/// hand-off so WebView subresources (which cannot carry custom headers) ride
/// the cookie on every later same-origin request.
pub async fn require_auth(
    State(auth): State<Arc<AuthState>>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if !auth.require_auth || EXEMPT_PATHS.contains(&request.uri().path()) {
        return next.run(request).await;
    }

    let query = request.uri().query().unwrap_or("");
    let candidate = candidate_token(request.headers(), query);
    let authorized = candidate
        .as_ref()
        .map(|(token, _)| constant_time_eq(token, &auth.token))
        .unwrap_or(false);
    if !authorized {
        let remote = request
            .extensions()
            .get::<ConnectInfo<std::net::SocketAddr>>()
            .map(|info| info.0.ip().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        // IP and path only — the token (wrong or right) never hits the journal.
        auth.log
            .warn(&format!("auth rejected {remote} {}", request.uri().path()));
        return unauthorized_response();
    }

    let via_header = matches!(candidate, Some((_, TokenSource::Header)));
    let has_valid_cookie = cookie_token(request.headers())
        .map(|token| constant_time_eq(&token, &auth.token))
        .unwrap_or(false);

    let mut response = next.run(request).await;
    if via_header && !has_valid_cookie {
        // No `Secure` attribute: transport is plain HTTP inside WireGuard.
        let cookie = format!(
            "{AUTH_COOKIE}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000",
            auth.token
        );
        if let Ok(value) = header::HeaderValue::from_str(&cookie) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
    response
}

fn unauthorized_response() -> Response {
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header(header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(r#"{"error":"unauthorized"}"#))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header_map(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                header::HeaderValue::from_str(value).unwrap(),
            );
        }
        headers
    }

    #[test]
    fn generates_persists_and_reloads_a_hex_token() {
        let root = tempfile::tempdir().unwrap();
        let first = resolve_token(None, root.path()).unwrap();
        assert!(first.generated);
        assert_eq!(first.token.len(), 64);
        assert!(first
            .token
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));

        let path = root.path().join(TOKEN_RELATIVE_PATH);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "token file must be 0600");

        let second = resolve_token(None, root.path()).unwrap();
        assert!(!second.generated);
        assert_eq!(second.token, first.token);
    }

    #[test]
    fn env_token_wins_and_empty_env_falls_through() {
        let root = tempfile::tempdir().unwrap();
        let load = resolve_token(Some("  from-env  "), root.path()).unwrap();
        assert_eq!(load.token, "from-env");
        assert!(!load.generated, "env token must not touch the file");
        assert!(!root.path().join(TOKEN_RELATIVE_PATH).exists());

        let load = resolve_token(Some(""), root.path()).unwrap();
        assert!(load.generated, "empty env falls through to generation");
    }

    #[test]
    fn empty_file_regenerates_and_loose_perms_tighten() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(TOKEN_RELATIVE_PATH);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "\n").unwrap();
        let load = resolve_token(None, root.path()).unwrap();
        assert!(load.generated, "empty token file is treated as absent");

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let load = resolve_token(None, root.path()).unwrap();
        assert!(load.perms_tightened);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);

        let load = resolve_token(None, root.path()).unwrap();
        assert!(!load.perms_tightened, "already-0600 file is left alone");
    }

    #[test]
    fn constant_time_eq_matrix() {
        assert!(constant_time_eq("abc123", "abc123"));
        assert!(!constant_time_eq("abc123", "abc124"));
        assert!(!constant_time_eq("abc123", "abc12"));
        assert!(!constant_time_eq("", "x"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn extraction_order_is_header_cookie_query_first_present_wins() {
        let headers = header_map(&[
            ("authorization", "Bearer from-header"),
            ("cookie", "remux_auth=from-cookie"),
        ]);
        assert_eq!(
            candidate_token(&headers, "token=from-query"),
            Some(("from-header".to_string(), TokenSource::Header))
        );

        let headers = header_map(&[("cookie", "a=b; remux_auth=from-cookie; c=d")]);
        assert_eq!(
            candidate_token(&headers, "token=from-query"),
            Some(("from-cookie".to_string(), TokenSource::Cookie))
        );

        let headers = header_map(&[]);
        assert_eq!(
            candidate_token(&headers, "x=1&token=from-query"),
            Some(("from-query".to_string(), TokenSource::Query))
        );
        assert_eq!(candidate_token(&headers, ""), None);

        // A malformed Authorization header is a (failing) candidate, not a
        // fall-through to weaker sources.
        let headers = header_map(&[
            ("authorization", "Basic nope"),
            ("cookie", "remux_auth=valid"),
        ]);
        assert_eq!(
            candidate_token(&headers, ""),
            Some((String::new(), TokenSource::Header))
        );
    }
}

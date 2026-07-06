//! HTTP surface, ported endpoint-for-endpoint from `cli/httpServer.cjs` +
//! `cli/viewerProvider.cjs`. Dispatch order matches the Node handler: health →
//! catalog → icon → root redirect → viewer providers → 404.

pub mod catalog;
pub mod icons;
pub mod viewers;

use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, StatusCode, Uri};
use axum::response::Response;

use crate::extensions::manifest::ExtensionManifest;
use viewers::ViewerProvider;

pub struct HttpState {
    pub default_extension: ExtensionManifest,
    pub extensions: Vec<ExtensionManifest>,
    pub viewer_providers: Vec<ViewerProvider>,
}

pub fn build_router(state: Arc<HttpState>) -> axum::Router {
    axum::Router::new().fallback(handle_request).with_state(state)
}

async fn handle_request(State(state): State<Arc<HttpState>>, uri: Uri) -> Response {
    // Node compared `request.url` (path + query) exactly for these two.
    let raw_url = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or_else(|| uri.path());
    let pathname = uri.path();
    let query = uri.query().unwrap_or("");

    if raw_url == "/readyz" || raw_url == "/healthz" || raw_url == "/health" {
        return json_response(serde_json::json!({
            "ok": true,
            "defaultExtension": state.default_extension.id,
            "service": "remux",
        }));
    }

    if pathname == "/remux/extensions" {
        return json_response(catalog::extension_catalog(
            Some(&state.default_extension),
            &state.extensions,
        ));
    }

    if let Some(icon_path) = icons::icon_for_icon_path(pathname, query, &state.extensions) {
        return icons::serve_extension_icon(&icon_path).await;
    }

    if raw_url == "/" || raw_url.is_empty() {
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(
                header::LOCATION,
                format!("{}/", state.default_extension.main_view().route),
            )
            .body(Body::empty())
            .expect("static response");
    }

    for provider in &state.viewer_providers {
        if let Some(response) = provider.handle(pathname).await {
            return response;
        }
    }

    text_response(StatusCode::NOT_FOUND, "Not found.")
}

pub(crate) fn json_response(value: serde_json::Value) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(value.to_string()))
        .expect("static response")
}

pub(crate) fn text_response(status: StatusCode, body: &'static str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Body::from(body))
        .expect("static response")
}

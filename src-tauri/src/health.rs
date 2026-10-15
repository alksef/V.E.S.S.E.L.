use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use serde_json::json;
use std::sync::Arc;

use crate::service::DomainService;
use crate::types::HealthResponse;

pub async fn health_handler(State(service): State<Arc<DomainService>>) -> Json<HealthResponse> {
    let (connected, ready, active) = service.get_health_stats();
    Json(HealthResponse {
        service: "VESSEL",
        version: "0.1.0",
        status: "online",
        renderer_connected: connected,
        model_ready: ready,
        active_command_count: active,
    })
}

pub async fn not_found_handler() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "error": "not_found",
            "message": "Endpoint not found. VESSEL provides /mcp (Streamable HTTP), /ws/avatar (WebSocket), and /health."
        })),
    )
        .into_response()
}

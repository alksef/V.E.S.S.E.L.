use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use std::sync::Arc;

use crate::service::{ActionDispatchError, DomainService};
use crate::types::{AvatarState, FramingPreset};

pub fn check_origin_security(headers: &HeaderMap) -> bool {
    if let Some(origin_val) = headers.get(header::ORIGIN) {
        if let Ok(origin) = origin_val.to_str() {
            let o = origin.to_lowercase();
            // Allow localhost, 127.0.0.1, tauri, null/native origins
            if o.contains("localhost")
                || o.contains("127.0.0.1")
                || o.starts_with("tauri://")
                || o == "null"
            {
                return true;
            }
            return false;
        }
    }
    // Native clients like OpenCode/curl don't send Origin header -> permitted on loopback
    true
}

pub fn check_auth(headers: &HeaderMap, service: &DomainService) -> bool {
    let auth_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|val| val.strip_prefix("Bearer "));
    service.verify_token(auth_header)
}

fn mcp_tools_catalog() -> Value {
    json!([
        {
            "name": "vessel_set_emotion",
            "description": "Sets the avatar's facial expression and intensity.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "emotion": {
                        "type": "string",
                        "enum": ["neutral", "happy", "angry", "sorrow", "sad", "surprised", "relaxed"],
                        "description": "The emotion to display on the avatar's face."
                    },
                    "intensity": {
                        "type": "number",
                        "minimum": 0.0,
                        "maximum": 1.0,
                        "default": 1.0,
                        "description": "Expression intensity from 0.0 to 1.0."
                    }
                },
                "required": ["emotion"]
            }
        },
        {
            "name": "vessel_play_gesture",
            "description": "Triggers a physical body or head gesture on the avatar. Asynchronous: returns accepted with a command_id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "gesture": {
                        "type": "string",
                        "enum": ["nod", "shake_head", "wave", "tilt_head", "shrug"],
                        "description": "The gesture to perform."
                    }
                },
                "required": ["gesture"]
            }
        },
        {
            "name": "vessel_set_state",
            "description": "Updates the conversational lifecycle state of the companion (idle, listening, thinking, speaking).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "state": {
                        "type": "string",
                        "enum": ["idle", "listening", "thinking", "speaking"],
                        "description": "The avatar conversational state."
                    }
                },
                "required": ["state"]
            }
        },
        {
            "name": "vessel_look_at",
            "description": "Directs the avatar's gaze toward the user, away, or a custom 2D screen coordinate.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": {
                        "type": "string",
                        "enum": ["user", "away", "custom"],
                        "description": "'user' looks straight at viewer, 'away' looks off-screen, 'custom' takes x/y coordinates."
                    },
                    "x": {
                        "type": "number",
                        "minimum": -1.0,
                        "maximum": 1.0,
                        "description": "Horizontal gaze coordinate [-1.0 left, 1.0 right]."
                    },
                    "y": {
                        "type": "number",
                        "minimum": -1.0,
                        "maximum": 1.0,
                        "description": "Vertical gaze coordinate [-1.0 down, 1.0 up]."
                    }
                },
                "required": ["target"]
            }
        },
        {
            "name": "vessel_set_framing",
            "description": "Adjusts the camera shot framing/size on the avatar (face, bust, half_body, full_body).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "preset": {
                        "type": "string",
                        "enum": ["face", "bust", "half_body", "full_body"],
                        "description": "Camera framing shot size: 'face', 'bust', 'half_body', 'full_body'."
                    }
                },
                "required": ["preset"]
            }
        },
        {
            "name": "vessel_speak",
            "description": "Plays spoken audio on the avatar overlay with real-time lip synchronization. Asynchronous: returns accepted with a command_id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "audio_url": {
                        "type": "string",
                        "description": "HTTP/HTTPS URL to an audio file (mp3, wav, ogg)."
                    },
                    "audio_base64": {
                        "type": "string",
                        "description": "Base64 data URI of the audio content."
                    },
                    "text": {
                        "type": "string",
                        "description": "Transcription or text phrase being spoken."
                    },
                    "emotion": {
                        "type": "string",
                        "enum": ["neutral", "happy", "angry", "sorrow", "sad", "surprised", "relaxed"],
                        "description": "Facial expression to maintain while speaking."
                    }
                }
            }
        },
        {
            "name": "vessel_get_action_status",
            "description": "Queries the execution status of an asynchronous action (gesture or speak) by its command_id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command_id": {
                        "type": "string",
                        "description": "The unique command_id returned by vessel_play_gesture or vessel_speak."
                    }
                },
                "required": ["command_id"]
            }
        },
        {
            "name": "vessel_get_status",
            "description": "Queries overall service health, renderer connectivity, model readiness, and current desired state.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }
    ])
}

pub async fn mcp_get_handler(
    headers: HeaderMap,
    State(service): State<Arc<DomainService>>,
) -> Response {
    if !check_origin_security(&headers) {
        return (StatusCode::FORBIDDEN, "Forbidden Origin").into_response();
    }
    if !check_auth(&headers, &service) {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
            "Unauthorized",
        )
            .into_response();
    }

    let accept = headers
        .get(header::ACCEPT)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");

    if accept.contains("text/event-stream") {
        // SSE endpoint as defined in MCP Streamable HTTP transport
        let body = Body::from("event: endpoint\ndata: /mcp\n\n");
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(body)
            .unwrap()
    } else {
        let resp = json!({
            "service": "VESSEL",
            "version": "0.1.0",
            "mcp_endpoint": "/mcp",
            "protocol": "Streamable HTTP"
        });
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(resp.to_string()))
            .unwrap()
    }
}

pub async fn mcp_post_handler(
    headers: HeaderMap,
    State(service): State<Arc<DomainService>>,
    body_str: String,
) -> Response {
    if !check_origin_security(&headers) {
        return (StatusCode::FORBIDDEN, "Forbidden Origin").into_response();
    }
    if !check_auth(&headers, &service) {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
            "Unauthorized",
        )
            .into_response();
    }

    let parsed: Value = match serde_json::from_str(&body_str) {
        Ok(v) => v,
        Err(_) => {
            let err_resp = json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": -32700, "message": "Parse error" }
            });
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(err_resp.to_string()))
                .unwrap();
        }
    };

    if !parsed.is_object() {
        let err_resp = json!({
            "jsonrpc": "2.0",
            "id": Value::Null,
            "error": { "code": -32600, "message": "Invalid Request: must be a JSON object" }
        });
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(err_resp.to_string()))
            .unwrap();
    }

    let id = parsed.get("id").cloned().unwrap_or(Value::Null);
    let method = match parsed.get("method").and_then(|m| m.as_str()) {
        Some(m) => m,
        None => {
            let err_resp = json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32600, "message": "Invalid Request: method string missing" }
            });
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(err_resp.to_string()))
                .unwrap();
        }
    };

    match method {
        "initialize" => {
            let resp = json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": {
                        "name": "vessel",
                        "version": "0.1.0"
                    }
                }
            });
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(resp.to_string()))
                .unwrap()
        }
        "notifications/initialized" => StatusCode::NO_CONTENT.into_response(),
        "tools/list" => {
            let resp = json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "tools": mcp_tools_catalog()
                }
            });
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(resp.to_string()))
                .unwrap()
        }
        "tools/call" => {
            let params = parsed.get("params").and_then(|p| p.as_object());
            let name = params
                .and_then(|p| p.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("");
            let args = params
                .and_then(|p| p.get("arguments"))
                .and_then(|a| a.as_object());

            let result_content = match name {
                "vessel_set_emotion" => {
                    let emotion = args
                        .and_then(|a| a.get("emotion"))
                        .and_then(|e| e.as_str())
                        .unwrap_or("neutral")
                        .to_string();
                    let intensity = args
                        .and_then(|a| a.get("intensity"))
                        .and_then(|i| i.as_f64())
                        .map(|f| f as f32)
                        .unwrap_or(1.0);
                    service.set_emotion(emotion.clone(), intensity);
                    Ok(
                        json!({ "status": "ok", "action": "set_emotion", "emotion": emotion, "intensity": intensity }),
                    )
                }
                "vessel_set_state" => {
                    let st = args
                        .and_then(|a| a.get("state"))
                        .and_then(|s| s.as_str())
                        .unwrap_or("idle");
                    let state_enum = match st {
                        "listening" => AvatarState::Listening,
                        "thinking" => AvatarState::Thinking,
                        "speaking" => AvatarState::Speaking,
                        _ => AvatarState::Idle,
                    };
                    service.set_state(state_enum);
                    Ok(json!({ "status": "ok", "action": "set_state", "state": st }))
                }
                "vessel_look_at" => {
                    let target = args
                        .and_then(|a| a.get("target"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("user");
                    let (x, y) = match target {
                        "away" => (0.45, 0.5),
                        "custom" => {
                            let cx = args
                                .and_then(|a| a.get("x"))
                                .and_then(|v| v.as_f64())
                                .map(|f| f as f32)
                                .unwrap_or(0.0);
                            let cy = args
                                .and_then(|a| a.get("y"))
                                .and_then(|v| v.as_f64())
                                .map(|f| f as f32)
                                .unwrap_or(0.0);
                            (cx, cy)
                        }
                        _ => (0.0, 0.1), // user default
                    };
                    service.set_gaze(x, y);
                    Ok(
                        json!({ "status": "ok", "action": "look_at", "target": target, "x": x, "y": y }),
                    )
                }
                "vessel_set_framing" => {
                    let preset_str = args
                        .and_then(|a| a.get("preset"))
                        .and_then(|p| p.as_str())
                        .unwrap_or("bust");
                    let preset = match preset_str {
                        "face" => FramingPreset::Face,
                        "half_body" => FramingPreset::HalfBody,
                        "full_body" => FramingPreset::FullBody,
                        _ => FramingPreset::Bust,
                    };
                    service.set_framing(preset);
                    Ok(json!({ "status": "ok", "action": "set_framing", "preset": preset_str }))
                }
                "vessel_play_gesture" => {
                    let gesture = args
                        .and_then(|a| a.get("gesture"))
                        .and_then(|g| g.as_str())
                        .unwrap_or("nod")
                        .to_string();
                    match service.dispatch_gesture(gesture.clone()) {
                        Ok(cmd_id) => Ok(json!({
                            "status": "accepted",
                            "action": "play_gesture",
                            "gesture": gesture,
                            "command_id": cmd_id
                        })),
                        Err(e) => Err(e),
                    }
                }
                "vessel_speak" => {
                    let audio_url = args
                        .and_then(|a| a.get("audio_url"))
                        .and_then(|u| u.as_str())
                        .map(|s| s.to_string());
                    let audio_base64 = args
                        .and_then(|a| a.get("audio_base64"))
                        .and_then(|b| b.as_str())
                        .map(|s| s.to_string());
                    let text = args
                        .and_then(|a| a.get("text"))
                        .and_then(|t| t.as_str())
                        .map(|s| s.to_string());
                    let emotion = args
                        .and_then(|a| a.get("emotion"))
                        .and_then(|e| e.as_str())
                        .map(|s| s.to_string());

                    match service.dispatch_speak(audio_url, audio_base64, text, emotion) {
                        Ok(cmd_id) => Ok(json!({
                            "status": "accepted",
                            "action": "speak",
                            "command_id": cmd_id
                        })),
                        Err(e) => Err(e),
                    }
                }
                "vessel_get_action_status" => {
                    let cmd_id = args
                        .and_then(|a| a.get("command_id"))
                        .and_then(|c| c.as_str())
                        .unwrap_or("");
                    let record = service.get_action_status(cmd_id);
                    Ok(json!({
                        "command_id": record.command_id,
                        "action": record.action,
                        "status": record.status,
                        "error": record.error,
                        "created_at_ms": record.created_at_ms,
                        "finished_at_ms": record.finished_at_ms,
                    }))
                }
                "vessel_get_status" => {
                    let (connected, ready, active) = service.get_health_stats();
                    let desired = service.get_desired_state();
                    Ok(json!({
                        "service": "VESSEL",
                        "status": "online",
                        "renderer_connected": connected,
                        "model_ready": ready,
                        "active_command_count": active,
                        "desired_state": desired,
                    }))
                }
                _ => {
                    let err_resp = json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32601, "message": format!("Unknown tool '{name}'") }
                    });
                    return Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(err_resp.to_string()))
                        .unwrap();
                }
            };

            match result_content {
                Ok(content_json) => {
                    let resp = json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [
                                {
                                    "type": "text",
                                    "text": content_json.to_string()
                                }
                            ]
                        }
                    });
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(resp.to_string()))
                        .unwrap()
                }
                Err(ActionDispatchError::RendererNotReady) => {
                    let resp = json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "isError": true,
                            "content": [
                                {
                                    "type": "text",
                                    "text": json!({
                                        "status": "rejected",
                                        "error": "renderer_not_ready",
                                        "message": "Avatar renderer is not connected or model is not loaded yet"
                                    }).to_string()
                                }
                            ]
                        }
                    });
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(resp.to_string()))
                        .unwrap()
                }
                Err(ActionDispatchError::InvalidArguments(msg)) => {
                    let resp = json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32602, "message": msg }
                    });
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(resp.to_string()))
                        .unwrap()
                }
            }
        }
        _ => {
            let err_resp = json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method '{method}' not found") }
            });
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(err_resp.to_string()))
                .unwrap()
        }
    }
}

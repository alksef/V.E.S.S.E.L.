use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::mcp_server::{check_auth, check_origin_security};
use crate::service::DomainService;
use crate::types::{ActionTerminalStatus, ActionType, AvatarState, FramingPreset};

pub async fn ws_avatar_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(service): State<Arc<DomainService>>,
) -> Response {
    if !check_origin_security(&headers) {
        return (StatusCode::FORBIDDEN, "Forbidden Origin").into_response();
    }
    if !check_auth(&headers, &service) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    ws.on_upgrade(move |socket| handle_socket(socket, service))
}

async fn handle_socket(socket: WebSocket, service: Arc<DomainService>) {
    let (mut ws_sink, mut ws_stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let mut is_renderer = false;
    let mut is_producer = false;
    let mut renderer_gen = 0u64;
    let mut action_sub_task: Option<tokio::task::JoinHandle<()>> = None;

    // Background task to send outgoing messages to this websocket client
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sink.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(msg_result) = ws_stream.next().await {
        let msg = match msg_result {
            Ok(m) => m,
            Err(_) => break,
        };

        match msg {
            Message::Text(text) => {
                let trimmed = text.trim();
                if trimmed == "ping" {
                    let _ = tx.send("pong".to_string());
                    continue;
                }

                let parsed: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(_) => continue, // Ignore malformed frames without crashing
                };

                let msg_type = parsed
                    .get("type")
                    .or_else(|| parsed.get("event_type"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("");

                match msg_type {
                    "register" => {
                        let role = parsed.get("role").and_then(|r| r.as_str()).unwrap_or("");
                        if role == "renderer" {
                            is_renderer = true;
                            renderer_gen = service.register_renderer(tx.clone());
                        } else if role == "producer" {
                            is_producer = true;
                            let (connected, ready, _) = service.get_health_stats();
                            let desired = service.get_desired_state();

                            // Send hello back to producer
                            let hello = serde_json::json!({
                                "type": "hello",
                                "protocol_version": "v1",
                                "capabilities": ["state", "expression", "gaze", "framing", "gesture", "speak", "stop"],
                                "renderer_connected": connected,
                                "model_ready": ready,
                                "snapshot": {
                                    "state": desired.state,
                                    "expression": desired.expression,
                                    "gaze": desired.gaze,
                                    "framing": desired.framing,
                                }
                            });
                            let _ = tx.send(hello.to_string());

                            // Subscribe to action events and forward to producer
                            let mut action_rx = service.subscribe_actions();
                            let producer_tx = tx.clone();
                            action_sub_task = Some(tokio::spawn(async move {
                                while let Ok(ev) = action_rx.recv().await {
                                    let msg = match ev.status {
                                        ActionTerminalStatus::PlaybackStarted => serde_json::json!({
                                            "type": "playback_started",
                                            "command_id": ev.command_id,
                                            "action": ev.action,
                                        }),
                                        ActionTerminalStatus::Completed
                                        | ActionTerminalStatus::Cancelled
                                        | ActionTerminalStatus::Failed => serde_json::json!({
                                            "type": "action_result",
                                            "command_id": ev.command_id,
                                            "action": ev.action,
                                            "status": ev.status,
                                            "error": ev.error,
                                        }),
                                        _ => continue,
                                    };
                                    if producer_tx.send(msg.to_string()).is_err() {
                                        break;
                                    }
                                }
                            }));
                        }
                    }
                    "ready" => {
                        if !is_renderer {
                            is_renderer = true;
                            renderer_gen = service.register_renderer(tx.clone());
                        }
                        let model = parsed
                            .get("model")
                            .and_then(|m| m.as_str())
                            .unwrap_or("default")
                            .to_string();
                        service.handle_renderer_ready(model);
                    }
                    "playback_started" => {
                        if is_renderer {
                            let cmd_id = parsed
                                .get("command_id")
                                .and_then(|c| c.as_str())
                                .unwrap_or("");
                            service.handle_playback_started(cmd_id, ActionType::Speak);
                        }
                    }
                    "action_result" => {
                        if is_renderer {
                            let cmd_id = parsed
                                .get("command_id")
                                .and_then(|c| c.as_str())
                                .unwrap_or("");
                            let action =
                                parsed.get("action").and_then(|a| a.as_str()).unwrap_or("");
                            let status_str = parsed
                                .get("status")
                                .and_then(|s| s.as_str())
                                .unwrap_or("completed");
                            let error = parsed
                                .get("error")
                                .and_then(|e| e.as_str())
                                .map(|s| s.to_string());

                            let status = match status_str {
                                "cancelled" => ActionTerminalStatus::Cancelled,
                                "failed" => ActionTerminalStatus::Failed,
                                _ => ActionTerminalStatus::Completed,
                            };
                            service.handle_action_result(cmd_id, action, status, error);
                        }
                    }
                    "state" => {
                        let state_str = parsed
                            .get("state")
                            .and_then(|s| s.as_str())
                            .unwrap_or("idle");
                        let state = match state_str {
                            "listening" => AvatarState::Listening,
                            "thinking" => AvatarState::Thinking,
                            "speaking" => AvatarState::Speaking,
                            _ => AvatarState::Idle,
                        };
                        service.set_state(state);
                        if is_producer {
                            let _ = tx.send(
                                serde_json::json!({ "type": "acknowledged", "action": "state" })
                                    .to_string(),
                            );
                        }
                    }
                    "expression" => {
                        let name = parsed
                            .get("name")
                            .or_else(|| parsed.get("emotion"))
                            .and_then(|n| n.as_str())
                            .unwrap_or("neutral")
                            .to_string();
                        let intensity = parsed
                            .get("intensity")
                            .and_then(|i| i.as_f64())
                            .map(|f| f as f32)
                            .unwrap_or(1.0);
                        service.set_emotion(name, intensity);
                        if is_producer {
                            let _ = tx.send(
                                serde_json::json!({ "type": "acknowledged", "action": "expression" })
                                    .to_string(),
                            );
                        }
                    }
                    "framing" => {
                        let preset_str = parsed
                            .get("preset")
                            .and_then(|p| p.as_str())
                            .unwrap_or("bust");
                        let preset = match preset_str {
                            "face" => FramingPreset::Face,
                            "half_body" => FramingPreset::HalfBody,
                            "full_body" => FramingPreset::FullBody,
                            _ => FramingPreset::Bust,
                        };
                        service.set_framing(preset);
                        if is_producer {
                            let _ = tx.send(
                                serde_json::json!({ "type": "acknowledged", "action": "framing" })
                                    .to_string(),
                            );
                        }
                    }
                    "gaze" => {
                        let persistent = parsed
                            .get("persistent")
                            .and_then(|p| p.as_bool())
                            .unwrap_or(false);
                        if persistent {
                            let x = parsed
                                .get("x")
                                .and_then(|v| v.as_f64())
                                .map(|f| f as f32)
                                .unwrap_or(0.0);
                            let y = parsed
                                .get("y")
                                .and_then(|v| v.as_f64())
                                .map(|f| f as f32)
                                .unwrap_or(0.0);
                            service.set_gaze(x, y);
                        } else if !is_renderer {
                            service.forward_to_renderer(trimmed);
                        }
                    }
                    "lipsync" => {
                        if !is_renderer {
                            service.forward_to_renderer(trimmed);
                        }
                    }
                    "gesture" => {
                        let name = parsed
                            .get("name")
                            .or_else(|| parsed.get("gesture"))
                            .and_then(|n| n.as_str())
                            .unwrap_or("")
                            .to_string();
                        let cmd_id_opt = parsed
                            .get("command_id")
                            .and_then(|c| c.as_str())
                            .map(|s| s.to_string());

                        match service.dispatch_gesture_with_id(cmd_id_opt.clone(), name) {
                            Ok(cmd_id) => {
                                let _ = tx.send(
                                    serde_json::json!({
                                        "type": "accepted",
                                        "command_id": cmd_id,
                                        "action": "gesture"
                                    })
                                    .to_string(),
                                );
                            }
                            Err(err) => {
                                let _ = tx.send(
                                    serde_json::json!({
                                        "type": "rejected",
                                        "command_id": cmd_id_opt.unwrap_or_default(),
                                        "action": "gesture",
                                        "error": err.to_string()
                                    })
                                    .to_string(),
                                );
                            }
                        }
                    }
                    "speak" => {
                        let cmd_id_opt = parsed
                            .get("command_id")
                            .and_then(|c| c.as_str())
                            .map(|s| s.to_string());
                        let audio_url = parsed
                            .get("audio_url")
                            .and_then(|u| u.as_str())
                            .map(|s| s.to_string());
                        let audio_base64 = parsed
                            .get("audio_base64")
                            .and_then(|b| b.as_str())
                            .map(|s| s.to_string());
                        let text = parsed
                            .get("text")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string());
                        let emotion = parsed
                            .get("emotion")
                            .and_then(|e| e.as_str())
                            .map(|s| s.to_string());

                        match service.dispatch_speak_with_id(
                            cmd_id_opt.clone(),
                            audio_url,
                            audio_base64,
                            text,
                            emotion,
                        ) {
                            Ok(cmd_id) => {
                                let _ = tx.send(
                                    serde_json::json!({
                                        "type": "accepted",
                                        "command_id": cmd_id,
                                        "action": "speak"
                                    })
                                    .to_string(),
                                );
                            }
                            Err(err) => {
                                let _ = tx.send(
                                    serde_json::json!({
                                        "type": "rejected",
                                        "command_id": cmd_id_opt.unwrap_or_default(),
                                        "action": "speak",
                                        "error": err.to_string()
                                    })
                                    .to_string(),
                                );
                            }
                        }
                    }
                    "stop_speak" => {
                        let cmd_id = parsed.get("command_id").and_then(|c| c.as_str());
                        service.stop_speak(cmd_id);
                        let _ = tx.send(
                            serde_json::json!({
                                "type": "stopped",
                                "action": "speak",
                                "command_id": cmd_id,
                            })
                            .to_string(),
                        );
                    }
                    "stop_gesture" => {
                        let cmd_id = parsed.get("command_id").and_then(|c| c.as_str());
                        service.stop_gesture(cmd_id);
                        let _ = tx.send(
                            serde_json::json!({
                                "type": "stopped",
                                "action": "gesture",
                                "command_id": cmd_id,
                            })
                            .to_string(),
                        );
                    }
                    "stop" => {
                        service.stop_speak(None);
                        service.stop_gesture(None);
                        let _ = tx.send(
                            serde_json::json!({
                                "type": "stopped",
                                "action": "all",
                            })
                            .to_string(),
                        );
                    }
                    "ping" => {
                        let _ = tx.send(serde_json::json!({ "type": "pong" }).to_string());
                    }
                    _ => {
                        if is_producer {
                            let _ = tx.send(
                                serde_json::json!({
                                    "type": "error",
                                    "error": "unknown_type",
                                    "message": format!("Unsupported message type '{msg_type}'")
                                })
                                .to_string(),
                            );
                        }
                    }
                }
            }
            Message::Ping(payload) => {
                let _ = payload;
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    if let Some(task) = action_sub_task {
        task.abort();
    }
    if is_renderer {
        service.unregister_renderer(renderer_gen);
    }
    send_task.abort();
}

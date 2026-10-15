use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use vessel_core::service::DomainService;
use vessel_core::start_server;
use vessel_core::types::ActionTerminalStatus;

#[tokio::test]
async fn test_health_and_not_found() {
    let service = DomainService::new(None);
    // Port 0 picks an OS-assigned free ephemeral port
    let mut handle = start_server(0, service)
        .await
        .expect("Failed to start server");
    let port = handle.port;
    let client = reqwest::Client::new();

    // 1. Health check returns 200 with service info
    let health_url = format!("http://127.0.0.1:{port}/health");
    let resp = client.get(&health_url).send().await.unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::OK);
    let health_json: Value = resp.json().await.unwrap();
    assert_eq!(health_json["service"], "VESSEL");
    assert_eq!(health_json["status"], "online");
    assert_eq!(health_json["renderer_connected"], false);
    assert_eq!(health_json["model_ready"], false);

    // 2. Unmatched route returns 404 (NOT 200!)
    let unknown_url = format!("http://127.0.0.1:{port}/unknown_route");
    let resp_404 = client.get(&unknown_url).send().await.unwrap();
    assert_eq!(resp_404.status(), reqwest::StatusCode::NOT_FOUND);

    handle.stop().await;
}

#[tokio::test]
async fn test_mcp_discovery_and_tools() {
    let service = DomainService::new(None);
    let mut handle = start_server(0, service)
        .await
        .expect("Failed to start server");
    let port = handle.port;
    let client = reqwest::Client::new();
    let mcp_url = format!("http://127.0.0.1:{port}/mcp");

    // 1. GET /mcp returns service info
    let get_resp = client.get(&mcp_url).send().await.unwrap();
    assert_eq!(get_resp.status(), reqwest::StatusCode::OK);
    let get_json: Value = get_resp.json().await.unwrap();
    assert_eq!(get_json["protocol"], "Streamable HTTP");

    // 2. POST /mcp initialize
    let init_resp = client
        .post(&mcp_url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(init_resp.status(), reqwest::StatusCode::OK);
    let init_json: Value = init_resp.json().await.unwrap();
    assert_eq!(init_json["result"]["serverInfo"]["name"], "vessel");

    // 3. POST /mcp tools/list
    let list_resp = client
        .post(&mcp_url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": "req-2",
            "method": "tools/list",
            "params": {}
        }))
        .send()
        .await
        .unwrap();
    let list_json: Value = list_resp.json().await.unwrap();
    let tools = list_json["result"]["tools"].as_array().unwrap();
    let tool_names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(tool_names.contains(&"vessel_set_emotion"));
    assert!(tool_names.contains(&"vessel_play_gesture"));
    assert!(tool_names.contains(&"vessel_speak"));
    assert!(tool_names.contains(&"vessel_get_action_status"));
    assert!(tool_names.contains(&"vessel_get_status"));

    // 4. tools/call vessel_set_emotion
    let emotion_resp = client
        .post(&mcp_url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "vessel_set_emotion",
                "arguments": {
                    "emotion": "happy",
                    "intensity": 0.8
                }
            }
        }))
        .send()
        .await
        .unwrap();
    let emotion_json: Value = emotion_resp.json().await.unwrap();
    assert!(emotion_json["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("happy"));

    // 5. tools/call play_gesture before renderer is ready -> rejected with renderer_not_ready
    let gesture_resp = client
        .post(&mcp_url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "vessel_play_gesture",
                "arguments": {
                    "gesture": "wave"
                }
            }
        }))
        .send()
        .await
        .unwrap();
    let gesture_json: Value = gesture_resp.json().await.unwrap();
    assert_eq!(gesture_json["result"]["isError"], true);
    assert!(gesture_json["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("renderer_not_ready"));

    handle.stop().await;
}

#[tokio::test]
async fn test_ws_renderer_action_correlation_and_lifecycle() {
    let service = DomainService::new(None);
    let mut handle = start_server(0, service.clone())
        .await
        .expect("Failed to start server");
    let port = handle.port;
    let ws_url = format!("ws://127.0.0.1:{port}/ws/avatar");
    let mcp_url = format!("http://127.0.0.1:{port}/mcp");
    let client = reqwest::Client::new();

    // Connect renderer WebSocket client
    let (mut ws_stream, _) = connect_async(&ws_url).await.expect("Failed to connect WS");

    // 1. Send register and ready
    ws_stream
        .send(Message::Text(
            json!({ "type": "register", "role": "renderer" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    ws_stream
        .send(Message::Text(
            json!({ "type": "ready", "model": "avatar.vrm" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();

    // Receive snapshot from server
    let msg = ws_stream.next().await.unwrap().unwrap();
    let snap_json: Value = serde_json::from_str(&msg.to_string()).unwrap();
    assert_eq!(snap_json["type"], "snapshot");

    // Check health: now renderer_connected = true, model_ready = true
    let (connected, ready, _) = service.get_health_stats();
    assert!(connected);
    assert!(ready);

    // 2. Dispatch gesture via MCP tool
    let call_resp = client
        .post(&mcp_url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": "req-gesture-1",
            "method": "tools/call",
            "params": {
                "name": "vessel_play_gesture",
                "arguments": { "gesture": "nod" }
            }
        }))
        .send()
        .await
        .unwrap();
    let call_json: Value = call_resp.json().await.unwrap();
    let text = call_json["result"]["content"][0]["text"].as_str().unwrap();
    let accepted: Value = serde_json::from_str(text).unwrap();
    assert_eq!(accepted["status"], "accepted");
    let command_id = accepted["command_id"].as_str().unwrap().to_string();

    // Verify message arrived on WS
    let ws_msg = ws_stream.next().await.unwrap().unwrap();
    let ws_json: Value = serde_json::from_str(&ws_msg.to_string()).unwrap();
    assert_eq!(ws_json["type"], "gesture");
    assert_eq!(ws_json["name"], "nod");
    assert_eq!(ws_json["command_id"], command_id);

    // Action status should be pending
    let status_record = service.get_action_status(&command_id);
    assert_eq!(status_record.status, ActionTerminalStatus::Pending);

    // 3. Renderer sends action_result completed
    ws_stream
        .send(Message::Text(
            json!({
                "type": "action_result",
                "command_id": command_id,
                "action": "gesture",
                "status": "completed"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    // Let the event loop process
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // Action status should now be completed
    let status_completed = service.get_action_status(&command_id);
    assert_eq!(status_completed.status, ActionTerminalStatus::Completed);

    // 4. Test Gesture Replacement / Interruption
    // Call gesture A
    let resp_a = client
        .post(&mcp_url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "tools/call",
            "params": {
                "name": "vessel_play_gesture",
                "arguments": { "gesture": "shake_head" }
            }
        }))
        .send()
        .await
        .unwrap();
    let json_a: Value = resp_a.json().await.unwrap();
    let cmd_a =
        serde_json::from_str::<Value>(json_a["result"]["content"][0]["text"].as_str().unwrap())
            .unwrap()["command_id"]
            .as_str()
            .unwrap()
            .to_string();

    // Call gesture B immediately
    let resp_b = client
        .post(&mcp_url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {
                "name": "vessel_play_gesture",
                "arguments": { "gesture": "tilt_head" }
            }
        }))
        .send()
        .await
        .unwrap();
    let json_b: Value = resp_b.json().await.unwrap();
    let cmd_b =
        serde_json::from_str::<Value>(json_b["result"]["content"][0]["text"].as_str().unwrap())
            .unwrap()["command_id"]
            .as_str()
            .unwrap()
            .to_string();

    // Gesture A should be cancelled!
    let status_a = service.get_action_status(&cmd_a);
    assert_eq!(status_a.status, ActionTerminalStatus::Cancelled);

    // Gesture B should be pending!
    let status_b = service.get_action_status(&cmd_b);
    assert_eq!(status_b.status, ActionTerminalStatus::Pending);

    // Close WS connection -> pending actions transition to Failed
    ws_stream.close(None).await.unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let status_b_after_disconnect = service.get_action_status(&cmd_b);
    assert_eq!(
        status_b_after_disconnect.status,
        ActionTerminalStatus::Failed
    );

    handle.stop().await;
}

#[tokio::test]
async fn test_security_origin_and_auth() {
    let service = DomainService::new(Some("secret-token-123".to_string()));
    let mut handle = start_server(0, service)
        .await
        .expect("Failed to start server");
    let port = handle.port;
    let mcp_url = format!("http://127.0.0.1:{port}/mcp");
    let client = reqwest::Client::new();

    // 1. Forbidden Origin header (cross-site website)
    let resp_forbidden = client
        .post(&mcp_url)
        .header("Origin", "https://attacker.evil.com")
        .send()
        .await
        .unwrap();
    assert_eq!(resp_forbidden.status(), reqwest::StatusCode::FORBIDDEN);

    // 2. Missing token
    let resp_unauth = client
        .post(&mcp_url)
        .header("Origin", "http://localhost:5173")
        .send()
        .await
        .unwrap();
    assert_eq!(resp_unauth.status(), reqwest::StatusCode::UNAUTHORIZED);

    // 3. Valid token and allowed origin
    let resp_auth = client
        .post(&mcp_url)
        .header("Origin", "http://localhost:5173")
        .header("Authorization", "Bearer secret-token-123")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp_auth.status(), reqwest::StatusCode::OK);

    handle.stop().await;
}

#[tokio::test]
async fn test_client_isolation_same_jsonrpc_id() {
    let service = DomainService::new(None);
    let mut handle = start_server(0, service)
        .await
        .expect("Failed to start server");
    let port = handle.port;
    let mcp_url = format!("http://127.0.0.1:{port}/mcp");
    let client = reqwest::Client::new();

    // Two clients sending requests with identical id = 99
    let req1 = client.post(&mcp_url).json(&json!({
        "jsonrpc": "2.0",
        "id": 99,
        "method": "tools/call",
        "params": {
            "name": "vessel_set_emotion",
            "arguments": { "emotion": "happy" }
        }
    }));

    let req2 = client.post(&mcp_url).json(&json!({
        "jsonrpc": "2.0",
        "id": 99,
        "method": "tools/call",
        "params": {
            "name": "vessel_set_framing",
            "arguments": { "preset": "face" }
        }
    }));

    let (res1, res2) = tokio::join!(req1.send(), req2.send());
    let json1: Value = res1.unwrap().json().await.unwrap();
    let json2: Value = res2.unwrap().json().await.unwrap();

    // Both preserve id 99, but return their own distinct results
    assert_eq!(json1["id"], 99);
    assert_eq!(json2["id"], 99);
    assert!(json1["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("happy"));
    assert!(json2["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("face"));

    handle.stop().await;
}

#[tokio::test]
async fn test_renderer_generation_lifecycle() {
    let service = DomainService::new(None);
    let mut handle = start_server(0, service.clone())
        .await
        .expect("Failed to start server");
    let port = handle.port;
    let ws_url = format!("ws://127.0.0.1:{port}/ws/avatar");

    // 1. Connect Renderer 1
    let (mut ws_stream1, _) = connect_async(&ws_url).await.unwrap();
    ws_stream1
        .send(Message::Text(
            json!({ "type": "register", "role": "renderer" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    ws_stream1
        .send(Message::Text(
            json!({ "type": "ready", "model": "model-1" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let (connected, ready, _) = service.get_health_stats();
    assert!(connected);
    assert!(ready);

    // Dispatch gesture
    let cmd_id = service.dispatch_gesture("nod".to_string()).unwrap();
    assert_eq!(service.get_action_status(&cmd_id).status, ActionTerminalStatus::Pending);

    // 2. Connect Renderer 2 (reconnect scenario)
    let (mut ws_stream2, _) = connect_async(&ws_url).await.unwrap();
    ws_stream2
        .send(Message::Text(
            json!({ "type": "register", "role": "renderer" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    ws_stream2
        .send(Message::Text(
            json!({ "type": "ready", "model": "model-2" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // 3. Now Renderer 1 disconnects (delayed close)
    ws_stream1.close(None).await.unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // Generation safety invariant: Renderer 2 is STILL active!
    let (connected2, ready2, _) = service.get_health_stats();
    assert!(connected2, "Renderer 2 must still be connected");
    assert!(ready2, "Renderer 2 must still be ready");

    // Action was not killed by stale unregister
    assert_eq!(
        service.get_action_status(&cmd_id).status,
        ActionTerminalStatus::Pending
    );

    // 4. Renderer 2 completes the action
    ws_stream2
        .send(Message::Text(
            json!({
                "type": "action_result",
                "command_id": cmd_id,
                "action": "gesture",
                "status": "completed"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    assert_eq!(
        service.get_action_status(&cmd_id).status,
        ActionTerminalStatus::Completed
    );

    // 5. When Renderer 2 disconnects, it is legitimately unregistered
    ws_stream2.close(None).await.unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let (connected3, ready3, _) = service.get_health_stats();
    assert!(!connected3);
    assert!(!ready3);

    handle.stop().await;
}

#[tokio::test]
async fn test_action_terminal_monotonicity_and_stop() {
    let service = DomainService::new(None);
    let mut handle = start_server(0, service.clone())
        .await
        .expect("Failed to start server");
    let port = handle.port;
    let ws_url = format!("ws://127.0.0.1:{port}/ws/avatar");

    let (mut ws_stream, _) = connect_async(&ws_url).await.unwrap();
    ws_stream
        .send(Message::Text(
            json!({ "type": "register", "role": "renderer" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    ws_stream
        .send(Message::Text(
            json!({ "type": "ready", "model": "test-model" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    // 1. Dispatch speak
    let cmd_id = service
        .dispatch_speak(
            None,
            Some("data:audio/wav;base64,UklGRgAAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=".to_string()),
            Some("Hello".to_string()),
            None,
        )
        .unwrap();

    assert_eq!(service.get_action_status(&cmd_id).status, ActionTerminalStatus::Pending);

    // 2. Call stop_speak
    let cancelled = service.stop_speak(Some(&cmd_id));
    assert!(cancelled);
    assert_eq!(service.get_action_status(&cmd_id).status, ActionTerminalStatus::Cancelled);

    // Verify stop_speak message arrived at renderer
    // (first msg is snapshot from ready, second is speak, third is stop_speak)
    let _ = ws_stream.next().await; // snapshot
    let _ = ws_stream.next().await; // speak
    let stop_msg = ws_stream.next().await.unwrap().unwrap();
    let stop_json: Value = serde_json::from_str(&stop_msg.to_string()).unwrap();
    assert_eq!(stop_json["type"], "stop_speak");
    assert_eq!(stop_json["command_id"], cmd_id);

    // 3. Monotonicity: Late "completed" from renderer must NOT overwrite "Cancelled"
    ws_stream
        .send(Message::Text(
            json!({
                "type": "action_result",
                "command_id": cmd_id,
                "action": "speak",
                "status": "completed"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    assert_eq!(
        service.get_action_status(&cmd_id).status,
        ActionTerminalStatus::Cancelled,
        "Terminal status must be monotonic: completed cannot overwrite cancelled"
    );

    handle.stop().await;
}

#[tokio::test]
async fn test_idempotent_duplicate_command_id() {
    let service = DomainService::new(None);
    let mut handle = start_server(0, service.clone())
        .await
        .expect("Failed to start server");
    let port = handle.port;
    let ws_url = format!("ws://127.0.0.1:{port}/ws/avatar");

    let (mut ws_stream, _) = connect_async(&ws_url).await.unwrap();
    ws_stream
        .send(Message::Text(
            json!({ "type": "ready", "model": "default" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let fixed_id = "custom-uuid-12345".to_string();

    // 1. First dispatch with custom ID
    let res1 = service.dispatch_gesture_with_id(Some(fixed_id.clone()), "nod".to_string());
    assert_eq!(res1.unwrap(), fixed_id);

    // 2. Second dispatch with identical custom ID (idempotent duplicate)
    let res2 = service.dispatch_gesture_with_id(Some(fixed_id.clone()), "nod".to_string());
    assert_eq!(res2.unwrap(), fixed_id);

    // Only one gesture was recorded and pending
    let (_, _, active) = service.get_health_stats();
    assert_eq!(active, 1);

    handle.stop().await;
}

#[tokio::test]
async fn test_bounded_history_pruning() {
    let service = DomainService::new(None);
    let (tx, _) = tokio::sync::mpsc::unbounded_channel();
    service.register_renderer(tx);
    service.handle_renderer_ready("m".to_string());

    // Dispatch and complete 520 actions
    for i in 0..520 {
        let cmd = service
            .dispatch_gesture_with_id(Some(format!("cmd-{i}")), "nod".to_string())
            .unwrap();
        service.handle_action_result(&cmd, "gesture", ActionTerminalStatus::Completed, None);
    }

    // Now dispatch one pending
    let pending_cmd = service
        .dispatch_gesture_with_id(Some("pending-1".to_string()), "nod".to_string())
        .unwrap();

    // The total history must be bounded at 500
    // And pending action must NOT be pruned
    assert_eq!(
        service.get_action_status(&pending_cmd).status,
        ActionTerminalStatus::Pending
    );

    // Oldest items (e.g. cmd-0..cmd-19) should have been pruned
    let old_status = service.get_action_status("cmd-0");
    assert_eq!(old_status.status, ActionTerminalStatus::UnknownOrExpired);
}

#[tokio::test]
async fn test_action_events_broadcast() {
    let service = DomainService::new(None);
    let (tx, _) = tokio::sync::mpsc::unbounded_channel();
    service.register_renderer(tx);
    service.handle_renderer_ready("m".to_string());

    let mut rx = service.subscribe_actions();

    let cmd_id = service.dispatch_gesture("wave".to_string()).unwrap();

    // First event should be Pending
    let ev1 = rx.recv().await.unwrap();
    assert_eq!(ev1.command_id, cmd_id);
    assert_eq!(ev1.status, ActionTerminalStatus::Pending);

    // Complete the action
    service.handle_action_result(&cmd_id, "gesture", ActionTerminalStatus::Completed, None);

    // Second event should be Completed
    let ev2 = rx.recv().await.unwrap();
    assert_eq!(ev2.command_id, cmd_id);
    assert_eq!(ev2.status, ActionTerminalStatus::Completed);
}

#[tokio::test]
async fn test_ws_producer_registration_and_hello() {
    let service = DomainService::new(None);
    let mut handle = start_server(0, service.clone())
        .await
        .expect("Failed to start server");
    let port = handle.port;
    let ws_url = format!("ws://127.0.0.1:{port}/ws/avatar");

    let (mut ws_stream, _) = connect_async(&ws_url).await.unwrap();

    // 1. Register as producer
    ws_stream
        .send(Message::Text(
            json!({
                "type": "register",
                "role": "producer",
                "protocol_version": "v1",
                "client_id": "test-assistant"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    // 2. Receive hello with capabilities and snapshot
    let msg = ws_stream.next().await.unwrap().unwrap();
    let hello: Value = serde_json::from_str(&msg.to_string()).unwrap();

    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["protocol_version"], "v1");
    assert_eq!(hello["renderer_connected"], false);
    assert_eq!(hello["model_ready"], false);
    assert!(hello["capabilities"].as_array().unwrap().contains(&json!("state")));
    assert!(hello["capabilities"].as_array().unwrap().contains(&json!("gesture")));
    assert!(hello["capabilities"].as_array().unwrap().contains(&json!("speak")));
    assert_eq!(hello["snapshot"]["state"], "idle");

    handle.stop().await;
}

#[tokio::test]
async fn test_ws_producer_state_expression_framing_gaze() {
    let service = DomainService::new(None);
    let mut handle = start_server(0, service.clone())
        .await
        .expect("Failed to start server");
    let port = handle.port;
    let ws_url = format!("ws://127.0.0.1:{port}/ws/avatar");

    // 1. Connect Renderer
    let (mut ws_renderer, _) = connect_async(&ws_url).await.unwrap();
    ws_renderer
        .send(Message::Text(
            json!({ "type": "ready", "model": "avatar-vrm" }).to_string().into(),
        ))
        .await
        .unwrap();
    let _ = ws_renderer.next().await; // consume initial snapshot

    // 2. Connect Producer
    let (mut ws_producer, _) = connect_async(&ws_url).await.unwrap();
    ws_producer
        .send(Message::Text(
            json!({ "type": "register", "role": "producer" }).to_string().into(),
        ))
        .await
        .unwrap();
    let _ = ws_producer.next().await; // consume hello

    // 3. Producer sets state = listening
    ws_producer
        .send(Message::Text(
            json!({ "type": "state", "state": "listening" }).to_string().into(),
        ))
        .await
        .unwrap();

    let ack_msg = ws_producer.next().await.unwrap().unwrap();
    let ack_json: Value = serde_json::from_str(&ack_msg.to_string()).unwrap();
    assert_eq!(ack_json["type"], "acknowledged");
    assert_eq!(ack_json["action"], "state");

    // Verify reached renderer and desired state
    let rend_msg = ws_renderer.next().await.unwrap().unwrap();
    let rend_json: Value = serde_json::from_str(&rend_msg.to_string()).unwrap();
    assert_eq!(rend_json["type"], "state");
    assert_eq!(rend_json["state"], "listening");
    assert_eq!(service.get_desired_state().state, vessel_core::types::AvatarState::Listening);

    // 4. Producer sets expression = happy
    ws_producer
        .send(Message::Text(
            json!({ "type": "expression", "name": "happy", "intensity": 0.85 }).to_string().into(),
        ))
        .await
        .unwrap();
    let _ = ws_producer.next().await; // ack
    let _ = ws_renderer.next().await; // renderer frame
    assert_eq!(service.get_desired_state().expression.name, "happy");

    // 5. Producer sets framing = face
    ws_producer
        .send(Message::Text(
            json!({ "type": "framing", "preset": "face" }).to_string().into(),
        ))
        .await
        .unwrap();
    let _ = ws_producer.next().await; // ack
    let _ = ws_renderer.next().await; // renderer frame
    assert_eq!(service.get_desired_state().framing, vessel_core::types::FramingPreset::Face);

    // 6. Producer sets persistent gaze
    ws_producer
        .send(Message::Text(
            json!({ "type": "gaze", "x": 0.4, "y": -0.2, "persistent": true }).to_string().into(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    assert_eq!(service.get_desired_state().gaze.x, 0.4);

    handle.stop().await;
}

#[tokio::test]
async fn test_ws_producer_gesture_accepted_and_action_result() {
    let service = DomainService::new(None);
    let mut handle = start_server(0, service.clone())
        .await
        .expect("Failed to start server");
    let port = handle.port;
    let ws_url = format!("ws://127.0.0.1:{port}/ws/avatar");

    let (mut ws_renderer, _) = connect_async(&ws_url).await.unwrap();
    ws_renderer
        .send(Message::Text(
            json!({ "type": "ready", "model": "avatar-vrm" }).to_string().into(),
        ))
        .await
        .unwrap();
    let _ = ws_renderer.next().await; // snapshot

    let (mut ws_producer, _) = connect_async(&ws_url).await.unwrap();
    ws_producer
        .send(Message::Text(
            json!({ "type": "register", "role": "producer" }).to_string().into(),
        ))
        .await
        .unwrap();
    let _ = ws_producer.next().await; // hello

    // 1. Producer dispatches gesture with custom command_id
    ws_producer
        .send(Message::Text(
            json!({
                "type": "gesture",
                "command_id": "producer-nod-001",
                "name": "nod"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    // 2. Producer receives accepted
    let acc_msg = ws_producer.next().await.unwrap().unwrap();
    let acc_json: Value = serde_json::from_str(&acc_msg.to_string()).unwrap();
    assert_eq!(acc_json["type"], "accepted");
    assert_eq!(acc_json["command_id"], "producer-nod-001");
    assert_eq!(acc_json["action"], "gesture");

    // 3. Renderer receives gesture command
    let rend_msg = ws_renderer.next().await.unwrap().unwrap();
    let rend_json: Value = serde_json::from_str(&rend_msg.to_string()).unwrap();
    assert_eq!(rend_json["type"], "gesture");
    assert_eq!(rend_json["command_id"], "producer-nod-001");
    assert_eq!(rend_json["name"], "nod");

    // 4. Renderer reports action_result completed
    ws_renderer
        .send(Message::Text(
            json!({
                "type": "action_result",
                "command_id": "producer-nod-001",
                "action": "gesture",
                "status": "completed"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    // 5. Producer receives action_result completed!
    let res_msg = ws_producer.next().await.unwrap().unwrap();
    let res_json: Value = serde_json::from_str(&res_msg.to_string()).unwrap();
    assert_eq!(res_json["type"], "action_result");
    assert_eq!(res_json["command_id"], "producer-nod-001");
    assert_eq!(res_json["action"], "gesture");
    assert_eq!(res_json["status"], "completed");

    handle.stop().await;
}

#[tokio::test]
async fn test_ws_producer_speak_playback_started_and_stop() {
    let service = DomainService::new(None);
    let mut handle = start_server(0, service.clone())
        .await
        .expect("Failed to start server");
    let port = handle.port;
    let ws_url = format!("ws://127.0.0.1:{port}/ws/avatar");

    let (mut ws_renderer, _) = connect_async(&ws_url).await.unwrap();
    ws_renderer
        .send(Message::Text(
            json!({ "type": "ready", "model": "avatar-vrm" }).to_string().into(),
        ))
        .await
        .unwrap();
    let _ = ws_renderer.next().await; // snapshot

    let (mut ws_producer, _) = connect_async(&ws_url).await.unwrap();
    ws_producer
        .send(Message::Text(
            json!({ "type": "register", "role": "producer" }).to_string().into(),
        ))
        .await
        .unwrap();
    let _ = ws_producer.next().await; // hello

    // 1. Producer dispatches speak
    ws_producer
        .send(Message::Text(
            json!({
                "type": "speak",
                "command_id": "speak-turn-42",
                "audio_base64": "UklGRgAAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
                "text": "Hello world"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    // Producer receives accepted
    let acc_msg = ws_producer.next().await.unwrap().unwrap();
    let acc_json: Value = serde_json::from_str(&acc_msg.to_string()).unwrap();
    assert_eq!(acc_json["type"], "accepted");
    assert_eq!(acc_json["command_id"], "speak-turn-42");

    // Renderer receives speak frame
    let _ = ws_renderer.next().await;

    // 2. Renderer emits playback_started
    ws_renderer
        .send(Message::Text(
            json!({
                "type": "playback_started",
                "command_id": "speak-turn-42",
                "action": "speak"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    // Producer receives playback_started!
    let play_msg = ws_producer.next().await.unwrap().unwrap();
    let play_json: Value = serde_json::from_str(&play_msg.to_string()).unwrap();
    assert_eq!(play_json["type"], "playback_started");
    assert_eq!(play_json["command_id"], "speak-turn-42");
    assert_eq!(play_json["action"], "speak");

    // 3. Producer sends stop_speak
    ws_producer
        .send(Message::Text(
            json!({
                "type": "stop_speak",
                "command_id": "speak-turn-42"
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();

    // Producer receives stopped confirmation and action_result cancelled
    let stop_ack = ws_producer.next().await.unwrap().unwrap();
    let stop_ack_json: Value = serde_json::from_str(&stop_ack.to_string()).unwrap();
    assert_eq!(stop_ack_json["type"], "stopped");

    let cancel_res = ws_producer.next().await.unwrap().unwrap();
    let cancel_json: Value = serde_json::from_str(&cancel_res.to_string()).unwrap();
    assert_eq!(cancel_json["type"], "action_result");
    assert_eq!(cancel_json["command_id"], "speak-turn-42");
    assert_eq!(cancel_json["status"], "cancelled");

    handle.stop().await;
}

#[tokio::test]
async fn test_ws_producer_rejected_and_unknown_error() {
    let service = DomainService::new(None);
    let mut handle = start_server(0, service.clone())
        .await
        .expect("Failed to start server");
    let port = handle.port;
    let ws_url = format!("ws://127.0.0.1:{port}/ws/avatar");

    let (mut ws_stream, _) = connect_async(&ws_url).await.unwrap();
    ws_stream
        .send(Message::Text(
            json!({ "type": "register", "role": "producer" }).to_string().into(),
        ))
        .await
        .unwrap();
    let _ = ws_stream.next().await; // hello

    // 1. Gesture with renderer offline -> rejected
    ws_stream
        .send(Message::Text(
            json!({ "type": "gesture", "name": "nod" }).to_string().into(),
        ))
        .await
        .unwrap();
    let rej_msg = ws_stream.next().await.unwrap().unwrap();
    let rej_json: Value = serde_json::from_str(&rej_msg.to_string()).unwrap();
    assert_eq!(rej_json["type"], "rejected");
    assert!(rej_json["error"].as_str().unwrap().contains("not connected"));

    // 2. Unknown message type -> error
    ws_stream
        .send(Message::Text(
            json!({ "type": "unknown_future_command" }).to_string().into(),
        ))
        .await
        .unwrap();
    let err_msg = ws_stream.next().await.unwrap().unwrap();
    let err_json: Value = serde_json::from_str(&err_msg.to_string()).unwrap();
    assert_eq!(err_json["type"], "error");
    assert_eq!(err_json["error"], "unknown_type");

    handle.stop().await;
}



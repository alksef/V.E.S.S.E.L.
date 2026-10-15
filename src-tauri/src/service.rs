use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use crate::types::{
    ActionEvent, ActionRecord, ActionTerminalStatus, ActionType, AvatarState, DesiredAvatarState,
    ExpressionState, FramingPreset, GazeState,
};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
pub struct ActionResultSummary {
    pub status: &'static str,
    pub command_id: String,
    pub details: Option<String>,
}

#[derive(Debug, Clone)]
pub enum ActionDispatchError {
    RendererNotReady,
    InvalidArguments(String),
}

impl std::fmt::Display for ActionDispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RendererNotReady => write!(
                f,
                "Avatar renderer is not connected or model is not loaded yet"
            ),
            Self::InvalidArguments(msg) => write!(f, "Invalid arguments: {msg}"),
        }
    }
}

impl std::error::Error for ActionDispatchError {}

struct ServiceState {
    desired: DesiredAvatarState,
    renderer_tx: Option<mpsc::UnboundedSender<String>>,
    renderer_generation: u64,
    model_ready: bool,
    loaded_model: Option<String>,
    actions: HashMap<String, ActionRecord>,
    active_gesture_command_id: Option<String>,
    active_speak_command_id: Option<String>,
    auth_token: Option<String>,
    action_seq: u64,
}

impl ServiceState {
    fn prune_actions(&mut self) {
        const MAX_ACTIONS: usize = 500;
        if self.actions.len() <= MAX_ACTIONS {
            return;
        }

        // Collect terminal actions with their finish time (or creation time) and sequence
        let mut terminal: Vec<(String, u64, u64)> = self
            .actions
            .iter()
            .filter(|(_, rec)| rec.status != ActionTerminalStatus::Pending)
            .map(|(id, rec)| (id.clone(), rec.finished_at_ms.unwrap_or(rec.created_at_ms), rec.seq))
            .collect();

        // Sort ascending by time, then sequence (oldest first)
        terminal.sort_by_key(|(_, t, seq)| (*t, *seq));

        let to_remove = self.actions.len().saturating_sub(MAX_ACTIONS);
        for (id, _, _) in terminal.into_iter().take(to_remove) {
            self.actions.remove(&id);
        }
    }
}

pub struct DomainService {
    state: Mutex<ServiceState>,
    action_tx: broadcast::Sender<ActionEvent>,
}

impl DomainService {
    pub fn new(auth_token: Option<String>) -> Arc<Self> {
        let (action_tx, _) = broadcast::channel(256);
        Arc::new(Self {
            state: Mutex::new(ServiceState {
                desired: DesiredAvatarState::default(),
                renderer_tx: None,
                renderer_generation: 0,
                model_ready: false,
                loaded_model: None,
                actions: HashMap::new(),
                active_gesture_command_id: None,
                active_speak_command_id: None,
                auth_token,
                action_seq: 0,
            }),
            action_tx,
        })
    }


    pub fn subscribe_actions(&self) -> broadcast::Receiver<ActionEvent> {
        self.action_tx.subscribe()
    }

    fn emit_action_event(&self, event: ActionEvent) {
        let _ = self.action_tx.send(event);
    }

    pub fn verify_token(&self, token_opt: Option<&str>) -> bool {
        let state = self.state.lock().unwrap();
        match &state.auth_token {
            None => true, // No token configured -> localhost open
            Some(expected) => match token_opt {
                Some(provided) => provided.trim() == expected.trim(),
                None => false,
            },
        }
    }

    pub fn get_health_stats(&self) -> (bool, bool, usize) {
        let state = self.state.lock().unwrap();
        let connected = state.renderer_tx.is_some();
        let ready = state.model_ready;
        let active = state
            .actions
            .values()
            .filter(|a| a.status == ActionTerminalStatus::Pending)
            .count();
        (connected, ready, active)
    }

    pub fn get_desired_state(&self) -> DesiredAvatarState {
        let state = self.state.lock().unwrap();
        state.desired.clone()
    }

    pub fn set_state(&self, avatar_state: AvatarState) {
        let mut state = self.state.lock().unwrap();
        state.desired.state = avatar_state.clone();
        if let Some(tx) = &state.renderer_tx {
            let msg = serde_json::json!({
                "type": "state",
                "state": avatar_state,
            });
            let _ = tx.send(msg.to_string());
        }
    }

    pub fn set_emotion(&self, name: String, intensity: f32) {
        let mut state = self.state.lock().unwrap();
        let clamped = intensity.clamp(0.0, 1.0);
        state.desired.expression = ExpressionState {
            name: name.clone(),
            intensity: clamped,
        };
        if let Some(tx) = &state.renderer_tx {
            let msg = serde_json::json!({
                "type": "expression",
                "name": name,
                "intensity": clamped,
            });
            let _ = tx.send(msg.to_string());
        }
    }

    pub fn set_gaze(&self, x: f32, y: f32) {
        let mut state = self.state.lock().unwrap();
        let cx = x.clamp(-1.0, 1.0);
        let cy = y.clamp(-1.0, 1.0);
        state.desired.gaze = GazeState { x: cx, y: cy };
        if let Some(tx) = &state.renderer_tx {
            let msg = serde_json::json!({
                "type": "gaze",
                "x": cx,
                "y": cy,
            });
            let _ = tx.send(msg.to_string());
        }
    }

    pub fn set_framing(&self, preset: FramingPreset) {
        let mut state = self.state.lock().unwrap();
        state.desired.framing = preset.clone();
        if let Some(tx) = &state.renderer_tx {
            let msg = serde_json::json!({
                "type": "framing",
                "preset": preset,
            });
            let _ = tx.send(msg.to_string());
        }
    }

    pub fn dispatch_gesture(&self, name: String) -> Result<String, ActionDispatchError> {
        self.dispatch_gesture_with_id(None, name)
    }

    pub fn dispatch_gesture_with_id(
        &self,
        command_id_opt: Option<String>,
        name: String,
    ) -> Result<String, ActionDispatchError> {
        let mut state = self.state.lock().unwrap();

        if state.renderer_tx.is_none() || !state.model_ready {
            return Err(ActionDispatchError::RendererNotReady);
        }

        let valid_gestures = ["nod", "shake_head", "tilt_head", "wave", "shrug"];
        if !valid_gestures.contains(&name.as_str()) {
            return Err(ActionDispatchError::InvalidArguments(format!(
                "Unknown gesture '{name}'. Must be one of: {}",
                valid_gestures.join(", ")
            )));
        }

        let command_id = match command_id_opt {
            Some(id) => {
                if let Some(existing) = state.actions.get(&id) {
                    if existing.action == ActionType::Gesture
                        && (existing.status == ActionTerminalStatus::Pending
                            || existing.status == ActionTerminalStatus::Completed)
                    {
                        // Idempotent duplicate: return existing id without sending again
                        return Ok(id);
                    } else {
                        return Err(ActionDispatchError::InvalidArguments(format!(
                            "Duplicate command_id '{id}' with conflicting state"
                        )));
                    }
                }
                id
            }
            None => Uuid::new_v4().to_string(),
        };

        // Cancel previous pending gesture if any
        let mut prev_event = None;
        if let Some(prev_id) = state.active_gesture_command_id.take() {
            if let Some(record) = state.actions.get_mut(&prev_id) {
                if record.status == ActionTerminalStatus::Pending {
                    record.status = ActionTerminalStatus::Cancelled;
                    record.finished_at_ms = Some(now_ms());
                    prev_event = Some(ActionEvent {
                        command_id: prev_id.clone(),
                        action: ActionType::Gesture,
                        status: ActionTerminalStatus::Cancelled,
                        error: None,
                    });
                }
            }
            if let Some(tx) = &state.renderer_tx {
                let stop_msg = serde_json::json!({
                    "type": "stop_gesture",
                    "command_id": prev_id,
                });
                let _ = tx.send(stop_msg.to_string());
            }
        }

        let now = now_ms();
        state.action_seq += 1;
        let seq = state.action_seq;
        state.actions.insert(
            command_id.clone(),
            ActionRecord {
                command_id: command_id.clone(),
                action: ActionType::Gesture,
                status: ActionTerminalStatus::Pending,
                error: None,
                created_at_ms: now,
                finished_at_ms: None,
                seq,
            },
        );

        state.active_gesture_command_id = Some(command_id.clone());
        state.prune_actions();

        if let Some(tx) = &state.renderer_tx {
            let msg = serde_json::json!({
                "type": "gesture",
                "command_id": command_id,
                "name": name,
            });
            let _ = tx.send(msg.to_string());
        }
        drop(state);

        if let Some(ev) = prev_event {
            self.emit_action_event(ev);
        }
        self.emit_action_event(ActionEvent {
            command_id: command_id.clone(),
            action: ActionType::Gesture,
            status: ActionTerminalStatus::Pending,
            error: None,
        });

        Ok(command_id)
    }

    pub fn dispatch_speak(
        &self,
        audio_url: Option<String>,
        audio_base64: Option<String>,
        text: Option<String>,
        emotion: Option<String>,
    ) -> Result<String, ActionDispatchError> {
        self.dispatch_speak_with_id(None, audio_url, audio_base64, text, emotion)
    }

    pub fn dispatch_speak_with_id(
        &self,
        command_id_opt: Option<String>,
        audio_url: Option<String>,
        audio_base64: Option<String>,
        text: Option<String>,
        emotion: Option<String>,
    ) -> Result<String, ActionDispatchError> {
        let mut state = self.state.lock().unwrap();

        if state.renderer_tx.is_none() || !state.model_ready {
            return Err(ActionDispatchError::RendererNotReady);
        }

        let has_url = audio_url
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        let has_base64 = audio_base64
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);

        if !has_url && !has_base64 {
            return Err(ActionDispatchError::InvalidArguments(
                "Speech playback requires audio_url or audio_base64. Text transcription alone is not a TTS engine."
                    .to_string(),
            ));
        }

        if let Some(ref url) = audio_url {
            let u = url.trim();
            if u.contains(":\\") || u.starts_with("\\\\") || u.starts_with("file://") {
                return Err(ActionDispatchError::InvalidArguments(format!(
                    "Local filesystem path '{u}' is not supported. Provide an HTTP/HTTPS URL or base64 data URI."
                )));
            }
        }

        let command_id = match command_id_opt {
            Some(id) => {
                if let Some(existing) = state.actions.get(&id) {
                    if existing.action == ActionType::Speak
                        && (existing.status == ActionTerminalStatus::Pending
                            || existing.status == ActionTerminalStatus::Completed)
                    {
                        // Idempotent duplicate: return existing id without sending again
                        return Ok(id);
                    } else {
                        return Err(ActionDispatchError::InvalidArguments(format!(
                            "Duplicate command_id '{id}' with conflicting state"
                        )));
                    }
                }
                id
            }
            None => Uuid::new_v4().to_string(),
        };

        // Cancel previous pending speech if any
        let mut prev_event = None;
        if let Some(prev_id) = state.active_speak_command_id.take() {
            if let Some(record) = state.actions.get_mut(&prev_id) {
                if record.status == ActionTerminalStatus::Pending {
                    record.status = ActionTerminalStatus::Cancelled;
                    record.finished_at_ms = Some(now_ms());
                    prev_event = Some(ActionEvent {
                        command_id: prev_id.clone(),
                        action: ActionType::Speak,
                        status: ActionTerminalStatus::Cancelled,
                        error: None,
                    });
                }
            }
            if let Some(tx) = &state.renderer_tx {
                let stop_msg = serde_json::json!({
                    "type": "stop_speak",
                    "command_id": prev_id,
                });
                let _ = tx.send(stop_msg.to_string());
            }
        }

        let now = now_ms();
        state.action_seq += 1;
        let seq = state.action_seq;
        state.actions.insert(
            command_id.clone(),
            ActionRecord {
                command_id: command_id.clone(),
                action: ActionType::Speak,
                status: ActionTerminalStatus::Pending,
                error: None,
                created_at_ms: now,
                finished_at_ms: None,
                seq,
            },
        );

        state.active_speak_command_id = Some(command_id.clone());
        state.prune_actions();

        if let Some(tx) = &state.renderer_tx {
            let msg = serde_json::json!({
                "type": "speak",
                "command_id": command_id,
                "audio_url": audio_url,
                "audio_base64": audio_base64,
                "text": text,
                "emotion": emotion,
            });
            let _ = tx.send(msg.to_string());
        }
        drop(state);

        if let Some(ev) = prev_event {
            self.emit_action_event(ev);
        }
        self.emit_action_event(ActionEvent {
            command_id: command_id.clone(),
            action: ActionType::Speak,
            status: ActionTerminalStatus::Pending,
            error: None,
        });

        Ok(command_id)
    }

    pub fn stop_speak(&self, command_id: Option<&str>) -> bool {
        let mut state = self.state.lock().unwrap();
        let target_id = match command_id {
            Some(id) => {
                if let Some(rec) = state.actions.get(id) {
                    if rec.status == ActionTerminalStatus::Pending && rec.action == ActionType::Speak {
                        id.to_string()
                    } else {
                        return false;
                    }
                } else {
                    return false;
                }
            }
            None => match state.active_speak_command_id.as_ref() {
                Some(id) => id.clone(),
                None => return false,
            },
        };

        let now = now_ms();
        if let Some(rec) = state.actions.get_mut(&target_id) {
            rec.status = ActionTerminalStatus::Cancelled;
            rec.finished_at_ms = Some(now);
        }
        if state.active_speak_command_id.as_deref() == Some(&target_id) {
            state.active_speak_command_id = None;
        }

        if let Some(tx) = &state.renderer_tx {
            let stop_msg = serde_json::json!({
                "type": "stop_speak",
                "command_id": target_id,
            });
            let _ = tx.send(stop_msg.to_string());
        }
        drop(state);

        self.emit_action_event(ActionEvent {
            command_id: target_id,
            action: ActionType::Speak,
            status: ActionTerminalStatus::Cancelled,
            error: None,
        });
        true
    }

    pub fn stop_gesture(&self, command_id: Option<&str>) -> bool {
        let mut state = self.state.lock().unwrap();
        let target_id = match command_id {
            Some(id) => {
                if let Some(rec) = state.actions.get(id) {
                    if rec.status == ActionTerminalStatus::Pending && rec.action == ActionType::Gesture {
                        id.to_string()
                    } else {
                        return false;
                    }
                } else {
                    return false;
                }
            }
            None => match state.active_gesture_command_id.as_ref() {
                Some(id) => id.clone(),
                None => return false,
            },
        };

        let now = now_ms();
        if let Some(rec) = state.actions.get_mut(&target_id) {
            rec.status = ActionTerminalStatus::Cancelled;
            rec.finished_at_ms = Some(now);
        }
        if state.active_gesture_command_id.as_deref() == Some(&target_id) {
            state.active_gesture_command_id = None;
        }

        if let Some(tx) = &state.renderer_tx {
            let stop_msg = serde_json::json!({
                "type": "stop_gesture",
                "command_id": target_id,
            });
            let _ = tx.send(stop_msg.to_string());
        }
        drop(state);

        self.emit_action_event(ActionEvent {
            command_id: target_id,
            action: ActionType::Gesture,
            status: ActionTerminalStatus::Cancelled,
            error: None,
        });
        true
    }

    pub fn get_action_status(&self, command_id: &str) -> ActionRecord {
        let state = self.state.lock().unwrap();
        match state.actions.get(command_id) {
            Some(record) => record.clone(),
            None => ActionRecord {
                command_id: command_id.to_string(),
                action: ActionType::Gesture,
                status: ActionTerminalStatus::UnknownOrExpired,
                error: Some("Command ID not found or expired from history".to_string()),
                created_at_ms: 0,
                finished_at_ms: None,
                seq: 0,
            },

        }
    }

    pub fn handle_playback_started(&self, command_id: &str, action: ActionType) {
        let state = self.state.lock().unwrap();
        if let Some(record) = state.actions.get(command_id) {
            if record.status == ActionTerminalStatus::Pending {
                drop(state);
                self.emit_action_event(ActionEvent {
                    command_id: command_id.to_string(),
                    action,
                    status: ActionTerminalStatus::PlaybackStarted,
                    error: None,
                });
            }
        }
    }

    pub fn handle_action_result(
        &self,
        command_id: &str,
        _action: &str,
        status: ActionTerminalStatus,
        error: Option<String>,
    ) {
        let mut state = self.state.lock().unwrap();
        let mut event = None;
        if let Some(record) = state.actions.get_mut(command_id) {
            // Invariant: monotonic terminal status. Once an action is terminal, late results cannot overwrite it.
            if record.status == ActionTerminalStatus::Pending {
                record.status = status.clone();
                record.error = error.clone();
                record.finished_at_ms = Some(now_ms());
                event = Some(ActionEvent {
                    command_id: record.command_id.clone(),
                    action: record.action.clone(),
                    status,
                    error,
                });
            }
        }
        if state.active_gesture_command_id.as_deref() == Some(command_id) {
            state.active_gesture_command_id = None;
        }
        if state.active_speak_command_id.as_deref() == Some(command_id) {
            state.active_speak_command_id = None;
        }
        drop(state);

        if let Some(ev) = event {
            self.emit_action_event(ev);
        }
    }

    pub fn register_renderer(&self, tx: mpsc::UnboundedSender<String>) -> u64 {
        let mut state = self.state.lock().unwrap();
        state.renderer_generation += 1;
        let gen = state.renderer_generation;
        state.renderer_tx = Some(tx);
        state.model_ready = false;
        state.loaded_model = None;
        gen
    }

    pub fn unregister_renderer(&self, generation: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.renderer_generation != generation {
            return false;
        }
        state.renderer_tx = None;
        state.model_ready = false;
        state.loaded_model = None;

        // Any pending actions are marked failed with renderer_disconnected
        let now = now_ms();
        let mut failed_events = Vec::new();
        for record in state.actions.values_mut() {
            if record.status == ActionTerminalStatus::Pending {
                record.status = ActionTerminalStatus::Failed;
                record.error = Some("Renderer disconnected before action completed".to_string());
                record.finished_at_ms = Some(now);
                failed_events.push(ActionEvent {
                    command_id: record.command_id.clone(),
                    action: record.action.clone(),
                    status: ActionTerminalStatus::Failed,
                    error: record.error.clone(),
                });
            }
        }
        state.active_gesture_command_id = None;
        state.active_speak_command_id = None;
        drop(state);

        for event in failed_events {
            self.emit_action_event(event);
        }
        true
    }

    pub fn handle_renderer_ready(&self, model: String) {
        let mut state = self.state.lock().unwrap();
        state.model_ready = true;
        state.loaded_model = Some(model);

        // Send desired state snapshot to newly ready renderer
        if let Some(tx) = &state.renderer_tx {
            let snap = serde_json::json!({
                "type": "snapshot",
                "snapshot": {
                    "state": state.desired.state,
                    "expression": {
                        "name": state.desired.expression.name,
                        "intensity": state.desired.expression.intensity,
                    },
                    "gaze": {
                        "x": state.desired.gaze.x,
                        "y": state.desired.gaze.y,
                    },
                    "framing": state.desired.framing,
                }
            });
            let _ = tx.send(snap.to_string());
        }
    }

    pub fn forward_to_renderer(&self, message: &str) {
        let state = self.state.lock().unwrap();
        if let Some(tx) = &state.renderer_tx {
            let _ = tx.send(message.to_string());
        }
    }
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AvatarState {
    #[default]
    Idle,
    Listening,
    Thinking,
    Speaking,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExpressionState {
    pub name: String,
    pub intensity: f32,
}

impl Default for ExpressionState {
    fn default() -> Self {
        Self {
            name: "neutral".to_string(),
            intensity: 1.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GazeState {
    pub x: f32,
    pub y: f32,
}

impl Default for GazeState {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0 }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FramingPreset {
    Face,
    #[default]
    Bust,
    HalfBody,
    FullBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DesiredAvatarState {
    pub state: AvatarState,
    pub expression: ExpressionState,
    pub gaze: GazeState,
    pub framing: FramingPreset,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionTerminalStatus {
    Pending,
    PlaybackStarted,
    Completed,
    Cancelled,
    Failed,
    UnknownOrExpired,
}


#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionType {
    Gesture,
    Speak,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionRecord {
    pub command_id: String,
    pub action: ActionType,
    pub status: ActionTerminalStatus,
    pub error: Option<String>,
    pub created_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    #[serde(default)]
    pub seq: u64,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub service: &'static str,
    pub version: &'static str,
    pub status: &'static str,
    pub renderer_connected: bool,
    pub model_ready: bool,
    pub active_command_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionEvent {
    pub command_id: String,
    pub action: ActionType,
    pub status: ActionTerminalStatus,
    pub error: Option<String>,
}


import { createVrmScene, type FramingPreset } from "./vrm-scene";
import { VrmAvatar } from "./vrm-avatar";
import { VrmAnimator, type EmotionName } from "./animator";
import {
  AvatarWsClient,
  type AvatarExpressionName,
  type AvatarStateName,
  type AvatarSpeakPayload,
  type AvatarSnapshotPayload,
} from "./ws-client";
import { SpeechPlayer } from "./speech-player";
import { readSavedModel, saveModel, type SavedModel } from "./model-store";

const EMOTION_KEYS: Record<string, EmotionName> = {
  "1": "neutral",
  "2": "happy",
  "3": "angry",
  "4": "sorrow",
  "5": "surprised",
  "6": "relaxed",
};

/** Backend expression names mapped to animator preset. */
const REMOTE_EXPRESSION_MAP: Record<AvatarExpressionName, EmotionName> = {
  neutral: "neutral",
  happy: "happy",
  angry: "angry",
  sorrow: "sorrow",
  sad: "sad",
  surprised: "surprised",
  relaxed: "relaxed",
  thinking: "neutral",
};

const FRAMING_CYCLE: readonly FramingPreset[] = ["face", "bust", "half_body", "full_body"];

let externalGazeActive = false;
let externalLipsyncActive = false;
let remoteSpeaking = false;
let clickThroughEnabled = false;

// "Thinking": look up and to the side while a reply is being composed.
const THINKING_GAZE = { x: 0.45, y: 0.5 } as const;
// "Listening": face the viewer dead-on while they speak.
const ATTENTIVE_GAZE = { x: 0, y: 0.1 } as const;

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const isTauri = typeof (window as unknown as { __TAURI__?: unknown }).__TAURI__ !== "undefined";
if (!isTauri) {
  document.body.classList.add("browser-preview");
}

const canvas = required<HTMLCanvasElement>("#avatar-canvas");
const debugPanel = required<HTMLElement>("#debug-panel");
const togglePanelButton = required<HTMLButtonElement>("#toggle-panel-button");
const zoomModelButton = required<HTMLButtonElement>("#zoom-model-button");
const zoomInButton = required<HTMLButtonElement>("#zoom-in-button");
const zoomOutButton = required<HTMLButtonElement>("#zoom-out-button");
const statusElement = required<HTMLElement>("#status");
const chooseModelButton = required<HTMLButtonElement>("#choose-model-button");
const modelFileInput = required<HTMLInputElement>("#model-file-input");
const blinkButton = required<HTMLButtonElement>("#blink-button");
const talkButton = required<HTMLButtonElement>("#talk-button");
const bgButton = required<HTMLButtonElement>("#bg-button");
const expressionButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("button[data-expression]"),
);
const framingButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("button[data-framing]"),
);

const vrmScene = createVrmScene(canvas);
let avatar = new VrmAvatar(vrmScene.scene);
const speechPlayer = new SpeechPlayer();
const speakDemoButton = document.querySelector<HTMLButtonElement>("#speak-demo-button");
let animator: VrmAnimator | null = null;
let talkEnabled = false;

// The status line combines the model state with the backend connection state.
let statusLine = "Loading avatar…";
let connectionLine = "";

function refreshStatus(): void {
  statusElement.textContent = [statusLine, connectionLine].filter(Boolean).join(" · ");
}

function selectExpression(name: EmotionName, weight = 1.0): void {
  animator?.setExpression(name, weight);
  for (const button of expressionButtons) {
    button.classList.toggle("active", button.dataset.expression === name && weight > 0.5);
  }
}

function selectFraming(preset: FramingPreset): void {
  vrmScene.setFraming(preset);
  const isFullBody = preset === "full_body";
  zoomModelButton.textContent = isFullBody ? "Bust" : "Full body";
  zoomModelButton.title = isFullBody ? "Return to bust view" : "Show the entire model";
  zoomModelButton.setAttribute("aria-pressed", String(isFullBody));
  for (const button of framingButtons) {
    button.classList.toggle("active", button.dataset.framing === preset);
  }
}

function setTalkEnabled(enabled: boolean): void {
  talkEnabled = enabled;
  if (!enabled) animator?.setLipSync(0);
  talkButton.classList.toggle("active", enabled);
}

function setCheckerBackground(enabled: boolean): void {
  document.body.classList.toggle("checkerboard", enabled);
  bgButton.classList.toggle("active", enabled);
}

/** Simulated speech: syllable bursts gated by a slow envelope, shaped like an RMS level. */
function testTalkAmplitude(elapsed: number): number {
  const envelope = 0.5 + 0.5 * Math.sin(elapsed * 1.9 + 0.7);
  const syllable = Math.max(0, Math.sin(elapsed * 12.0));
  return Math.min(1, Math.max(0, syllable * envelope * 1.4));
}

async function activateModel(model: SavedModel, persist: boolean): Promise<void> {
  const candidate = new VrmAvatar(vrmScene.scene);
  const url = URL.createObjectURL(model.data);
  let candidateAnimator: VrmAnimator | null = null;
  try {
    const vrm = await candidate.loadModel(url);
    vrm.scene.visible = false;
    candidateAnimator = new VrmAnimator(vrm, vrmScene.scene);
    candidateAnimator.setExpression("neutral");
    candidateAnimator.setGestureTerminalCallback((result) => {
      if (result.commandId) {
        wsClient.sendActionResult("gesture", result.commandId, result.status, result.error);
      }
    });
    // A malformed file or failed save must leave the previous model usable.
    if (persist) await saveModel(model);
    speechPlayer.stop();
    animator?.dispose();
    avatar.dispose();
    avatar = candidate;
    animator = candidateAnimator;
    vrm.scene.visible = true;
    talkEnabled = false;
    talkButton.classList.remove("active");
    externalGazeActive = false;
    externalLipsyncActive = false;
    remoteSpeaking = false;
    statusLine = `Avatar ready — ${model.name}`;
    wsClient.sendReady(model.name);
  } catch (error) {
    candidateAnimator?.dispose();
    candidate.dispose();
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadAvatar(): Promise<void> {
  chooseModelButton.disabled = true;
  modelFileInput.disabled = true;
  try {
    const saved = await readSavedModel();
    if (saved) {
      await activateModel(saved, false);
    } else {
      statusLine = "Choose a VRM model to begin";
    }
  } catch (error) {
    console.warn("Cannot restore model:", error);
    statusLine = "Cannot restore model. Choose a VRM file to retry.";
  } finally {
    chooseModelButton.disabled = false;
    modelFileInput.disabled = false;
    refreshStatus();
  }
}

chooseModelButton.addEventListener("click", () => modelFileInput.click());
modelFileInput.addEventListener("change", () => {
  const file = modelFileInput.files?.[0];
  modelFileInput.value = "";
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".vrm")) {
    statusLine = "Choose a .vrm file";
    refreshStatus();
    return;
  }
  chooseModelButton.disabled = true;
  modelFileInput.disabled = true;
  statusLine = `Loading ${file.name}…`;
  refreshStatus();
  void activateModel({ name: file.name, data: file }, true)
    .catch((error: unknown) => {
      console.warn("Cannot load selected model:", error);
      statusLine = avatar.raw
        ? "Could not load/save that VRM. Previous model is still active."
        : "Could not load/save that VRM. Choose another file.";
    })
    .finally(() => {
      chooseModelButton.disabled = false;
      modelFileInput.disabled = false;
      refreshStatus();
    });
});

vrmScene.addFrameCallback((delta, elapsed) => {
  speechPlayer.update();
  const isAudioSpeaking = speechPlayer.active;
  if (!isAudioSpeaking && !externalLipsyncActive && (remoteSpeaking || talkEnabled)) {
    animator?.setLipSync(testTalkAmplitude(elapsed));
  }
  animator?.update(delta);
  avatar.update(delta);
});

window.addEventListener("mousemove", (event: MouseEvent) => {
  if (externalGazeActive) return;
  const x = (event.clientX / window.innerWidth) * 2 - 1;
  const y = 1 - (event.clientY / window.innerHeight) * 2;
  animator?.setGazeTarget(x, y);
});

function togglePanel(): void {
  const isCollapsed = debugPanel.classList.toggle("collapsed");
  togglePanelButton.textContent = isCollapsed ? "+" : "−";
}

async function startTauriDrag(): Promise<void> {
  try {
    const tauri = (window as unknown as { __TAURI__?: { window?: { getCurrentWindow?: () => { startDragging?: () => Promise<void> } } } }).__TAURI__;
    await tauri?.window?.getCurrentWindow?.()?.startDragging?.();
  } catch (err) {
    console.warn("Failed to start window dragging:", err);
  }
}

const clickThroughButton = document.querySelector<HTMLButtonElement>("#click-through-button");
const closeButton = document.querySelector<HTMLButtonElement>("#close-button");

async function closeWindow(): Promise<void> {
  try {
    const tauri = (window as unknown as { __TAURI__?: { window?: { getCurrentWindow?: () => { close?: () => Promise<void> } } } }).__TAURI__;
    if (tauri?.window?.getCurrentWindow?.()?.close) {
      await tauri.window.getCurrentWindow()!.close!();
      return;
    }
  } catch {
    // ignore
  }
  window.close();
}

async function setClickThrough(ignore: boolean): Promise<void> {
  clickThroughEnabled = ignore;
  clickThroughButton?.classList.toggle("active", ignore);
  try {
    const tauri = (window as unknown as { __TAURI__?: { core?: { invoke?: (cmd: string, args: Record<string, unknown>) => Promise<void> } } }).__TAURI__;
    if (tauri?.core?.invoke) {
      await tauri.core.invoke("toggle_click_through", { ignore });
    }
  } catch (err) {
    console.warn("Failed to toggle click-through:", err);
  }
}

const dragHandle = document.querySelector<HTMLElement>("#drag-handle");
dragHandle?.addEventListener("mousedown", (e) => {
  if (e.button === 0) void startTauriDrag();
});

debugPanel.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || (event.target as Element).closest("button")) return;
  event.preventDefault();
  void startTauriDrag();
});

canvas.addEventListener("mousedown", (e) => {
  if (e.button === 0 && (e.altKey || e.shiftKey)) {
    void startTauriDrag();
  }
});

window.addEventListener("keydown", (event: KeyboardEvent) => {
  const emotion = EMOTION_KEYS[event.key];
  if (emotion) {
    selectExpression(emotion);
  } else if (event.key === "b" || event.key === "B") {
    animator?.triggerBlink();
  } else if (event.key === "t" || event.key === "T") {
    setTalkEnabled(!talkEnabled);
  } else if (event.key === "h" || event.key === "H") {
    togglePanel();
  } else if (event.key === "n" || event.key === "N") {
    animator?.triggerGesture("nod");
  } else if (event.key === "w" || event.key === "W") {
    animator?.triggerGesture("wave");
  } else if (event.key === "s" || event.key === "S") {
    animator?.triggerGesture("shrug");
  } else if (event.key === "x" || event.key === "X") {
    void setClickThrough(!clickThroughEnabled);
  } else if (event.key === "Escape") {
    void closeWindow();
  } else if (event.key === "f" || event.key === "F") {
    const currentIndex = FRAMING_CYCLE.indexOf(vrmScene.getFraming());
    const nextPreset = FRAMING_CYCLE[(currentIndex + 1) % FRAMING_CYCLE.length];
    selectFraming(nextPreset);
    wsClient.send({ type: "framing", preset: nextPreset });
  }
});

togglePanelButton.addEventListener("click", () => togglePanel());
zoomInButton.addEventListener("click", () => vrmScene.zoomBy(1 / 1.2));
zoomOutButton.addEventListener("click", () => vrmScene.zoomBy(1.2));
zoomModelButton.addEventListener("click", () => {
  const preset = vrmScene.getFraming() === "full_body" ? "bust" : "full_body";
  selectFraming(preset);
  wsClient.send({ type: "framing", preset });
});
clickThroughButton?.addEventListener("click", () => void setClickThrough(!clickThroughEnabled));
closeButton?.addEventListener("click", () => void closeWindow());

for (const button of expressionButtons) {
  button.addEventListener("click", () => {
    selectExpression((button.dataset.expression ?? "neutral") as EmotionName);
  });
}

for (const button of framingButtons) {
  button.addEventListener("click", () => {
    const preset = (button.dataset.framing ?? "bust") as FramingPreset;
    selectFraming(preset);
    wsClient.send({ type: "framing", preset });
  });
}
blinkButton.addEventListener("click", () => animator?.triggerBlink());
talkButton.addEventListener("click", () => setTalkEnabled(!talkEnabled));
speakDemoButton?.addEventListener("click", () =>
  void handleSpeak({ text: "VESSEL synthetic speech demo", is_demo: true }),
);
bgButton.addEventListener("click", () =>
  setCheckerBackground(!document.body.classList.contains("checkerboard")),
);

if (new URLSearchParams(window.location.search).get("bg") === "check") {
  setCheckerBackground(true);
}

function applyRemoteExpression(name: AvatarExpressionName, intensity: number): void {
  const mapped = REMOTE_EXPRESSION_MAP[name];
  selectExpression(mapped, intensity);
}

function applyRemoteState(state: AvatarStateName): void {
  remoteSpeaking = state === "speaking";
  if (state !== "speaking") {
    externalLipsyncActive = false;
    animator?.setLipSync(0);
  }

  switch (state) {
    case "idle":
      externalGazeActive = false;
      applyRemoteExpression("neutral", 1);
      break;
    case "listening":
      externalGazeActive = false;
      animator?.setGazeTarget(ATTENTIVE_GAZE.x, ATTENTIVE_GAZE.y);
      applyRemoteExpression("neutral", 1);
      break;
    case "thinking":
      externalGazeActive = true;
      animator?.setGazeTarget(THINKING_GAZE.x, THINKING_GAZE.y);
      applyRemoteExpression("neutral", 1);
      break;
    case "speaking":
      externalGazeActive = false;
      applyRemoteExpression("neutral", 1);
      break;
  }
}

function applySnapshot(snap: AvatarSnapshotPayload): void {
  if (snap.state) {
    applyRemoteState(snap.state);
  }
  if (snap.expression) {
    applyRemoteExpression(snap.expression.name, snap.expression.intensity);
  }
  if (snap.gaze) {
    externalGazeActive = true;
    animator?.setGazeTarget(snap.gaze.x, snap.gaze.y);
  }
  if (snap.framing) {
    selectFraming(snap.framing);
  }
}

async function handleSpeak(payload: AvatarSpeakPayload & { is_demo?: boolean }): Promise<void> {
  applyRemoteState("speaking");
  if (payload.emotion) {
    applyRemoteExpression(payload.emotion, 1.0);
  }
  try {
    await speechPlayer.play({
      commandId: payload.command_id,
      audioUrl: payload.audio_url,
      audioBase64: payload.audio_base64,
      text: payload.text,
      isDemo: payload.is_demo,
      onRms: (rms) => animator?.setLipSync(rms),
      onPlaybackStarted: () => {
        if (payload.command_id) {
          wsClient.sendPlaybackStarted("speak", payload.command_id);
        }
      },
      onTerminal: (result) => {
        if (!speechPlayer.active) {
          applyRemoteState("idle");
        }
        if (result.commandId) {
          wsClient.sendActionResult("speak", result.commandId, result.status, result.error);
        }
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("Speech playback error:", msg);
    applyRemoteState("idle");
    if (payload.command_id) {
      wsClient.sendActionResult("speak", payload.command_id, "failed", msg);
    }
  }
}

// Backend link with automated readiness and action dispatch
const wsClient = new AvatarWsClient({
  handlers: {
    onStatus(status) {
      connectionLine =
        status === "online"
          ? `live · ${wsClient.endpoint}`
          : status === "connecting"
            ? `connecting ${wsClient.endpoint}`
            : "backend offline — standalone mode";
      refreshStatus();
    },
    onState: applyRemoteState,
    onExpression: applyRemoteExpression,
    onLipSync: (rms, viseme) => {
      externalLipsyncActive = rms > 0;
      animator?.setLipSync(rms, viseme);
    },
    onGaze(x, y) {
      externalGazeActive = true;
      animator?.setGazeTarget(x, y);
    },
    onGesture: (name, commandId) => animator?.triggerGesture(name, commandId),
    onStopGesture: (commandId) => animator?.stopGesture(commandId),
    onFraming: selectFraming,
    onSpeak: (payload) => void handleSpeak(payload),
    onStopSpeak: (commandId) => speechPlayer.stop(commandId),
    onSnapshot: applySnapshot,
  },
});


wsClient.connect();

window.addEventListener("pagehide", () => {
  speechPlayer.dispose();
  animator?.dispose();
  avatar.dispose();
  wsClient.dispose();
});

refreshStatus();
void loadAvatar();

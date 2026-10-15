/**
 * Typed WebSocket channel between the desktop overlay renderer and the native Rust backend.
 *
 * Implements Plan 01 unified contract:
 * - Flat JSON messages with `type`.
 * - Role registration: { type: "register", role: "renderer" }.
 * - Readiness and snapshot restoration across reconnects.
 * - Correlated action results: { type: "action_result", command_id, action, status, error }.
 * - Stale lipsync frame decay.
 */

import { ALL_VISEMES, type AvatarViseme } from "./animator";

export type AvatarStateName = "idle" | "listening" | "thinking" | "speaking";
export type AvatarExpressionName =
  | "neutral"
  | "happy"
  | "angry"
  | "sorrow"
  | "sad"
  | "surprised"
  | "relaxed"
  | "thinking";
export type { AvatarViseme };
export type AvatarGestureName = "nod" | "shake_head" | "tilt_head" | "wave" | "shrug";
export type FramingPreset = "face" | "bust" | "half_body" | "full_body";
export type ActionTerminalStatus = "completed" | "cancelled" | "failed";

export interface AvatarSpeakPayload {
  command_id?: string;
  audio_url?: string;
  audio_base64?: string;
  text?: string;
  emotion?: AvatarExpressionName;
}

export interface AvatarSnapshotPayload {
  state?: AvatarStateName;
  expression?: { name: AvatarExpressionName; intensity: number };
  gaze?: { x: number; y: number };
  framing?: FramingPreset;
}

export type AvatarConnectionStatus = "connecting" | "online" | "offline";

export interface AvatarWsHandlers {
  onStatus?(status: AvatarConnectionStatus): void;
  onState?(state: AvatarStateName): void;
  onExpression?(name: AvatarExpressionName, intensity: number): void;
  onLipSync?(rms: number, viseme: AvatarViseme | null): void;
  onGaze?(x: number, y: number): void;
  onGesture?(name: AvatarGestureName, commandId?: string): void;
  onStopGesture?(commandId?: string): void;
  onFraming?(preset: FramingPreset): void;
  onSpeak?(payload: AvatarSpeakPayload): void;
  onStopSpeak?(commandId?: string): void;
  onSnapshot?(snapshot: AvatarSnapshotPayload): void;
  onReconnected?(): void;
}

export interface AvatarWsOptions {
  url?: string;
  handlers?: AvatarWsHandlers;
}

const DEFAULT_WS_URL = "ws://127.0.0.1:8765/ws/avatar";
const QUERY_PARAM = "ws";
const LOCAL_STORAGE_KEY = "avatar-ws-url";
const RECONNECT_DELAYS_MS = [1000, 2000, 5000] as const;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_PENDING_LIMIT_BYTES = 64;
const LIPSYNC_STALE_TIMEOUT_MS = 150;

const STATE_NAMES: readonly string[] = ["idle", "listening", "thinking", "speaking"];
const EXPRESSION_NAMES: readonly string[] = [
  "neutral",
  "happy",
  "angry",
  "sorrow",
  "sad",
  "surprised",
  "relaxed",
  "thinking",
];
const VISEME_NAMES: readonly string[] = ALL_VISEMES;
const GESTURE_NAMES: readonly string[] = ["nod", "shake_head", "tilt_head", "wave", "shrug"];
const FRAMING_PRESETS: readonly string[] = ["face", "bust", "half_body", "full_body"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isUnitRange(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1;
}

function toWsUrl(url: string): string {
  if (url.startsWith("https://")) return `wss://${url.slice("https://".length)}`;
  if (url.startsWith("http://")) return `ws://${url.slice("http://".length)}`;
  return url;
}

export function resolveAvatarWsUrl(): string {
  const fromQuery = new URLSearchParams(window.location.search).get(QUERY_PARAM);
  if (fromQuery && fromQuery.trim()) return toWsUrl(fromQuery.trim());

  const fromEnv = import.meta.env.VITE_AVATAR_WS_URL;
  if (typeof fromEnv === "string" && fromEnv.trim()) return toWsUrl(fromEnv.trim());

  try {
    const stored = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (stored && stored.trim()) return toWsUrl(stored.trim());
  } catch {
    // Sandboxed webview
  }

  return DEFAULT_WS_URL;
}

export class AvatarWsClient {
  private readonly url: string;
  private readonly handlers: AvatarWsHandlers;
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private lipsyncStaleTimer: number | null = null;
  private reconnectAttempt = 0;
  private disposed = false;
  private statusValue: AvatarConnectionStatus = "offline";
  private lastModelReady: string | null = null;

  constructor(options: AvatarWsOptions = {}) {
    this.url = options.url ?? resolveAvatarWsUrl();
    this.handlers = options.handlers ?? {};
  }

  get endpoint(): string {
    return this.url;
  }

  get status(): AvatarConnectionStatus {
    return this.statusValue;
  }

  connect(): void {
    if (this.disposed || this.socket || this.reconnectTimer !== null) return;
    this.open();
  }

  send(data: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(typeof data === "string" ? data : JSON.stringify(data));
    return true;
  }

  sendReady(model: string): boolean {
    this.lastModelReady = model;
    return this.send({ type: "ready", model });
  }

  sendActionResult(
    action: "gesture" | "speak",
    commandId: string,
    status: ActionTerminalStatus,
    error?: string,
  ): boolean {
    return this.send({
      type: "action_result",
      command_id: commandId,
      action,
      status,
      error,
    });
  }

  sendPlaybackStarted(action: "speak", commandId: string): boolean {
    return this.send({
      type: "playback_started",
      command_id: commandId,
      action,
    });
  }


  dispose(): void {
    this.disposed = true;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.clearLipsyncStaleTimer();
    this.socket?.close();
    this.socket = null;
  }

  private open(): void {
    this.clearReconnectTimer();
    this.setStatus("connecting");

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      this.setStatus("online");

      // Register role as primary renderer
      this.send({ type: "register", role: "renderer" });

      // If we already had a loaded model before reconnect, announce readiness again
      if (this.lastModelReady) {
        this.send({ type: "ready", model: this.lastModelReady });
      }
      this.handlers.onReconnected?.();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) return;
      this.dispatch(event.data);
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopHeartbeat();
      this.clearLipsyncStaleTimer();
      this.setStatus("offline");
      if (!this.disposed) {
        this.reconnectAttempt += 1;
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      // Reconnect handled by onclose
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > HEARTBEAT_PENDING_LIMIT_BYTES) {
        socket.close();
        return;
      }
      this.send({ type: "ping" });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearLipsyncStaleTimer(): void {
    if (this.lipsyncStaleTimer !== null) {
      window.clearTimeout(this.lipsyncStaleTimer);
      this.lipsyncStaleTimer = null;
    }
  }

  private bumpLipsyncStaleTimer(): void {
    this.clearLipsyncStaleTimer();
    this.lipsyncStaleTimer = window.setTimeout(() => {
      this.lipsyncStaleTimer = null;
      this.handlers.onLipSync?.(0, null);
    }, LIPSYNC_STALE_TIMEOUT_MS);
  }

  private setStatus(status: AvatarConnectionStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.handlers.onStatus?.(status);
  }

  private dispatch(raw: unknown): void {
    if (typeof raw !== "string") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    // Support flat message format (canonical) and legacy { event_type, payload } envelope
    const type = parsed.type ?? parsed.event_type;
    const payload = isRecord(parsed.payload) ? parsed.payload : parsed;
    if (typeof type !== "string") return;

    switch (type) {
      case "state": {
        const state = payload.state;
        if (typeof state === "string" && STATE_NAMES.includes(state)) {
          this.handlers.onState?.(state as AvatarStateName);
        }
        return;
      }
      case "expression": {
        const { name, intensity } = payload;
        if (
          typeof name === "string" &&
          EXPRESSION_NAMES.includes(name) &&
          typeof intensity === "number" &&
          Number.isFinite(intensity)
        ) {
          this.handlers.onExpression?.(name as AvatarExpressionName, clamp01(intensity));
        }
        return;
      }
      case "lipsync": {
        const { rms, viseme } = payload;
        if (typeof rms === "number" && Number.isFinite(rms)) {
          const knownViseme =
            typeof viseme === "string" && VISEME_NAMES.includes(viseme)
              ? (viseme as AvatarViseme)
              : null;
          this.bumpLipsyncStaleTimer();
          this.handlers.onLipSync?.(clamp01(rms), knownViseme);
        }
        return;
      }
      case "gaze": {
        const { x, y } = payload;
        if (isUnitRange(x) && isUnitRange(y)) {
          this.handlers.onGaze?.(x, y);
        }
        return;
      }
      case "gesture": {
        const name = payload.name ?? payload.gesture;
        const commandId = typeof payload.command_id === "string" ? payload.command_id : undefined;
        if (typeof name === "string" && GESTURE_NAMES.includes(name)) {
          this.handlers.onGesture?.(name as AvatarGestureName, commandId);
        }
        return;
      }
      case "stop_gesture": {
        const commandId = typeof payload.command_id === "string" ? payload.command_id : undefined;
        this.handlers.onStopGesture?.(commandId);
        return;
      }
      case "framing": {
        const preset = payload.preset ?? payload.name;
        if (typeof preset === "string" && FRAMING_PRESETS.includes(preset)) {
          this.handlers.onFraming?.(preset as FramingPreset);
        }
        return;
      }
      case "speak": {
        this.handlers.onSpeak?.({
          command_id: typeof payload.command_id === "string" ? payload.command_id : undefined,
          audio_url: typeof payload.audio_url === "string" ? payload.audio_url : undefined,
          audio_base64: typeof payload.audio_base64 === "string" ? payload.audio_base64 : undefined,
          text: typeof payload.text === "string" ? payload.text : undefined,
          emotion:
            typeof payload.emotion === "string" && EXPRESSION_NAMES.includes(payload.emotion)
              ? (payload.emotion as AvatarExpressionName)
              : undefined,
        });
        return;
      }
      case "stop_speak": {
        const commandId = typeof payload.command_id === "string" ? payload.command_id : undefined;
        this.handlers.onStopSpeak?.(commandId);
        return;
      }
      case "snapshot": {
        const snap = isRecord(payload.snapshot) ? (payload.snapshot as Record<string, unknown>) : payload;
        const snapshot: AvatarSnapshotPayload = {};
        if (typeof snap.state === "string" && STATE_NAMES.includes(snap.state)) {
          snapshot.state = snap.state as AvatarStateName;
        }
        if (isRecord(snap.expression) && typeof snap.expression.name === "string") {
          snapshot.expression = {
            name: snap.expression.name as AvatarExpressionName,
            intensity: typeof snap.expression.intensity === "number" ? clamp01(snap.expression.intensity) : 1.0,
          };
        }
        if (isRecord(snap.gaze) && isUnitRange(snap.gaze.x) && isUnitRange(snap.gaze.y)) {
          snapshot.gaze = { x: snap.gaze.x, y: snap.gaze.y };
        }
        if (typeof snap.framing === "string" && FRAMING_PRESETS.includes(snap.framing)) {
          snapshot.framing = snap.framing as FramingPreset;
        }
        this.handlers.onSnapshot?.(snapshot);
        return;
      }
      case "ping": {
        this.send({ type: "pong" });
        return;
      }
      case "pong":
        return;
      default:
        return;
    }
  }
}

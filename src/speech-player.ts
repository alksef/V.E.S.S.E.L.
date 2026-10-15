/**
 * Web Audio API Player with robust lifecycle management, race condition prevention,
 * and real-time RMS computation for avatar lipsync.
 */

export type SpeechTerminalStatus = "completed" | "cancelled" | "failed";

export interface SpeechTerminalResult {
  commandId?: string;
  status: SpeechTerminalStatus;
  error?: string;
}

export interface SpeechOptions {
  commandId?: string;
  audioUrl?: string;
  audioBase64?: string;
  text?: string;
  isDemo?: boolean;
  onRms?: (rms: number) => void;
  onPlaybackStarted?: () => void;
  onTerminal?: (result: SpeechTerminalResult) => void;
  /** Backwards-compatible onEnded callback (fires only on completed). */
  onEnded?: () => void;
}

interface ActiveSession {
  readonly id: number;
  readonly commandId?: string;
  readonly abortController: AbortController;
  readonly onRms?: (rms: number) => void;
  readonly onPlaybackStarted?: () => void;
  readonly onTerminal?: (result: SpeechTerminalResult) => void;
  readonly onEnded?: () => void;

  source: AudioBufferSourceNode | null;
  analyser: AnalyserNode | null;
  terminalFired: boolean;
  state: "loading" | "decoding" | "playing" | "terminated";
}

export class SpeechPlayer {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private timeData: Uint8Array<ArrayBuffer> | null = null;
  private isPlaying = false;
  private sessionCounter = 0;
  private activeSession: ActiveSession | null = null;

  private initContext(): AudioContext {
    if (!this.audioContext || this.audioContext.state === "closed") {
      const AudioCtx =
        (typeof window !== "undefined"
          ? window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
          : undefined) ||
        (typeof globalThis !== "undefined" ? (globalThis as any).AudioContext : undefined);
      if (!AudioCtx) {
        throw new Error("AudioContext is not supported in this environment");
      }
      this.audioContext = new AudioCtx();
    }
    return this.audioContext!;
  }

  get active(): boolean {
    return this.isPlaying;
  }

  get currentCommandId(): string | undefined {
    return this.activeSession?.commandId;
  }

  /**
   * Stop currently loading or playing audio immediately.
   * If a commandId is specified, only cancels if it matches the active session.
   * Emits status "cancelled" exactly once to the active session.
   */
  stop(commandId?: string): void {
    if (this.activeSession) {
      if (commandId && this.activeSession.commandId && this.activeSession.commandId !== commandId) {
        return;
      }
      this.terminateSession(this.activeSession, "cancelled");
    }
  }


  /**
   * Play an audio file from URL or base64 string, feeding RMS volume to callback every frame.
   * Cancels any currently pending or playing speech session cleanly.
   */
  async play(options: SpeechOptions): Promise<void> {
    // 1. Validation
    const hasBase64 = typeof options.audioBase64 === "string" && options.audioBase64.trim().length > 0;
    const hasUrl = typeof options.audioUrl === "string" && options.audioUrl.trim().length > 0;
    const isDemo = Boolean(options.isDemo);

    if (!hasBase64 && !hasUrl && !isDemo) {
      const errorMsg =
        "Speech playback requires audio_url or audio_base64. Text transcription alone is not a TTS engine.";
      options.onTerminal?.({
        commandId: options.commandId,
        status: "failed",
        error: errorMsg,
      });
      options.onRms?.(0);
      throw new Error(errorMsg);
    }

    if (hasUrl && !hasBase64) {
      const rawUrl = options.audioUrl!.trim();
      // Detect Windows local filesystem path (e.g. C:\... or \\...)
      if (/^[a-zA-Z]:[\\/]/.test(rawUrl) || rawUrl.startsWith("\\\\") || rawUrl.startsWith("file://")) {
        const errorMsg = `Local filesystem path '${rawUrl}' is not supported. Use HTTP/HTTPS URL or audio_base64 data URI.`;
        options.onTerminal?.({
          commandId: options.commandId,
          status: "failed",
          error: errorMsg,
        });
        options.onRms?.(0);
        throw new Error(errorMsg);
      }
    }

    // 2. Invalidate any existing session immediately
    if (this.activeSession) {
      this.terminateSession(this.activeSession, "cancelled");
    }

    // 3. Create new session with unique generation ID
    const sessionId = ++this.sessionCounter;
    const abortController = new AbortController();
    const session: ActiveSession = {
      id: sessionId,
      commandId: options.commandId,
      abortController,
      onRms: options.onRms,
      onPlaybackStarted: options.onPlaybackStarted,
      onTerminal: options.onTerminal,
      onEnded: options.onEnded,
      source: null,
      analyser: null,
      terminalFired: false,
      state: "loading",
    };

    this.activeSession = session;

    let arrayBuffer: ArrayBuffer;
    try {
      if (hasBase64) {
        arrayBuffer = this.base64ToArrayBuffer(options.audioBase64!);
      } else if (hasUrl) {
        const res = await fetch(options.audioUrl!, { signal: abortController.signal });
        if (!res.ok) {
          throw new Error(`Failed to fetch audio from ${options.audioUrl}: HTTP ${res.status}`);
        }
        arrayBuffer = await res.arrayBuffer();
      } else {
        const ctx = this.initContext();
        arrayBuffer = this.generateTestChirp(ctx);
      }
    } catch (err: unknown) {
      if (abortController.signal.aborted || this.activeSession?.id !== sessionId) {
        this.terminateSession(session, "cancelled");
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.terminateSession(session, "failed", msg);
      throw err;
    }

    // Guard: check if session was superseded or cancelled during fetch
    if (this.activeSession?.id !== sessionId || abortController.signal.aborted) {
      this.terminateSession(session, "cancelled");
      return;
    }

    // 4. Decode audio data
    session.state = "decoding";
    const ctx = this.initContext();

    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (err: unknown) {
        if (this.activeSession?.id !== sessionId || abortController.signal.aborted) {
          this.terminateSession(session, "cancelled");
          return;
        }
        const msg = `AudioContext resume blocked (autoplay restriction): ${err instanceof Error ? err.message : String(err)}`;
        this.terminateSession(session, "failed", msg);
        throw new Error(msg);
      }
    }

    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    } catch (err: unknown) {
      if (this.activeSession?.id !== sessionId || abortController.signal.aborted) {
        this.terminateSession(session, "cancelled");
        return;
      }
      const msg = `Failed to decode audio: ${err instanceof Error ? err.message : String(err)}`;
      this.terminateSession(session, "failed", msg);
      throw new Error(msg);
    }

    // Guard: check if session was superseded during decoding
    if (this.activeSession?.id !== sessionId || abortController.signal.aborted) {
      this.terminateSession(session, "cancelled");
      return;
    }

    // 5. Connect and play
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch {
        // ignore
      }
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.3;
    this.analyser = analyser;
    this.timeData = new Uint8Array(new ArrayBuffer(analyser.fftSize));

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(analyser);
    analyser.connect(ctx.destination);

    session.source = source;
    session.analyser = analyser;
    session.state = "playing";
    this.isPlaying = true;

    source.onended = () => {
      // Isolate old handler: check that this source belongs to active session
      if (this.activeSession?.id === sessionId && !session.terminalFired) {
        this.terminateSession(session, "completed");
      }
    };

    session.onPlaybackStarted?.();
    source.start(0);
  }


  /**
   * Called every animation frame to extract real-time RMS from the audio signal.
   */
  update(): void {
    if (!this.isPlaying || !this.analyser || !this.timeData || !this.activeSession) return;

    this.analyser.getByteTimeDomainData(this.timeData);

    let sumSquares = 0;
    const len = this.timeData.length;
    for (let i = 0; i < len; i++) {
      const norm = (this.timeData[i] - 128) / 128;
      sumSquares += norm * norm;
    }

    const rms = Math.sqrt(sumSquares / len);
    const threshold = 0.02;
    const boosted = rms > threshold ? Math.min(1.0, (rms - threshold) * 2.8) : 0;

    this.activeSession.onRms?.(boosted);
  }

  /** Disposes audio nodes and context cleanly. */
  dispose(): void {
    this.stop();
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch {
        // ignore
      }
      this.analyser = null;
    }
    if (this.audioContext && this.audioContext.state !== "closed") {
      try {
        void this.audioContext.close();
      } catch {
        // ignore
      }
      this.audioContext = null;
    }
    this.timeData = null;
  }

  private terminateSession(session: ActiveSession, status: SpeechTerminalStatus, error?: string): void {
    if (session.terminalFired) return;
    session.terminalFired = true;
    session.state = "terminated";

    try {
      session.abortController.abort();
    } catch {
      // ignore
    }

    if (session.source) {
      session.source.onended = null;
      try {
        session.source.stop();
      } catch {
        // already stopped
      }
      try {
        session.source.disconnect();
      } catch {
        // ignore
      }
      session.source = null;
    }

    if (session.analyser) {
      try {
        session.analyser.disconnect();
      } catch {
        // ignore
      }
      session.analyser = null;
    }

    if (this.activeSession?.id === session.id) {
      this.activeSession = null;
      this.isPlaying = false;
      this.analyser = null;
    }

    session.onRms?.(0);
    session.onTerminal?.({
      commandId: session.commandId,
      status,
      error,
    });
    if (status === "completed") {
      session.onEnded?.();
    }
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const clean = base64.replace(/^data:audio\/[^;]+;base64,/, "");
    const atobFn =
      (typeof atob !== "undefined" ? atob : undefined) ||
      (typeof window !== "undefined" ? window.atob : undefined) ||
      ((s: string) => Buffer.from(s, "base64").toString("binary"));
    const binaryString = atobFn(clean);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  private generateTestChirp(ctx: AudioContext): ArrayBuffer {
    const sampleRate = ctx.sampleRate || 44100;
    const duration = 2.0;
    const numSamples = Math.floor(sampleRate * duration);
    const buffer = ctx.createBuffer(1, numSamples, sampleRate);
    const channel = buffer.getChannelData(0);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const vowelEnv = Math.max(0, Math.sin(t * Math.PI * 4)) * Math.min(1, (duration - t) * 2);
      const pitch = 220 + Math.sin(t * 8) * 35;
      const wave = Math.sin(t * pitch * 2 * Math.PI) * 0.6 + Math.sin(t * pitch * 4 * Math.PI) * 0.3;
      channel[i] = wave * vowelEnv * 0.45;
    }

    return this.audioBufferToWav(buffer);
  }

  private audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
    const numOfChan = buffer.numberOfChannels;
    const length = buffer.length * numOfChan * 2 + 44;
    const out = new DataView(new ArrayBuffer(length));
    let pos = 0;

    const writeString = (s: string) => {
      for (let i = 0; i < s.length; i++) out.setUint8(pos++, s.charCodeAt(i));
    };

    writeString("RIFF");
    out.setUint32(pos, length - 8, true);
    pos += 4;
    writeString("WAVE");
    writeString("fmt ");
    out.setUint32(pos, 16, true);
    pos += 4;
    out.setUint16(pos, 1, true);
    pos += 2;
    out.setUint16(pos, numOfChan, true);
    pos += 2;
    out.setUint32(pos, buffer.sampleRate, true);
    pos += 4;
    out.setUint32(pos, buffer.sampleRate * 2 * numOfChan, true);
    pos += 4;
    out.setUint16(pos, numOfChan * 2, true);
    pos += 2;
    out.setUint16(pos, 16, true);
    pos += 2;
    writeString("data");
    out.setUint32(pos, length - pos - 4, true);
    pos += 4;

    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const sample = Math.max(-1, Math.min(1, data[i]));
      out.setInt16(pos, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      pos += 2;
    }

    return out.buffer;
  }
}

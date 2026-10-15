import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpeechPlayer } from "../src/speech-player";

describe("SpeechPlayer Lifecycle and Concurrency", () => {
  let player: SpeechPlayer;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects play when neither audioUrl nor audioBase64 provided (and isDemo is false)", async () => {
    player = new SpeechPlayer();
    const terminalResults: any[] = [];
    await expect(
      player.play({
        commandId: "cmd-1",
        text: "hello world",
        onTerminal: (res) => terminalResults.push(res),
      }),
    ).rejects.toThrow(/Speech playback requires audio_url or audio_base64/);

    expect(terminalResults).toEqual([
      {
        commandId: "cmd-1",
        status: "failed",
        error: expect.stringContaining("Speech playback requires audio_url"),
      },
    ]);
  });

  it("rejects local Windows filesystem paths for audioUrl", async () => {
    player = new SpeechPlayer();
    const terminalResults: any[] = [];
    await expect(
      player.play({
        commandId: "cmd-win-path",
        audioUrl: "C:\\sounds\\voice.mp3",
        onTerminal: (res) => terminalResults.push(res),
      }),
    ).rejects.toThrow(/Local filesystem path 'C:\\sounds\\voice.mp3' is not supported/);

    expect(terminalResults).toEqual([
      {
        commandId: "cmd-win-path",
        status: "failed",
        error: expect.stringContaining("Local filesystem path"),
      },
    ]);
  });

  it("handles race condition: slow fetch A followed by fast fetch B -> only B plays, A is cancelled", async () => {
    player = new SpeechPlayer();

    let resolveFetchA: (value: any) => void;
    let resolveFetchB: (value: any) => void;

    const promiseA = new Promise((resolve) => {
      resolveFetchA = resolve;
    });
    const promiseB = new Promise((resolve) => {
      resolveFetchB = resolve;
    });

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url === "http://example.com/a.mp3") return promiseA;
      if (url === "http://example.com/b.mp3") return promiseB;
      return Promise.reject(new Error("unexpected url"));
    });
    vi.stubGlobal("fetch", mockFetch);

    const createdSources: any[] = [];
    const mockAudioContext = {
      state: "running",
      sampleRate: 44100,
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      decodeAudioData: vi.fn().mockResolvedValue({ duration: 1.0 }),
      createAnalyser: vi.fn().mockReturnValue({
        fftSize: 256,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      createBufferSource: vi.fn().mockImplementation(() => {
        const src = {
          buffer: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null as any,
        };
        createdSources.push(src);
        return src;
      }),
    };
    vi.stubGlobal("AudioContext", class {
      constructor() {
        return mockAudioContext;
      }
    });

    const eventsA: any[] = [];
    const eventsB: any[] = [];

    // 1. Start slow fetch A
    const playA = player.play({
      commandId: "cmd-A",
      audioUrl: "http://example.com/a.mp3",
      onTerminal: (res) => eventsA.push(res),
    });

    // 2. Start fast fetch B
    const playB = player.play({
      commandId: "cmd-B",
      audioUrl: "http://example.com/b.mp3",
      onTerminal: (res) => eventsB.push(res),
    });

    // A should already be cancelled because B invalidated it
    expect(eventsA).toEqual([{ commandId: "cmd-A", status: "cancelled" }]);

    // Resolve B first
    resolveFetchB!({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });
    await playB;

    // Verify B created exactly 1 source and started it
    expect(createdSources.length).toBe(1);
    expect(createdSources[0].start).toHaveBeenCalled();

    // Now resolve A late
    resolveFetchA!({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });
    await playA;

    // A was aborted, so no additional source is created
    expect(createdSources.length).toBe(1);
    expect(eventsA.length).toBe(1);

    // When B finishes, B emits completed
    createdSources[0].onended();
    expect(eventsB).toEqual([{ commandId: "cmd-B", status: "completed" }]);
  });

  it("handles slow decode A vs fast decode B: outdated decode does not start A", async () => {
    player = new SpeechPlayer();

    let resolveDecodeA: (buf: any) => void;
    let resolveDecodeB: (buf: any) => void;

    const decodePromiseA = new Promise((resolve) => {
      resolveDecodeA = resolve;
    });
    const decodePromiseB = new Promise((resolve) => {
      resolveDecodeB = resolve;
    });

    const createdSources: any[] = [];
    let decodeCallCount = 0;
    const mockAudioContext = {
      state: "running",
      sampleRate: 44100,
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      decodeAudioData: vi.fn().mockImplementation(() => {
        decodeCallCount++;
        return decodeCallCount === 1 ? decodePromiseA : decodePromiseB;
      }),
      createAnalyser: vi.fn().mockReturnValue({
        fftSize: 256,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      createBufferSource: vi.fn().mockImplementation(() => {
        const src = {
          buffer: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null as any,
        };
        createdSources.push(src);
        return src;
      }),
    };
    vi.stubGlobal("AudioContext", class {
      constructor() {
        return mockAudioContext;
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(50)),
    }));

    const eventsA: any[] = [];
    const eventsB: any[] = [];

    // Start A
    const playA = player.play({
      commandId: "cmd-dec-A",
      audioUrl: "http://example.com/a.mp3",
      onTerminal: (res) => eventsA.push(res),
    });
    // Let fetch resolve and reach decodeAudioData
    await new Promise((r) => setTimeout(r, 5));

    // Now start B while A is waiting for decode
    const playB = player.play({
      commandId: "cmd-dec-B",
      audioUrl: "http://example.com/b.mp3",
      onTerminal: (res) => eventsB.push(res),
    });
    await new Promise((r) => setTimeout(r, 5));

    // A was cancelled when B started
    expect(eventsA).toEqual([{ commandId: "cmd-dec-A", status: "cancelled" }]);

    // Resolve decode B first
    resolveDecodeB!({ duration: 1.0 });
    await playB;
    expect(createdSources.length).toBe(1);
    expect(createdSources[0].start).toHaveBeenCalled();

    // Now resolve decode A late
    resolveDecodeA!({ duration: 1.0 });
    await playA;

    // A must not have started
    expect(createdSources.length).toBe(1);
    expect(eventsA.length).toBe(1);
  });

  it("isolates old onended: early source ending does not affect newer session", async () => {
    player = new SpeechPlayer();

    const mockSource1 = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as any,
    };
    const mockSource2 = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as any,
    };

    let count = 0;
    const mockAudioContext = {
      state: "running",
      sampleRate: 44100,
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      decodeAudioData: vi.fn().mockResolvedValue({ duration: 1.0 }),
      createAnalyser: vi.fn().mockReturnValue({
        fftSize: 256,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      createBufferSource: vi.fn().mockImplementation(() => {
        count++;
        return count === 1 ? mockSource1 : mockSource2;
      }),
    };
    vi.stubGlobal("AudioContext", class {
      constructor() {
        return mockAudioContext;
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(50)),
    }));

    const events1: any[] = [];
    const events2: any[] = [];

    // Start 1
    await player.play({
      commandId: "c1",
      audioUrl: "http://example.com/1.mp3",
      onTerminal: (res) => events1.push(res),
    });
    expect(player.active).toBe(true);

    const oldHandler = mockSource1.onended;

    // Start 2 (supersedes 1)
    await player.play({
      commandId: "c2",
      audioUrl: "http://example.com/2.mp3",
      onTerminal: (res) => events2.push(res),
    });
    expect(events1).toEqual([{ commandId: "c1", status: "cancelled" }]);

    // Trigger old onended
    if (oldHandler) oldHandler();

    // 2 should still be playing!
    expect(player.active).toBe(true);
    expect(events2.length).toBe(0);

    // Now end 2
    mockSource2.onended();
    expect(player.active).toBe(false);
    expect(events2).toEqual([{ commandId: "c2", status: "completed" }]);
  });

  it("handles stop() during playing, repeated stop(), and dispose() without double terminal events", async () => {
    player = new SpeechPlayer();

    const mockSource = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as any,
    };
    const mockAudioContext = {
      state: "running",
      sampleRate: 44100,
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      decodeAudioData: vi.fn().mockResolvedValue({ duration: 1.0 }),
      createAnalyser: vi.fn().mockReturnValue({
        fftSize: 256,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      createBufferSource: vi.fn().mockReturnValue(mockSource),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal("AudioContext", class {
      constructor() {
        return mockAudioContext;
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(50)),
    }));

    const events: any[] = [];
    await player.play({
      commandId: "cmd-stop-test",
      audioUrl: "http://example.com/test.mp3",
      onTerminal: (res) => events.push(res),
    });

    expect(player.active).toBe(true);
    player.stop();
    expect(player.active).toBe(false);
    expect(events).toEqual([{ commandId: "cmd-stop-test", status: "cancelled" }]);

    // Repeated stop should not fire another event
    player.stop();
    expect(events.length).toBe(1);

    // Dispose
    player.dispose();
    expect(events.length).toBe(1);
    expect(mockAudioContext.close).toHaveBeenCalled();
  });

  it("handles 20 successive plays without leaking active sources", async () => {
    player = new SpeechPlayer();
    const createdSources: any[] = [];
    const mockAudioContext = {
      state: "running",
      sampleRate: 44100,
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      decodeAudioData: vi.fn().mockResolvedValue({ duration: 1.0 }),
      createAnalyser: vi.fn().mockReturnValue({
        fftSize: 256,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      createBufferSource: vi.fn().mockImplementation(() => {
        const src = {
          buffer: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null as any,
        };
        createdSources.push(src);
        return src;
      }),
    };
    vi.stubGlobal("AudioContext", class {
      constructor() {
        return mockAudioContext;
      }
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(50)),
    }));

    const events: any[] = [];
    for (let i = 0; i < 20; i++) {
      await player.play({
        commandId: `cmd-${i}`,
        audioUrl: `http://example.com/${i}.mp3`,
        onTerminal: (res) => events.push(res),
      });
    }

    // First 19 should be cancelled
    expect(events.filter((e) => e.status === "cancelled").length).toBe(19);
    // Player is active with 20th
    expect(player.active).toBe(true);
    expect(player.currentCommandId).toBe("cmd-19");

    // Complete the 20th
    createdSources[19].onended();
    expect(player.active).toBe(false);
    expect(events[events.length - 1]).toEqual({ commandId: "cmd-19", status: "completed" });
  });

  it("invokes onPlaybackStarted when audio source begins playing", async () => {
    player = new SpeechPlayer();
    let started = false;

    const mockSource = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as any,
    };
    const mockAudioContext = {
      state: "running",
      createAnalyser: vi.fn().mockReturnValue({
        fftSize: 256,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getByteTimeDomainData: vi.fn(),
      }),
      decodeAudioData: vi.fn().mockResolvedValue({}),
      destination: {},
      createBufferSource: vi.fn().mockReturnValue(mockSource),
    };
    vi.stubGlobal("AudioContext", class {
      constructor() {
        return mockAudioContext;
      }
    });

    await player.play({
      commandId: "cmd-start-1",
      audioBase64: "dGVzdA==",
      onPlaybackStarted: () => {
        started = true;
      },
    });

    expect(started).toBe(true);
    expect(mockSource.start).toHaveBeenCalledWith(0);
  });

  it("ignores stop when called with a different commandId than active session", async () => {
    player = new SpeechPlayer();
    const terminalResults: any[] = [];

    const mockSource = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as any,
    };
    const mockAudioContext = {
      state: "running",
      createAnalyser: vi.fn().mockReturnValue({
        fftSize: 256,
        smoothingTimeConstant: 0.3,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getByteTimeDomainData: vi.fn(),
      }),
      decodeAudioData: vi.fn().mockResolvedValue({}),
      destination: {},
      createBufferSource: vi.fn().mockReturnValue(mockSource),
    };
    vi.stubGlobal("AudioContext", class {
      constructor() {
        return mockAudioContext;
      }
    });

    await player.play({
      commandId: "cmd-active",
      audioBase64: "dGVzdA==",
      onTerminal: (res) => terminalResults.push(res),
    });

    expect(player.active).toBe(true);

    // Call stop for a stale / different command ID
    player.stop("cmd-old-stale");

    // Must still be active!
    expect(player.active).toBe(true);
    expect(terminalResults.length).toBe(0);

    // Now call stop with matching command ID
    player.stop("cmd-active");
    expect(player.active).toBe(false);
    expect(terminalResults).toEqual([
      {
        commandId: "cmd-active",
        status: "cancelled",
      },
    ]);
  });
});


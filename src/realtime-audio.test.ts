import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  float32ToInt16,
  int16ToBase64,
  resolveMicWorkletUrl,
  startMicCapture,
} from "./realtime-audio-capture";
import {
  base64ToInt16,
  int16ToFloat32,
  RealtimeSpeaker,
  validateRealtimeAudioChunk,
} from "./realtime-audio-playback";

describe("float32ToInt16", () => {
  it("converts positive values", () => {
    const input = new Float32Array([0.5, 1.0]);
    const output = float32ToInt16(input);
    expect(output[0]).toBe(16383); // 0.5 * 0x7fff
    expect(output[1]).toBe(32767); // 1.0 * 0x7fff
  });

  it("converts negative values", () => {
    const input = new Float32Array([-0.5, -1.0]);
    const output = float32ToInt16(input);
    expect(output[0]).toBe(-16384); // -0.5 * 0x8000
    expect(output[1]).toBe(-32768); // -1.0 * 0x8000
  });

  it("clamps values outside [-1, 1]", () => {
    const input = new Float32Array([2.0, -2.0]);
    const output = float32ToInt16(input);
    expect(output[0]).toBe(32767);
    expect(output[1]).toBe(-32768);
  });
});

describe("int16ToBase64 round-trip", () => {
  it("round-trips through base64", () => {
    const original = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const base64 = int16ToBase64(original);
    const decoded = base64ToInt16(base64);
    expect(decoded).toEqual(original);
  });

  it("handles empty array", () => {
    const original = new Int16Array(0);
    const base64 = int16ToBase64(original);
    const decoded = base64ToInt16(base64);
    expect(decoded).toEqual(original);
  });
});

describe("microphone worklet asset", () => {
  it.each([
    ["Tauri custom protocol", "tauri://localhost/", "tauri://localhost/realtime-mic-processor.js"],
    ["Windows WebView protocol", "http://tauri.localhost/", "http://tauri.localhost/realtime-mic-processor.js"],
    ["Vite development", "http://127.0.0.1:5173/", "http://127.0.0.1:5173/realtime-mic-processor.js"],
    ["nested document", "https://example.test/app/index.html", "https://example.test/app/realtime-mic-processor.js"],
  ])("resolves a same-origin module for %s", (_name, baseUri, expected) => {
    const resolved = resolveMicWorkletUrl(baseUri);
    expect(resolved).toBe(expected);
    expect(resolved.startsWith("blob:")).toBe(false);
  });

  it("rejects an invalid document base instead of falling back to a blob script", () => {
    expect(() => resolveMicWorkletUrl("not a URL")).toThrow();
  });

  it("loads the bundled module and releases the microphone after module failure", async () => {
    const stopTrack = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const addModule = vi.fn().mockRejectedValue(new Error("module rejected"));
    vi.stubGlobal("document", { baseURI: "http://tauri.localhost/" });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: stopTrack }],
        }),
      },
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        audioWorklet = { addModule };
        state = "running";
        resume = vi.fn().mockResolvedValue(undefined);
        createMediaStreamSource = vi.fn(() => ({ disconnect: vi.fn() }));
        close = close;
      },
    );

    await expect(startMicCapture({ onChunk: vi.fn() })).rejects.toThrow(
      "module rejected",
    );
    expect(addModule).toHaveBeenCalledWith(
      "http://tauri.localhost/realtime-mic-processor.js",
    );
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("creates and resumes the capture context before requesting microphone access", async () => {
    const order: string[] = [];
    const addModule = vi.fn().mockRejectedValue(new Error("stop after ordering"));
    vi.stubGlobal("document", { baseURI: "http://tauri.localhost/" });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          order.push("microphone");
          return { getTracks: () => [{ stop: vi.fn() }] };
        }),
      },
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        audioWorklet = { addModule };
        constructor() {
          order.push("context");
        }
        resume = vi.fn(async () => {
          order.push("resume");
        });
        createMediaStreamSource = vi.fn(() => ({ disconnect: vi.fn() }));
        close = vi.fn().mockResolvedValue(undefined);
      },
    );

    await expect(startMicCapture({ onChunk: vi.fn() })).rejects.toThrow(
      "stop after ordering",
    );
    expect(order).toEqual(["context", "resume", "microphone"]);
  });
});

describe("int16ToFloat32", () => {
  it("converts back to float32", () => {
    const int16 = new Int16Array([16383, -16384, 0]);
    const float32 = int16ToFloat32(int16);
    expect(float32[0]).toBeCloseTo(0.5, 4);
    expect(float32[1]).toBeCloseTo(-0.5, 4);
    expect(float32[2]).toBe(0);
  });
});

describe("RealtimeSpeaker", () => {
  let mockCtx: {
    state: string;
    currentTime: number;
    destination: unknown;
    sampleRate: number;
    resume: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    createBuffer: ReturnType<typeof vi.fn>;
    createBufferSource: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockCtx = {
      state: "running",
      currentTime: 0,
      destination: {},
      sampleRate: 24000,
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      createBuffer: vi.fn(
        (_channels: number, length: number, sampleRate: number) => ({
          length,
          sampleRate,
          duration: length / sampleRate,
          getChannelData: () => new Float32Array(length),
        }),
      ),
      createBufferSource: vi.fn(() => ({
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(),
      })),
    };
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          return mockCtx as unknown as AudioContext;
        }
      },
    );
  });

  it("schedules contiguous playback", () => {
    const speaker = new RealtimeSpeaker();
    const base64 = int16ToBase64(new Int16Array([1000, 2000]));
    speaker.enqueue({
      data: base64,
      sampleRate: 24000,
      numChannels: 1,
      samplesPerChannel: 2,
      itemId: null,
    });
    speaker.enqueue({
      data: base64,
      sampleRate: 24000,
      numChannels: 1,
      samplesPerChannel: 2,
      itemId: null,
    });
    // Second enqueue should schedule after first
    speaker.close();
  });

  it("resume() creates the AudioContext proactively (autoplay gate)", async () => {
    // Regression: the original resume() was a no-op when this.ctx was null,
    // so the browser autoplay policy blocked the first output chunk.
    const speaker = new RealtimeSpeaker();
    await speaker.resume();
    expect(mockCtx.createBuffer).not.toHaveBeenCalled();
    // The constructor must have run, so close() should be callable without error.
    speaker.close();
    expect(mockCtx.close).toHaveBeenCalled();
  });

  it("de-interleaves stereo and passes per-channel frame count", () => {
    // Regression: the original enqueue always wrote into channel 0 and used
    // the interleaved sample count as the frame count, so stereo chunks
    // played at double speed with garbled content.
    const speaker = new RealtimeSpeaker();
    // 4 interleaved samples = 2 frames × 2 channels.
    const stereoInt16 = new Int16Array([100, 200, 300, 400]);
    const base64 = int16ToBase64(stereoInt16);
    speaker.enqueue({
      data: base64,
      sampleRate: 24000,
      numChannels: 2,
      samplesPerChannel: 2,
      itemId: null,
    });
    expect(mockCtx.createBuffer).toHaveBeenCalledWith(2, 2, 24000);
    speaker.close();
  });

  it("derives frame count from total samples when samplesPerChannel is null", () => {
    const speaker = new RealtimeSpeaker();
    const stereoInt16 = new Int16Array([100, 200, 300, 400, 500, 600]);
    const base64 = int16ToBase64(stereoInt16);
    speaker.enqueue({
      data: base64,
      sampleRate: 24000,
      numChannels: 2,
      samplesPerChannel: null,
      itemId: null,
    });
    // 6 interleaved samples / 2 channels = 3 frames per channel.
    expect(mockCtx.createBuffer).toHaveBeenCalledWith(2, 3, 24000);
    speaker.close();
  });
});

describe("hostile realtime output", () => {
  const chunk = (overrides: Record<string, unknown> = {}) => ({
    data: int16ToBase64(new Int16Array([1, 2])),
    sampleRate: 24000,
    numChannels: 1,
    samplesPerChannel: 2,
    itemId: null,
    ...overrides,
  });

  it.each([
    ["invalid base64", { data: "%%%" }],
    ["unsupported rate", { sampleRate: 48000 }],
    ["impossible channels", { numChannels: 0 }],
    ["inconsistent frames", { samplesPerChannel: 3 }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => validateRealtimeAudioChunk(chunk(overrides))).toThrow();
  });

  it("rejects oversized decoded allocations", () => {
    const oversized = btoa("\0".repeat(960_002));
    expect(() => validateRealtimeAudioChunk(chunk({ data: oversized }))).toThrow(
      /maximum size/,
    );
  });
});

import type { ThreadRealtimeAudioChunk } from "./generated/codex-app-server/v2/ThreadRealtimeAudioChunk";

const MAX_AUDIO_BYTES = 960_000;

function decodeBase64(base64: string): string {
  if (base64.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4) {
    throw new Error("Realtime audio exceeds the maximum size");
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error("Realtime audio contains invalid base64");
  }
  if (binary.length > MAX_AUDIO_BYTES) {
    throw new Error("Realtime audio exceeds the maximum size");
  }
  if (binary.length % 2 !== 0) {
    throw new Error("Realtime PCM16 audio has an odd byte length");
  }
  return binary;
}

function base64ToInt16(base64: string): Int16Array {
  const binary = decodeBase64(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

export function validateRealtimeAudioChunk(
  chunk: ThreadRealtimeAudioChunk,
): { samples: Int16Array; frameCount: number } {
  if (chunk.sampleRate !== 24000) {
    throw new Error(`Unsupported realtime sample rate: ${chunk.sampleRate}`);
  }
  if (!Number.isInteger(chunk.numChannels) || chunk.numChannels < 1 || chunk.numChannels > 2) {
    throw new Error(`Invalid realtime channel count: ${chunk.numChannels}`);
  }
  const samples = base64ToInt16(chunk.data);
  if (samples.length % chunk.numChannels !== 0) {
    throw new Error("Realtime sample count is inconsistent with channel count");
  }
  const frameCount = samples.length / chunk.numChannels;
  if (
    chunk.samplesPerChannel !== null &&
    chunk.samplesPerChannel !== frameCount
  ) {
    throw new Error("Realtime frame count is inconsistent with the payload");
  }
  return { samples, frameCount };
}

function int16ToFloat32(int16: Int16Array): Float32Array {
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
  }
  return float32;
}

export class RealtimeSpeaker {
  private ctx: AudioContext | null = null;
  private nextStartTime = 0;

  /**
   * Create (if needed) and resume the AudioContext. Must be called from a user
   * gesture (e.g. the voice-button click handler) to satisfy browser autoplay
   * policies before the first output audio chunk arrives.
   */
  async resume(): Promise<void> {
    if (!this.ctx) {
      // Create at 24 kHz up front so the gesture satisfies the autoplay gate.
      // If a later chunk arrives at a different sampleRate we recreate the
      // context (rare; the app-server emits a consistent rate per session).
      this.ctx = new AudioContext({ sampleRate: 24000 });
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  enqueue(chunk: ThreadRealtimeAudioChunk): void {
    const { samples: int16, frameCount } = validateRealtimeAudioChunk(chunk);
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: chunk.sampleRate });
    }
    const numChannels = chunk.numChannels;
    const sampleRate = chunk.sampleRate;
    const buffer = this.ctx.createBuffer(numChannels, frameCount, sampleRate);
    // De-interleave: input is [L0, R0, L1, R1, ...] for stereo.
    for (let c = 0; c < numChannels; c++) {
      const channelData = buffer.getChannelData(c);
      for (let i = 0; i < frameCount; i++) {
        const sample = int16[i * numChannels + c] ?? 0;
        channelData[i] = sample / (sample < 0 ? 0x8000 : 0x7fff);
      }
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    if (this.nextStartTime < now) {
      this.nextStartTime = now;
    }
    source.start(this.nextStartTime);
    this.nextStartTime += buffer.duration;
  }

  close(): void {
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
    this.nextStartTime = 0;
  }
}

export { base64ToInt16, int16ToFloat32 };

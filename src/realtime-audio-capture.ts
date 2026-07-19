const SAMPLE_RATE = 24000;

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function int16ToBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export { float32ToInt16, int16ToBase64 };

const MIC_WORKLET_ASSET = "realtime-mic-processor.js";

/**
 * Resolve the processor from the bundled frontend origin. Production CSP keeps
 * `script-src` restricted to self, so microphone capture must never depend on
 * a dynamically generated blob script.
 */
export function resolveMicWorkletUrl(baseUri: string): string {
  return new URL(MIC_WORKLET_ASSET, baseUri).href;
}

type MicCaptureOptions = {
  onChunk: (base64Data: string) => void;
  sampleRate?: number;
};

export async function startMicCapture(
  options: MicCaptureOptions,
): Promise<{ stop: () => void }> {
  const { onChunk, sampleRate = SAMPLE_RATE } = options;
  let stream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let sink: GainNode | null = null;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    worklet?.disconnect();
    source?.disconnect();
    sink?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    void audioContext?.close().catch(() => {});
  };

  try {
    // Construct and resume synchronously from the click-triggered call path.
    // Waiting for app-server startup or even getUserMedia first loses WebView's
    // transient user activation and makes resume() fail after the modal opens.
    audioContext = new AudioContext({ sampleRate });
    await audioContext.resume();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
    source = audioContext.createMediaStreamSource(stream);
    await audioContext.audioWorklet.addModule(
      resolveMicWorkletUrl(document.baseURI),
    );

    worklet = new AudioWorkletNode(audioContext, "mic-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    sink = audioContext.createGain();
    sink.gain.value = 0;
    source.connect(worklet);
    worklet.connect(sink);
    sink.connect(audioContext.destination);

    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (stopped) return;
      onChunk(int16ToBase64(float32ToInt16(event.data)));
    };
    if (audioContext.state === "suspended") await audioContext.resume();
    return { stop };
  } catch (error) {
    stop();
    throw error;
  }
}

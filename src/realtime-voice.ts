import type { RealtimeVoicesList } from "./generated/codex-app-server/RealtimeVoicesList";
import type { ThreadRealtimeAudioChunk } from "./generated/codex-app-server/v2/ThreadRealtimeAudioChunk";

export type VoiceSessionState = "idle" | "starting" | "live" | "error";

export type TranscriptTurn = {
  role: "user" | "assistant";
  text: string;
  final: boolean;
  at: number;
};

export type VoiceStore = {
  sessionKey: string;
  state: VoiceSessionState;
  transcript: TranscriptTurn[];
  voice: string;
  outputModality: "text" | "audio";
  error: string | null;
  threadId: string | null;
  realtimeSessionId: string | null;
};

export const initialVoiceStore = (sessionKey: string): VoiceStore => ({
  sessionKey,
  state: "idle",
  transcript: [],
  voice: "",
  outputModality: "audio",
  error: null,
  threadId: null,
  realtimeSessionId: null,
});

export function applyStarted(
  store: VoiceStore,
  payload: { threadId: string; realtimeSessionId?: string; version?: string },
): VoiceStore {
  return {
    ...store,
    state: "live",
    threadId: payload.threadId,
    realtimeSessionId: payload.realtimeSessionId ?? store.realtimeSessionId,
    error: null,
  };
}

export function applyTranscriptDelta(
  store: VoiceStore,
  payload: { role: string; delta: string },
): VoiceStore {
  const role = payload.role === "assistant" ? "assistant" : "user";
  const transcript = [...store.transcript];
  const last = transcript[transcript.length - 1];
  if (last && last.role === role && !last.final) {
    transcript[transcript.length - 1] = {
      ...last,
      text: last.text + payload.delta,
    };
  } else {
    transcript.push({ role, text: payload.delta, final: false, at: Date.now() });
  }
  return { ...store, transcript };
}

export function applyTranscriptDone(store: VoiceStore): VoiceStore {
  const transcript = [...store.transcript];
  if (transcript.length > 0) {
    transcript[transcript.length - 1] = {
      ...transcript[transcript.length - 1],
      final: true,
    };
  }
  return { ...store, transcript };
}

export function applyOutputAudio(
  store: VoiceStore,
  _payload: { audio: ThreadRealtimeAudioChunk },
): VoiceStore {
  return store;
}

export function applyError(
  store: VoiceStore,
  payload: { message: string },
): VoiceStore {
  return { ...store, state: "error", error: payload.message };
}

export function applyClosed(
  store: VoiceStore,
  _payload: { reason: string },
): VoiceStore {
  return {
    ...store,
    state: "idle",
    threadId: null,
    realtimeSessionId: null,
  };
}

export function resetStore(sessionKey: string): VoiceStore {
  return initialVoiceStore(sessionKey);
}

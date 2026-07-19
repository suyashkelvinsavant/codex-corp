import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RealtimeVoicesList } from "./generated/codex-app-server/RealtimeVoicesList";
import type { ThreadRealtimeAudioChunk } from "./generated/codex-app-server/v2/ThreadRealtimeAudioChunk";

export type StartRealtimeParams = {
  sessionKey: string;
  surface: "company" | "architect";
  model?: string;
  effort?: string;
  workspacePath?: string;
  voice?: string;
  outputModality: string;
  baseInstructions?: string;
  developerInstructions?: string;
  contextDigest?: string;
  recentTranscript?: string;
  dynamicTools?: unknown[];
};

export type StartRealtimeResult = {
  threadId: string;
  realtimeSessionId?: string;
  version?: string;
};

export async function listCodexVoices(): Promise<RealtimeVoicesList> {
  return invoke("list_codex_voices");
}

export async function startCodexRealtime(
  params: StartRealtimeParams,
): Promise<StartRealtimeResult> {
  return invoke("start_codex_realtime", { request: params });
}

export async function appendCodexRealtimeAudio(
  sessionKey: string,
  audio: ThreadRealtimeAudioChunk,
): Promise<void> {
  return invoke("append_codex_realtime_audio", {
    request: { sessionKey, audio },
  });
}

export async function appendCodexRealtimeText(
  sessionKey: string,
  text: string,
): Promise<void> {
  return invoke("append_codex_realtime_text", {
    request: { sessionKey, text },
  });
}

export async function appendCodexRealtimeSpeech(
  sessionKey: string,
  text: string,
): Promise<void> {
  return invoke("append_codex_realtime_speech", {
    request: { sessionKey, text },
  });
}

export async function stopCodexRealtime(
  sessionKey: string,
): Promise<void> {
  return invoke("stop_codex_realtime", { sessionKey });
}

// ---- Listener registrations ----
//
// Each helper returns a Promise<UnlistenFn> so the caller can `await` it before
// triggering the action that produces events. The earlier synchronous-return
// shape raced: `listen()` is async, so events fired before the underlying
// registration completed were silently dropped, and rapid register/unregister
// leaked the listener (the returned closure's `unlisten` was still null).

export type RealtimeStartedPayload = {
  sessionKey: string;
  threadId: string;
  realtimeSessionId?: string;
  version?: string;
};
export function onRealtimeStarted(
  sessionKey: string,
  handler: (payload: RealtimeStartedPayload) => void,
): Promise<UnlistenFn> {
  return listen<RealtimeStartedPayload>("codex-realtime-started", (event) =>
    event.payload.sessionKey === sessionKey && handler(event.payload),
  );
}

export type RealtimeTranscriptDeltaPayload = {
  sessionKey: string;
  threadId: string;
  role: string;
  delta: string;
};
export function onRealtimeTranscriptDelta(
  sessionKey: string,
  handler: (payload: RealtimeTranscriptDeltaPayload) => void,
): Promise<UnlistenFn> {
  return listen<RealtimeTranscriptDeltaPayload>(
    "codex-realtime-transcript-delta",
    (event) => event.payload.sessionKey === sessionKey && handler(event.payload),
  );
}

export type RealtimeTranscriptDonePayload = { sessionKey: string; threadId: string };
export function onRealtimeTranscriptDone(
  sessionKey: string,
  handler: (payload: RealtimeTranscriptDonePayload) => void,
): Promise<UnlistenFn> {
  return listen<RealtimeTranscriptDonePayload>(
    "codex-realtime-transcript-done",
    (event) => event.payload.sessionKey === sessionKey && handler(event.payload),
  );
}

export type RealtimeOutputAudioPayload = {
  sessionKey: string;
  threadId: string;
  audio: ThreadRealtimeAudioChunk;
};
export function onRealtimeOutputAudio(
  sessionKey: string,
  handler: (payload: RealtimeOutputAudioPayload) => void,
): Promise<UnlistenFn> {
  return listen<RealtimeOutputAudioPayload>(
    "codex-realtime-output-audio",
    (event) => event.payload.sessionKey === sessionKey && handler(event.payload),
  );
}

export type RealtimeErrorPayload = { sessionKey: string; threadId: string; message: string };
export function onRealtimeError(
  sessionKey: string,
  handler: (payload: RealtimeErrorPayload) => void,
): Promise<UnlistenFn> {
  return listen<RealtimeErrorPayload>("codex-realtime-error", (event) =>
    event.payload.sessionKey === sessionKey && handler(event.payload),
  );
}

export type RealtimeClosedPayload = { sessionKey: string; threadId: string; reason: string };
export function onRealtimeClosed(
  sessionKey: string,
  handler: (payload: RealtimeClosedPayload) => void,
): Promise<UnlistenFn> {
  return listen<RealtimeClosedPayload>("codex-realtime-closed", (event) =>
    event.payload.sessionKey === sessionKey && handler(event.payload),
  );
}

export type RealtimeToolCallPayload = {
  requestId: string;
  sessionKey: string;
  surface: "company" | "architect";
  tool: string;
  arguments: unknown;
};

export function onRealtimeToolCall(
  sessionKey: string,
  handler: (payload: RealtimeToolCallPayload) => void,
): Promise<UnlistenFn> {
  return listen<RealtimeToolCallPayload>("mediator-tool-call", (event) =>
    event.payload.sessionKey === sessionKey && handler(event.payload),
  );
}

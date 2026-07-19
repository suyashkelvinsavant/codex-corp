import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Copy,
  GitBranch,
  MessageSquarePlus,
  Network,
  Pencil,
  Phone,
  PhoneOff,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import type {
  ByteVoiceContext,
  MediatorTurnRequest,
  MediatorTurnResult,
  VoiceToolResolver,
} from "./agent-chat-page";
import { invoke } from "@tauri-apps/api/core";
import { listWorkflows, templateStats } from "./templates";
import {
  createSession,
  hydrateChatStore,
  loadChatStore,
  makeMessage,
  saveChatStore,
  titleFromFirstMessage,
  type ChatMessage,
  type ChatSession,
  type WorkflowChatStore,
} from "./workflow-chat";
import type { RealtimeVoicesList } from "./generated/codex-app-server/RealtimeVoicesList";
import {
  applyClosed,
  applyError,
  applyOutputAudio,
  applyStarted,
  applyTranscriptDelta,
  applyTranscriptDone,
  initialVoiceStore,
  resetStore,
  type VoiceStore,
} from "./realtime-voice";
import {
  appendCodexRealtimeAudio,
  listCodexVoices,
  onRealtimeClosed,
  onRealtimeError,
  onRealtimeOutputAudio,
  onRealtimeStarted,
  onRealtimeTranscriptDelta,
  onRealtimeTranscriptDone,
  onRealtimeToolCall,
  startCodexRealtime,
  stopCodexRealtime,
} from "./realtime-voice-client";
import { startMicCapture } from "./realtime-audio-capture";
import { RealtimeSpeaker } from "./realtime-audio-playback";
import { VoicePanel } from "./voice-panel";
import { useByteVoiceSession } from "./use-byte-voice-session";
import { isRealtimeUnavailableError } from "./codex-capabilities";

const ARCHITECT_CHAT_SCOPE = "__workflow-architect__";

export type WorkflowArchitectPageProps = {
  revision: number;
  initialPrompt?: string;
  onBack: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onTurn?: (req: MediatorTurnRequest) => Promise<MediatorTurnResult>;
  voiceContext: ByteVoiceContext;
  onVoiceToolCall: VoiceToolResolver;
  voiceAvailable: boolean;
  onVoiceUnavailable: () => void;
};
import { STARTERS } from "./shared/architect-presets";

function loadArchitectStore(): WorkflowChatStore {
  const stored = loadChatStore(ARCHITECT_CHAT_SCOPE);
  if (stored.sessions.length) {
    const activeSessionId = stored.sessions.some(
      (session) => session.id === stored.activeSessionId,
    )
      ? stored.activeSessionId
      : stored.sessions[0].id;
    return { ...stored, activeSessionId };
  }
  const session = createSession(ARCHITECT_CHAT_SCOPE);
  const next = { sessions: [session], activeSessionId: session.id };
  saveChatStore(ARCHITECT_CHAT_SCOPE, next);
  return next;
}

function relativeTime(iso: string): string {
  const minutes = Math.floor(
    Math.max(0, Date.now() - new Date(iso).getTime()) / 60_000,
  );
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(iso).toLocaleDateString();
}

export function WorkflowArchitectPage({
  revision,
  initialPrompt,
  onBack,
  onEdit,
  onDelete,
  onDuplicate,
  onTurn,
  voiceContext,
  onVoiceToolCall,
  voiceAvailable,
  onVoiceUnavailable,
}: WorkflowArchitectPageProps) {
  const workflows = useMemo(() => listWorkflows(), [revision]);
  const [selected, setSelected] = useState(workflows[0]?.id ?? "");
  const [store, setStore] = useState<WorkflowChatStore>(loadArchitectStore);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const initialPromptUsed = useRef(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const voiceStoreRef = useRef<VoiceStore>(
    initialVoiceStore(`architect-${Date.now()}`),
  );
  const [voiceSnapshot, setVoiceSnapshot] = useState<VoiceStore>(
    voiceStoreRef.current,
  );
  const [voices, setVoices] = useState<RealtimeVoicesList | null>(null);
  const speakerRef = useRef<RealtimeSpeaker>(new RealtimeSpeaker());
  const stopMicRef = useRef<(() => void) | null>(null);
  const voiceListenersRef = useRef<(() => void)[]>([]);
  // Tracks the live threadId so mic frames are not sent with an empty threadId
  // before the /started notification arrives. Seeded from startCodexRealtime's
  // synchronous return value and refined by /started.
  const threadIdRef = useRef<string | null>(null);
  const voiceSession = useByteVoiceSession();
  const persistedVoiceSessionsRef = useRef(new Set<string>());
  const activeSession = useMemo(
    () =>
      store.sessions.find((session) => session.id === store.activeSessionId) ??
      store.sessions[0] ??
      null,
    [store],
  );
  const messages = activeSession?.messages ?? [];
  const sortedSessions = useMemo(
    () =>
      [...store.sessions].sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [store.sessions],
  );

  const persist = (next: WorkflowChatStore) => {
    setStore(next);
    saveChatStore(ARCHITECT_CHAT_SCOPE, next);
  };

  useEffect(() => {
    let cancelled = false;
    void hydrateChatStore(ARCHITECT_CHAT_SCOPE).then((hydrated) => {
      if (cancelled) return;
      let next = hydrated;
      if (!next.sessions.length) {
        const session = createSession(ARCHITECT_CHAT_SCOPE);
        next = { sessions: [session], activeSessionId: session.id };
        saveChatStore(ARCHITECT_CHAT_SCOPE, next);
      } else if (
        !next.activeSessionId ||
        !next.sessions.some((session) => session.id === next.activeSessionId)
      ) {
        next = { ...next, activeSessionId: next.sessions[0].id };
        saveChatStore(ARCHITECT_CHAT_SCOPE, next);
      }
      setStore(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!workflows.some((workflow) => workflow.id === selected))
      setSelected(workflows[0]?.id ?? "");
  }, [selected, workflows]);

  const send = async (
    text = draft,
    targetSession = activeSession,
    baseStore = store,
  ) => {
    const value = text.trim();
    if (!value || !targetSession || sending) return;
    const user = makeMessage("user", value);
    const pending = makeMessage("mediator", "", "progress");
    const session: ChatSession = {
      ...targetSession,
      title: targetSession.messages.length
        ? targetSession.title
        : titleFromFirstMessage(value),
      updatedAt: pending.at,
      messages: [...targetSession.messages, user, pending],
    };
    persist({
      ...baseStore,
      sessions: baseStore.sessions.map((item) =>
        item.id === session.id ? session : item,
      ),
      activeSessionId: session.id,
    });
    setDraft("");
    setSending(true);
    try {
      if (!onTurn)
        throw new Error(
          "Byte requires the Codex Corp desktop runtime.",
        );
      let streamed = "";
      const result = await onTurn({
        text: value,
        attachments: [],
        history: targetSession.messages
          .filter(
            (message) => message.role === "user" || message.role === "mediator",
          )
          .slice(-12)
          .map(({ role, text }) => ({ role, text })),
        sessionId: session.id,
        messageId: pending.id,
        threadId: session.mediatorThreadId,
        model: "",
        effort: "high",
        onDelta: (delta) => {
          streamed += delta;
          setStore((current) => ({
            ...current,
            sessions: current.sessions.map((item) =>
              item.id !== session.id
                ? item
                : {
                    ...item,
                    messages: item.messages.map((message) =>
                      message.id === pending.id
                        ? { ...message, text: streamed }
                        : message,
                    ),
                  },
            ),
          }));
        },
      });
      const current = loadChatStore(ARCHITECT_CHAT_SCOPE);
      const now = new Date().toISOString();
      const next: WorkflowChatStore = {
        ...current,
        sessions: current.sessions.map((item) =>
          item.id !== session.id
            ? item
            : {
                ...item,
                mediatorThreadId: result.threadId || item.mediatorThreadId,
                updatedAt: now,
                messages: item.messages.map((message) =>
                  message.id === pending.id
                    ? {
                        ...message,
                        text:
                          result.summary || streamed || "No response returned.",
                        at: now,
                        kind: "status",
                      }
                    : message,
                ),
              },
        ),
      };
      saveChatStore(ARCHITECT_CHAT_SCOPE, next);
      setStore(next);
    } catch (error) {
      const current = loadChatStore(ARCHITECT_CHAT_SCOPE);
      const now = new Date().toISOString();
      const next: WorkflowChatStore = {
        ...current,
        sessions: current.sessions.map((item) =>
          item.id !== session.id
            ? item
            : {
                ...item,
                updatedAt: now,
                messages: item.messages.map((message) =>
                  message.id === pending.id
                    ? {
                        ...message,
                        text: String(
                          error instanceof Error ? error.message : error,
                        ),
                        at: now,
                        kind: "error",
                      }
                    : message,
                ),
              },
        ),
      };
      saveChatStore(ARCHITECT_CHAT_SCOPE, next);
      setStore(next);
    } finally {
      setSending(false);
    }
  };

  const startNewChat = (prompt?: string) => {
    if (sending) return;
    const session = createSession(ARCHITECT_CHAT_SCOPE);
    const next = {
      sessions: [session, ...store.sessions],
      activeSessionId: session.id,
    };
    persist(next);
    if (prompt) {
      setDraft(prompt);
    } else {
      setDraft("");
    }
  };

  const deleteSession = (id: string) => {
    if (sending && id === activeSession?.id) return;
    const remaining = store.sessions.filter((session) => session.id !== id);
    if (!remaining.length) {
      const session = createSession(ARCHITECT_CHAT_SCOPE);
      persist({ sessions: [session], activeSessionId: session.id });
      return;
    }
    persist({
      sessions: remaining,
      activeSessionId:
        store.activeSessionId === id ? remaining[0].id : store.activeSessionId,
    });
  };

  const emitVoice = (next: VoiceStore) => {
    voiceStoreRef.current = next;
    setVoiceSnapshot({ ...next });
  };

  const cleanupVoiceListeners = () => {
    voiceListenersRef.current.forEach((unlisten) => {
      try {
        unlisten();
      } catch {
        /* already torn down */
      }
    });
    voiceListenersRef.current = [];
  };

  const persistVoiceTranscript = (transcript: VoiceStore["transcript"]) => {
    if (!transcript.length || !activeSession) return;
    const sessionKey = voiceStoreRef.current.sessionKey;
    if (persistedVoiceSessionsRef.current.has(sessionKey)) return;
    const voiceMessages = transcript
      .filter((turn) => turn.text.trim())
      .map((turn) =>
        makeMessage(turn.role === "user" ? "user" : "mediator", turn.text),
      );
    if (!voiceMessages.length) return;
    persistedVoiceSessionsRef.current.add(sessionKey);
    const session: ChatSession = {
      ...activeSession,
      updatedAt: new Date().toISOString(),
      messages: [...activeSession.messages, ...voiceMessages],
    };
    persist({
      ...store,
      sessions: store.sessions.map((item) =>
        item.id === session.id ? session : item,
      ),
    });
  };

  const stopVoiceSession = async (closePanel = true) => {
    const activeKey = voiceSession.claimStop();
    cleanupVoiceListeners();
    if (stopMicRef.current) {
      stopMicRef.current();
      stopMicRef.current = null;
    }
    threadIdRef.current = null;
    if (activeKey) {
      try {
        await stopCodexRealtime(activeKey);
      } catch {
        // best-effort
      }
    }
    speakerRef.current.close();
    speakerRef.current = new RealtimeSpeaker();
    if (closePanel) {
      emitVoice(resetStore(voiceStoreRef.current.sessionKey));
      setVoiceOpen(false);
    }
  };

  useEffect(() => {
    return () => {
      const key = voiceSession.claimStop();
      if (key) void stopCodexRealtime(key).catch(() => {});
      stopMicRef.current?.();
      cleanupVoiceListeners();
      speakerRef.current.close();
    };
  }, []);

  const startVoiceSession = async () => {
    const sessionKey = `architect-${Date.now()}`;
    const sessionToken = voiceSession.begin(sessionKey);
    const initial = initialVoiceStore(sessionKey);
    emitVoice({ ...initial, state: "starting" });
    const capturePromise = startMicCapture({
      onChunk: (base64Data) => {
        void appendCodexRealtimeAudio(sessionKey, {
          data: base64Data,
          sampleRate: 24000,
          numChannels: 1,
          samplesPerChannel: 2400,
          itemId: null,
        }).catch(() => {});
      },
    });
    void capturePromise.catch(() => {});

    cleanupVoiceListeners();
    try {
      // Await every listener before starting the server. A registration
      // failure is handled by the same cleanup path as a later startup error.
      const unlisteners = await Promise.all([
      onRealtimeStarted(sessionKey, (payload) => {
        threadIdRef.current = payload.threadId;
        emitVoice(applyStarted(voiceStoreRef.current, payload));
      }),
      onRealtimeTranscriptDelta(sessionKey, (payload) => {
        emitVoice(applyTranscriptDelta(voiceStoreRef.current, payload));
      }),
      onRealtimeTranscriptDone(sessionKey, () => {
        emitVoice(applyTranscriptDone(voiceStoreRef.current));
      }),
      onRealtimeOutputAudio(sessionKey, (payload) => {
        try {
          emitVoice(applyOutputAudio(voiceStoreRef.current, payload));
          speakerRef.current.enqueue(payload.audio);
        } catch (failure) {
          emitVoice(
            applyError(voiceStoreRef.current, {
              message: failure instanceof Error ? failure.message : String(failure),
            }),
          );
          void stopVoiceSession(false);
        }
      }),
      onRealtimeError(sessionKey, (payload) => {
        if (isRealtimeUnavailableError(payload.message)) onVoiceUnavailable();
        emitVoice(applyError(voiceStoreRef.current, payload));
        persistVoiceTranscript(voiceStoreRef.current.transcript);
        void stopVoiceSession(false);
      }),
      onRealtimeClosed(sessionKey, (payload) => {
        emitVoice(applyClosed(voiceStoreRef.current, payload));
        persistVoiceTranscript(voiceStoreRef.current.transcript);
        void stopVoiceSession(false);
      }),
      onRealtimeToolCall(sessionKey, async (payload) => {
        try {
          const result = await onVoiceToolCall("architect", payload.tool, payload.arguments);
          await invoke("respond_mediator_tool", {
            requestId: payload.requestId,
            success: result.success,
            content: result.text,
          });
        } catch (failure) {
          await invoke("respond_mediator_tool", {
            requestId: payload.requestId,
            success: false,
            content: JSON.stringify({ error: String(failure) }),
          }).catch(() => undefined);
        }
      }),
      ]);
      voiceListenersRef.current = unlisteners;
      if (!voiceSession.isCurrent(sessionToken)) {
        cleanupVoiceListeners();
        return;
      }

      if (!voices) {
        const list = await listCodexVoices();
        setVoices(list);
      }
      await speakerRef.current.resume();
      const result = await startCodexRealtime({
        sessionKey,
        surface: "architect",
        effort: "high",
        outputModality: voiceStoreRef.current.outputModality,
        voice: voiceStoreRef.current.voice || undefined,
        baseInstructions: voiceContext.baseInstructions,
        developerInstructions: voiceContext.developerInstructions,
        contextDigest: voiceContext.contextDigest,
        recentTranscript: messages
          .slice(-12)
          .map((message) => `${message.role === "user" ? "Operator" : "Byte"}: ${message.text}`)
          .join("\n")
          .slice(-12_000),
        dynamicTools: voiceContext.dynamicTools,
      });
      if (!voiceSession.isCurrent(sessionToken)) {
        await stopCodexRealtime(sessionKey).catch(() => {});
        return;
      }
      // Seed threadId synchronously so the first mic frame is not sent with
      // an empty threadId (the app-server rejects appendAudio without one).
      threadIdRef.current = result.threadId;
      if (activeSession) {
        persist({
          ...store,
          sessions: store.sessions.map((session) =>
            session.id === activeSession.id
              ? { ...session, mediatorThreadId: result.threadId, updatedAt: new Date().toISOString() }
              : session,
          ),
        });
      }
      const mic = await capturePromise;
      if (!voiceSession.isCurrent(sessionToken)) {
        mic.stop();
        await stopCodexRealtime(sessionKey).catch(() => {});
        return;
      }
      stopMicRef.current = mic.stop;
    } catch (error) {
      if (isRealtimeUnavailableError(error)) onVoiceUnavailable();
      emitVoice(
        applyError(voiceStoreRef.current, {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      cleanupVoiceListeners();
      void capturePromise.then((capture) => capture.stop()).catch(() => {});
      stopMicRef.current?.();
      stopMicRef.current = null;
      await stopCodexRealtime(sessionKey).catch(() => {});
      voiceSession.claimStop();
      speakerRef.current.close();
    }
  };

  const toggleVoiceMode = async () => {
    if (voiceOpen) {
      persistVoiceTranscript(voiceStoreRef.current.transcript);
      await stopVoiceSession();
    } else {
      void speakerRef.current.resume().catch(() => {});
      setVoiceOpen(true);
      await startVoiceSession();
    }
  };

  useEffect(() => {
    if (!initialPrompt || initialPromptUsed.current) return;
    initialPromptUsed.current = true;
    startNewChat(initialPrompt);
  }, [initialPrompt]);

  return (
    <div className="architect-shell">
      <aside
        className="architect-rail"
        aria-label="Byte chat history"
      >
        <button className="agent-chat-back" onClick={onBack}>
          <ArrowLeft size={14} /> Workflows
        </button>
        <div className="architect-brand">
          <span>
            <GitBranch size={18} />
          </span>
          <div>
            <small>WORKFLOW COMPANION</small>
            <b>Byte</b>
          </div>
        </div>
        <button className="architect-new" onClick={() => startNewChat()}>
          <MessageSquarePlus size={14} /> New chat
        </button>
        <div className="architect-catalog-label">
          Previous chats <span>{store.sessions.length}</span>
        </div>
        <ul className="architect-history">
          {sortedSessions.map((session) => (
            <li key={session.id}>
              <button
                className={session.id === activeSession?.id ? "active" : ""}
                onClick={() =>
                  !sending && persist({ ...store, activeSessionId: session.id })
                }
              >
                <span>
                  <b>{session.title}</b>
                  <small>{relativeTime(session.updatedAt)}</small>
                </span>
              </button>
              <button
                className="architect-history-delete"
                aria-label={`Delete ${session.title}`}
                onClick={() => deleteSession(session.id)}
              >
                <Trash2 size={11} />
              </button>
            </li>
          ))}
        </ul>
        <div className="architect-catalog-label">
          Company catalog <span>{workflows.length}</span>
        </div>
        <div className="architect-catalog">
          {workflows.map((workflow) => {
            const stats = templateStats(workflow);
            return (
              <button
                key={workflow.id}
                className={selected === workflow.id ? "active" : ""}
                onClick={() => setSelected(workflow.id)}
              >
                <Network size={14} />
                <span>
                  <b>{workflow.name}</b>
                  <small>
                    {stats.nodeCount} nodes · {stats.edgeCount} edges
                  </small>
                </span>
              </button>
            );
          })}
        </div>
        {selected && (
          <div className="architect-crud" aria-label="Workflow actions">
            <button onClick={() => onEdit(selected)} title="Edit graph">
              <Pencil size={14} />
              <span>Edit</span>
            </button>
            <button
              onClick={() => onDuplicate(selected)}
              title="Duplicate workflow"
            >
              <Copy size={14} />
              <span>Copy</span>
            </button>
            <button
              className="danger"
              onClick={() => onDelete(selected)}
              title="Delete workflow"
            >
              <Trash2 size={14} />
              <span>Delete</span>
            </button>
          </div>
        )}
      </aside>
      <main className="architect-stage">
        <header className="architect-top">
          <div>
            <span>
              <Sparkles size={12} /> CODEX CONTROL PLANE
            </span>
            <h1>Build the company behind the work.</h1>
            <p>
              Describe an outcome. I’ll design the specialists, prompts,
              handoffs, access, approval gates, and recovery paths.
            </p>
          </div>
          <div className="architect-live">
            <i /> Byte ready
          </div>
        </header>
        <section className="architect-chat">
          {!messages.length ? (
            <div className="architect-empty">
              <div className="architect-blueprint" aria-hidden>
                <span className="bp-node one">
                  <Bot size={18} />
                </span>
                <span className="bp-node two">
                  <Wrench size={18} />
                </span>
                <span className="bp-node three">
                  <CheckCircle2 size={18} />
                </span>
                <i className="bp-line a" />
                <i className="bp-line b" />
              </div>
              <h2>What company should we assemble?</h2>
              <p>
                I’ll ask what matters before touching the catalog, then show you
                the graph I intend to create.
              </p>
              <div className="architect-starters">
                {STARTERS.map(({ icon: Icon, title, prompt }) => (
                  <button key={title} onClick={() => void send(prompt)}>
                    <Icon size={15} />
                    <span>
                      <b>{title}</b>
                      <small>
                        {prompt.split(". ")[1] ??
                          "Start with guided requirements."}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="architect-messages">
              {messages.map((message: ChatMessage) => (
                <article
                  key={message.id}
                  className={
                    message.role === "user"
                      ? "user"
                      : `architect ${message.kind ?? ""}`
                  }
                >
                  <small>
                    {message.role === "user" ? "YOU" : "BYTE"}
                  </small>
                  <p>{message.text || "Thinking through the graph…"}</p>
                </article>
              ))}
            </div>
          )}
          <div
            className={`architect-compose ${voiceAvailable ? "with-voice" : ""}`}
          >
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="Describe a company workflow, a bug, or a change to agent access…"
            />
            <div className="architect-compose-actions">
              {voiceAvailable ? (
                <button
                  type="button"
                  className={`architect-voice-button agent-tool-btn ${voiceOpen ? "live" : ""}`}
                  onClick={() => void toggleVoiceMode()}
                  title={voiceOpen ? "End voice session" : "Start voice session"}
                  aria-label={voiceOpen ? "End voice session" : "Start voice session"}
                  aria-pressed={voiceOpen}
                >
                  {voiceOpen ? <PhoneOff size={15} /> : <Phone size={15} />}
                </button>
              ) : null}
              <button
                className="architect-send-button"
                disabled={!draft.trim() || sending}
                onClick={() => void send()}
                aria-label="Send"
              >
                <Send size={17} />
              </button>
            </div>
            <div className="architect-compose-meta">
              <span>Live Codex</span>
              <span>Full workflow CRUD</span>
              <kbd>Enter ↵</kbd>
            </div>
          </div>
        </section>
      </main>
      {voiceOpen && (
        <VoicePanel
          store={voiceSnapshot}
          voices={
            voices?.v2 ?? voices?.v1 ?? []
          }
          onVoiceChange={(voice) => {
            emitVoice({ ...voiceStoreRef.current, voice });
          }}
          onModalityChange={(modality) => {
            emitVoice({ ...voiceStoreRef.current, outputModality: modality });
          }}
          onEnd={() => void toggleVoiceMode()}
        />
      )}
    </div>
  );
}

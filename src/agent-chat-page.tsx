import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  ArrowLeft,
  Brain,
  ChevronDown,
  Cpu,
  Folder,
  FolderOpen,
  FolderPlus,
  FileText,
  Image as ImageIcon,
  MessageSquarePlus,
  Mic,
  MicOff,
  Network,
  Paperclip,
  Pencil,
  Hand,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { ApprovalRequest, RunEvent, RunRecord } from "./model";
import { getTemplate, templateStats } from "./templates";
import {
  createSession,
  ingestFiles,
  loadChatStore,
  makeMessage,
  APP_WORKSPACE_REQUEST_EVENT,
  MEDIATOR_CHAT_UPDATED_EVENT,
  saveChatStore,
  titleFromFirstMessage,
  type ChatAttachment,
  type AppProjectMode,
  type AppWorkspaceRequestDetail,
  type AppWorkspaceSelection,
  type ChatMessage,
  type ChatSession,
  type WorkflowChatStore,
} from "./workflow-chat";
import {
  chatMessagesFingerprint,
  isPinnedToBottom,
  parseChatFingerprint,
  scrollChatListToBottom,
  shouldAutoScrollChat,
} from "./chat-scroll";
import {
  defaultModelFromList,
  effortsForModel,
  getLiveCodexModels,
  subscribeLiveCodexModels,
  type CodexModelOption,
} from "./codex-models";

const MEDIATOR_MODEL_KEY = "codex-corp-mediator-model";
const MEDIATOR_EFFORT_KEY = "codex-corp-mediator-effort";

function loadMediatorModelPref(): string {
  try {
    return localStorage.getItem(MEDIATOR_MODEL_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function loadMediatorEffortPref(): string {
  try {
    return localStorage.getItem(MEDIATOR_EFFORT_KEY)?.trim() ?? "low";
  } catch {
    return "low";
  }
}

function saveMediatorModelPref(model: string) {
  try {
    localStorage.setItem(MEDIATOR_MODEL_KEY, model);
  } catch {
    /* ignore */
  }
}

function saveMediatorEffortPref(effort: string) {
  try {
    localStorage.setItem(MEDIATOR_EFFORT_KEY, effort);
  } catch {
    /* ignore */
  }
}

function pickEffortForModel(
  models: CodexModelOption[],
  modelId: string,
  preferred: string,
): string {
  const options = effortsForModel(models, modelId);
  if (preferred && options.includes(preferred)) return preferred;
  const hit = models.find((m) => m.id === modelId || m.model === modelId);
  if (hit?.defaultEffort && options.includes(hit.defaultEffort)) {
    return hit.defaultEffort;
  }
  return options[0] ?? "low";
}

export type MediatorTurnRequest = {
  text: string;
  attachments: ChatAttachment[];
  /** Recent visible turns, re-sent because each mediator call uses a fresh app-server. */
  history: Array<Pick<ChatMessage, "role" | "text">>;
  sessionId: string;
  messageId: string;
  threadId?: string;
  /** Live Codex model id from model/list. */
  model: string;
  /** Reasoning effort for this turn. */
  effort: string;
  /** Whether this conversation creates a new app or changes an existing one. */
  projectMode?: AppProjectMode;
  /** User-selected app folder used by the mediator and workflow run. */
  workspacePath?: string;
  /** Live token stream from Codex (desktop). */
  onDelta?: (delta: string) => void;
};

export type MediatorTurnResult = {
  summary: string;
  threadId: string;
};

export type AgentChatPageProps = {
  workflowId: string;
  activeWorkflowId: string;
  running: boolean;
  runId: string | null;
  events: RunEvent[];
  approvals: ApprovalRequest[];
  runHistory: RunRecord[];
  completedCount: number;
  totalExecutable: number;
  pendingDecisionCount: number;
  onOpenApprovals: () => void;
  onBack: () => void;
  onEditWorkflow: (id: string) => void;
  /**
   * Live Codex company mediator turn (desktop). Streams via host events;
   * tools are resolved on the host.
   */
  onMediatorTurn?: (req: MediatorTurnRequest) => Promise<MediatorTurnResult>;
  /** Native folder picker supplied by the desktop host. */
  onChooseWorkspace?: (initialPath?: string) => Promise<string | null>;
  /** Resolved Codex Corp workspace used as the modal default. */
  onResolveDefaultWorkspace?: () => Promise<string>;
};

export function AgentChatPage({
  workflowId,
  activeWorkflowId,
  running,
  runId,
  events,
  approvals,
  runHistory,
  completedCount,
  totalExecutable,
  pendingDecisionCount,
  onOpenApprovals,
  onBack,
  onEditWorkflow,
  onMediatorTurn,
  onChooseWorkspace,
  onResolveDefaultWorkspace,
}: AgentChatPageProps) {
  const template = getTemplate(workflowId);
  const stats = templateStats(template);
  const [store, setStore] = useState<WorkflowChatStore>(() =>
    loadChatStore(workflowId),
  );
  const [draft, setDraft] = useState("");
  const [pendingFiles, setPendingFiles] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [sending, setSending] = useState(false);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [projectMode, setProjectMode] = useState<AppProjectMode>("new");
  const [workspacePath, setWorkspacePath] = useState("Codex Corp workspace");
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceRequestedByMediator, setWorkspaceRequestedByMediator] =
    useState(false);
  const workspaceRequestResolver = useRef<
    ((selection: AppWorkspaceSelection | null) => void) | null
  >(null);
  const liveModels = useSyncExternalStore(
    subscribeLiveCodexModels,
    getLiveCodexModels,
    getLiveCodexModels,
  );
  const [chatModel, setChatModel] = useState(loadMediatorModelPref);
  const [chatEffort, setChatEffort] = useState(loadMediatorEffortPref);

  // Resolve model/effort against the live catalog when it arrives or changes.
  useEffect(() => {
    if (!liveModels.length) return;
    const preferred =
      chatModel &&
      liveModels.some((m) => m.id === chatModel || m.model === chatModel)
        ? chatModel
        : defaultModelFromList(liveModels);
    if (!preferred) return;
    if (preferred !== chatModel) {
      setChatModel(preferred);
      saveMediatorModelPref(preferred);
    }
    const nextEffort = pickEffortForModel(liveModels, preferred, chatEffort);
    if (nextEffort !== chatEffort) {
      setChatEffort(nextEffort);
      saveMediatorEffortPref(nextEffort);
    }
    // Only re-clamp when catalog identity changes, not on every effort edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [liveModels]);

  const effortOptions = useMemo(
    () => effortsForModel(liveModels, chatModel),
    [liveModels, chatModel],
  );
  const streamEnd = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const justSent = useRef(false);
  const lastMsgFp = useRef("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<{
    stop: () => void;
    start: () => void;
    onresult: ((ev: unknown) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    onend: (() => void) | null;
    continuous: boolean;
    interimResults: boolean;
    lang: string;
  } | null>(null);

  const activeSession: ChatSession | null = useMemo(() => {
    if (!store.sessions.length) return null;
    return (
      store.sessions.find((s) => s.id === store.activeSessionId) ??
      store.sessions[0] ??
      null
    );
  }, [store]);

  const messages = activeSession?.messages ?? [];
  const isEmpty = messages.length === 0;

  const persist = (next: WorkflowChatStore) => {
    setStore(next);
    saveChatStore(workflowId, next);
  };

  // Reload store when switching workflows.
  useEffect(() => {
    let next = loadChatStore(workflowId);
    if (!next.sessions.length) {
      const session = createSession(workflowId);
      next = { sessions: [session], activeSessionId: session.id };
      saveChatStore(workflowId, next);
    } else if (
      !next.activeSessionId ||
      !next.sessions.some((s) => s.id === next.activeSessionId)
    ) {
      next = { ...next, activeSessionId: next.sessions[0].id };
      saveChatStore(workflowId, next);
    }
    setStore(next);
    setDraft("");
    const active =
      next.sessions.find((session) => session.id === next.activeSessionId) ??
      next.sessions[0];
    setWorkspaceModalOpen(false);
    setWorkspaceRequestedByMediator(false);
    setProjectMode(active?.projectMode ?? "new");
    setWorkspacePath(active?.workspacePath ?? "Codex Corp workspace");
    requestAnimationFrame(() => inputRef.current?.focus());
    // The host callback is intentionally excluded: it may be recreated by App.
    // Reopening this modal on every render would discard the operator's choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  // The mediator opens this modal through a dynamic tool only after it has
  // identified a concrete create-or-modify project request.
  useEffect(() => {
    const onWorkspaceRequest = (event: Event) => {
      const detail = (event as CustomEvent<AppWorkspaceRequestDetail>).detail;
      if (!detail?.resolve) return;
      workspaceRequestResolver.current?.(null);
      workspaceRequestResolver.current = detail.resolve;
      setWorkspaceRequestedByMediator(true);
      setProjectMode(detail.suggestedMode);
      setWorkspaceError(null);
      setWorkspacePath(activeSession?.workspacePath ?? "Codex Corp workspace");
      setWorkspaceModalOpen(true);
      if (!activeSession?.workspacePath) {
        void onResolveDefaultWorkspace?.()
          .then((path) => {
            if (path.trim()) setWorkspacePath(path);
          })
          .catch(() => undefined);
      }
    };
    window.addEventListener(APP_WORKSPACE_REQUEST_EVENT, onWorkspaceRequest);
    return () =>
      window.removeEventListener(APP_WORKSPACE_REQUEST_EVENT, onWorkspaceRequest);
  }, [activeSession?.workspacePath, onResolveDefaultWorkspace]);

  useEffect(() => {
    const fp = chatMessagesFingerprint(messages);
    const prev = parseChatFingerprint(lastMsgFp.current);
    const next = parseChatFingerprint(fp);
    const lastMessageIdChanged =
      next.id !== prev.id || next.count !== prev.count;
    const contentGrew = !lastMessageIdChanged && next.len > prev.len;
    lastMsgFp.current = fp;
    const shouldScroll = shouldAutoScrollChat({
      pinnedToBottom: pinnedToBottom.current,
      justSent: justSent.current,
      lastMessageIdChanged,
      contentGrew,
    });
    const smooth = justSent.current;
    justSent.current = false;
    if (!shouldScroll) return;
    // Scroll only the list container — never scrollIntoView (page snap).
    requestAnimationFrame(() => {
      scrollChatListToBottom(listRef.current, smooth ? "smooth" : "auto");
    });
  }, [messages, isEmpty]);

  // Browser speech-to-text (dictation). Codex app-server has experimental
  // realtime *voices* for spoken conversation — not STT for chat compose —
  // so mediation uses the Web Speech API when available.
  useEffect(() => {
    const SpeechRecognition =
      (window as unknown as { SpeechRecognition?: new () => unknown })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => unknown })
        .webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceSupported(false);
      return;
    }
    setVoiceSupported(true);
    const rec = new SpeechRecognition() as NonNullable<
      typeof recognitionRef.current
    >;
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (event: unknown) => {
      const ev = event as {
        results: ArrayLike<{ 0: { transcript: string }; isFinal?: boolean }>;
        resultIndex: number;
      };
      let chunk = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        chunk += ev.results[i][0].transcript;
      }
      if (chunk.trim()) {
        setDraft((prev) => {
          const base = prev.trim();
          const next = chunk.trim();
          return base ? `${base} ${next}` : next;
        });
      }
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    return () => {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
    };
  }, []);

  const sortedSessions = useMemo(
    () =>
      [...store.sessions].sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    [store.sessions],
  );

  const startNewChat = () => {
    const session = createSession(workflowId);
    persist({
      sessions: [session, ...store.sessions],
      activeSessionId: session.id,
    });
    setDraft("");
    setProjectMode("new");
    setWorkspaceModalOpen(false);
    setWorkspaceRequestedByMediator(false);
    setWorkspaceError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const selectSession = (id: string) => {
    persist({ ...store, activeSessionId: id });
    setDraft("");
    const selected = store.sessions.find((session) => session.id === id);
    setProjectMode(selected?.projectMode ?? "new");
    setWorkspacePath(selected?.workspacePath ?? "Codex Corp workspace");
    setWorkspaceModalOpen(false);
    setWorkspaceRequestedByMediator(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const browseWorkspace = async () => {
    if (!onChooseWorkspace) {
      setWorkspaceError("Folder selection is available in the desktop app.");
      return;
    }
    setWorkspaceBusy(true);
    setWorkspaceError(null);
    try {
      const selected = await onChooseWorkspace(workspacePath);
      if (selected) setWorkspacePath(selected);
    } catch (error) {
      setWorkspaceError(String(error));
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const confirmWorkspace = () => {
    const path = workspacePath.trim();
    if (!path) {
      setWorkspaceError("Choose a folder to continue.");
      return;
    }
    if (!activeSession) return;
    const next: WorkflowChatStore = {
      ...store,
      activeSessionId: activeSession.id,
      sessions: store.sessions.map((session) =>
        session.id === activeSession.id
          ? {
              ...session,
              projectMode,
              workspacePath: path,
              // A changed workspace must start a Codex thread with the new cwd.
              mediatorThreadId: undefined,
            }
          : session,
      ),
    };
    persist(next);
    setWorkspaceModalOpen(false);
    workspaceRequestResolver.current?.({
      projectMode,
      workspacePath: path,
    });
    workspaceRequestResolver.current = null;
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const cancelWorkspace = () => {
    workspaceRequestResolver.current?.(null);
    workspaceRequestResolver.current = null;
    setWorkspaceModalOpen(false);
    setWorkspaceRequestedByMediator(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const deleteSession = (id: string) => {
    const remaining = store.sessions.filter((s) => s.id !== id);
    if (!remaining.length) {
      const session = createSession(workflowId);
      persist({ sessions: [session], activeSessionId: session.id });
      setProjectMode("new");
      setWorkspaceModalOpen(false);
      setWorkspaceRequestedByMediator(false);
      return;
    }
    const activeSessionId =
      store.activeSessionId === id ? remaining[0].id : store.activeSessionId;
    persist({ sessions: remaining, activeSessionId });
  };

  const addFiles = async (list: FileList | File[] | null) => {
    if (!list || !list.length) return;
    setAttachError(null);
    const { attachments, errors } = await ingestFiles(list);
    if (errors.length) setAttachError(errors.join(" "));
    if (attachments.length) {
      setPendingFiles((prev) => [...prev, ...attachments].slice(0, 6));
    }
  };

  const toggleVoice = () => {
    const rec = recognitionRef.current;
    if (!rec) return;
    if (listening) {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      setListening(false);
      return;
    }
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
      setAttachError("Could not start microphone dictation.");
    }
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && !pendingFiles.length) || !activeSession || sending) return;
    setSending(true);
    setDraft("");
    const files = pendingFiles;
    setPendingFiles([]);
    setAttachError(null);
    justSent.current = true;
    pinnedToBottom.current = true;
    const userMsg = makeMessage(
      "user",
      text ||
        (files.length
          ? `(sent ${files.length} file${files.length === 1 ? "" : "s"})`
          : ""),
      undefined,
      files,
    );
    const pendingId = crypto.randomUUID();
    const pendingMsg: ChatMessage = {
      id: pendingId,
      role: "mediator",
      text: "…",
      at: new Date().toISOString(),
      kind: "progress",
    };
    const wasEmpty = activeSession.messages.length === 0;
    let session: ChatSession = {
      ...activeSession,
      title: wasEmpty
        ? titleFromFirstMessage(text || files[0]?.name || "Attachment")
        : activeSession.title,
      updatedAt: pendingMsg.at,
      messages: [...activeSession.messages, userMsg, pendingMsg],
    };
    persist({
      ...store,
      sessions: store.sessions.map((s) => (s.id === session.id ? session : s)),
      activeSessionId: session.id,
    });

    try {
      if (!onMediatorTurn) {
        throw new Error(
          "Company chat is available in the desktop app. Start it with npm run desktop:dev.",
        );
      }
      if (!chatModel.trim()) {
        throw new Error(
          "No Codex model selected. Wait for model/list or pick a model in the composer.",
        );
      }
      let streamed = "";
      const result = await onMediatorTurn({
        text:
          text ||
          (files.length
            ? `User attached ${files.length} file(s): ${files.map((f) => f.name).join(", ")}`
            : ""),
        attachments: files,
        history: activeSession.messages
          .filter(
            (message) =>
              message.role === "user" ||
              (message.role === "mediator" && message.kind !== "progress"),
          )
          .slice(-12)
          .map(({ role, text: messageText }) => ({ role, text: messageText })),
        sessionId: session.id,
        messageId: pendingId,
        threadId: session.mediatorThreadId,
        model: chatModel,
        effort: chatEffort || "low",
        projectMode: activeSession.projectMode,
        workspacePath: activeSession.workspacePath,
        onDelta: (delta) => {
          streamed += delta;
          const liveText = streamed;
          setStore((prev) => {
            const sessions = prev.sessions.map((s) =>
              s.id !== session.id
                ? s
                : {
                    ...s,
                    messages: s.messages.map((m) =>
                      m.id === pendingId
                        ? { ...m, text: liveText, kind: "progress" as const }
                        : m,
                    ),
                  },
            );
            return { ...prev, sessions };
          });
        },
      });
      const finalMsg = makeMessage(
        "mediator",
        result.summary || streamed || "…",
        "status",
      );
      finalMsg.id = pendingId;
      setStore((prev) => {
        const next: WorkflowChatStore = {
          ...prev,
          activeSessionId: session.id,
          sessions: prev.sessions.map((s) =>
            s.id !== session.id
              ? s
              : {
                  ...s,
                  mediatorThreadId:
                    result.threadId ||
                    s.mediatorThreadId ||
                    session.mediatorThreadId,
                  updatedAt: finalMsg.at,
                  messages: s.messages.map((m) =>
                    m.id === pendingId
                      ? finalMsg
                      : m.id === userMsg.id && m.attachments
                        ? {
                            ...m,
                            attachments: m.attachments.map(
                              ({ dataUrl: _dataUrl, ...metadata }) => metadata,
                            ),
                          }
                        : m,
                  ),
                },
          ),
        };
        saveChatStore(workflowId, next);
        return next;
      });
    } catch (err) {
      const errMsg = makeMessage(
        "mediator",
        String(err instanceof Error ? err.message : err),
        "error",
      );
      errMsg.id = pendingId;
      setStore((prev) => {
        const next: WorkflowChatStore = {
          ...prev,
          activeSessionId: session.id,
          sessions: prev.sessions.map((s) =>
            s.id !== session.id
              ? s
              : {
                  ...s,
                  updatedAt: errMsg.at,
                  messages: s.messages.map((m) =>
                    m.id === pendingId ? errMsg : m,
                  ),
                },
          ),
        };
        saveChatStore(workflowId, next);
        return next;
      });
    }
    setSending(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // Refresh chat when host appends lifecycle progress — only if fingerprint changes.
  // Skip while a Live Codex turn is streaming so localStorage "…" cannot clobber deltas.
  useEffect(() => {
    const tick = () => {
      if (sending) return;
      const next = loadChatStore(workflowId);
      const active =
        next.sessions.find((s) => s.id === next.activeSessionId) ??
        next.sessions[0];
      const fp = chatMessagesFingerprint(active?.messages);
      if (
        fp === lastMsgFp.current &&
        next.activeSessionId === store.activeSessionId
      ) {
        return;
      }
      setStore(next);
    };
    const onCustom = (ev: Event) => {
      if (sending) return;
      const detail = (ev as CustomEvent<{ workflowId?: string }>).detail;
      if (!detail?.workflowId || detail.workflowId === workflowId) tick();
    };
    const id = window.setInterval(tick, 2500);
    window.addEventListener("storage", tick);
    window.addEventListener(MEDIATOR_CHAT_UPDATED_EVENT, onCustom);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("storage", tick);
      window.removeEventListener(MEDIATOR_CHAT_UPDATED_EVENT, onCustom);
    };
  }, [workflowId, store.activeSessionId, sending]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="agent-chat-shell">
      <aside className="agent-chat-rail" aria-label="Chat history">
        <div className="agent-chat-corp-brand">
          <div className="brand-mark compact">
            <span />
            <span />
            <span />
          </div>
          <div>
            <b>CODEX CORP</b>
            <small>agent operating system</small>
          </div>
        </div>

        <button
          type="button"
          className="agent-chat-back"
          onClick={onBack}
          aria-label="Back to overview"
        >
          <ArrowLeft size={16} />
          Overview
        </button>

        <div className="agent-chat-rail-brand">
          <div className="agent-chat-rail-mark">
            <Sparkles size={14} />
          </div>
          <div>
            <b>Mediator</b>
            <small>Company operator</small>
          </div>
        </div>

        <button type="button" className="agent-chat-new" onClick={startNewChat}>
          <MessageSquarePlus size={16} />
          New chat
        </button>

        <div className="agent-chat-history-label">Previous chats</div>
        <ul className="agent-chat-history">
          {sortedSessions.map((session) => {
            const active = session.id === activeSession?.id;
            return (
              <li key={session.id}>
                <button
                  type="button"
                  className={`agent-chat-history-item ${active ? "active" : ""}`}
                  onClick={() => selectSession(session.id)}
                >
                  <span className="agent-chat-history-title">
                    {session.title}
                  </span>
                  <span className="agent-chat-history-meta">
                    {formatRelative(session.updatedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className="agent-chat-history-delete"
                  aria-label={`Delete ${session.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSession(session.id);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </li>
            );
          })}
        </ul>

        <div className="agent-chat-rail-foot">
          <Network size={12} />
          {stats.nodeCount} nodes · {stats.edgeCount} edges
        </div>
      </aside>

      <section className="agent-chat-stage">
        <header className="agent-chat-top">
          <div>
            <span className="agent-chat-eyebrow">Company · Mediator</span>
            <h1>{template.name}</h1>
            <p>{template.description}</p>
          </div>
          <div className="agent-chat-top-actions">
            <button
              type="button"
              className="agent-chat-workspace"
              onClick={() => {
                if (activeSession?.projectMode) setProjectMode(activeSession.projectMode);
                if (activeSession?.workspacePath) setWorkspacePath(activeSession.workspacePath);
                setWorkspaceRequestedByMediator(false);
                setWorkspaceModalOpen(true);
              }}
              title={activeSession?.workspacePath ?? "Choose app folder"}
            >
              <FolderOpen size={14} />
              <span>
                {!activeSession?.workspacePath
                  ? "App folder"
                  : activeSession.projectMode === "existing"
                    ? "Existing app"
                    : "New app"}
              </span>
            </button>
            <button
              type="button"
              className="agent-chat-approval"
              onClick={onOpenApprovals}
            >
              <Hand size={14} />
              Approvals
              <span className="decision-count">{pendingDecisionCount}</span>
            </button>
            <button
              type="button"
              className="agent-chat-edit"
              onClick={() => onEditWorkflow(workflowId)}
            >
              <Pencil size={14} />
              View / Edit workflow
            </button>
          </div>
        </header>

        {isEmpty ? (
          <div className="agent-chat-empty">
            <div className="agent-chat-empty-glow" aria-hidden />
            <div className="agent-chat-empty-copy">
              <Sparkles size={22} />
              <h2>Brief the mediator</h2>
              <p>
                Track progress, surface human approvals, and steer{" "}
                <strong>{template.name}</strong> without drowning in the graph.
              </p>
            </div>
            <Composer
              centered
              draft={draft}
              setDraft={setDraft}
              pendingFiles={pendingFiles}
              setPendingFiles={setPendingFiles}
              attachError={attachError}
              onKeyDown={onKeyDown}
              onSend={() => void send()}
              onPickFiles={() => fileInputRef.current?.click()}
              onFiles={addFiles}
              onToggleVoice={toggleVoice}
              listening={listening}
              voiceSupported={voiceSupported}
              sending={sending}
              inputRef={inputRef}
              placeholder="Message the mediator — attach images or docs anytime…"
              models={liveModels}
              modelId={chatModel}
              effort={chatEffort}
              effortOptions={effortOptions}
              onModelChange={(next) => {
                setChatModel(next);
                saveMediatorModelPref(next);
                const nextEffort = pickEffortForModel(
                  liveModels,
                  next,
                  chatEffort,
                );
                setChatEffort(nextEffort);
                saveMediatorEffortPref(nextEffort);
              }}
              onEffortChange={(next) => {
                setChatEffort(next);
                saveMediatorEffortPref(next);
              }}
            />
          </div>
        ) : (
          <>
            <div
              className="agent-chat-stream"
              role="log"
              aria-live="polite"
              ref={listRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                // Only re-pin when the user is near the bottom; scrolling up
                // must stay unpinned until they return (no snap).
                pinnedToBottom.current = isPinnedToBottom(
                  el.scrollTop,
                  el.clientHeight,
                  el.scrollHeight,
                  96,
                );
              }}
            >
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`agent-bubble ${msg.role} ${msg.kind ?? ""}`}
                >
                  <div className="agent-bubble-meta">
                    {msg.role === "user" ? "You" : "Mediator"}
                    <span>{formatTime(msg.at)}</span>
                  </div>
                  {!!msg.attachments?.length && (
                    <div className="agent-attach-row">
                      {msg.attachments.map((file) => (
                        <AttachmentChip key={file.id} file={file} />
                      ))}
                    </div>
                  )}
                  <div className="agent-bubble-body">
                    {msg.text.split("\n").map((line, i) => (
                      <p key={i}>{formatChatLine(line)}</p>
                    ))}
                  </div>
                </div>
              ))}
              <div ref={streamEnd} />
            </div>
            <div className="agent-chat-dock">
              <Composer
                centered={false}
                draft={draft}
                setDraft={setDraft}
                pendingFiles={pendingFiles}
                setPendingFiles={setPendingFiles}
                attachError={attachError}
                onKeyDown={onKeyDown}
                onSend={() => void send()}
                onPickFiles={() => fileInputRef.current?.click()}
                onFiles={addFiles}
                onToggleVoice={toggleVoice}
                listening={listening}
                voiceSupported={voiceSupported}
                sending={sending}
                inputRef={inputRef}
                placeholder="Follow up — text, files, or dictate…"
                models={liveModels}
                modelId={chatModel}
                effort={chatEffort}
                effortOptions={effortOptions}
                onModelChange={(next) => {
                  setChatModel(next);
                  saveMediatorModelPref(next);
                  const nextEffort = pickEffortForModel(
                    liveModels,
                    next,
                    chatEffort,
                  );
                  setChatEffort(nextEffort);
                  saveMediatorEffortPref(nextEffort);
                }}
                onEffortChange={(next) => {
                  setChatEffort(next);
                  saveMediatorEffortPref(next);
                }}
              />
            </div>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="agent-file-input"
          accept="image/*,.pdf,.txt,.md,.json,.csv,.doc,.docx,.png,.jpg,.jpeg,.webp,.gif,.svg"
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {workspaceModalOpen ? (
          <div className="modal-backdrop app-workspace-backdrop" role="presentation">
            <section
              className="app-workspace-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="app-workspace-title"
            >
              <header>
                <span className="agent-chat-eyebrow">Set app context</span>
                <h2 id="app-workspace-title">What are we working on?</h2>
                <p>
                  {workspaceRequestedByMediator
                    ? "The mediator identified a project task. Confirm where the workflow should work."
                    : "Choose the app context and folder used when this chat starts a workflow."}
                </p>
              </header>

              <div className="app-workspace-options" role="radiogroup" aria-label="App intent">
                <button
                  type="button"
                  role="radio"
                  aria-checked={projectMode === "new"}
                  className={projectMode === "new" ? "active" : ""}
                  onClick={() => setProjectMode("new")}
                >
                  <FolderPlus size={22} />
                  <span><b>Create a new app</b><small>Start in a new or empty project folder.</small></span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={projectMode === "existing"}
                  className={projectMode === "existing" ? "active" : ""}
                  onClick={() => setProjectMode("existing")}
                >
                  <FolderOpen size={22} />
                  <span><b>Modify an existing app</b><small>Open the folder that already contains the app.</small></span>
                </button>
              </div>

              <div className="app-workspace-folder">
                <label>App folder</label>
                <div>
                  <Folder size={16} />
                  <span title={workspacePath}>{workspacePath}</span>
                  <button type="button" onClick={() => void browseWorkspace()} disabled={workspaceBusy}>
                    {workspaceBusy ? "Opening…" : "Choose folder"}
                  </button>
                </div>
                <small>Defaults to the Codex Corp workspace. You can change it anytime from the chat header.</small>
                {workspaceError ? <p className="app-workspace-error">{workspaceError}</p> : null}
              </div>

              <footer>
                <button type="button" className="app-workspace-back" onClick={cancelWorkspace}>Not now</button>
                <button type="button" className="app-workspace-confirm" onClick={confirmWorkspace} autoFocus>
                  Continue to chat
                </button>
              </footer>
            </section>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function AttachmentChip({
  file,
  onRemove,
}: {
  file: ChatAttachment;
  onRemove?: () => void;
}) {
  return (
    <div className={`agent-attach-chip kind-${file.kind}`}>
      {file.kind === "image" && file.dataUrl ? (
        <img src={file.dataUrl} alt={file.name} />
      ) : file.kind === "image" ? (
        <ImageIcon size={14} />
      ) : (
        <FileText size={14} />
      )}
      <span title={file.name}>{file.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function Composer({
  centered,
  draft,
  setDraft,
  pendingFiles,
  setPendingFiles,
  attachError,
  onKeyDown,
  onSend,
  onPickFiles,
  onFiles,
  onToggleVoice,
  listening,
  voiceSupported,
  sending,
  inputRef,
  placeholder,
  models,
  modelId,
  effort,
  effortOptions,
  onModelChange,
  onEffortChange,
}: {
  centered: boolean;
  draft: string;
  setDraft: (v: string) => void;
  pendingFiles: ChatAttachment[];
  setPendingFiles: Dispatch<SetStateAction<ChatAttachment[]>>;
  attachError: string | null;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onPickFiles: () => void;
  onFiles: (list: FileList | File[] | null) => void | Promise<void>;
  onToggleVoice: () => void;
  listening: boolean;
  voiceSupported: boolean;
  sending: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  models: CodexModelOption[];
  modelId: string;
  effort: string;
  effortOptions: string[];
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const modelInList = models.some(
    (m) => m.id === modelId || m.model === modelId,
  );
  const effortValue = effortOptions.includes(effort)
    ? effort
    : (effortOptions[0] ?? "low");
  const modelLabel =
    models.find((m) => m.id === modelId || m.model === modelId)?.displayName ||
    modelId ||
    "Model";
  return (
    <div
      className={`agent-composer ${centered ? "centered" : "docked"} ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void onFiles(e.dataTransfer.files);
      }}
    >
      {!!pendingFiles.length && (
        <div className="agent-attach-pending">
          {pendingFiles.map((file) => (
            <AttachmentChip
              key={file.id}
              file={file}
              onRemove={() =>
                setPendingFiles((prev) => prev.filter((f) => f.id !== file.id))
              }
            />
          ))}
        </div>
      )}
      {attachError && <p className="agent-attach-error">{attachError}</p>}
      <textarea
        ref={inputRef}
        value={draft}
        rows={centered ? 3 : 2}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label="Message mediator"
      />
      <div className="agent-composer-bar">
        <div className="agent-composer-tools">
          <button
            type="button"
            className="agent-tool-btn"
            onClick={onPickFiles}
            title="Attach images or documents"
            aria-label="Attach files"
          >
            <Paperclip size={15} />
          </button>
          {voiceSupported && (
            <button
              type="button"
              className={`agent-tool-btn ${listening ? "live" : ""}`}
              onClick={onToggleVoice}
              title={
                listening
                  ? "Stop dictation"
                  : "Dictate with microphone (browser speech-to-text)"
              }
              aria-label={listening ? "Stop dictation" : "Start dictation"}
              aria-pressed={listening}
            >
              {listening ? <MicOff size={15} /> : <Mic size={15} />}
            </button>
          )}
          <span className="agent-composer-divider" aria-hidden />
          <div
            className="agent-composer-chip"
            data-testid="mediator-model-row"
            title={modelLabel}
          >
            <Cpu size={13} strokeWidth={1.75} aria-hidden />
            <select
              value={modelInList ? modelId : modelId || ""}
              onChange={(e) => onModelChange(e.target.value)}
              disabled={sending || models.length === 0}
              aria-label="Mediator model"
            >
              {models.length === 0 ? (
                <option value="">Models…</option>
              ) : (
                <>
                  {!modelInList && modelId ? (
                    <option value={modelId}>{modelId}</option>
                  ) : null}
                  {!modelId ? (
                    <option value="" disabled>
                      Model
                    </option>
                  ) : null}
                  {models.map((m) => (
                    <option key={m.id} value={m.id} title={m.description}>
                      {m.displayName || m.model || m.id}
                    </option>
                  ))}
                </>
              )}
            </select>
            <ChevronDown size={12} strokeWidth={2} aria-hidden />
          </div>
          <div className="agent-composer-chip agent-composer-chip-effort">
            <Brain size={13} strokeWidth={1.75} aria-hidden />
            <select
              value={effortValue}
              onChange={(e) => onEffortChange(e.target.value)}
              disabled={sending || effortOptions.length === 0}
              aria-label="Reasoning effort"
            >
              {(effortOptions.length ? effortOptions : ["low"]).map((opt) => (
                <option key={opt} value={opt}>
                  {opt.charAt(0).toUpperCase() + opt.slice(1)}
                </option>
              ))}
            </select>
            <ChevronDown size={12} strokeWidth={2} aria-hidden />
          </div>
        </div>
        <button
          type="button"
          className="agent-composer-send"
          onClick={onSend}
          disabled={
            (!draft.trim() && !pendingFiles.length) ||
            sending ||
            !modelId.trim()
          }
          aria-label="Send message"
        >
          <Send size={15} />
          Send
        </button>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatRelative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours}h`;
    return new Date(iso).toLocaleDateString();
  } catch {
    return "";
  }
}

function formatChatLine(line: string): ReactNode {
  const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    return <span key={i}>{part}</span>;
  });
}

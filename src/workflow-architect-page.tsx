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
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import type {
  MediatorTurnRequest,
  MediatorTurnResult,
} from "./agent-chat-page";
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

const ARCHITECT_CHAT_SCOPE = "__workflow-architect__";

export type WorkflowArchitectPageProps = {
  revision: number;
  initialPrompt?: string;
  onBack: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onTurn?: (req: MediatorTurnRequest) => Promise<MediatorTurnResult>;
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
}: WorkflowArchitectPageProps) {
  const workflows = useMemo(() => listWorkflows(), [revision]);
  const [selected, setSelected] = useState(workflows[0]?.id ?? "");
  const [store, setStore] = useState<WorkflowChatStore>(loadArchitectStore);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const initialPromptUsed = useRef(false);
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
          <div className="architect-compose">
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
            <button
              disabled={!draft.trim() || sending}
              onClick={() => void send()}
              aria-label="Send"
            >
              <Send size={17} />
            </button>
            <div>
              <span>Live Codex</span>
              <span>Full workflow CRUD</span>
              <kbd>Enter ↵</kbd>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

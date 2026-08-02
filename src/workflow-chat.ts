/**
 * Mediator chat — multi-session threads per company workflow.
 * Operator agent between the human and specialist graph agents.
 *
 * Freeform replies are NEVER generated here. Company chat goes through
 * Live Codex (execute_mediator_turn + company/node tools) only.
 */

import type { RunEvent } from "./model";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { isLifecycleRunEvent, progressLineFromRunEvent } from "./mediator-ui";
import { notifyPersistenceError } from "./persistence-events";

export type ChatRole = "user" | "mediator" | "system";
export type AppProjectMode = "new" | "existing";
export type AppWorkspaceSelection = {
  projectMode: AppProjectMode;
  workspacePath: string;
};

export const APP_WORKSPACE_REQUEST_EVENT = "codex-corp:request-app-workspace";

export type AppWorkspaceRequestDetail = {
  suggestedMode: AppProjectMode;
  resolve: (selection: AppWorkspaceSelection | null) => void;
};

/** Bridge a mediator dynamic-tool call to the currently visible chat modal. */
export function requestAppWorkspaceSelection(
  suggestedMode: AppProjectMode,
): Promise<AppWorkspaceSelection | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent<AppWorkspaceRequestDetail>(APP_WORKSPACE_REQUEST_EVENT, {
        detail: { suggestedMode, resolve },
      }),
    );
  });
}

/**
 * Chat-side attachment. Mediation layer only — Codex app-server `UserInput`
 * natively supports: text | image (url) | localImage (path) | skill | mention.
 * Docs are carried as text excerpts or metadata until a graph agent turn
 * forwards them as text / image inputs.
 */
export type ChatAttachmentKind = "image" | "document" | "text" | "other";

export type ChatAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: ChatAttachmentKind;
  /** data: URL for images / small previews (local only). */
  dataUrl?: string;
  /** Extracted or truncated text for text-like documents. */
  textExcerpt?: string;
  /** Absolute path when available (desktop); maps to UserInput.localImage. */
  localPath?: string;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  at: string;
  kind?: "status" | "approval" | "progress" | "help" | "error" | "test";
  attachments?: ChatAttachment[];
};

/** Soft cap so chat payloads and rendering remain bounded. */
export const MAX_CHAT_ATTACHMENT_BYTES = 1_500_000;
export const MAX_CHAT_ATTACHMENTS_PER_MESSAGE = 6;

export type ChatSession = {
  id: string;
  workflowId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  /** Most recent Live Codex thread id; recent messages provide cross-process continuity. */
  mediatorThreadId?: string;
  /** App intent and working folder selected before the first turn. */
  projectMode?: AppProjectMode;
  workspacePath?: string;
};

export type WorkflowChatStore = {
  sessions: ChatSession[];
  activeSessionId: string | null;
};

export const chatStoreKey = (workflowId: string) =>
  `codex-corp-chat-sessions:${workflowId}`;

/** Legacy single-thread key (migrated once). */
const legacyChatKey = (workflowId: string) => `codex-corp-chat:${workflowId}`;

const desktopChatStores = new Map<string, WorkflowChatStore>();
const hydratedDesktopStores = new Set<string>();
const desktopHydrations = new Map<string, Promise<WorkflowChatStore>>();
const pendingDesktopStores = new Map<string, WorkflowChatStore>();
const desktopSaveChains = new Map<string, Promise<void>>();

export function makeMessage(
  role: ChatRole,
  text: string,
  kind?: ChatMessage["kind"],
  attachments?: ChatAttachment[],
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    at: new Date().toISOString(),
    kind,
    attachments:
      attachments && attachments.length
        ? attachments.slice(0, MAX_CHAT_ATTACHMENTS_PER_MESSAGE)
        : undefined,
  };
}

export function classifyAttachment(
  mime: string,
  name: string,
): ChatAttachmentKind {
  const lower = `${mime} ${name}`.toLowerCase();
  if (
    mime.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name)
  ) {
    return "image";
  }
  if (
    mime.startsWith("text/") ||
    /json|markdown|csv|xml|javascript|typescript/.test(mime) ||
    /\.(txt|md|json|csv|ts|tsx|js|jsx|css|html|xml|log|yml|yaml)$/i.test(name)
  ) {
    return "text";
  }
  if (
    /pdf|word|document|sheet|presentation|zip|octet-stream/.test(lower) ||
    /\.(pdf|docx?|xlsx?|pptx?|zip)$/i.test(name)
  ) {
    return "document";
  }
  return "other";
}

/**
 * Build Codex-compatible turn inputs from a mediator message.
 * Images → UserInput.image (data URL) or localImage (path).
 * Text docs → text blocks. Binary docs → text note with filename only.
 */
export function toCodexUserInputs(
  text: string,
  attachments: ChatAttachment[] = [],
): Array<Record<string, unknown>> {
  const inputs: Array<Record<string, unknown>> = [];
  const body = text.trim();
  if (body) {
    inputs.push({ type: "text", text: body, text_elements: [] });
  }
  for (const file of attachments) {
    if (file.kind === "image") {
      if (file.localPath) {
        inputs.push({
          type: "localImage",
          path: file.localPath,
          detail: "auto",
        });
      } else if (file.dataUrl) {
        inputs.push({ type: "image", url: file.dataUrl, detail: "auto" });
      } else {
        inputs.push({
          type: "text",
          text: `[Image attached: ${file.name}]`,
          text_elements: [],
        });
      }
      continue;
    }
    if (file.textExcerpt) {
      inputs.push({
        type: "text",
        text: `--- Attached file: ${file.name} (${file.mime}) ---\n${file.textExcerpt}`,
        text_elements: [],
      });
      continue;
    }
    inputs.push({
      type: "text",
      text: `[File attached: ${file.name} · ${file.mime} · ${file.size} bytes — binary content not inlined; open in workflow agents with workspace access if needed.]`,
      text_elements: [],
    });
  }
  if (!inputs.length) {
    inputs.push({ type: "text", text: "(empty message)", text_elements: [] });
  }
  return inputs;
}

export async function ingestFiles(
  fileList: FileList | File[],
): Promise<{ attachments: ChatAttachment[]; errors: string[] }> {
  const files = Array.from(fileList).slice(0, MAX_CHAT_ATTACHMENTS_PER_MESSAGE);
  const attachments: ChatAttachment[] = [];
  const errors: string[] = [];

  for (const file of files) {
    if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
      errors.push(
        `${file.name} is too large (max ${Math.round(MAX_CHAT_ATTACHMENT_BYTES / 1000)}KB for chat mediation).`,
      );
      continue;
    }
    const kind = classifyAttachment(
      file.type || "application/octet-stream",
      file.name,
    );
    const base: ChatAttachment = {
      id: crypto.randomUUID(),
      name: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size,
      kind,
    };

    try {
      if (kind === "image") {
        const dataUrl = await readAsDataUrl(file);
        attachments.push({ ...base, dataUrl });
      } else if (kind === "text") {
        const text = await readAsText(file);
        attachments.push({
          ...base,
          textExcerpt: text.slice(0, 40_000),
        });
      } else {
        // PDF / office / binary: keep metadata only (Codex has no generic file UserInput).
        attachments.push(base);
      }
    } catch {
      errors.push(`Could not read ${file.name}.`);
    }
  }
  return { attachments, errors };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export function emptyStore(): WorkflowChatStore {
  return { sessions: [], activeSessionId: null };
}

function loadBrowserChatStore(workflowId: string): WorkflowChatStore {
  try {
    const raw = localStorage.getItem(chatStoreKey(workflowId));
    if (raw) {
      const parsed = JSON.parse(raw) as WorkflowChatStore;
      if (parsed && Array.isArray(parsed.sessions)) {
        return {
          sessions: parsed.sessions,
          activeSessionId: parsed.activeSessionId ?? null,
        };
      }
    }
    // Migrate legacy single-thread storage.
    const legacy = localStorage.getItem(legacyChatKey(workflowId));
    if (legacy) {
      const messages = JSON.parse(legacy) as ChatMessage[];
      if (Array.isArray(messages) && messages.length) {
        const session = createSession(workflowId, "Earlier conversation");
        session.messages = messages;
        session.updatedAt =
          messages[messages.length - 1]?.at ?? session.updatedAt;
        const store: WorkflowChatStore = {
          sessions: [session],
          activeSessionId: session.id,
        };
        saveChatStore(workflowId, store);
        localStorage.removeItem(legacyChatKey(workflowId));
        return store;
      }
    }
  } catch {
    /* ignore */
  }
  return emptyStore();
}

/** Hydrate the desktop cache from SQLite, migrating browser-era storage once. */
export async function hydrateChatStore(
  workflowId: string,
): Promise<WorkflowChatStore> {
  if (!isTauri()) return loadBrowserChatStore(workflowId);
  if (hydratedDesktopStores.has(workflowId)) {
    return desktopChatStores.get(workflowId) ?? emptyStore();
  }
  const existing = desktopHydrations.get(workflowId);
  if (existing) return existing;

  const hydration = (async () => {
    const serialized = await invoke<string | null>("get_chat_store", {
      workflowId,
    });
    let store: WorkflowChatStore | null = null;
    if (serialized) {
      try {
        const parsed = JSON.parse(serialized) as WorkflowChatStore;
        if (parsed && Array.isArray(parsed.sessions)) {
          store = {
            sessions: parsed.sessions,
            activeSessionId: parsed.activeSessionId ?? null,
          };
        }
      } catch {
        /* invalid native data falls through to the browser-era migration */
      }
    }
    if (!store) store = loadBrowserChatStore(workflowId);

    const pending = pendingDesktopStores.get(workflowId);
    if (pending) {
      store = mergeChatStores(store, pending);
      pendingDesktopStores.delete(workflowId);
    }
    store = trimChatStore(store);
    desktopChatStores.set(workflowId, store);
    hydratedDesktopStores.add(workflowId);
    if (store.sessions.length || pending)
      enqueueDesktopChatSave(workflowId, store);
    return store;
  })().finally(() => desktopHydrations.delete(workflowId));
  desktopHydrations.set(workflowId, hydration);
  return hydration;
}

export function loadChatStore(workflowId: string): WorkflowChatStore {
  if (isTauri() && hydratedDesktopStores.has(workflowId)) {
    return desktopChatStores.get(workflowId) ?? emptyStore();
  }
  return loadBrowserChatStore(workflowId);
}

function trimChatStore(store: WorkflowChatStore): WorkflowChatStore {
  return {
    ...store,
    sessions: store.sessions.map((session) => ({
      ...session,
      messages: session.messages.slice(-120),
    })),
  };
}

export function mergeChatStores(
  nativeStore: WorkflowChatStore,
  pendingStore: WorkflowChatStore,
): WorkflowChatStore {
  const sessions = new Map(
    nativeStore.sessions.map((session) => [session.id, session]),
  );
  for (const pending of pendingStore.sessions) {
    const native = sessions.get(pending.id);
    if (!native) {
      sessions.set(pending.id, pending);
      continue;
    }
    const messages = new Map(
      native.messages.map((message) => [message.id, message]),
    );
    for (const message of pending.messages) messages.set(message.id, message);
    sessions.set(pending.id, {
      ...native,
      ...pending,
      messages: [...messages.values()],
    });
  }
  return {
    sessions: [...sessions.values()],
    activeSessionId:
      pendingStore.activeSessionId ?? nativeStore.activeSessionId,
  };
}

function enqueueDesktopChatSave(
  workflowId: string,
  store: WorkflowChatStore,
): void {
  const previous = desktopSaveChains.get(workflowId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() =>
      invoke("save_chat_store", {
        workflowId,
        storeJson: JSON.stringify(store),
      }),
    )
    .then(() => undefined)
    .catch((error) => notifyPersistenceError("chat history", error))
    .finally(() => {
      if (desktopSaveChains.get(workflowId) === next) {
        desktopSaveChains.delete(workflowId);
      }
    });
  desktopSaveChains.set(workflowId, next);
}

export function resetDesktopChatCaches(): void {
  desktopChatStores.clear();
  hydratedDesktopStores.clear();
  desktopHydrations.clear();
  pendingDesktopStores.clear();
  desktopSaveChains.clear();
}

export async function flushDesktopChatSaves(): Promise<void> {
  while (desktopSaveChains.size) {
    await Promise.all([...desktopSaveChains.values()]);
  }
}

export function saveChatStore(
  workflowId: string,
  store: WorkflowChatStore,
): void {
  const trimmed = trimChatStore(store);
  if (isTauri()) {
    if (hydratedDesktopStores.has(workflowId)) {
      desktopChatStores.set(workflowId, trimmed);
      enqueueDesktopChatSave(workflowId, trimmed);
    } else {
      pendingDesktopStores.set(workflowId, trimmed);
      void hydrateChatStore(workflowId).catch((error) =>
        notifyPersistenceError("chat history", error),
      );
    }
    return;
  }
  try {
    localStorage.setItem(chatStoreKey(workflowId), JSON.stringify(trimmed));
  } catch {
    /* quota */
  }
}

export function createSession(
  workflowId: string,
  title = "New chat",
): ChatSession {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    workflowId,
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export function titleFromFirstMessage(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean;
}

/** Same-tab signal so chat UI refreshes without waiting on storage events. */
export const MEDIATOR_CHAT_UPDATED_EVENT = "codex-corp:mediator-chat-updated";

export function notifyMediatorChatUpdated(workflowId: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent(MEDIATOR_CHAT_UPDATED_EVENT, {
        detail: { workflowId },
      }),
    );
  } catch {
    /* non-browser */
  }
}

/** Append a mediator runtime event to the active session (create one if needed). */
export function appendMediatorEventToStore(
  workflowId: string,
  type: string,
  message: string,
): void {
  const line = mediatorEventMessage(type, message);
  if (!line) return;
  appendMediatorMessageToStore(workflowId, line.text, line.kind);
}

/** Append an explicit host-authored mediator message, such as local-test instructions. */
export function appendMediatorMessageToStore(
  workflowId: string,
  message: string,
  kind: ChatMessage["kind"] = "status",
): void {
  const text = message.trim();
  if (!text) return;
  const at = new Date().toISOString();
  let store = loadChatStore(workflowId);
  if (!store.activeSessionId || !store.sessions.length) {
    const session = createSession(workflowId, "Company run");
    store = {
      sessions: [session, ...store.sessions],
      activeSessionId: session.id,
    };
  }
  const sessions = store.sessions.map((s) =>
    s.id === store.activeSessionId
      ? {
          ...s,
          updatedAt: at,
          messages: [
            ...s.messages,
            makeMessage("mediator", text, kind),
          ].slice(-120),
        }
      : s,
  );
  saveChatStore(workflowId, { ...store, sessions });
  notifyMediatorChatUpdated(workflowId);
}

/** Replace mediator bubble text in-place (streaming deltas / final summary). */
export function patchChatMessageText(
  workflowId: string,
  sessionId: string,
  messageId: string,
  text: string,
  kind?: ChatMessage["kind"],
): void {
  const store = loadChatStore(workflowId);
  const at = new Date().toISOString();
  const sessions = store.sessions.map((s) =>
    s.id !== sessionId
      ? s
      : {
          ...s,
          updatedAt: at,
          messages: s.messages.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  text,
                  at,
                  kind: kind ?? m.kind,
                }
              : m,
          ),
        },
  );
  saveChatStore(workflowId, { ...store, sessions });
  notifyMediatorChatUpdated(workflowId);
}

export function mediatorEventMessage(
  type: string,
  message: string,
): ChatMessage | null {
  // Prefer lifecycle formatting (in progress / completed / blocked).
  const synthetic: RunEvent = {
    id: "tmp",
    at: new Date().toISOString(),
    type,
    message,
    level: "info",
  };
  if (isLifecycleRunEvent(type) || type.includes("layout.failed")) {
    const formatted = progressLineFromRunEvent(synthetic) ?? message;
    const kind: ChatMessage["kind"] = type.includes("approval")
      ? "approval"
      : type.includes("fail") || type.includes("interrupt")
        ? "error"
        : "progress";
    return makeMessage("mediator", formatted || message, kind);
  }
  return null;
}

// Back-compat aliases used by older call sites during migration.
export const loadChat = (workflowId: string): ChatMessage[] => {
  const store = loadChatStore(workflowId);
  const active =
    store.sessions.find((s) => s.id === store.activeSessionId) ??
    store.sessions[0];
  return active?.messages ?? [];
};

export const saveChat = (workflowId: string, messages: ChatMessage[]) => {
  const store = loadChatStore(workflowId);
  if (!store.activeSessionId) {
    const session = createSession(workflowId);
    session.messages = messages;
    saveChatStore(workflowId, {
      sessions: [session],
      activeSessionId: session.id,
    });
    return;
  }
  saveChatStore(workflowId, {
    ...store,
    sessions: store.sessions.map((s) =>
      s.id === store.activeSessionId
        ? { ...s, messages, updatedAt: new Date().toISOString() }
        : s,
    ),
  });
};

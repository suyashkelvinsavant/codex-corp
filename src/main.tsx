import {
  StrictMode,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  addEdge,
  reconnectEdge,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Connection,
  type NodeProps,
  type EdgeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Boxes,
  Braces,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  Copy,
  FileOutput,
  GitBranch,
  Hand,
  Image,
  Inbox,
  LayoutGrid,
  Lock,
  Maximize2,
  Merge,
  Network,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Unlock,
  X,
} from "lucide-react";
import { invoke, isTauri as tauriIsTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import "@fontsource/sora/500.css";
import "@fontsource/sora/600.css";
import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/500.css";
import "@fontsource/instrument-sans/600.css";
import "@fontsource/instrument-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import { applyEdgeMapping, projectedToHandoffFields } from "./edge-mapping";
import {
  defaultModelFromList,
  displayNameForModel,
  effortsForModel,
  getLiveCodexModels,
  needsLiveModelDefault,
  normalizeStoredModelId,
  publishLiveCodexModels,
  sanitizeModelList,
  subscribeLiveCodexModels,
  type CodexModelOption,
} from "./codex-models";
import { kindPopColor } from "./kind-colors";
import { autoLayout, upstreamLineage, validateWorkflow } from "./graph";
import { matchCron } from "./cron-trigger";
import { resetExecutableNodeForRun } from "./run-lifecycle";
import { resolveActiveSkill } from "./creative-skills";
import {
  EMPTY_CODEX_CAPABILITIES,
  reconcileCapabilitySelections,
  sanitizeCapabilityInventory,
  type CodexCapabilityInventory,
} from "./codex-capabilities";
import { defaultPlatformCriteria } from "./completion-criteria";
import { isSpecialistKind } from "./model";
import {
  ACTIVE_WORKFLOW_KEY,
  normalizeRunRecord,
  parseRunRecords,
  parseWorkflowSnapshot,
  readActiveWorkflowId,
  rehydrateRunRecord,
  RUNS_STORAGE_KEY,
  shouldApplyAutoloadSnapshot,
  shouldAutosaveBeforeTemplateSwitch,
  shouldReplaceEdgesFromRun,
  templateSwitchBaselineEvents,
  WORKFLOW_ID,
  workflowStorageKey,
} from "./persistence";
import {
  cloneTemplateGraph,
  createBlankWorkflowTemplate,
  DEFAULT_TEMPLATE_ID,
  EMPTY_WORKFLOW_TEMPLATE,
  getTemplate,
  listWorkflows,
  listTemplates,
  updateWorkflowMetadata,
  saveCustomWorkflow,
  deleteWorkflowFromCatalog,
} from "./templates";
import { resetBrowserWorkspaceOnce } from "./fresh-app-reset";
import { FeatureBoundary } from "./feature-boundary";
import { initAppearance } from "./theme";
import { useUiStore } from "./ui-store";
import {
  appendMediatorEventToStore,
  requestAppWorkspaceSelection,
  toCodexUserInputs,
  type AppProjectMode,
  type ChatAttachment,
} from "./workflow-chat";
import {
  isCodexAgentLifecycleEvent,
  notificationFromRunEvent,
  type MediatorNotification,
  type MediatorQuestion,
  type MediatorQuestionAnswer,
} from "./mediator-ui";
import { appendStreamPreview, isAgentMessageDelta } from "./stream-display";
import { modelDefault } from "./editor-defaults";
import { Metric } from "./metric";
import { CONTROL_KINDS, controlKindLabel, statusText } from "./node-display";
import {
  buildMediatorContextDigest,
  companyMediatorDynamicTools,
  COMPANY_MEDIATOR_SYSTEM_PROMPT,
  executeCompanyMediatorTool,
  type MediatorHostContext,
} from "./company-mediator-tools";
import {
  buildArchitectContextDigest,
  executeWorkflowArchitectTool,
  workflowArchitectDynamicTools,
  WORKFLOW_ARCHITECT_SYSTEM_PROMPT,
} from "./workflow-architect-tools";

initAppearance();
import type {
  AgentData,
  ApprovalRequest,
  CodexInfo,
  FlowEdge,
  FlowNode,
  Kind,
  RunEvent,
  RunRecord,
  Status,
  WorkflowSnapshot,
} from "./model";
import "./styles.css";
import "./responsive.css";

const AgentChatPage = lazy(() =>
  import("./agent-chat-page").then((module) => ({
    default: module.AgentChatPage,
  })),
);
const OverviewPage = lazy(() =>
  import("./overview-page").then((module) => ({
    default: module.OverviewPage,
  })),
);
const WorkflowArchitectPage = lazy(() =>
  import("./workflow-architect-page").then((module) => ({
    default: module.WorkflowArchitectPage,
  })),
);
const DecisionCenterModal = lazy(() =>
  import("./decision-center-modal").then((module) => ({
    default: module.DecisionCenterModal,
  })),
);
const NodeInspector = lazy(() =>
  import("./editor-inspector").then((module) => ({
    default: module.NodeInspector,
  })),
);
const EdgeInspector = lazy(() =>
  import("./editor-inspector").then((module) => ({
    default: module.EdgeInspector,
  })),
);

/** True inside the native desktop shell (not a plain browser tab on Vite). */
function isTauri(): boolean {
  if (tauriIsTauri()) return true;
  const g = globalThis as typeof globalThis & {
    isTauri?: boolean;
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  return !!(g.isTauri || g.__TAURI_INTERNALS__ || g.__TAURI__);
}

function codexHealthLabel(info: CodexInfo): string {
  if (info.compatible && info.found) {
    return `${info.version ?? "Codex"} ready`;
  }
  if (info.found) {
    return `${info.version ?? "Codex"} — setup needed`;
  }
  if (info.version === "Detecting Codex…") {
    return "Detecting Codex…";
  }
  if (!isTauri()) {
    return "Desktop shell required";
  }
  return info.incompatibilityReason?.includes("not found")
    ? "Codex not found"
    : "Codex unavailable";
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000 },
    mutations: { retry: 0 },
  },
});
const edgeBase = {
  type: "signalEdge",
  // Only the arrow (target) end is a disconnect/rewire grip — no source circle
  reconnectable: "target" as const,
  interactionWidth: 24,
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 16,
    height: 16,
    // CSS variable — follows light/dark + accent theme tokens
    color: "var(--edge-stroke)",
  },
};

function themedMarkerEnd(highlighted = false, selected = false) {
  return {
    type: MarkerType.ArrowClosed as const,
    width: 16,
    height: 16,
    color:
      highlighted || selected ? "var(--accent)" : "var(--edge-stroke, #52606d)",
  };
}

type CanvasContextMenu = {
  x: number;
  y: number;
  target: "pane" | "node" | "edge";
  id?: string;
};

const freshAppNeedsNativeReset = resetBrowserWorkspaceOnce();
const initialGraph = cloneTemplateGraph(EMPTY_WORKFLOW_TEMPLATE);

const roleIcons: Record<Kind, typeof Bot> = {
  agent: Bot,
  creative: Image,
  cron: Clock3,
  input: Inbox,
  approval: Hand,
  condition: GitBranch,
  merge: Merge,
  output: FileOutput,
  note: Braces,
};
function defaultLabelForKind(kind: Kind, role?: string): string {
  if (role) return role;
  switch (kind) {
    case "note":
      return "Sticky note";
    case "input":
      return "Mission brief";
    case "cron":
      return "Cron trigger";
    case "output":
      return "Delivery bundle";
    case "approval":
      return "Release approval";
    case "condition":
      return "Route condition";
    case "merge":
      return "Join branches";
    case "creative":
      return "Image Studio";
    case "agent":
      return "New specialist";
  }
}

function defaultRoleForKind(kind: Kind, role?: string): string {
  if (role) return role;
  switch (kind) {
    case "note":
      return "Canvas annotation";
    case "input":
      return "Workflow input";
    case "cron":
      return "Scheduled trigger";
    case "output":
      return "Workflow output";
    case "approval":
      return "Human checkpoint";
    case "condition":
      return "Typed routing";
    case "merge":
      return "Dependency join";
    case "creative":
      return "Visual specialist";
    case "agent":
      return "Unassigned agent";
  }
}

function CorpNode({ data, selected }: NodeProps<FlowNode>) {
  const Icon = roleIcons[data.kind];
  const liveModels = useSyncExternalStore(
    subscribeLiveCodexModels,
    getLiveCodexModels,
  );
  if (data.kind === "note") {
    const body =
      (data.prompt || "").trim() || data.description || "Empty annotation";
    return (
      <div
        className={`corp-node note-node ${selected ? "selected" : ""} ${data.dimmed ? "aperture-dim" : ""} ${data.highlighted ? "aperture-lit" : ""}`}
        style={{ "--identity": kindPopColor("note") } as React.CSSProperties}
      >
        <div className="identity-rail" />
        <div className="node-head">
          <span className="role-glyph note-glyph">
            <Icon size={16} />
          </span>
          <span className="status-chip note-chip">Note</span>
        </div>
        <strong>{data.label}</strong>
        <p className="note-preview">{body}</p>
        <div className="node-activity note-meta">
          Canvas only · not executed
        </div>
      </div>
    );
  }

  const isControl = CONTROL_KINDS.has(data.kind);
  const isCreative = data.kind === "creative";
  const controlStats = (): string[] => {
    switch (data.kind) {
      case "input":
        return ["Mission entry", "Starts the company"];
      case "cron":
        return [
          data.cronEnabled === false ? "Schedule paused" : "Schedule active",
          data.cronExpression || "Not configured",
        ];
      case "output":
        return ["Collects artifacts", `${data.artifacts?.length ?? 0} files`];
      case "approval":
        return [
          "Human checkpoint",
          data.duration !== "—" ? data.duration : "Gate",
        ];
      case "condition":
        return [
          data.conditionRule
            ? `${data.conditionRule.path} ${data.conditionRule.operator} ${String(data.conditionRule.value ?? "")}`
            : "Configure data rule",
        ];
      case "merge":
        return ["Join branches", "Waits on deps"];
      default:
        return [];
    }
  };
  const creativeSkill = isCreative
    ? resolveActiveSkill(data.skills, data.activeSkill)
    : null;

  return (
    <div
      className={`corp-node status-${data.status} ${isControl ? `control-node kind-${data.kind}` : isCreative ? "creative-node" : "agent-node"} ${selected ? "selected" : ""} ${data.dimmed ? "aperture-dim" : ""} ${data.highlighted ? "aperture-lit" : ""}`}
      style={
        {
          // Always kind SSOT so canvas identity matches library glyphs
          "--identity": kindPopColor(data.kind),
        } as React.CSSProperties
      }
    >
      {data.kind !== "cron" && (
        <Handle
          type="target"
          position={Position.Left}
          className="port port-in"
          aria-label={`Connect into ${data.label}`}
        />
      )}
      <div className="identity-rail" />
      <div className="node-head">
        <span className="role-glyph">
          <Icon size={16} />
        </span>
        <span className="node-badges">
          {isControl && (
            <span className="kind-chip">{controlKindLabel(data.kind)}</span>
          )}
          {isCreative && (
            <span className="kind-chip creative-chip">Studio</span>
          )}
          {data.requiresApproval && (
            <span title="Approval required">
              <Hand size={10} />
            </span>
          )}
          {(data.artifacts?.length ?? 0) > 0 && (
            <span title={`${data.artifacts?.length} artifacts`}>
              <FileOutput size={10} />
            </span>
          )}
          <span className="status-chip">
            <CircleDot size={9} />
            {statusText[data.status]}
          </span>
        </span>
      </div>
      <strong>{data.label}</strong>
      <p>{data.role}</p>
      <div
        className={`node-activity ${data.streamingPreview ? "streaming" : ""}`}
      >
        {data.streamingPreview || data.trace[data.trace.length - 1]}
      </div>
      <div className="node-stats">
        {isControl ? (
          controlStats().map((stat) => <span key={stat}>{stat}</span>)
        ) : isCreative ? (
          <>
            <span>{creativeSkill?.label ?? "Skill"}</span>
            <span>{(data.skills ?? []).length} skills</span>
            <span>{data.contextInputs ?? 0} ins</span>
            <span>{data.duration}</span>
          </>
        ) : (
          <>
            <span>
              {data.model
                ? displayNameForModel(liveModels, data.model)
                : "No model"}
            </span>
            <span>{data.tools.length} tools</span>
            <span>{data.contextInputs ?? 0} inputs</span>
            <span>{data.tokens.toLocaleString()} tok</span>
            <span>{data.duration}</span>
          </>
        )}
      </div>
      {data.status === "running" && (
        <div className="node-progress" aria-hidden />
      )}
      {data.kind !== "output" && (
        <Handle
          type="source"
          position={Position.Right}
          className="port port-out"
          aria-label={`Connect from ${data.label}`}
        />
      )}
    </div>
  );
}

function SignalEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  selected,
}: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.42,
  });
  const kind = data?.edgeType || "standard";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={24}
        className={`signal-edge edge-${kind} ${selected ? "selected" : ""} ${data?.highlighted ? "aperture-lit" : ""} ${data?.dimmed ? "aperture-dim" : ""}`}
      />
      {kind === "revision" && (
        <EdgeLabelRenderer>
          <div
            className="edge-label revision"
            style={{
              transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
            }}
          >
            REVISION · 1/2
          </div>
        </EdgeLabelRenderer>
      )}
      {data?.highlighted && (
        <circle className="edge-signal" r="4">
          <animateMotion dur="1.4s" repeatCount="indefinite" path={path} />
        </circle>
      )}
    </>
  );
}

const nodeTypes = { corpNode: CorpNode };
const edgeTypes = { signalEdge: SignalEdge };
const library = [
  {
    kind: "agent" as Kind,
    label: "Agent",
    hint: "fresh Codex thread",
    icon: Bot,
  },
  {
    kind: "creative" as Kind,
    label: "Creative",
    hint: "logos · assets · edit",
    icon: Image,
  },
  {
    kind: "approval" as Kind,
    label: "Approval",
    hint: "human checkpoint",
    icon: Hand,
  },
  {
    kind: "condition" as Kind,
    label: "Condition",
    hint: "typed routing",
    icon: GitBranch,
  },
  {
    kind: "merge" as Kind,
    label: "Merge",
    hint: "join dependencies",
    icon: Merge,
  },
  {
    kind: "cron" as Kind,
    label: "Cron trigger",
    hint: "scheduled start",
    icon: Clock3,
  },
  {
    kind: "input" as Kind,
    label: "Input",
    hint: "request + files",
    icon: Inbox,
  },
  {
    kind: "output" as Kind,
    label: "Output",
    hint: "collect artifacts",
    icon: FileOutput,
  },
  {
    kind: "note" as Kind,
    label: "Note",
    hint: "canvas documentation",
    icon: Braces,
  },
];

const specialistRoles = [
  "Product Manager",
  "Researcher",
  "Architect",
  "Designer",
  "Frontend Engineer",
  "Backend Engineer",
  "QA Engineer",
  "Security Reviewer",
  "Code Reviewer",
  "Delivery Agent",
] as const;

function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(
    initialGraph.nodes,
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(
    initialGraph.edges,
  );
  const [workflowId, setWorkflowId] = useState(DEFAULT_TEMPLATE_ID);
  const [workflowName, setWorkflowName] = useState("Untitled workflow");
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [architectInitialPrompt, setArchitectInitialPrompt] = useState("");
  const activeChatWorkspaceRef = useRef<string | null>(null);

  useEffect(() => {
    if (!freshAppNeedsNativeReset || !isTauri()) return;
    void invoke("clear_all_company_data").catch(() => undefined);
  }, []);

  const {
    appView,
    chatWorkflowId,
    selectedId,
    selectedEdge,
    inspectorTab: tab,
    drawerOpen: drawer,
    drawerTab,
    setAppView,
    setChatWorkflowId,
    setSelectedId,
    setSelectedEdge,
    setInspectorTab: setTab,
    setDrawerOpen: setDrawer,
    setDrawerTab,
  } = useUiStore();
  const [running, setRunning] = useState(false);
  const activeTemplate = getTemplate(workflowId);
  const [events, setEvents] = useState<RunEvent[]>([
    {
      id: "open",
      at: new Date().toISOString(),
      type: "workspace.opened",
      message: "Workspace opened",
    },
    {
      id: "graph",
      at: new Date().toISOString(),
      type: "graph.ready",
      message: "Graph ready",
    },
  ]);
  const eventsRef = useRef<RunEvent[]>(events);
  const [problems, setProblems] = useState<ReturnType<typeof validateWorkflow>>(
    [],
  );
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const approvalsRef = useRef<ApprovalRequest[]>([]);
  const [activeApproval, setActiveApproval] = useState<ApprovalRequest | null>(
    null,
  );
  const [approvalCenterOpen, setApprovalCenterOpen] = useState(false);
  const [mediatorToasts, setMediatorToasts] = useState<MediatorNotification[]>(
    [],
  );
  const [activeQuestion, setActiveQuestion] = useState<MediatorQuestion | null>(
    null,
  );
  const questionResolver = useRef<
    ((answer: MediatorQuestionAnswer | null) => void) | null
  >(null);
  const [questionFreeText, setQuestionFreeText] = useState("");
  const [questionSelected, setQuestionSelected] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [runHistory, setRunHistory] = useState<RunRecord[]>([]);
  const [compatibilityOpen, setCompatibilityOpen] = useState(false);
  const [compatibilityError, setCompatibilityError] = useState("");
  const [customCodexPath, setCustomCodexPath] = useState("");
  const [inspectorWidth, setInspectorWidth] = useState(380);
  const [libraryWidth, setLibraryWidth] = useState(240);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [drawerHeight, setDrawerHeight] = useState(210);
  const [codexModels, setCodexModels] = useState<CodexModelOption[]>([]);
  const [codexModelsStatus, setCodexModelsStatus] = useState<
    "idle" | "loading" | "live" | "unavailable"
  >("idle");
  const [codexModelsError, setCodexModelsError] = useState("");
  const [codexCapabilities, setCodexCapabilities] =
    useState<CodexCapabilityInventory>(EMPTY_CODEX_CAPABILITIES);
  const [codexCapabilitiesStatus, setCodexCapabilitiesStatus] = useState<
    "loading" | "live" | "unavailable"
  >("loading");
  const [codexCapabilitiesError, setCodexCapabilitiesError] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [librarySearchOpen, setLibrarySearchOpen] = useState(false);
  const librarySearchRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<CanvasContextMenu | null>(
    null,
  );
  const [saved, setSaved] = useState("Unsaved changes");
  const [codexInfo, setCodexInfo] = useState<CodexInfo>(() =>
    isTauri()
      ? {
          found: true,
          version: "Detecting Codex…",
          compatible: true,
          supportedRange: "codex-cli 0.140–0.150",
          lastTestedVersion: "codex-cli 0.144.1",
          selectedSource: "System CLI",
          fallbackAvailable: false,
          capabilities: [],
        }
      : {
          found: false,
          compatible: false,
          incompatibilityReason:
            "Live Codex requires the native Tauri desktop shell.",
          lastTestedVersion: "codex-cli 0.144.1",
          supportedRange: "codex-cli 0.140–0.150",
          fallbackAvailable: false,
          capabilities: [],
        },
  );
  const wrapper = useRef<HTMLDivElement>(null);
  const flowRef = useRef<any>(null);
  const historyPast = useRef<WorkflowSnapshot[]>([]);
  const historyFuture = useRef<WorkflowSnapshot[]>([]);
  const clipboard = useRef<FlowNode[]>([]);
  const dragSnapshot = useRef<WorkflowSnapshot | null>(null);
  const edgeReconnectSuccessful = useRef(true);
  /** Blocks late startup auto-load after Seed/edit/explicit workflow mutation. */
  const userMutatedWorkflow = useRef(false);
  const [, refreshHistory] = useState(0);
  const selected = nodes.find((n) => n.id === selectedId);
  const edge = edges.find((e) => e.id === selectedEdge);
  const saveWorkflowMutation = useMutation({
    mutationFn: async ({
      id,
      name,
      graphJson,
    }: {
      id: string;
      name: string;
      graphJson: string;
    }) => {
      localStorage.setItem(ACTIVE_WORKFLOW_KEY, id);
      if (isTauri())
        await invoke("save_workflow", {
          snapshot: {
            id,
            name,
            graphJson,
          },
        });
      else localStorage.setItem(workflowStorageKey(id), graphJson);
    },
  });

  const lineage = useMemo(
    () => upstreamLineage(selectedId, edges),
    [selectedId, edges],
  );
  const displayNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          // Keep data.color aligned with library kind palette (fixes stale saves)
          color: kindPopColor(n.data.kind),
          contextInputs: edges.filter(
            (edge) =>
              edge.target === n.id && edge.data?.edgeType !== "revision",
          ).length,
          highlighted: lineage.has(n.id),
          dimmed: !!selectedId && !lineage.has(n.id),
        },
      })),
    [nodes, edges, lineage, selectedId],
  );
  const libraryFilter = libraryQuery.trim().toLowerCase();
  const filteredLibrary = useMemo(() => {
    if (!libraryFilter) return library;
    return library.filter(
      (item) =>
        item.label.toLowerCase().includes(libraryFilter) ||
        item.hint.toLowerCase().includes(libraryFilter) ||
        item.kind.toLowerCase().includes(libraryFilter),
    );
  }, [libraryFilter]);
  const filteredSpecialists = useMemo(() => {
    if (!libraryFilter) return [...specialistRoles];
    return specialistRoles.filter((role) =>
      role.toLowerCase().includes(libraryFilter),
    );
  }, [libraryFilter]);

  const displayEdges = useMemo<FlowEdge[]>(
    () =>
      edges.map((e) => {
        const highlighted = lineage.has(e.source) && lineage.has(e.target);
        return {
          ...e,
          markerEnd: themedMarkerEnd(highlighted, !!e.selected),
          data: {
            ...e.data,
            edgeType: e.data?.edgeType || "standard",
            highlighted,
            dimmed:
              !!selectedId && !(lineage.has(e.source) && lineage.has(e.target)),
          },
        };
      }),
    [edges, lineage, selectedId],
  );

  const snapshot = (): WorkflowSnapshot => structuredClone({ nodes, edges });
  const pushHistory = (value = snapshot()) => {
    historyPast.current.push(value);
    if (historyPast.current.length > 60) historyPast.current.shift();
    historyFuture.current = [];
    refreshHistory((v) => v + 1);
  };
  const restore = (value: WorkflowSnapshot) => {
    setNodes(value.nodes);
    setEdges(value.edges);
    setSaved("Unsaved changes");
  };
  const undo = () => {
    const value = historyPast.current.pop();
    if (!value) return;
    historyFuture.current.push(snapshot());
    restore(value);
    refreshHistory((v) => v + 1);
  };
  const redo = () => {
    const value = historyFuture.current.pop();
    if (!value) return;
    historyPast.current.push(snapshot());
    restore(value);
    refreshHistory((v) => v + 1);
  };
  const emit = (
    message: string,
    type = "run.event",
    nodeId?: string,
    level: "info" | "warning" | "error" = "info",
  ) => {
    const event = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      type,
      message,
      nodeId,
      level,
    } satisfies RunEvent;
    eventsRef.current = [...eventsRef.current, event];
    setEvents(eventsRef.current);
    // Mirror lifecycle signals into the company mediator chat session.
    try {
      appendMediatorEventToStore(workflowId, type, message);
    } catch {
      /* ignore chat persistence errors */
    }
    // In-app toast for lifecycle events (mediator notification plane).
    try {
      const toast = notificationFromRunEvent(event, runId ?? undefined);
      if (toast) {
        setMediatorToasts((prev) => [...prev.slice(-4), toast]);
        window.setTimeout(() => {
          setMediatorToasts((prev) => prev.filter((t) => t.id !== toast.id));
        }, 5200);
      }
    } catch {
      /* ignore */
    }
  };

  const setMissionBrief = (
    mission: string,
    source: "manual" | "chat" | "template" = "chat",
    sessionId?: string,
  ) => {
    const text = mission.trim();
    if (!text) return;
    setNodes((ns) =>
      ns.map((n) =>
        n.data.kind === "input"
          ? {
              ...n,
              data: {
                ...n.data,
                output: text,
                missionSource: source,
                chatSessionId: sessionId ?? n.data.chatSessionId,
                missionUpdatedAt: new Date().toISOString(),
                status: "completed",
                trace: [
                  ...n.data.trace,
                  source === "chat"
                    ? "Mission updated from company mediator"
                    : "Mission updated",
                ],
              },
            }
          : n,
      ),
    );
    markDirty();
    emit(`Mission brief updated (${source})`, "mission.updated", "input");
  };

  const mediatorHostContext = (): MediatorHostContext => ({
    nodes,
    edges,
    events: eventsRef.current,
    running,
    runId,
    approvals: approvalsRef.current,
    runHistory,
    actions: {
      run: (mission) => {
        if (mission) setMissionBrief(mission, "chat");
        return run();
      },
      stop: () => stop(),
      setMission: (mission) => setMissionBrief(mission, "chat"),
      approve: () => decideApproval(true),
      decline: () => decideApproval(false),
      runFrom: (nodeId) => run(nodeId),
      askOperator: (question) => askMediatorQuestion(question),
      selectAppWorkspace: async (suggestedMode) => {
        const selection = await requestAppWorkspaceSelection(suggestedMode);
        activeChatWorkspaceRef.current = selection?.workspacePath ?? null;
        return selection;
      },
      focusNode: (nodeId) => {
        setSelectedId(nodeId);
        setAppView("editor");
      },
    },
  });

  const handleMediatorTurn = async (req: {
    text: string;
    attachments: ChatAttachment[];
    history: Array<{ role: "user" | "mediator" | "system"; text: string }>;
    sessionId: string;
    messageId: string;
    threadId?: string;
    model?: string;
    effort?: string;
    projectMode?: AppProjectMode;
    workspacePath?: string;
    onDelta?: (delta: string) => void;
  }) => {
    if (!isTauri()) {
      throw new Error(
        "Company chat is available in the desktop app. Start it with npm run desktop:dev.",
      );
    }
    if (!codexInfo.compatible) {
      throw new Error(
        codexInfo.incompatibilityReason ||
          "Codex CLI is unavailable or incompatible.",
      );
    }
    activeChatWorkspaceRef.current = req.workspacePath ?? null;
    const model =
      normalizeStoredModelId(req.model ?? "") ||
      defaultModelFromList(codexModels) ||
      normalizeStoredModelId(
        nodes.find((n) => isSpecialistKind(n.data.kind))?.data.model ?? "",
      );
    if (!model) {
      throw new Error(
        "No Codex model available. Connect CLI (model/list) and pick a model in chat.",
      );
    }
    const effortOptions = effortsForModel(codexModels, model);
    const effortRaw = (req.effort ?? "low").trim().toLowerCase();
    const effort = effortOptions.includes(effortRaw)
      ? effortRaw
      : (effortOptions[0] ?? "low");
    const unlistenTool = await listen<{
      requestId: string;
      tool: string;
      arguments: unknown;
    }>("mediator-tool-call", async (event) => {
      const { requestId, tool, arguments: args } = event.payload;
      try {
        if (
          [
            "company_run",
            "company_run_from",
            "company_approve",
            "company_decline",
          ].includes(tool)
        ) {
          const detail =
            tool === "company_run_from"
              ? "Start from this node and intentionally skip its ancestors?"
              : `Allow the mediator to ${tool.replace("company_", "").replace(/_/g, " ")}?`;
          if (!window.confirm(detail)) {
            await invoke("respond_mediator_tool", {
              requestId,
              success: false,
              content: JSON.stringify({
                error: "Operator cancelled confirmation",
              }),
            });
            return;
          }
        }
        const result = await executeCompanyMediatorTool(
          tool,
          args,
          mediatorHostContext(),
        );
        await invoke("respond_mediator_tool", {
          requestId,
          success: result.success,
          content: result.text,
        });
      } catch (error) {
        await invoke("respond_mediator_tool", {
          requestId,
          success: false,
          content: JSON.stringify({ error: String(error) }),
        }).catch(() => undefined);
      }
    });
    const unlistenDelta = await listen<{
      messageId?: string;
      delta: string;
    }>("mediator-chat-delta", (event) => {
      if (event.payload.messageId !== req.messageId) return;
      if (event.payload.delta) req.onDelta?.(event.payload.delta);
    });
    try {
      const recentConversation = req.history
        .map(
          (message) =>
            `${message.role === "user" ? "Operator" : "Company mediator"}: ${message.text}`,
        )
        .join("\n\n");
      const result = await invoke<{
        summary: string;
        threadId: string;
        turnId: string;
      }>("execute_mediator_turn", {
        request: {
          model,
          effort,
          systemPrompt: COMPANY_MEDIATOR_SYSTEM_PROMPT,
          input: toCodexUserInputs(req.text, req.attachments),
          fallbackTranscript: recentConversation,
          contextDigest: buildMediatorContextDigest(mediatorHostContext()),
          projectMode: req.projectMode,
          workspacePath: req.workspacePath,
          dynamicTools: companyMediatorDynamicTools(),
          threadId: req.threadId ?? null,
          sessionId: req.sessionId,
          messageId: req.messageId,
        },
      });
      return { summary: result.summary, threadId: result.threadId };
    } finally {
      unlistenTool();
      unlistenDelta();
    }
  };

  const persistArchitectWorkflow = async (
    template: ReturnType<typeof getTemplate>,
  ) => {
    saveCustomWorkflow(template);
    const graphJson = JSON.stringify({
      nodes: template.nodes,
      edges: template.edges,
    });
    if (isTauri())
      await invoke("save_workflow", {
        snapshot: { id: template.id, name: template.name, graphJson },
      });
    else localStorage.setItem(workflowStorageKey(template.id), graphJson);
    setCatalogRevision((value) => value + 1);
  };

  const handleArchitectTurn = async (
    req: Parameters<typeof handleMediatorTurn>[0],
  ) => {
    if (!isTauri())
      throw new Error(
        "Workflow Architect needs the Codex Corp desktop app with Live Codex.",
      );
    if (!codexInfo.compatible)
      throw new Error(
        codexInfo.incompatibilityReason ||
          "Codex CLI is unavailable or incompatible.",
      );
    const model =
      normalizeStoredModelId(req.model ?? "") ||
      defaultModelFromList(codexModels) ||
      normalizeStoredModelId(
        nodes.find((n) => isSpecialistKind(n.data.kind))?.data.model ?? "",
      );
    if (!model)
      throw new Error("No Codex model is available. Connect the CLI first.");
    const effortOptions = effortsForModel(codexModels, model);
    const effort = effortOptions.includes(req.effort ?? "")
      ? req.effort!
      : effortOptions.includes("high")
        ? "high"
        : (effortOptions[0] ?? "low");
    const unlistenTool = await listen<{
      requestId: string;
      tool: string;
      arguments: unknown;
    }>("mediator-tool-call", async (event) => {
      const { requestId, tool, arguments: args } = event.payload;
      try {
        const result = await executeWorkflowArchitectTool(tool, args, {
          save: persistArchitectWorkflow,
          remove: async (id) => {
            if (isTauri()) await invoke("delete_workflow", { id });
            deleteWorkflowFromCatalog(id);
            localStorage.removeItem(workflowStorageKey(id));
            setCatalogRevision((value) => value + 1);
          },
          open: (id) => {
            void switchTemplate(id, "editor");
          },
        });
        await invoke("respond_mediator_tool", {
          requestId,
          success: result.success,
          content: result.text,
        });
      } catch (error) {
        await invoke("respond_mediator_tool", {
          requestId,
          success: false,
          content: JSON.stringify({ error: String(error) }),
        }).catch(() => undefined);
      }
    });
    const unlistenDelta = await listen<{ messageId?: string; delta: string }>(
      "mediator-chat-delta",
      (event) => {
        if (event.payload.messageId === req.messageId && event.payload.delta)
          req.onDelta?.(event.payload.delta);
      },
    );
    try {
      const result = await invoke<{ summary: string; threadId: string }>(
        "execute_mediator_turn",
        {
          request: {
            model,
            effort,
            systemPrompt: WORKFLOW_ARCHITECT_SYSTEM_PROMPT,
            input: toCodexUserInputs(req.text, req.attachments),
            fallbackTranscript: req.history
              .map(
                (m) =>
                  `${m.role === "user" ? "Operator" : "Workflow Architect"}: ${m.text}`,
              )
              .join("\n\n"),
            contextDigest: buildArchitectContextDigest(),
            dynamicTools: workflowArchitectDynamicTools(),
            threadId: req.threadId ?? null,
            sessionId: req.sessionId,
            messageId: req.messageId,
          },
        },
      );
      return { summary: result.summary, threadId: result.threadId };
    } finally {
      unlistenTool();
      unlistenDelta();
    }
  };

  /** Ask the operator a question (options and/or free text). Blocks until answered. */
  const askMediatorQuestion = (question: MediatorQuestion) =>
    new Promise<MediatorQuestionAnswer | null>((resolve) => {
      setActiveQuestion(question);
      setApprovalCenterOpen(true);
      setQuestionFreeText("");
      setQuestionSelected([]);
      questionResolver.current = resolve;
    });

  const resolveMediatorQuestion = (cancel: boolean) => {
    if (!activeQuestion) return;
    if (cancel) {
      questionResolver.current?.(null);
      questionResolver.current = null;
      setActiveQuestion(null);
      return;
    }
    const answer: MediatorQuestionAnswer = {
      questionId: activeQuestion.id,
      optionIds: questionSelected,
      freeText: questionFreeText.trim() || undefined,
      at: new Date().toISOString(),
    };
    if (
      activeQuestion.optionsOnly &&
      activeQuestion.options?.length &&
      !answer.optionIds.length
    ) {
      return;
    }
    questionResolver.current?.(answer);
    questionResolver.current = null;
    setActiveQuestion(null);
    emit(
      `Operator answered: ${activeQuestion.title}`,
      "mediator.question.answered",
    );
  };
  const inspectRun = (record: RunRecord) => {
    setRunId(record.id);
    const rehydrated = rehydrateRunRecord(record);
    eventsRef.current = rehydrated.events;
    setEvents(rehydrated.events);
    if (rehydrated.nodes?.length) {
      setNodes(rehydrated.nodes);
      const focus =
        rehydrated.nodes.find((n) =>
          (n.data.artifacts ?? []).some(
            (a) => a.name === "delivery-bundle.json",
          ),
        ) ??
        rehydrated.nodes.find((n) => n.data.kind === "output") ??
        rehydrated.nodes[0];
      if (focus) {
        setSelectedId(focus.id);
        setSelectedEdge(null);
        setTab(focus.data.kind === "agent" ? "io" : "overview");
      }
    }
    // null = missing edgesJson (keep canvas); [] = explicit empty graph edges.
    if (shouldReplaceEdgesFromRun(rehydrated.edges)) setEdges(rehydrated.edges);
    setDrawer(true);
    setDrawerTab(rehydrated.deliveryArtifactPresent ? "artifacts" : "timeline");
    emit(
      `Inspecting run ${record.id.slice(0, 8)} · ${record.status}`,
      "run.inspected",
      undefined,
      "info",
    );
  };
  const resumeRun = async (record: RunRecord) => {
    if (!isTauri() || !record.resumable || record.status !== "interrupted") {
      inspectRun(record);
      return;
    }
    if (!window.confirm("Resume this run from its last safe checkpoint?"))
      return;
    try {
      const resumed = await invoke<RunRecord>("resume_run", {
        runId: record.id,
      });
      setRunId(resumed.id);
      setRunning(true);
      setDrawer(true);
      setDrawerTab("timeline");
      emit(
        `Resuming ${resumed.id.slice(0, 8)} from its last safe checkpoint`,
        "run.resume.requested",
      );
    } catch (error) {
      emit(
        `Resume failed: ${String(error)}`,
        "run.resume.failed",
        undefined,
        "error",
      );
    }
  };
  const markDirty = () => {
    userMutatedWorkflow.current = true;
    setSaved("Unsaved changes");
  };
  const beginInspectorResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = inspectorWidth;
    const move = (pointer: PointerEvent) =>
      setInspectorWidth(
        Math.max(320, Math.min(640, startWidth + startX - pointer.clientX)),
      );
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };
  const beginLibraryResize = (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startWidth = libraryWidth;
    const move = (pointer: PointerEvent) =>
      setLibraryWidth(
        Math.max(180, Math.min(420, startWidth + pointer.clientX - startX)),
      );
    const finish = (pointer: PointerEvent) => {
      try {
        target.releasePointerCapture?.(pointer.pointerId);
      } catch {
        /* already released */
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };
  const beginDrawerResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = drawerHeight;
    const move = (pointer: PointerEvent) =>
      setDrawerHeight(
        Math.max(150, Math.min(420, startHeight + startY - pointer.clientY)),
      );
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };
  const updateNode = (patch: Partial<AgentData>) => {
    if (!selected) return;
    pushHistory();
    setNodes((ns) =>
      ns.map((n) =>
        n.id === selected.id ? { ...n, data: { ...n.data, ...patch } } : n,
      ),
    );
    markDirty();
  };
  const updateEdge = (patch: Partial<NonNullable<FlowEdge["data"]>>) => {
    if (!edge) return;
    pushHistory();
    setEdges((es) =>
      es.map((item) =>
        item.id === edge.id
          ? {
              ...item,
              data: {
                edgeType: item.data?.edgeType ?? "standard",
                ...item.data,
                ...patch,
              },
            }
          : item,
      ),
    );
    markDirty();
  };
  const onConnect = useCallback(
    (c: Connection) => {
      pushHistory();
      setEdges(
        (es) =>
          addEdge(
            {
              ...c,
              id: `e-${crypto.randomUUID()}`,
              type: "signalEdge",
              reconnectable: "target",
              interactionWidth: 24,
              data: { edgeType: "standard" },
              markerEnd: themedMarkerEnd(),
            },
            es,
          ) as FlowEdge[],
      );
      markDirty();
    },
    [nodes, edges, setEdges],
  );
  const onReconnectStart = useCallback(() => {
    edgeReconnectSuccessful.current = false;
    setContextMenu(null);
  }, []);
  const onReconnect = useCallback(
    (oldEdge: FlowEdge, newConnection: Connection) => {
      edgeReconnectSuccessful.current = true;
      pushHistory();
      setEdges((eds) => reconnectEdge(oldEdge, newConnection, eds));
      markDirty();
    },
    [setEdges],
  );
  const onReconnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, edge: FlowEdge) => {
      if (!edgeReconnectSuccessful.current) {
        pushHistory();
        setEdges((eds) => eds.filter((item) => item.id !== edge.id));
        setSelectedEdge(null);
        markDirty();
        emit("Connection unplugged", "edge.disconnected");
      }
      edgeReconnectSuccessful.current = true;
    },
    [setEdges, setSelectedEdge],
  );
  const openContextMenu = (
    event: {
      clientX: number;
      clientY: number;
      preventDefault: () => void;
      stopPropagation: () => void;
    },
    target: CanvasContextMenu["target"],
    id?: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target,
      id,
    });
  };
  const closeContextMenu = () => setContextMenu(null);
  const deleteEdgeById = (edgeId: string) => {
    pushHistory();
    setEdges((eds) => eds.filter((item) => item.id !== edgeId));
    setSelectedEdge(null);
    markDirty();
    emit("Connection removed", "edge.deleted");
  };
  const deleteNodeById = (nodeId: string) => {
    pushHistory();
    setNodes((ns) => ns.filter((node) => node.id !== nodeId));
    setEdges((eds) =>
      eds.filter((item) => item.source !== nodeId && item.target !== nodeId),
    );
    if (selectedId === nodeId) setSelectedId("");
    markDirty();
  };
  const createNode = (
    kind: Kind,
    position?: { x: number; y: number },
    role?: string,
  ) => {
    pushHistory();
    const id = `${kind}-${crypto.randomUUID()}`;
    const i = nodes.length;
    const isSpecialist = isSpecialistKind(kind);
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: "corpNode",
        position: position ?? {
          x: 320 + (i % 3) * 310,
          y: 120 + (i % 4) * 150,
        },
        data: {
          label: defaultLabelForKind(kind, role),
          role: defaultRoleForKind(kind, role),
          kind,
          status: kind === "note" ? "draft" : "idle",
          model: isSpecialist
            ? defaultModelFromList(codexModels) || modelDefault
            : kind === "approval"
              ? "Human"
              : kind === "output"
                ? "Collector"
                : "Control",
          effort: "low",
          tools:
            kind === "creative"
              ? ["Image generation", "Image edit", "Workspace write"]
              : [],
          skills: isSpecialist ? [] : undefined,
          connectorTools: isSpecialist ? [] : undefined,
          prompt:
            kind === "note"
              ? "Use this note to explain a subgraph or design decision. Notes are never executed."
              : kind === "creative"
                ? "You are Codex Creative Studio. Produce visual assets for non-technical operators: logos, UI art, heroes, icons, edits, and mockups. Follow the primary skill direction and return image artifacts."
                : kind === "approval"
                  ? "Pause until a human approves the reviewed deliverable."
                  : kind === "input"
                    ? "Capture the user request and constraints."
                    : kind === "cron"
                      ? "Start the workflow on the configured schedule."
                      : kind === "output"
                        ? "Collect approved artifacts and execution notes."
                        : kind === "condition"
                          ? "Route when the configured branch value matches."
                          : kind === "merge"
                            ? "Wait for required upstream branches, then continue."
                            : "Define this node contract.",
          description:
            kind === "note"
              ? "Documentation only — not part of the executable company graph."
              : kind === "creative"
                ? "One studio node · many visual skills (logo, assets, edit, mockups)."
                : kind === "input"
                  ? "The authorized request entering the company."
                  : kind === "cron"
                    ? "Schedules a company run and connects into the Mission brief."
                    : kind === "output"
                      ? "Final auditable project handoff."
                      : kind === "approval"
                        ? "Explicit human release decision."
                        : kind === "condition"
                          ? "Typed branch control for downstream edges."
                          : kind === "merge"
                            ? "Joins parallel specialist tracks."
                            : "Configure this node in the inspector.",
          duration: "—",
          tokens: 0,
          conditionRule:
            kind === "condition"
              ? {
                  path: "$.status",
                  operator: "==",
                  value: "success",
                  trueBranch: "success",
                  falseBranch: "otherwise",
                }
              : undefined,
          output:
            kind === "input"
              ? "Describe the product request for the company."
              : undefined,
          cronExpression: kind === "cron" ? "0 9 * * 1-5" : undefined,
          cronTimezone:
            kind === "cron"
              ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
              : undefined,
          cronEnabled: kind === "cron" ? true : undefined,
          trace:
            kind === "note"
              ? ["Annotation placed on canvas"]
              : kind === "creative"
                ? ["Creative Studio ready"]
                : ["Draft node created"],
          maxRevisions: 2,
          completionCriteria: isSpecialist
            ? defaultPlatformCriteria()
            : undefined,
          maxRetries: 2,
          timeoutSeconds: 120,
          // Same SSOT as library sidebar glyphs
          color: kindPopColor(kind),
        },
      },
    ]);
    setSelectedId(id);
    setSelectedEdge(null);
    markDirty();
    return id;
  };
  const duplicate = () => {
    const chosen = nodes.filter((n) => n.selected || n.id === selectedId);
    if (!chosen.length) return;
    pushHistory();
    const copies = chosen.map((n) => ({
      ...structuredClone(n),
      id: `${n.id}-copy-${crypto.randomUUID()}`,
      position: { x: n.position.x + 40, y: n.position.y + 40 },
      data: { ...n.data, label: `${n.data.label} copy` },
      selected: true,
    }));
    setNodes((ns) => [
      ...ns.map((n) => ({ ...n, selected: false })),
      ...copies,
    ]);
    setSelectedId(copies[0].id);
    markDirty();
  };
  const copy = () => {
    clipboard.current = structuredClone(
      nodes.filter((n) => n.selected || n.id === selectedId),
    );
    emit(
      `${clipboard.current.length} node${clipboard.current.length === 1 ? "" : "s"} copied`,
      "editor.copy",
    );
  };
  const paste = () => {
    if (!clipboard.current.length) return;
    pushHistory();
    const pasted = clipboard.current.map((n) => ({
      ...structuredClone(n),
      id: `${n.id}-paste-${crypto.randomUUID()}`,
      position: { x: n.position.x + 48, y: n.position.y + 48 },
      selected: true,
    }));
    setNodes((ns) => [
      ...ns.map((n) => ({ ...n, selected: false })),
      ...pasted,
    ]);
    clipboard.current = structuredClone(pasted);
    setSelectedId(pasted[0].id);
    markDirty();
  };
  const removeSelected = () => {
    const ids = new Set(
      nodes.filter((n) => n.selected || n.id === selectedId).map((n) => n.id),
    );
    if (!ids.size && !selectedEdge) return;
    pushHistory();
    if (selectedEdge) {
      setEdges((es) => es.filter((e) => e.id !== selectedEdge));
      setSelectedEdge(null);
    } else {
      setNodes((ns) => ns.filter((n) => !ids.has(n.id)));
      setEdges((es) =>
        es.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
      );
      setSelectedId("");
    }
    markDirty();
  };
  const layout = () => {
    try {
      const next = autoLayout(nodes, edges);
      pushHistory();
      setNodes(next);
      markDirty();
      requestAnimationFrame(() =>
        flowRef.current?.fitView({ padding: 0.12, duration: 350 }),
      );
    } catch (error) {
      console.error("Auto layout failed", error);
      emit(
        `Auto layout failed: ${error instanceof Error ? error.message : String(error)}`,
        "layout.failed",
        undefined,
        "error",
      );
    }
  };
  const applyGraph = (
    nextNodes: FlowNode[],
    nextEdges: FlowEdge[],
    nextWorkflowId: string,
    label: string,
  ) => {
    setWorkflowId(nextWorkflowId);
    setWorkflowName(getTemplate(nextWorkflowId).name);
    localStorage.setItem(ACTIVE_WORKFLOW_KEY, nextWorkflowId);
    setNodes(nextNodes);
    setEdges(nextEdges);
    setProblems([]);
    // Prefer an agent so the inspector does not surface a second "Run company".
    const focus =
      nextNodes.find((n) => n.id === "builder")?.id ??
      nextNodes.find((n) => n.data.kind === "agent")?.id ??
      nextNodes.find((n) => n.data.kind === "input")?.id ??
      nextNodes[0]?.id ??
      "";
    setSelectedId(focus);
    setSelectedEdge(null);
    setSaved(label);
  };

  const save = async (emptyConfirmed = false) => {
    if (!emptyConfirmed && !nodes.length && !edges.length) {
      const confirmed = window.confirm(
        "Are you sure you want to save an empty workflow?",
      );
      if (!confirmed) return false;
    }
    const graphJson = JSON.stringify({ nodes, edges });
    const template = getTemplate(workflowId);
    saveCustomWorkflow({
      ...template,
      name: workflowName.trim() || "Untitled workflow",
      nodes: structuredClone(nodes),
      edges: structuredClone(edges),
      draft: false,
    });
    await saveWorkflowMutation.mutateAsync({
      id: workflowId,
      name: workflowName.trim() || "Untitled workflow",
      graphJson,
    });
    setCatalogRevision((value) => value + 1);
    setSaved(isTauri() ? "Saved to SQLite" : "Saved locally");
    emit(
      isTauri()
        ? `Workflow saved to SQLite · ${workflowName}`
        : `Workflow saved locally · ${workflowName}`,
      "workflow.saved",
    );
    return true;
  };

  const leaveEditorForOverview = async () => {
    const template = getTemplate(workflowId);
    if (template.draft) {
      if (!nodes.length && !edges.length) {
        const keep = window.confirm(
          "Are you sure you want to save an empty workflow? Select Cancel to discard it.",
        );
        if (keep) {
          const savedEmpty = await save(true);
          if (!savedEmpty) return;
        } else {
          deleteWorkflowFromCatalog(workflowId);
          localStorage.removeItem(workflowStorageKey(workflowId));
        }
      } else {
        await save();
      }
    }
    setAppView("overview");
  };
  const load = async () => {
    const raw = isTauri()
      ? await invoke<string | null>("load_workflow", { id: workflowId })
      : localStorage.getItem(workflowStorageKey(workflowId));
    const w = parseWorkflowSnapshot(raw);
    if (!w) {
      emit(
        "No saved workflow found",
        "workflow.load.miss",
        undefined,
        "warning",
      );
      return;
    }
    userMutatedWorkflow.current = true;
    pushHistory();
    applyGraph(
      w.nodes,
      w.edges,
      workflowId,
      isTauri() ? "Loaded from SQLite" : "Loaded locally",
    );
    emit("Workflow reopened", "workflow.loaded");
  };
  const resetToSeed = () => {
    userMutatedWorkflow.current = true;
    pushHistory();
    const factory = cloneTemplateGraph(getTemplate(workflowId));
    applyGraph(factory.nodes, factory.edges, workflowId, "Seed template");
    emit(
      `Factory template restored · ${getTemplate(workflowId).name}`,
      "workflow.seed",
    );
  };
  const loadRunHistoryFor = async (id: string) => {
    try {
      if (isTauri()) {
        const rows = await invoke<RunRecord[]>("list_runs", {
          workflowId: id,
        });
        setRunHistory(
          rows
            .map((row) => normalizeRunRecord(row))
            .filter((row): row is RunRecord => Boolean(row)),
        );
      } else {
        const all = parseRunRecords(localStorage.getItem(RUNS_STORAGE_KEY));
        setRunHistory(all.filter((record) => record.workflowId === id));
      }
    } catch {
      setRunHistory([]);
    }
  };

  const clearRunUiForTemplateSwitch = (templateName: string) => {
    const baseline = templateSwitchBaselineEvents(templateName);
    eventsRef.current = baseline;
    setEvents(baseline);
    approvalsRef.current = [];
    setApprovals([]);
    setActiveApproval(null);
    setRunId(null);
    setDrawerTab("timeline");
  };

  const switchTemplate = async (
    nextId: string,
    mode: "stay" | "editor" | "chat" = "stay",
  ) => {
    // Don't switch companies mid-run; same company can open chat/editor freely.
    if (running && nextId !== workflowId) return;
    const template = getTemplate(nextId);

    if (nextId === workflowId) {
      if (mode === "editor") {
        setAppView("editor");
        requestAnimationFrame(() =>
          flowRef.current?.fitView({ padding: 0.12, duration: 300 }),
        );
      } else if (mode === "chat") {
        setChatWorkflowId(nextId);
        setAppView("chat");
      }
      return;
    }

    userMutatedWorkflow.current = true;
    pushHistory();
    const leavingId = workflowId;

    // Persist the canvas we are leaving so unsaved edits are not discarded.
    if (shouldAutosaveBeforeTemplateSwitch(leavingId, nextId, running)) {
      try {
        const graphJson = JSON.stringify({ nodes, edges });
        const leaving = getTemplate(leavingId);
        await saveWorkflowMutation.mutateAsync({
          id: leavingId,
          name: leaving.name,
          graphJson,
        });
        emit(
          `Auto-saved · ${leaving.name} before template switch`,
          "workflow.autosave",
        );
      } catch (error) {
        emit(
          `Auto-save before switch failed: ${String(error)}`,
          "workflow.autosave.failed",
          undefined,
          "error",
        );
        // Still switch — user already confirmed by picking a template; edits
        // remain in undo history for the session.
      }
    }

    clearRunUiForTemplateSwitch(template.name);

    try {
      const raw = isTauri()
        ? await invoke<string | null>("load_workflow", { id: nextId })
        : localStorage.getItem(workflowStorageKey(nextId));
      const saved = parseWorkflowSnapshot(raw);
      if (saved) {
        applyGraph(
          saved.nodes,
          saved.edges,
          nextId,
          isTauri() ? "Loaded from SQLite" : "Loaded locally",
        );
        await loadRunHistoryFor(nextId);
        emit(`Switched to saved · ${template.name}`, "workflow.template");
        if (mode === "editor") {
          setAppView("editor");
          requestAnimationFrame(() =>
            flowRef.current?.fitView({ padding: 0.12, duration: 300 }),
          );
        } else if (mode === "chat") {
          setChatWorkflowId(nextId);
          setAppView("chat");
        }
        return;
      }
    } catch {
      /* factory fallback */
    }
    const factory = cloneTemplateGraph(template);
    applyGraph(factory.nodes, factory.edges, nextId, "Template loaded");
    await loadRunHistoryFor(nextId);
    emit(`Switched to template · ${template.name}`, "workflow.template");
    if (mode === "editor") {
      setAppView("editor");
      requestAnimationFrame(() =>
        flowRef.current?.fitView({ padding: 0.12, duration: 300 }),
      );
    } else if (mode === "chat") {
      setChatWorkflowId(nextId);
      setAppView("chat");
    }
  };

  const createBlankWorkflow = async () => {
    if (running) return;
    const template = createBlankWorkflowTemplate();
    await persistArchitectWorkflow(template);
    await switchTemplate(template.id, "editor");
  };

  const validate = async () => {
    let found = validateWorkflow(nodes, edges);
    if (isTauri())
      try {
        const nativeProblems = await invoke<typeof found>("validate_workflow", {
          graphJson: JSON.stringify({ nodes, edges }),
        });
        const known = new Set(found.map((problem) => problem.id));
        found = [
          ...found,
          ...nativeProblems.filter((problem) => !known.has(problem.id)),
        ];
      } catch (error) {
        found.push({
          id: "rust-validation-failed",
          severity: "error",
          message: `Rust graph validation failed: ${String(error)}`,
        });
      }
    if (!isTauri()) {
      found.push({
        id: "desktop-shell-required",
        severity: "error",
        message:
          "Company runs are available in the desktop app. Start it with npm run desktop:dev.",
      });
    } else if (!codexInfo.compatible) {
      found.push({
        id: "codex-incompatible",
        severity: "error",
        message:
          "The selected Codex executable is unavailable or incompatible.",
      });
    }
    setProblems(found);
    setNodes((ns) =>
      ns.map((n) => ({
        ...n,
        data: {
          ...n.data,
          validationErrors: found
            .filter((p) => p.nodeId === n.id)
            .map((p) => p.message),
          status: found.some((p) => p.nodeId === n.id && p.severity === "error")
            ? "invalid"
            : n.data.status === "invalid"
              ? "idle"
              : n.data.status,
        },
      })),
    );
    if (found.length) {
      setDrawer(true);
      setDrawerTab("problems");
      found.forEach((p) =>
        emit(
          p.message,
          "validation.problem",
          p.nodeId,
          p.severity === "error" ? "error" : "warning",
        ),
      );
    } else
      emit(
        `Validation passed · ${isTauri() ? "Rust graph executable" : "graph executable"}`,
        "validation.passed",
      );
    return found.length === 0;
  };
  const decideApprovalFor = async (
    request: ApprovalRequest,
    approved: boolean,
  ) => {
    const decision = approved ? "approved" : "declined";
    approvalsRef.current = approvalsRef.current.map((item) =>
      item.id === request.id ? { ...item, status: decision } : item,
    );
    setApprovals(approvalsRef.current);
    if (request.nativeRequestId && isTauri())
      await invoke(
        request.runId ? "respond_run_approval" : "respond_codex_approval",
        request.runId
          ? {
              runId: request.runId,
              requestId: request.nativeRequestId,
              decision: approved,
            }
          : {
              requestId: request.nativeRequestId,
              decision: approved ? "accept" : "decline",
            },
      );
    const next = approvalsRef.current.find((item) => item.status === "pending");
    setActiveApproval(next ?? null);
  };
  const decideApproval = async (approved: boolean) => {
    if (!activeApproval) return;
    await decideApprovalFor(activeApproval, approved);
  };
  const selectCodexSource = async (source: "system" | "fallback") => {
    if (!isTauri()) return;
    setCompatibilityError("");
    try {
      const info = await invoke<CodexInfo>("select_codex_source", { source });
      setCodexInfo(info);
      emit(
        `${info.selectedSource} selected · ${info.version}`,
        "codex.source.selected",
      );
    } catch (error) {
      setCompatibilityError(String(error));
    }
  };
  const selectCustomCodexPath = async () => {
    if (!isTauri() || !customCodexPath.trim()) return;
    setCompatibilityError("");
    try {
      const proposed = await invoke<CodexInfo>("probe_codex_path", {
        path: customCodexPath.trim(),
      });
      const accepted = window.confirm(
        `Use this Codex executable?\n\nResolved path: ${proposed.executable}\nVersion: ${proposed.version ?? "unknown"}\nApp-server protocol probe: ${proposed.appServerAvailable ? "passed" : "failed"}${proposed.compatibilityWarning ? `\nWarning: ${proposed.compatibilityWarning}` : ""}`,
      );
      if (!accepted) return;
      const info = await invoke<CodexInfo>("select_codex_path", {
        path: customCodexPath.trim(),
      });
      setCodexInfo(info);
      emit(
        `User Codex path selected · ${info.version}`,
        "codex.source.selected",
      );
    } catch (error) {
      setCompatibilityError(String(error));
    }
  };
  const stop = async () => {
    if (isTauri() && runId) {
      await invoke("stop_run", { runId });
      return;
    }
    setActiveApproval(null);
    setNodes((ns) =>
      ns.map((n) =>
        n.data.status === "running" ||
        n.data.status === "queued" ||
        n.data.status === "approval"
          ? {
              ...n,
              data: {
                ...n.data,
                status: "interrupted",
                trace: [...n.data.trace, "Interrupted by operator"],
              },
            }
          : n,
      ),
    );
    emit(
      "Run interrupted by operator",
      "run.interrupted",
      undefined,
      "warning",
    );
  };
  const run = async (startNodeId?: string) => {
    if (running || !(await validate())) return;
    if (!isTauri()) {
      emit(
        "Live Codex runs require the desktop app.",
        "run.desktop.required",
        undefined,
        "error",
      );
      return;
    }
    setRunning(true);
    setDrawer(true);
    setDrawerTab("timeline");
    eventsRef.current = [];
    setEvents([]);
    try {
      const persisted = await save();
      if (!persisted) {
        setRunning(false);
        return;
      }
      const record = await invoke<RunRecord>("start_run", {
        workflowId,
        startNodeId: startNodeId ?? null,
        workspacePath: activeChatWorkspaceRef.current,
      });
      setRunId(record.id);
      setRunHistory((items) => [
        record,
        ...items.filter((item) => item.id !== record.id),
      ]);
      setNodes((items) => items.map(resetExecutableNodeForRun));
      emit(`Native run ${record.id.slice(-8)} queued`, "run.queued");
    } catch (error) {
      setRunning(false);
      emit(
        `Native run failed to start: ${String(error)}`,
        "run.start.failed",
        undefined,
        "error",
      );
    }
  };

  const cronMinuteKeys = useRef<Record<string, string>>({});
  useEffect(() => {
    const checkSchedules = () => {
      if (running || !isTauri()) return;
      for (const node of nodes) {
        if (node.data.kind !== "cron" || node.data.cronEnabled === false)
          continue;
        try {
          const result = matchCron(
            node.data.cronExpression ?? "",
            node.data.cronTimezone ?? "UTC",
          );
          if (
            result.matches &&
            cronMinuteKeys.current[node.id] !== result.minuteKey
          ) {
            cronMinuteKeys.current[node.id] = result.minuteKey;
            emit(
              `Schedule fired · ${node.data.label}`,
              "workflow.cron.triggered",
              node.id,
            );
            void run();
            break;
          }
        } catch (error) {
          emit(
            `Schedule error · ${node.data.label}: ${String(error)}`,
            "workflow.cron.failed",
            node.id,
            "error",
          );
        }
      }
    };
    checkSchedules();
    const timer = window.setInterval(checkSchedules, 15_000);
    return () => window.clearInterval(timer);
  }, [nodes, running, workflowId]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const editing = (e.target as HTMLElement).matches(
        "input,textarea,select,[contenteditable=true]",
      );
      const graphFocused =
        e.target instanceof HTMLElement &&
        Boolean(wrapper.current?.contains(e.target));
      if (editing && e.key !== "Escape") return;
      if ((e.ctrlKey || e.metaKey) && e.key === ".") {
        e.preventDefault();
        stop();
      } else if (
        graphFocused &&
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "d"
      ) {
        e.preventDefault();
        duplicate();
      } else if (
        graphFocused &&
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "c"
      ) {
        e.preventDefault();
        copy();
      } else if (
        graphFocused &&
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "v"
      ) {
        e.preventDefault();
        paste();
      } else if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "z"
      ) {
        e.preventDefault();
        redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        run(selectedId || undefined);
      } else if (e.key === "Enter" && selectedId) {
        e.preventDefault();
        setTab("overview");
      } else if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setCompatibilityOpen(true);
      } else if (graphFocused && (e.key === "Delete" || e.key === "Backspace"))
        removeSelected();
      else if (e.key.toLowerCase() === "f" && !e.ctrlKey)
        flowRef.current?.fitView({ padding: 0.15, duration: 300 });
      else if (e.key.toLowerCase() === "r" && !e.ctrlKey) {
        e.preventDefault();
        if (window.confirm("Run this workflow?")) run();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        load();
      } else if (e.key === "Escape") {
        if (contextMenu) {
          closeContextMenu();
          return;
        }
        setSelectedEdge(null);
        setActiveApproval(null);
        setCompatibilityOpen(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  /**
   * Unattended Live Codex proof: when Vite is started with
   * VITE_CODEX_CORP_AUTORUN=software-company and the app runs in the Tauri
   * shell, invoke the shipped native Run company path (run → start_run) once
   * the SQLite-restored graph + Codex discovery are ready.
   */
  const autorunStarted = useRef(false);
  useEffect(() => {
    if (autorunStarted.current || running) return;
    if (!isTauri()) return;
    if (!import.meta.env.DEV) return;
    if (import.meta.env.VITE_CODEX_CORP_AUTORUN !== "software-company") return;
    if (!codexInfo.compatible) return;
    const agents = nodes.filter((n) => isSpecialistKind(n.data.kind));
    if (!agents.length) return;
    if (agents.some((a) => !normalizeStoredModelId(a.data.model))) return;
    const mission = nodes.find((n) => n.data.kind === "input")?.data.output;
    if (!mission?.trim()) return;
    autorunStarted.current = true;
    setAppView("editor");
    setDrawer(true);
    setDrawerTab("timeline");
    emit(
      `Autorun Live Codex · ${agents.length} specialists · mission set`,
      "autorun.started",
    );
    void run();
  }, [nodes, edges, codexInfo.compatible, running, run]);

  useEffect(() => {
    if (!isTauri()) {
      setCodexModels([]);
      setCodexModelsStatus("unavailable");
      setCodexModelsError(
        "Desktop app required — connect Codex CLI via the Tauri shell to load models (model/list).",
      );
      setCodexCapabilities(EMPTY_CODEX_CAPABILITIES);
      setCodexCapabilitiesStatus("unavailable");
      setCodexCapabilitiesError(
        "Desktop app required for connector discovery.",
      );
      setCodexInfo({
        found: false,
        compatible: false,
        incompatibilityReason:
          "Open the Codex Corp desktop window (npm run desktop:dev), not a browser tab on localhost.",
        lastTestedVersion: "codex-cli 0.144.1",
        supportedRange: "codex-cli 0.140–0.150",
        fallbackAvailable: false,
        capabilities: [],
      });
      return;
    }

    const refreshDiscovery = () =>
      invoke<CodexInfo>("discover_codex")
        .then((info) => {
          setCodexInfo(info);
          emit(
            info.compatible
              ? `${info.version} · app-server ready`
              : "Codex compatibility problem",
            "codex.compatibility",
            undefined,
            info.compatible ? "info" : "error",
          );
          return info;
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error
              ? error.message
              : String(error ?? "Codex discovery failed.");
          setCodexInfo({
            found: false,
            compatible: false,
            appServerAvailable: false,
            incompatibilityReason: message,
            lastTestedVersion: "codex-cli 0.144.1",
            supportedRange: "codex-cli 0.140–0.150",
            fallbackAvailable: false,
            capabilities: [],
          });
          return null;
        });

    void refreshDiscovery();

    // Live models from Codex CLI app-server (`model/list`) only — no hardcoded catalog.
    setCodexModelsStatus("loading");
    invoke<CodexModelOption[]>("list_codex_models")
      .then((models) => {
        const cleaned = sanitizeModelList(models);
        if (!cleaned.length) {
          setCodexModels([]);
          setCodexModelsStatus("unavailable");
          setCodexModelsError("Codex returned an empty model list.");
          return;
        }
        setCodexModels(cleaned);
        setCodexModelsStatus("live");
        setCodexModelsError("");
        // Successful model/list means the CLI is reachable — re-run discovery so
        // the top badge cannot stay stuck on a false "unavailable".
        void refreshDiscovery();
      })
      .catch((error: unknown) => {
        setCodexModels([]);
        setCodexModelsStatus("unavailable");
        setCodexModelsError(
          error instanceof Error
            ? error.message
            : String(error ?? "model/list failed"),
        );
        emit(
          "Model list unavailable — picker empty until Codex CLI responds",
          "codex.models.error",
          undefined,
          "error",
        );
      });

    invoke<CodexCapabilityInventory>("list_codex_capabilities", { cwd: null })
      .then((inventory) => {
        const clean = sanitizeCapabilityInventory(inventory);
        setCodexCapabilities(clean);
        setCodexCapabilitiesStatus("live");
        setCodexCapabilitiesError("");
      })
      .catch((error: unknown) => {
        setCodexCapabilities(EMPTY_CODEX_CAPABILITIES);
        setCodexCapabilitiesStatus("unavailable");
        setCodexCapabilitiesError(
          error instanceof Error ? error.message : String(error),
        );
      });
  }, []);

  // Publish live list for canvas labels (CorpNode) without prop-drilling.
  useEffect(() => {
    publishLiveCodexModels(codexModels);
  }, [codexModels]);

  // Reconcile persisted selections only after a successful live inventory.
  // This removes obsolete invented Creative skill ids while preserving every
  // connector-backed selection. Image Studio receives imagegen only when the
  // installed connector actually advertises it.
  useEffect(() => {
    if (codexCapabilitiesStatus !== "live") return;
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        if (!isSpecialistKind(node.data.kind)) return node;
        const { skills, activeSkill, connectorTools } =
          reconcileCapabilitySelections(
            node.data.kind,
            node.data.skills,
            node.data.activeSkill,
            node.data.connectorTools,
            codexCapabilities,
          );
        if (
          JSON.stringify(skills) === JSON.stringify(node.data.skills ?? []) &&
          JSON.stringify(connectorTools) ===
            JSON.stringify(node.data.connectorTools ?? []) &&
          activeSkill === node.data.activeSkill
        ) {
          return node;
        }
        changed = true;
        return {
          ...node,
          data: { ...node.data, skills, connectorTools, activeSkill },
        };
      });
      return changed ? next : current;
    });
  }, [codexCapabilities, codexCapabilitiesStatus]);

  // When model/list becomes available, write live default into specialists
  // that still have empty model so canvas, persistence, and runs agree.
  useEffect(() => {
    if (!codexModels.length) return;
    const def = defaultModelFromList(codexModels);
    if (!def) return;
    setNodes((ns) => {
      let changed = false;
      const next = ns.map((node) => {
        if (!isSpecialistKind(node.data.kind)) return node;
        if (!needsLiveModelDefault(node.data.model)) return node;
        changed = true;
        const efforts = effortsForModel(codexModels, def);
        const effort = efforts.includes(node.data.effort)
          ? node.data.effort
          : (efforts[0] ?? node.data.effort);
        return {
          ...node,
          data: { ...node.data, model: def, effort },
        };
      });
      return changed ? next : ns;
    });
  }, [codexModels, setNodes]);

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      const activeId = readActiveWorkflowId(
        localStorage.getItem(ACTIVE_WORKFLOW_KEY),
        DEFAULT_TEMPLATE_ID,
      );
      // 1) Auto-load last saved workflow for the active template when present.
      // Skip if the user already Seeded/edited after first paint (late-load race).
      try {
        const raw = isTauri()
          ? await invoke<string | null>("load_workflow", { id: activeId })
          : localStorage.getItem(workflowStorageKey(activeId));
        const snapshot = parseWorkflowSnapshot(raw);
        if (
          !cancelled &&
          shouldApplyAutoloadSnapshot(userMutatedWorkflow.current)
        ) {
          if (snapshot) {
            setWorkflowId(activeId);
            setNodes(snapshot.nodes);
            setEdges(snapshot.edges);
            setSaved(isTauri() ? "Loaded from SQLite" : "Loaded locally");
            emit(
              isTauri()
                ? `Restored workflow from SQLite · ${getTemplate(activeId).name}`
                : `Restored workflow from local storage · ${getTemplate(activeId).name}`,
              "workflow.autoload",
            );
          } else if (activeId !== DEFAULT_TEMPLATE_ID) {
            const factory = cloneTemplateGraph(getTemplate(activeId));
            setWorkflowId(activeId);
            setNodes(factory.nodes);
            setEdges(factory.edges);
            setSaved("Template loaded");
          }
        }
      } catch {
        /* keep seed */
      }

      // 2) Run history for the active workflow (flat local list filtered by id).
      try {
        if (isTauri()) {
          const rows = await invoke<RunRecord[]>("list_runs", {
            workflowId: activeId,
          });
          if (!cancelled)
            setRunHistory(
              rows
                .map((row) => normalizeRunRecord(row))
                .filter((row): row is RunRecord => Boolean(row)),
            );
        } else {
          const stored = localStorage.getItem(RUNS_STORAGE_KEY);
          if (!cancelled) {
            const all = parseRunRecords(stored);
            setRunHistory(
              all.filter(
                (record) =>
                  record.workflowId === activeId ||
                  (activeId === WORKFLOW_ID &&
                    record.workflowId === WORKFLOW_ID),
              ),
            );
          }
        }
      } catch {
        if (!cancelled) setRunHistory([]);
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisteners: Promise<() => void>[] = [];
    unlisteners.push(
      listen<{
        nodeId: string;
        eventType: string;
        message: string;
        threadId?: string;
        turnId?: string;
      }>("codex-agent-event", (event) => {
        if (disposed) return;
        const payload = event.payload;
        const lifecycle = isCodexAgentLifecycleEvent(payload.eventType);
        const streaming = isAgentMessageDelta(payload.eventType);
        if (!lifecycle && !streaming) return;
        setNodes((ns) =>
          ns.map((n) =>
            n.id === payload.nodeId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    threadId: payload.threadId ?? n.data.threadId,
                    streamingPreview: streaming
                      ? appendStreamPreview(
                          n.data.streamingPreview,
                          payload.message,
                        )
                      : undefined,
                    trace: lifecycle
                      ? [...n.data.trace, payload.message].slice(-80)
                      : n.data.trace,
                  },
                }
              : n,
          ),
        );
        if (lifecycle)
          emit(
            `${payload.nodeId} · ${payload.message}`,
            payload.eventType,
            payload.nodeId,
          );
      }),
    );
    unlisteners.push(
      listen<{
        requestId: string;
        nodeId: string;
        method: string;
        params: Record<string, unknown>;
      }>("codex-approval-requested", (event) => {
        if (disposed) return;
        const payload = event.payload;
        const request: ApprovalRequest = {
          id: crypto.randomUUID(),
          nativeRequestId: payload.requestId,
          nodeId: payload.nodeId,
          title: payload.method.includes("fileChange")
            ? "Approve proposed file changes"
            : "Approve Codex tool action",
          detail: JSON.stringify(payload.params, null, 2),
          risk: "Review the command, paths, working directory and requested permission. This decision applies once.",
          status: "pending",
        };
        approvalsRef.current = [...approvalsRef.current, request];
        setApprovals(approvalsRef.current);
        setActiveApproval(request);
        setApprovalCenterOpen(true);
        setDrawer(true);
        setDrawerTab("approvals");
        setNodes((ns) =>
          ns.map((n) =>
            n.id === payload.nodeId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    status: "approval",
                    trace: [...n.data.trace, "Codex tool approval requested"],
                  },
                }
              : n,
          ),
        );
      }),
    );
    return () => {
      disposed = true;
      Promise.all(unlisteners).then((items) =>
        items.forEach((unlisten) => unlisten()),
      );
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisteners: Promise<() => void>[] = [];
    unlisteners.push(
      listen<{
        runId: string;
        nodeId?: string;
        attemptId?: string;
        sequence: number;
        eventType: string;
        level: "info" | "warning" | "error";
        at: string;
        message: string;
        diagnostics: Record<string, unknown>;
      }>("workflow-run-event", (event) => {
        if (disposed) return;
        const payload = event.payload;
        if (runId && payload.runId !== runId) return;
        const nodeStatus: Partial<Record<string, Status>> = {
          "node.attempt.started": "running",
          "node.attempt.completed": "completed",
          "node.attempt.failed": "failed",
          "node.skipped": "skipped",
          "approval.requested": "approval",
        };
        if (payload.nodeId && nodeStatus[payload.eventType]) {
          setNodes((items) =>
            items.map((node) =>
              node.id === payload.nodeId
                ? {
                    ...node,
                    data: {
                      ...node.data,
                      status: nodeStatus[payload.eventType]!,
                      trace: [...node.data.trace, payload.message].slice(-80),
                    },
                  }
                : node,
            ),
          );
        }
        const runEvent: RunEvent = {
          id: `${payload.runId}:${payload.sequence}`,
          at: new Date().toISOString(),
          type: payload.eventType,
          message: payload.message,
          nodeId: payload.nodeId,
          level: payload.level,
        };
        eventsRef.current = [...eventsRef.current, runEvent];
        setEvents(eventsRef.current);
        try {
          appendMediatorEventToStore(
            workflowId,
            payload.eventType,
            payload.message,
          );
          const toast = notificationFromRunEvent(runEvent, payload.runId);
          if (toast) {
            setMediatorToasts((prev) => [...prev.slice(-4), toast]);
            window.setTimeout(() => {
              setMediatorToasts((prev) =>
                prev.filter((item) => item.id !== toast.id),
              );
            }, 5200);
          }
        } catch {
          /* keep the runtime event path resilient to chat persistence errors */
        }
        if (
          payload.eventType === "run.completed" ||
          payload.eventType === "run.failed" ||
          payload.eventType === "run.interrupted" ||
          payload.eventType === "run.cancelled"
        ) {
          setRunning(false);
          void loadRunHistoryFor(workflowId);
        }
      }),
    );
    unlisteners.push(
      listen<{
        runId: string;
        requestId: string;
        nodeId: string;
        title: string;
        detail: string;
      }>("workflow-run-approval", (event) => {
        if (disposed) return;
        const payload = event.payload;
        const request: ApprovalRequest = {
          id: crypto.randomUUID(),
          nativeRequestId: payload.requestId,
          runId: payload.runId,
          nodeId: payload.nodeId,
          title: payload.title,
          detail: payload.detail,
          risk: "This explicit human decision controls delivery for this run only.",
          status: "pending",
        };
        approvalsRef.current = [...approvalsRef.current, request];
        setApprovals(approvalsRef.current);
        setActiveApproval(request);
        setApprovalCenterOpen(true);
        setDrawer(true);
        setDrawerTab("approvals");
      }),
    );
    return () => {
      disposed = true;
      Promise.all(unlisteners).then((items) =>
        items.forEach((unlisten) => unlisten()),
      );
    };
  }, [runId, workflowId]);

  const renderGlobalModals = () => (
    <>
      {approvalCenterOpen && (
        <Suspense fallback={null}>
          <DecisionCenterModal
            approvals={approvals}
            question={activeQuestion}
            selectedOptions={questionSelected}
            freeText={questionFreeText}
            onFreeTextChange={setQuestionFreeText}
            onToggleOption={(id, multiSelect) =>
              setQuestionSelected((current) =>
                multiSelect
                  ? current.includes(id)
                    ? current.filter((item) => item !== id)
                    : [...current, id]
                  : [id],
              )
            }
            onDecideApproval={(request, approved) =>
              void decideApprovalFor(request, approved)
            }
            onResolveQuestion={resolveMediatorQuestion}
            onClose={() => setApprovalCenterOpen(false)}
          />
        </Suspense>
      )}
      {!!mediatorToasts.length && (
        <div className="mediator-toast-stack" aria-live="polite">
          {mediatorToasts.map((t) => (
            <div
              key={t.id}
              className={`mediator-toast level-${t.level}`}
              role="status"
            >
              <b>{t.title}</b>
              <span>{t.body}</span>
            </div>
          ))}
        </div>
      )}
      {compatibilityOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="compatibility-title"
        >
          <div className="compatibility-modal">
            <button
              className="modal-close"
              onClick={() => setCompatibilityOpen(false)}
              aria-label="Close"
            >
              <X size={16} />
            </button>
            <span>CODEX COMPATIBILITY</span>
            <h2 id="compatibility-title">
              {codexInfo.compatible
                ? "Runtime ready"
                : "Runtime needs attention"}
            </h2>
            <div className="compat-grid">
              <Metric
                label="Installed"
                value={codexInfo.version ?? "Not found"}
              />
              <Metric
                label="Selected source"
                value={codexInfo.selectedSource ?? "System CLI"}
              />
              <Metric
                label="Executable"
                value={codexInfo.executable ?? "System installation"}
              />
              <Metric
                label="Last tested"
                value={codexInfo.lastTestedVersion ?? "codex-cli 0.144.1"}
              />
              <Metric
                label="Supported range"
                value={codexInfo.supportedRange ?? "Unknown"}
              />
              <Metric
                label="App-server"
                value={
                  codexInfo.appServerAvailable === false
                    ? "Unavailable"
                    : "Available"
                }
              />
              <Metric
                label="Pinned fallback"
                value={
                  codexInfo.fallbackAvailable
                    ? "Available"
                    : "Not bundled in this build"
                }
              />
            </div>
            {(codexInfo.incompatibilityReason ||
              codexInfo.compatibilityWarning ||
              compatibilityError) && (
              <div className="compat-warning">
                <AlertTriangle size={15} />
                {compatibilityError ||
                  codexInfo.incompatibilityReason ||
                  codexInfo.compatibilityWarning}
              </div>
            )}
            <div className="capability-list">
              {(codexInfo.capabilities ?? []).map((capability) => (
                <span key={capability}>
                  <Check size={11} />
                  {capability}
                </span>
              ))}
            </div>
            <label className="custom-runtime-path">
              User-configured Codex executable
              <span>
                <input
                  value={customCodexPath}
                  onChange={(event) => setCustomCodexPath(event.target.value)}
                  placeholder="C:\\path\\to\\codex.exe"
                />
                <button
                  onClick={() => void selectCustomCodexPath()}
                  disabled={!customCodexPath.trim()}
                >
                  Validate and use
                </button>
              </span>
            </label>
            <div className="modal-actions">
              <button
                onClick={() => void selectCodexSource("system")}
                disabled={codexInfo.selectedSource === "System CLI"}
              >
                Use system CLI
              </button>
              <button
                onClick={() => void selectCodexSource("fallback")}
                disabled={
                  !codexInfo.fallbackAvailable ||
                  codexInfo.selectedSource === "Tested fallback"
                }
              >
                Use tested fallback
              </button>
              <button
                className="primary"
                onClick={() => setCompatibilityOpen(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  if (appView === "overview") {
    return (
      <>
        <FeatureBoundary name="Workflows overview">
          <OverviewPage
            activeWorkflowId={workflowId}
            running={running}
            runHistory={runHistory}
            codexInfo={codexInfo}
            onOpenChat={(id) => {
              void switchTemplate(id, "chat");
            }}
            onEditWorkflow={(id) => {
              void switchTemplate(id, "editor");
            }}
            onOpenCodexHealth={() => setCompatibilityOpen(true)}
            onCreateWorkflow={() => void createBlankWorkflow()}
            onOpenArchitect={(prompt) => {
              setArchitectInitialPrompt(prompt ?? "");
              setAppView("architect");
            }}
          />
        </FeatureBoundary>
        {renderGlobalModals()}
      </>
    );
  }

  if (appView === "architect") {
    return (
      <>
        <FeatureBoundary name="Workflow Architect">
          <WorkflowArchitectPage
            revision={catalogRevision}
            initialPrompt={architectInitialPrompt}
            onBack={() => {
              setArchitectInitialPrompt("");
              setAppView("overview");
            }}
            onEdit={(id) => void switchTemplate(id, "editor")}
            onDuplicate={(id) => {
              const source = getTemplate(id);
              const nextId = `${id}-copy-${Date.now().toString().slice(-4)}`;
              void persistArchitectWorkflow({
                ...structuredClone(source),
                id: nextId,
                name: `${source.name} copy`,
                version: "v0.1",
              });
            }}
            onDelete={(id) => {
              const target = getTemplate(id);
              if (
                !window.confirm(
                  `Delete “${target.name}” from the workflow catalog? This cannot be undone.`,
                )
              )
                return;
              void (async () => {
                if (isTauri()) await invoke("delete_workflow", { id });
                deleteWorkflowFromCatalog(id);
                localStorage.removeItem(workflowStorageKey(id));
                setCatalogRevision((value) => value + 1);
                if (id === workflowId) {
                  const fallback = listWorkflows()[0];
                  if (fallback) await switchTemplate(fallback.id, "stay");
                }
              })();
            }}
            onTurn={handleArchitectTurn}
          />
        </FeatureBoundary>
        {renderGlobalModals()}
      </>
    );
  }

  if (appView === "chat" && chatWorkflowId) {
    return (
      <>
        <FeatureBoundary name="Company chat">
          <AgentChatPage
            workflowId={chatWorkflowId}
            activeWorkflowId={workflowId}
            running={running}
            runId={runId}
            events={events}
            approvals={approvals}
            runHistory={runHistory}
            completedCount={
              nodes.filter((n) => n.data.status === "completed").length
            }
            totalExecutable={nodes.filter((n) => n.data.kind !== "note").length}
            pendingDecisionCount={
              approvals.filter((item) => item.status === "pending").length +
              (activeQuestion ? 1 : 0)
            }
            onOpenApprovals={() => setApprovalCenterOpen(true)}
            onBack={() => {
              setAppView("overview");
            }}
            onEditWorkflow={(id) => {
              void switchTemplate(id, "editor");
            }}
            onMediatorTurn={handleMediatorTurn}
            onResolveDefaultWorkspace={() =>
              isTauri()
                ? invoke<string>("get_default_chat_workspace")
                : Promise.resolve("Codex Corp workspace")
            }
            onChooseWorkspace={(initialPath) =>
              isTauri()
                ? invoke<string | null>("choose_chat_workspace", {
                    initialPath: initialPath ?? null,
                  })
                : Promise.resolve(null)
            }
          />
        </FeatureBoundary>
        {renderGlobalModals()}
      </>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <span />
            <span />
            <span />
          </div>
          <div>
            <b>CODEX CORP</b>
            <small>agent operating system</small>
          </div>
        </div>
        <div className="workflow-picker editor-workflow-meta">
          <div className="workflow-current">
            <span>EDITING</span>
            <label className="workflow-name-editor">
              <input
                value={workflowName}
                onChange={(event) => {
                  setWorkflowName(event.target.value);
                  markDirty();
                }}
                onBlur={() => {
                  const name = workflowName.trim() || "Untitled workflow";
                  setWorkflowName(name);
                  updateWorkflowMetadata(workflowId, { name });
                  setCatalogRevision((value) => value + 1);
                }}
                aria-label="Workflow name"
              />
              <small>{activeTemplate.version}</small>
            </label>
          </div>
          <button
            type="button"
            className={`architect-lock ${activeTemplate.locked ? "locked" : ""}`}
            onClick={() => {
              updateWorkflowMetadata(workflowId, {
                locked: !activeTemplate.locked,
              });
              setCatalogRevision((value) => value + 1);
            }}
            title={
              activeTemplate.locked
                ? "Workflow Architect cannot modify this workflow"
                : "Allow Workflow Architect to modify this workflow"
            }
            aria-pressed={Boolean(activeTemplate.locked)}
          >
            {activeTemplate.locked ? <Lock size={14} /> : <Unlock size={14} />}
            Architect {activeTemplate.locked ? "locked" : "unlocked"}
          </button>
        </div>
        <div className="top-actions">
          <button
            type="button"
            className="approval-center-trigger"
            onClick={() => setApprovalCenterOpen(true)}
            aria-label="Open approvals and questions"
          >
            <Hand size={14} />
            Approvals
            <span className="decision-count">
              {approvals.filter((item) => item.status === "pending").length +
                (activeQuestion ? 1 : 0)}
            </span>
          </button>
          <button
            className={`codex-health ${codexInfo.compatible ? "" : "fault"}`}
            onClick={() => setCompatibilityOpen(true)}
            title={
              codexInfo.incompatibilityReason ||
              (codexInfo.compatible
                ? "Codex CLI ready"
                : "Open Codex compatibility details")
            }
          >
            <span />
            {codexHealthLabel(codexInfo)}
          </button>
          <button onClick={() => void validate()}>
            <ShieldCheck size={15} />
            Validate
          </button>
          <button
            className={running ? "stop-primary" : "run-primary"}
            onClick={running ? stop : () => run()}
          >
            {running ? (
              <Square size={14} fill="currentColor" />
            ) : (
              <Play size={14} fill="currentColor" />
            )}
            {running ? "Stop run" : "Run company"}
          </button>
        </div>
      </header>
      <div className="commandbar">
        <button
          type="button"
          className="workflow-back"
          onClick={() => void leaveEditorForOverview()}
          aria-label="Back to overview"
        >
          <ArrowRight size={14} className="flip-x" />
          Overview
        </button>
        <span className="divider" />
        <button
          onClick={() =>
            flowRef.current?.fitView({ padding: 0.15, duration: 300 })
          }
        >
          <Maximize2 size={14} />
          Fit
        </button>
        <button onClick={layout}>
          <LayoutGrid size={14} />
          Auto layout
        </button>
        <button onClick={duplicate}>
          <Copy size={14} />
          Duplicate
        </button>
        <button onClick={removeSelected}>
          <Trash2 size={14} />
          Delete
        </button>
        <span className="divider" />
        <button onClick={undo} disabled={!historyPast.current.length}>
          <Undo2 size={14} />
          Undo
        </button>
        <button onClick={redo} disabled={!historyFuture.current.length}>
          <Redo2 size={14} />
          Redo
        </button>
        <span className="divider" />
        <button onClick={() => void save()}>
          <Save size={14} />
          Save
        </button>
        <button onClick={() => void load()}>
          <RotateCcw size={14} />
          Reopen
        </button>
        <button
          onClick={resetToSeed}
          title="Discard canvas changes and restore the factory graph for this template"
        >
          <Sparkles size={14} />
          Seed
        </button>
        <span className="save-state">{saved}</span>
      </div>
      <main
        className={`workspace ${drawer ? "drawer-open" : ""} ${libraryOpen ? "" : "library-collapsed"} ${inspectorOpen ? "" : "inspector-collapsed"}`}
        style={
          {
            "--library-width": `${libraryOpen ? libraryWidth : 0}px`,
            "--inspector-width": `${inspectorOpen ? inspectorWidth : 0}px`,
            "--drawer-height": `${drawerHeight}px`,
          } as React.CSSProperties
        }
      >
        <aside
          className={`node-library ${libraryOpen ? "" : "is-collapsed"}`}
          aria-hidden={!libraryOpen}
        >
          <div className="panel-title">
            <span>NODE LIBRARY</span>
            <div className="panel-title-actions">
              <button
                type="button"
                className={`library-search-toggle ${librarySearchOpen || libraryQuery ? "active" : ""}`}
                aria-label={
                  librarySearchOpen
                    ? "Close node library search"
                    : "Search node library"
                }
                aria-expanded={librarySearchOpen}
                title="Search nodes and specialists"
                onClick={() => {
                  setLibrarySearchOpen((open) => {
                    const next = !open;
                    if (next) {
                      requestAnimationFrame(() =>
                        librarySearchRef.current?.focus(),
                      );
                    } else {
                      setLibraryQuery("");
                    }
                    return next;
                  });
                }}
              >
                {librarySearchOpen ? <X size={14} /> : <Search size={14} />}
              </button>
              <button
                type="button"
                className="panel-collapse-btn"
                aria-label="Collapse node library"
                title="Collapse library"
                onClick={() => setLibraryOpen(false)}
              >
                <ChevronLeft size={14} />
              </button>
            </div>
          </div>
          {librarySearchOpen ? (
            <label className="library-search-field">
              <Search size={13} aria-hidden />
              <input
                ref={librarySearchRef}
                type="search"
                value={libraryQuery}
                onChange={(e) => setLibraryQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setLibraryQuery("");
                    setLibrarySearchOpen(false);
                  }
                }}
                placeholder="Search types and specialists…"
                aria-label="Search node library"
              />
              {libraryQuery && (
                <button
                  type="button"
                  className="library-search-clear"
                  aria-label="Clear search"
                  onClick={() => {
                    setLibraryQuery("");
                    librarySearchRef.current?.focus();
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </label>
          ) : (
            <p className="panel-help">
              Drag onto the drafting table or click to add.
            </p>
          )}
          {filteredLibrary.map((item) => (
            <button
              className="library-item"
              key={item.kind}
              draggable
              onDragStart={(e) =>
                e.dataTransfer.setData("application/codex-node", item.kind)
              }
              onClick={() => createNode(item.kind)}
            >
              <span
                className={`library-glyph ${item.kind}`}
                style={
                  {
                    "--glyph": kindPopColor(item.kind),
                  } as React.CSSProperties
                }
              >
                <item.icon size={16} />
              </span>
              <span>
                <b>{item.label}</b>
                <small>{item.hint}</small>
              </span>
              <Plus size={14} />
            </button>
          ))}
          {filteredSpecialists.length > 0 && (
            <>
              <div className="library-section">SPECIALISTS</div>
              {filteredSpecialists.map((role) => (
                <button
                  className="profile-item"
                  key={role}
                  onClick={() => createNode("agent", undefined, role)}
                >
                  <Bot size={13} />
                  {role}
                </button>
              ))}
            </>
          )}
          {filteredLibrary.length === 0 && filteredSpecialists.length === 0 && (
            <p className="library-empty">
              No nodes match “{libraryQuery.trim()}”.
            </p>
          )}
        </aside>
        {libraryOpen ? (
          <div
            className="library-resizer"
            role="separator"
            aria-label="Resize node library"
            aria-orientation="vertical"
            aria-valuemin={180}
            aria-valuemax={420}
            aria-valuenow={libraryWidth}
            tabIndex={0}
            title="Drag to resize library"
            onPointerDown={beginLibraryResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft")
                setLibraryWidth((width) => Math.max(180, width - 20));
              if (event.key === "ArrowRight")
                setLibraryWidth((width) => Math.min(420, width + 20));
            }}
          />
        ) : (
          <button
            type="button"
            className="panel-expand-rail library-expand"
            aria-label="Expand node library"
            title="Expand library"
            onClick={() => setLibraryOpen(true)}
          >
            <ChevronRight size={14} />
            <span>Library</span>
          </button>
        )}
        <section
          className="canvas-panel"
          ref={wrapper}
          tabIndex={0}
          onDrop={(e) => {
            e.preventDefault();
            const kind = e.dataTransfer.getData(
              "application/codex-node",
            ) as Kind;
            if (!kind) return;
            const p = flowRef.current.screenToFlowPosition({
              x: e.clientX,
              y: e.clientY,
            });
            createNode(kind, p);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
        >
          <div className="canvas-banner">
            <div>
              <span className="live-dot" />
              <b>COMPANY GRAPH</b>
              <em>
                {nodes.length} nodes · {edges.length} connections
              </em>
            </div>
            <div className="aperture-key">
              <Network size={14} />
              Context Aperture · {lineage.size} included
            </div>
          </div>
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={(c) => {
              onNodesChange(c);
              if (c.some((change) => change.type !== "select")) markDirty();
            }}
            onEdgesChange={(c) => {
              if (c.some((change) => change.type === "remove")) pushHistory();
              onEdgesChange(c);
              markDirty();
            }}
            onConnect={onConnect}
            onReconnect={onReconnect}
            onReconnectStart={onReconnectStart}
            onReconnectEnd={onReconnectEnd}
            edgesReconnectable
            reconnectRadius={12}
            onInit={(i) => (flowRef.current = i)}
            onNodeDragStart={() => {
              dragSnapshot.current = snapshot();
            }}
            onNodeDragStop={() => {
              if (dragSnapshot.current) {
                historyPast.current.push(dragSnapshot.current);
                historyFuture.current = [];
                dragSnapshot.current = null;
                refreshHistory((v) => v + 1);
                markDirty();
              }
            }}
            onNodeClick={(_, n) => {
              closeContextMenu();
              setSelectedId(n.id);
              setSelectedEdge(null);
              setTab("overview");
            }}
            onEdgeClick={(_, e) => {
              closeContextMenu();
              setSelectedEdge(e.id);
              setSelectedId("");
            }}
            onPaneClick={() => {
              closeContextMenu();
              setSelectedId("");
              setSelectedEdge(null);
            }}
            onNodeContextMenu={(event, n) => {
              setSelectedId(n.id);
              setSelectedEdge(null);
              openContextMenu(event, "node", n.id);
            }}
            onEdgeContextMenu={(event, e) => {
              setSelectedEdge(e.id);
              setSelectedId("");
              openContextMenu(event, "edge", e.id);
            }}
            onPaneContextMenu={(event) => {
              openContextMenu(event, "pane");
            }}
            selectionOnDrag
            multiSelectionKeyCode={["Control", "Meta", "Shift"]}
            fitView
            fitViewOptions={{ padding: 0.1, maxZoom: 0.78 }}
            minZoom={0.25}
            maxZoom={1.8}
            snapToGrid
            snapGrid={[16, 16]}
            connectionLineStyle={{
              stroke: "var(--accent)",
              strokeWidth: 2,
            }}
            defaultEdgeOptions={edgeBase}
            deleteKeyCode={null}
          >
            <Background color="var(--canvas-dot, #26303a)" gap={24} size={1} />
            <Controls position="bottom-left" showInteractive={false} />
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              nodeColor={(n) => (n.data as AgentData).color}
              maskColor="var(--minimap-mask, rgba(8,10,13,.76))"
            />
          </ReactFlow>
        </section>
        {inspectorOpen ? (
          <div
            className="inspector-resizer"
            role="separator"
            aria-label="Resize inspector"
            aria-orientation="vertical"
            aria-valuemin={320}
            aria-valuemax={640}
            aria-valuenow={inspectorWidth}
            tabIndex={0}
            title="Drag to resize inspector"
            onPointerDown={beginInspectorResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft")
                setInspectorWidth((width) => Math.min(640, width + 20));
              if (event.key === "ArrowRight")
                setInspectorWidth((width) => Math.max(320, width - 20));
            }}
          />
        ) : (
          <button
            type="button"
            className="panel-expand-rail inspector-expand"
            aria-label="Expand inspector"
            title="Expand inspector"
            onClick={() => setInspectorOpen(true)}
          >
            <ChevronLeft size={14} />
            <span>Inspector</span>
          </button>
        )}
        <aside
          className={`inspector ${inspectorOpen ? "" : "is-collapsed"}`}
          aria-hidden={!inspectorOpen}
        >
          {inspectorOpen && (
            <button
              type="button"
              className="panel-collapse-btn inspector-collapse-float"
              aria-label="Collapse inspector"
              title="Collapse inspector"
              onClick={() => setInspectorOpen(false)}
            >
              <ChevronRight size={14} />
            </button>
          )}
          <Suspense
            fallback={
              <div className="empty-inspector">
                <Settings2 size={22} />
                <p>Loading inspector…</p>
              </div>
            }
          >
            {edge ? (
              <EdgeInspector edge={edge} nodes={nodes} update={updateEdge} />
            ) : selected ? (
              <NodeInspector
                node={selected}
                tab={tab}
                setTab={setTab}
                update={updateNode}
                availableModels={codexModels}
                modelsStatus={codexModelsStatus}
                modelsError={codexModelsError}
                capabilities={codexCapabilities}
                capabilitiesStatus={codexCapabilitiesStatus}
                capabilitiesError={codexCapabilitiesError}
                onRefreshModels={() => {
                  if (!isTauri()) return;
                  setCodexModelsStatus("loading");
                  invoke<CodexModelOption[]>("list_codex_models")
                    .then((models) => {
                      const cleaned = sanitizeModelList(models);
                      if (!cleaned.length) {
                        setCodexModels([]);
                        setCodexModelsStatus("unavailable");
                        setCodexModelsError(
                          "Codex returned an empty model list.",
                        );
                        return;
                      }
                      setCodexModels(cleaned);
                      setCodexModelsStatus("live");
                      setCodexModelsError("");
                    })
                    .catch((error: unknown) => {
                      setCodexModels([]);
                      setCodexModelsStatus("unavailable");
                      setCodexModelsError(
                        error instanceof Error
                          ? error.message
                          : String(error ?? "model/list failed"),
                      );
                    });
                }}
                upstream={edges.filter((e) => e.target === selected.id).length}
                upstreamNodes={edges
                  .filter(
                    (connection) =>
                      connection.target === selected.id &&
                      connection.data?.edgeType !== "revision",
                  )
                  .map((connection) =>
                    nodes.find((node) => node.id === connection.source),
                  )
                  .filter((node): node is FlowNode => Boolean(node))}
                revisionNodes={edges
                  .filter(
                    (connection) =>
                      connection.target === selected.id &&
                      connection.data?.edgeType === "revision",
                  )
                  .map((connection) =>
                    nodes.find((node) => node.id === connection.source),
                  )
                  .filter((node): node is FlowNode => Boolean(node))}
                downstream={
                  edges.filter((e) => e.source === selected.id).length
                }
                run={() => run(selected.id)}
                duplicate={duplicate}
                save={() => void save()}
                interrupt={stop}
              />
            ) : (
              <div className="empty-inspector">
                <Boxes size={28} />
                <b>Select a node or edge</b>
                <p>
                  Inspect its contract, exact context, permissions, output and
                  execution trace.
                </p>
              </div>
            )}
          </Suspense>
        </aside>
        <section className={`execution-drawer ${drawer ? "open" : ""}`}>
          {drawer && (
            <div
              className="drawer-resizer"
              role="separator"
              aria-label="Resize execution drawer"
              aria-orientation="horizontal"
              aria-valuemin={150}
              aria-valuemax={420}
              aria-valuenow={drawerHeight}
              tabIndex={0}
              onPointerDown={beginDrawerResize}
              onKeyDown={(event) => {
                if (event.key === "ArrowUp")
                  setDrawerHeight((height) => Math.min(420, height + 20));
                if (event.key === "ArrowDown")
                  setDrawerHeight((height) => Math.max(150, height - 20));
              }}
            />
          )}
          <button
            className="drawer-toggle"
            onClick={() => setDrawer((v) => !v)}
          >
            <Activity size={14} />
            <b>EXECUTION</b>
            <span>
              {running ? `Live run · ${runId?.slice(0, 8)}` : "Ready"}
            </span>
            <ChevronDown size={14} />
          </button>
          {drawer && (
            <div className="drawer-body">
              <nav>
                {(
                  [
                    "timeline",
                    "runs",
                    "approvals",
                    "logs",
                    "problems",
                    "artifacts",
                    "usage",
                  ] as const
                ).map((name) => (
                  <button
                    key={name}
                    className={drawerTab === name ? "active" : ""}
                    onClick={() => setDrawerTab(name)}
                  >
                    {name[0].toUpperCase() + name.slice(1)}
                    {name === "runs" && runHistory.length > 0 && (
                      <span>{runHistory.length}</span>
                    )}
                    {name === "approvals" && (
                      <span>
                        {approvals.filter((a) => a.status === "pending").length}
                      </span>
                    )}
                    {name === "problems" && problems.length > 0 && (
                      <span>{problems.length}</span>
                    )}
                  </button>
                ))}
              </nav>
              <div className="event-list">
                {drawerTab === "timeline" &&
                  events
                    .slice(-12)
                    .reverse()
                    .map((event, i) => (
                      <button
                        key={event.id}
                        onClick={() => {
                          if (event.nodeId) {
                            setSelectedId(event.nodeId);
                            setSelectedEdge(null);
                            setTab(
                              event.type.includes("failed")
                                ? "trace"
                                : event.type.includes("revision")
                                  ? "context"
                                  : "overview",
                            );
                          }
                        }}
                      >
                        <span
                          className={`event-dot ${i === 0 ? "active" : ""} ${event.level ?? ""}`}
                        />
                        <code>
                          {new Date(event.at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </code>
                        <span>{event.message}</span>
                      </button>
                    ))}
                {drawerTab === "runs" &&
                  (runHistory.length ? (
                    runHistory.map((record) => (
                      <button
                        key={record.id}
                        onClick={() =>
                          record.resumable && record.status === "interrupted"
                            ? void resumeRun(record)
                            : inspectRun(record)
                        }
                      >
                        <span className={`run-state ${record.status}`} />
                        <code>{record.id.slice(0, 8)}</code>
                        <span>
                          {record.status} ·{" "}
                          {new Date(record.createdAt).toLocaleString()}
                          {record.resumable && record.status === "interrupted"
                            ? " · Resume from checkpoint"
                            : ""}
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="drawer-empty">
                      <Clock3 size={15} />
                      No previous runs
                    </div>
                  ))}
                {drawerTab === "approvals" &&
                  approvals.map((request) => (
                    <button
                      key={request.id}
                      onClick={() => setSelectedId(request.nodeId)}
                    >
                      <span className={`approval-state ${request.status}`} />
                      <code>{request.status}</code>
                      <span>{request.title}</span>
                    </button>
                  ))}
                {drawerTab === "logs" &&
                  events
                    .slice()
                    .reverse()
                    .map((event) => (
                      <button
                        key={event.id}
                        onClick={() =>
                          event.nodeId && setSelectedId(event.nodeId)
                        }
                      >
                        <code>{event.type}</code>
                        <span>{event.message}</span>
                      </button>
                    ))}
                {drawerTab === "problems" &&
                  (problems.length ? (
                    problems.map((problem) => (
                      <button
                        key={problem.id}
                        onClick={() =>
                          problem.nodeId && setSelectedId(problem.nodeId)
                        }
                      >
                        <AlertTriangle size={13} />
                        <code>{problem.severity}</code>
                        <span>{problem.message}</span>
                      </button>
                    ))
                  ) : (
                    <div className="drawer-empty">
                      <Check size={15} />
                      No validation problems
                    </div>
                  ))}
                {drawerTab === "artifacts" &&
                  (nodes.some((n) => (n.data.artifacts ?? []).length > 0) ? (
                    nodes.flatMap((n) =>
                      (n.data.artifacts ?? []).map((a) => (
                        <button
                          key={a.id}
                          className="artifact-drawer-item"
                          onClick={() => {
                            setSelectedId(n.id);
                            setSelectedEdge(null);
                            setTab(
                              n.data.kind === "agent" ||
                                n.data.kind === "output"
                                ? "io"
                                : "overview",
                            );
                          }}
                        >
                          <FileOutput size={13} />
                          <code>{a.kind}</code>
                          <span>
                            {a.name}
                            <small>
                              {n.data.label}
                              {a.content ? ` · ${a.content.length} chars` : ""}
                            </small>
                          </span>
                        </button>
                      )),
                    )
                  ) : (
                    <div className="drawer-empty">
                      <FileOutput size={15} />
                      No artifacts yet — run the company to produce a delivery
                      bundle
                    </div>
                  ))}
                {drawerTab === "usage" && (
                  <div className="usage-detail">
                    <Metric
                      label="Total tokens"
                      value={nodes
                        .reduce((s, n) => s + n.data.tokens, 0)
                        .toLocaleString()}
                    />
                    <Metric
                      label="Fresh threads"
                      value={String(
                        nodes.filter((n) => n.data.threadId).length,
                      )}
                    />
                    <Metric
                      label="Estimated cost"
                      value="Subscription runtime (Codex CLI)"
                    />
                  </div>
                )}
              </div>
              <div className="run-summary">
                <div>
                  <small>NODES</small>
                  <b>
                    {nodes.filter((n) => n.data.status === "completed").length}/
                    {nodes.filter((n) => n.data.kind !== "note").length}
                  </b>
                </div>
                <div>
                  <small>USAGE</small>
                  <b>
                    {nodes
                      .reduce((s, n) => s + n.data.tokens, 0)
                      .toLocaleString()}
                  </b>
                </div>
                <div>
                  <small>CONTEXT</small>
                  <b>isolated</b>
                </div>
              </div>
            </div>
          )}
        </section>
      </main>
      {contextMenu && (
        <div
          className="canvas-context-backdrop"
          onClick={closeContextMenu}
          onContextMenu={(event) => {
            event.preventDefault();
            closeContextMenu();
          }}
        >
          <div
            className="canvas-context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            {contextMenu.target === "edge" && contextMenu.id && (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    setSelectedEdge(contextMenu.id!);
                    setSelectedId("");
                    closeContextMenu();
                  }}
                >
                  Inspect connection
                </button>
                <button
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    deleteEdgeById(contextMenu.id!);
                    closeContextMenu();
                  }}
                >
                  <Trash2 size={13} />
                  Disconnect
                </button>
              </>
            )}
            {contextMenu.target === "node" && contextMenu.id && (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    setSelectedId(contextMenu.id!);
                    setSelectedEdge(null);
                    setTab("overview");
                    closeContextMenu();
                  }}
                >
                  Inspect node
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setSelectedId(contextMenu.id!);
                    run(contextMenu.id!);
                    closeContextMenu();
                  }}
                >
                  <Play size={13} />
                  Run node
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setSelectedId(contextMenu.id!);
                    duplicate();
                    closeContextMenu();
                  }}
                >
                  <Copy size={13} />
                  Duplicate
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setSelectedId(contextMenu.id!);
                    copy();
                    closeContextMenu();
                  }}
                >
                  Copy
                </button>
                <button
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    deleteNodeById(contextMenu.id!);
                    closeContextMenu();
                  }}
                >
                  <Trash2 size={13} />
                  Delete node
                </button>
              </>
            )}
            {contextMenu.target === "pane" && (
              <>
                <button
                  role="menuitem"
                  onClick={() => {
                    createNode("agent");
                    closeContextMenu();
                  }}
                >
                  <Plus size={13} />
                  Add agent
                </button>
                <button
                  role="menuitem"
                  disabled={!clipboard.current.length}
                  onClick={() => {
                    paste();
                    closeContextMenu();
                  }}
                >
                  Paste
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    flowRef.current?.fitView({ padding: 0.15, duration: 300 });
                    closeContextMenu();
                  }}
                >
                  Fit view
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    layout();
                    closeContextMenu();
                  }}
                >
                  <LayoutGrid size={13} />
                  Auto layout
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {renderGlobalModals()}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ReactFlowProvider>
        <App />
      </ReactFlowProvider>
    </QueryClientProvider>
  </StrictMode>,
);

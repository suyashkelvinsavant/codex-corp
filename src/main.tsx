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
  useStore,
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
  Pencil,
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
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./native-adapter";
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
  defaultNodeEffortForModel,
  defaultModelFromList,
  defaultNodeModelFromList,
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
import { autoLayout } from "./graph-layout";
import { upstreamLineage, validateWorkflow } from "./graph-validation";
import {
  nodeOutputPatchForRunEvent,
  nodeStatusForRunEvent,
  prepareNodesForRun,
  resetExecutableNodeForRun,
  revisionCountForRunEvent,
  shouldAcceptRunEvent,
  type RunEventCursor,
} from "./run-lifecycle";
import { resolveActiveSkill } from "./creative-skills";
import {
  EMPTY_CODEX_CAPABILITIES,
  reconcileCapabilitySelections,
  sanitizeCapabilityInventory,
  type CodexCapabilityInventory,
} from "./codex-capabilities";
import { defaultPlatformCriteria } from "./completion-criteria";
import {
  parseVerificationLoops,
  type VerificationLoopReport,
} from "./analytics";
import type { DeliveryPreviewStatus } from "./delivery-bundle";
import { isSpecialistKind } from "./model";
import {
  ACTIVE_WORKFLOW_KEY,
  normalizeRunRecord,
  normalizeLoadedWorkflowState,
  parseRunRecords,
  parseWorkflowSnapshot,
  readActiveWorkflowId,
  rehydrateRunRecord,
  RUNS_STORAGE_KEY,
  serializeWorkflowSnapshot,
  shouldApplyAutoloadSnapshot,
  shouldAutosaveBeforeTemplateSwitch,
  shouldReplaceEdgesFromRun,
  templateSwitchBaselineEvents,
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_ID,
  workflowStorageKey,
} from "./persistence";
import {
  cloneTemplateGraph,
  cloneTemplateGraphLaidOut,
  createBlankWorkflowTemplate,
  createWorkflowFromTemplate,
  DEFAULT_TEMPLATE_ID,
  EMPTY_WORKFLOW_TEMPLATE,
  getTemplate,
  listWorkflows,
  listTemplates,
  normalizeWorkflowVersion,
  updateWorkflowMetadata,
  saveCustomWorkflow,
  deleteWorkflowFromCatalog,
  hydrateWorkflowCatalog,
} from "./templates";
import { ensureSpecialistQuality } from "./specialist-defaults";
import {
  instantiatePack,
  instantiatePackForRole,
  listPacksForCatalog,
  type NodePack,
} from "./node-packs";
import { RoleCatalogMenu } from "./role-catalog-menu";
import { iconForPack, iconForSpecialistRole } from "./role-icons";
import {
  DEFAULT_WORKFLOW_ICON,
  WORKFLOW_ICON_OPTIONS,
  normalizeWorkflowIcon,
  workflowIconComponent,
} from "./workflow-icons";
import {
  applyTokenUsageToNode,
  extractTotalTokensFromPayload,
  isTokenUsageEventType,
} from "./token-usage";
import { resetBrowserWorkspaceOnce } from "./fresh-app-reset";
import { FeatureBoundary } from "./feature-boundary";
import { initAppearance } from "./theme";
import { useUiStore } from "./ui-store";
import {
  appendMediatorEventToStore,
  appendMediatorMessageToStore,
  hydrateChatStore,
  requestAppWorkspaceSelection,
  toCodexUserInputs,
  type AppProjectMode,
  type ChatAttachment,
} from "./workflow-chat";
import {
  formatLocalTestPrompt,
  isSafeLocalLaunchPlan,
  prepareLocalTestRerun,
  type LocalTestSession,
} from "./local-test";
import {
  isCodexAgentLifecycleEvent,
  mediatorToolConfirmation,
  notificationFromRunEvent,
  parseStructuredApproval,
  type MediatorConfirmation,
  type MediatorNotification,
  type MediatorQuestion,
  type MediatorQuestionAnswer,
} from "./mediator-ui";
import {
  appendStreamPreview,
  appendTypedTrace,
  classifyStreamKind,
  isAgentMessageDelta,
  isStreamingTraceEvent,
  normalizeStreamEventType,
} from "./stream-display";
import {
  appendStreamEvent,
  createStreamBuffer,
  type ExecutionStreamBuffer,
} from "./execution-stream";
import { ExecutionStreamDisclosure } from "./execution-stream-disclosure";
import {
  buildUserInputResponse,
  parseElicitationForm,
  parseUserInputQuestions,
} from "./codex-interactions";
import { Metric } from "./metric";
import {
  PERSISTENCE_ERROR_EVENT,
  type PersistenceErrorDetail,
} from "./persistence-events";
import {
  estimateTokenCostUsd,
  summarizePortfolioRuns,
  type PortfolioRunSummary,
} from "./dashboard-finance";
import { CONTROL_KINDS, controlKindLabel, statusText } from "./node-display";
import { isConcreteMission, missionBriefStatus } from "./mission-context";
import {
  resolveNativeApproval,
  type NativeApprovalResolution,
} from "./approval-lifecycle";
import {
  buildMediatorContextDigest,
  companyMediatorDynamicTools,
  COMPANY_MEDIATOR_SYSTEM_PROMPT,
  executeCompanyMediatorTool,
  type MediatorHostContext,
} from "./company-mediator-tools";
import {
  architectContextExtras,
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

async function loadPersistedWorkflowState(id: string) {
  const value = isTauri()
    ? await invoke<unknown>("load_workflow_record", { id })
    : localStorage.getItem(workflowStorageKey(id));
  return normalizeLoadedWorkflowState(value);
}
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
  const Icon =
    data.kind === "agent" || data.kind === "creative"
      ? iconForSpecialistRole({
          packId: data.packId,
          role: data.role,
          label: data.label,
          kind: data.kind,
        })
      : roleIcons[data.kind];
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
        return [
          "Verifies approved artifacts",
          `${data.artifacts?.length ?? 0} release bundle${data.artifacts?.length === 1 ? "" : "s"}`,
        ];
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
        {data.streamingPreview ||
          (() => {
            const last = data.trace[data.trace.length - 1];
            return typeof last === "string" ? last : last?.text;
          })()}
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
  target,
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
  // Live revision count lives on the revised node (edge target); policy on the edge.
  const usedRevisions = useStore(
    useCallback(
      (state) => {
        const node = state.nodes.find((item) => item.id === target);
        const revisions = (node?.data as { revisions?: number } | undefined)
          ?.revisions;
        return typeof revisions === "number" && revisions >= 0 ? revisions : 0;
      },
      [target],
    ),
  );
  const maxRevisions = Math.max(
    1,
    Number.isFinite(data?.maxRevisions) ? Number(data?.maxRevisions) : 2,
  );
  const edgeLabel =
    kind === "revision"
      ? `REVISION · ${usedRevisions}/${maxRevisions}`
      : kind === "conditional"
        ? `IF · ${data?.condition?.trim() || "success"}`
        : kind === "approval"
          ? "APPROVAL"
          : kind === "merge"
            ? "MERGE"
            : null;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={24}
        className={`signal-edge edge-${kind} ${selected ? "selected" : ""} ${data?.highlighted ? "aperture-lit" : ""} ${data?.dimmed ? "aperture-dim" : ""}`}
      />
      {edgeLabel && (
        <EdgeLabelRenderer>
          <div
            className={`edge-label ${kind === "revision" ? "revision" : kind}`}
            style={{
              transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
            }}
          >
            {edgeLabel}
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
  // Creative is available via Agent role catalog and SPECIALISTS (not a
  // duplicate top-level entry).
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
    label: "Release bundle",
    hint: "verify approved artifacts",
    icon: FileOutput,
  },
  {
    kind: "note" as Kind,
    label: "Note",
    hint: "canvas documentation",
    icon: Braces,
  },
];

/** Specialist packs for library sidebar (excludes empty — Empty is last in role catalog). */
const specialistPacks = listPacksForCatalog().filter(
  (pack) => pack.id !== "empty-agent",
);

function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(
    initialGraph.nodes,
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(
    initialGraph.edges,
  );
  const [workflowId, setWorkflowId] = useState(DEFAULT_TEMPLATE_ID);
  const [workflowName, setWorkflowName] = useState("Untitled workflow");
  const [workflowDescription, setWorkflowDescription] = useState("");
  const [workflowVersion, setWorkflowVersion] = useState("v0.1");
  const [workflowIcon, setWorkflowIcon] = useState(DEFAULT_WORKFLOW_ICON);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [identityDraft, setIdentityDraft] = useState({
    name: "Untitled workflow",
    description: "",
    version: "v0.1",
    icon: DEFAULT_WORKFLOW_ICON,
  });
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [catalogReady, setCatalogReady] = useState(() => !isTauri());
  const [architectInitialPrompt, setArchitectInitialPrompt] = useState("");
  const [costPer1k, setCostPer1k] = useState<number | undefined>(undefined);
  const activeChatWorkspaceRef = useRef<string | null>(null);

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
  const lastRunEventCursor = useRef<RunEventCursor>({
    runId: null,
    sequence: 0,
  });
  const [problems, setProblems] = useState<ReturnType<typeof validateWorkflow>>(
    [],
  );
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const approvalsRef = useRef<ApprovalRequest[]>([]);
  const streamBuffersRef = useRef<Record<string, ExecutionStreamBuffer>>({});
  const [activeStreamNodeId, setActiveStreamNodeId] = useState<string | null>(
    null,
  );
  const [localTest, setLocalTest] = useState<LocalTestSession | null>(null);
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
  const [activeConfirmation, setActiveConfirmation] =
    useState<MediatorConfirmation | null>(null);
  const confirmationResolver = useRef<((approved: boolean) => void) | null>(
    null,
  );
  const questionResolver = useRef<
    ((answer: MediatorQuestionAnswer | null) => void) | null
  >(null);
  const interactionQueue = useRef<Promise<void>>(Promise.resolve());
  const [questionFreeText, setQuestionFreeText] = useState("");
  const [questionSelected, setQuestionSelected] = useState<string[]>([]);
  const askOperatorConfirmation = (confirmation: MediatorConfirmation) =>
    new Promise<boolean>((resolve) => {
      confirmationResolver.current?.(false);
      confirmationResolver.current = resolve;
      setActiveConfirmation(confirmation);
      setApprovalCenterOpen(true);
    });
  const resolveOperatorConfirmation = (approved: boolean) => {
    const resolve = confirmationResolver.current;
    confirmationResolver.current = null;
    setActiveConfirmation(null);
    setApprovalCenterOpen(
      activeQuestion !== null ||
        approvalsRef.current.some((item) => item.status === "pending"),
    );
    resolve?.(approved);
  };
  const [runId, setRunId] = useState<string | null>(null);
  const [runHistory, setRunHistory] = useState<RunRecord[]>([]);
  /** Per-node verification→revision loops for the inspected run (P4 chip). */
  const [verificationLoops, setVerificationLoops] = useState<
    VerificationLoopReport[]
  >([]);
  /** Fail-closed Delivery status for the inspected run (P5 chip). */
  const [inspectedDeliveryStatus, setInspectedDeliveryStatus] =
    useState<DeliveryPreviewStatus>("pending");
  /** Compact lifetime totals for Dashboards (not active-workflow-only). */
  const [portfolioRunSummaries, setPortfolioRunSummaries] = useState<
    PortfolioRunSummary[]
  >([]);
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
  const [realtimeRuntimeUnavailable, setRealtimeRuntimeUnavailable] =
    useState(false);
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
      workspacePath,
      templateJson,
    }: {
      id: string;
      name: string;
      graphJson: string;
      workspacePath?: string | null;
      templateJson?: string;
    }) => {
      localStorage.setItem(ACTIVE_WORKFLOW_KEY, id);
      if (isTauri())
        await invoke("save_workflow", {
          snapshot: {
            id,
            name,
            graphJson,
            workspacePath,
            templateJson,
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
    if (!libraryFilter) return specialistPacks;
    return specialistPacks.filter(
      (pack) =>
        pack.label.toLowerCase().includes(libraryFilter) ||
        pack.role.toLowerCase().includes(libraryFilter) ||
        pack.description.toLowerCase().includes(libraryFilter),
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

  const snapshot = (): WorkflowSnapshot =>
    structuredClone({ schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes, edges });
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
                status: missionBriefStatus(text),
                trace: [
                  ...n.data.trace,
                  source === "chat"
                    ? "Mission updated from Byte"
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
    workflowId,
    approvals: approvalsRef.current,
    localTest,
    runHistory,
    actions: {
      run: (mission) => {
        if (mission) setMissionBrief(mission, "chat");
        return run(undefined, mission);
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

  const resolveVoiceTool = async (
    surface: "company" | "architect",
    tool: string,
    args: unknown,
  ): Promise<{ success: boolean; text: string }> => {
    if (surface === "company") {
      if (
        [
          "company_run",
          "company_run_from",
          "company_approve",
          "company_decline",
        ].includes(tool)
      ) {
        const confirmation = mediatorToolConfirmation(tool);
        if (confirmation && !(await askOperatorConfirmation(confirmation))) {
          return {
            success: false,
            text: JSON.stringify({ error: "Operator cancelled confirmation" }),
          };
        }
      }
      return executeCompanyMediatorTool(tool, args, mediatorHostContext());
    }
    return executeWorkflowArchitectTool(tool, args, {
      save: persistArchitectWorkflow,
      remove: async (id) => {
        deleteWorkflowFromCatalog(id);
        localStorage.removeItem(workflowStorageKey(id));
        setCatalogRevision((value) => value + 1);
      },
      open: (id) => void switchTemplate(id, "editor"),
    });
  };

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
    onStreamEvent?: (event: {
      eventType: string;
      text: string;
      threadId?: string;
      turnId?: string;
    }) => void;
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
      sessionKey?: string;
      tool: string;
      arguments: unknown;
    }>("mediator-tool-call", async (event) => {
      const { requestId, tool, arguments: args } = event.payload;
      if (event.payload.sessionKey) return;
      try {
        if (
          [
            "company_run",
            "company_run_from",
            "company_approve",
            "company_decline",
          ].includes(tool)
        ) {
          const confirmation = mediatorToolConfirmation(tool);
          if (confirmation && !(await askOperatorConfirmation(confirmation))) {
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
    const unlistenStream = await listen<{
      messageId?: string;
      eventType: string;
      text: string;
      threadId?: string;
      turnId?: string;
    }>("mediator-stream-event", (event) => {
      if (event.payload.messageId !== req.messageId) return;
      if (event.payload.text) {
        req.onStreamEvent?.({
          eventType: event.payload.eventType,
          text: event.payload.text,
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
        });
      }
    });
    try {
      const recentConversation = req.history
        .map(
          (message) =>
            `${message.role === "user" ? "Operator" : "Byte"}: ${message.text}`,
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
      unlistenStream();
    }
  };

  const persistArchitectWorkflow = async (
    template: ReturnType<typeof getTemplate>,
  ) => {
    saveCustomWorkflow(template);
    const graphJson = serializeWorkflowSnapshot(template.nodes, template.edges);
    if (isTauri())
      await invoke("save_workflow", {
        snapshot: {
          id: template.id,
          name: template.name,
          graphJson,
          templateJson: JSON.stringify(template),
        },
      });
    else localStorage.setItem(workflowStorageKey(template.id), graphJson);
    setCatalogRevision((value) => value + 1);
  };

  const handleArchitectTurn = async (
    req: Parameters<typeof handleMediatorTurn>[0],
  ) => {
    if (!isTauri())
      throw new Error("Byte needs the Codex Corp desktop app with Live Codex.");
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
      sessionKey?: string;
      tool: string;
      arguments: unknown;
    }>("mediator-tool-call", async (event) => {
      const { requestId, tool, arguments: args } = event.payload;
      if (event.payload.sessionKey) return;
      try {
        const result = await executeWorkflowArchitectTool(tool, args, {
          save: persistArchitectWorkflow,
          remove: async (id) => {
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
                (m) => `${m.role === "user" ? "Operator" : "Byte"}: ${m.text}`,
              )
              .join("\n\n"),
            contextDigest: `${buildArchitectContextDigest()}${await architectContextExtras()}`,
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
  const closeDecisionCenter = () => {
    if (activeConfirmation) resolveOperatorConfirmation(false);
    if (activeQuestion) resolveMediatorQuestion(true);
    setApprovalCenterOpen(false);
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
    // P5: the inspector shows the same fail-closed Delivery status as the
    // overview list — derived from the output node verificationSummary +
    // pair-compare, never contradiction a failed/cancelled run.
    setInspectedDeliveryStatus(rehydrated.deliveryStatus);
    // P4: verification-revision loop analytics chip (Native only — node_attempts).
    setVerificationLoops([]);
    if (isTauri()) {
      invoke<unknown>("analytics_verification_loops", { runId: record.id })
        .then((value) => setVerificationLoops(parseVerificationLoops(value)))
        .catch(() => setVerificationLoops([]));
    }
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
    const nextPatch: Partial<AgentData> = { ...patch };
    if (
      selected.data.kind === "input" &&
      Object.prototype.hasOwnProperty.call(patch, "output")
    ) {
      nextPatch.status = missionBriefStatus(
        typeof patch.output === "string" ? patch.output : selected.data.output,
      );
    }
    pushHistory();
    setNodes((ns) =>
      ns.map((n) =>
        n.id === selected.id ? { ...n, data: { ...n.data, ...nextPatch } } : n,
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
  const [roleCatalog, setRoleCatalog] = useState<null | {
    x: number;
    y: number;
    position?: { x: number; y: number };
  }>(null);

  const createNodeFromPack = (
    pack: NodePack,
    position?: { x: number; y: number },
  ) => {
    pushHistory();
    const id = `${pack.kind}-${crypto.randomUUID()}`;
    const i = nodes.length;
    const inst = instantiatePack(pack);
    const defaultModel = defaultNodeModelFromList(codexModels);
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
          label: inst.label,
          role: inst.role,
          kind: inst.kind,
          status: "idle",
          model: defaultModel,
          effort: defaultNodeEffortForModel(codexModels, defaultModel),
          tools: inst.tools,
          skills: inst.skills,
          connectorTools: [],
          packId: inst.packId,
          packVersion: inst.packVersion,
          baseInstructions: inst.baseInstructions,
          developerInstructions: inst.developerInstructions,
          prompt: inst.prompt,
          description: inst.description,
          duration: "—",
          tokens: 0,
          trace:
            inst.kind === "creative"
              ? ["Creative Studio ready"]
              : ["Draft node created"],
          completionCriteria:
            inst.completionCriteria ?? defaultPlatformCriteria(),
          maxRetries: 2,
          timeoutSeconds: 120,
          sandboxProfile: inst.sandboxProfile,
          approvalPolicy: inst.approvalPolicy,
          workspacePolicy: inst.workspacePolicy ?? "isolated",
          color: kindPopColor(inst.kind),
        },
      },
    ]);
    setSelectedId(id);
    setSelectedEdge(null);
    markDirty();
    return id;
  };

  const createNode = (
    kind: Kind,
    position?: { x: number; y: number },
    role?: string,
    options?: { openRoleCatalogAt?: { x: number; y: number } },
  ) => {
    // Generic agent placement opens the role catalog (Empty last).
    if (kind === "agent" && !role) {
      const screen = options?.openRoleCatalogAt ?? {
        x: window.innerWidth / 2 - 160,
        y: window.innerHeight / 2 - 200,
      };
      setRoleCatalog({ x: screen.x, y: screen.y, position });
      return "";
    }

    pushHistory();
    const id = `${kind}-${crypto.randomUUID()}`;
    const i = nodes.length;
    const isSpecialist = isSpecialistKind(kind);
    const label = defaultLabelForKind(kind, role);
    const nodeRole = defaultRoleForKind(kind, role);
    const packInst =
      isSpecialist && role
        ? instantiatePackForRole(
            role,
            kind === "creative" ? "creative" : "agent",
          )
        : isSpecialist && kind === "creative"
          ? instantiatePackForRole("Creative", "creative")
          : null;
    const defaultModel = defaultNodeModelFromList(codexModels);
    const specialist = packInst
      ? ensureSpecialistQuality({
          kind: packInst.kind,
          role: packInst.role,
          label: packInst.label,
          packId: packInst.packId,
          packVersion: packInst.packVersion,
          baseInstructions: packInst.baseInstructions,
          developerInstructions: packInst.developerInstructions,
          prompt: packInst.prompt,
          tools: packInst.tools,
          skills: packInst.skills,
          description: packInst.description,
        })
      : isSpecialist
        ? ensureSpecialistQuality({
            kind,
            role: nodeRole,
            label,
            prompt: "",
            tools: [],
            skills: [],
            description: "",
          })
        : null;
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
          label: specialist?.packId ? (packInst?.label ?? label) : label,
          role: specialist ? (packInst?.role ?? nodeRole) : nodeRole,
          kind,
          status: kind === "note" ? "draft" : "idle",
          model: isSpecialist
            ? defaultModel
            : kind === "approval"
              ? "Human"
              : kind === "output"
                ? "Collector"
                : "Control",
          effort: isSpecialist
            ? defaultNodeEffortForModel(codexModels, defaultModel)
            : "low",
          tools: specialist
            ? specialist.tools
            : kind === "creative"
              ? ["Image generation", "Image edit", "Workspace write"]
              : [],
          skills: specialist ? specialist.skills : undefined,
          connectorTools: isSpecialist ? [] : undefined,
          packId: specialist?.packId,
          packVersion: specialist?.packVersion,
          baseInstructions: specialist?.baseInstructions,
          developerInstructions: specialist?.developerInstructions,
          prompt: specialist
            ? specialist.prompt
            : kind === "note"
              ? "Use this note to explain a subgraph or design decision. Notes are never executed."
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
          description: specialist
            ? specialist.description
            : kind === "note"
              ? "Documentation only — not part of the executable company graph."
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
          missionSource: kind === "input" ? "template" : undefined,
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
          completionCriteria: isSpecialist
            ? defaultPlatformCriteria()
            : undefined,
          maxRetries: 2,
          timeoutSeconds: 120,
          sandboxProfile: specialist?.sandboxProfile,
          approvalPolicy: specialist?.approvalPolicy,
          workspacePolicy: specialist?.workspacePolicy ?? "isolated",
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
    migrationNotices: string[] = [],
  ) => {
    setWorkflowId(nextWorkflowId);
    const meta = getTemplate(nextWorkflowId);
    setWorkflowName(meta.name);
    setWorkflowDescription(meta.description ?? "");
    setWorkflowVersion(meta.version || "v0.1");
    setWorkflowIcon(normalizeWorkflowIcon(meta.icon));
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
    migrationNotices.forEach((notice) =>
      emit(notice, "workflow.snapshot.migrated", undefined, "warning"),
    );
  };

  const persistWorkflowMetadata = (patch: {
    name?: string;
    description?: string;
    version?: string;
    icon?: string;
  }) => {
    // Explicit metadata edits promote drafts into the catalog so name/description
    // are visible on Overview without requiring a full graph save first.
    const updated = updateWorkflowMetadata(workflowId, {
      ...patch,
      draft: false,
    });
    if (updated) {
      if (patch.name !== undefined) setWorkflowName(updated.name);
      if (patch.description !== undefined)
        setWorkflowDescription(updated.description);
      if (patch.version !== undefined) setWorkflowVersion(updated.version);
      if (patch.icon !== undefined)
        setWorkflowIcon(normalizeWorkflowIcon(updated.icon));
      setCatalogRevision((value) => value + 1);
    }
  };

  const openIdentityEditor = () => {
    setIdentityDraft({
      name: workflowName,
      description: workflowDescription,
      version: workflowVersion,
      icon: normalizeWorkflowIcon(workflowIcon),
    });
    setIdentityOpen(true);
  };

  const saveIdentityEditor = () => {
    const name = identityDraft.name.trim() || "Untitled workflow";
    const version = normalizeWorkflowVersion(identityDraft.version);
    const description = identityDraft.description.trim();
    const icon = normalizeWorkflowIcon(identityDraft.icon);
    setWorkflowName(name);
    setWorkflowVersion(version);
    setWorkflowDescription(description);
    setWorkflowIcon(icon);
    persistWorkflowMetadata({ name, version, description, icon });
    markDirty();
    setIdentityOpen(false);
  };

  const save = async (
    emptyConfirmed = false,
    nodesToSave = nodes,
    edgesToSave = edges,
  ) => {
    if (!emptyConfirmed && !nodesToSave.length && !edgesToSave.length) {
      const confirmed = window.confirm(
        "Are you sure you want to save an empty workflow?",
      );
      if (!confirmed) return false;
    }
    const graphJson = serializeWorkflowSnapshot(nodesToSave, edgesToSave);
    const template = getTemplate(workflowId);
    saveCustomWorkflow({
      ...template,
      name: workflowName.trim() || "Untitled workflow",
      description: workflowDescription.trim(),
      version: normalizeWorkflowVersion(workflowVersion),
      icon: normalizeWorkflowIcon(workflowIcon),
      nodes: structuredClone(nodesToSave),
      edges: structuredClone(edgesToSave),
      draft: false,
    });
    await saveWorkflowMutation.mutateAsync({
      id: workflowId,
      name: workflowName.trim() || "Untitled workflow",
      graphJson,
      workspacePath: activeChatWorkspaceRef.current,
      templateJson: JSON.stringify({
        ...template,
        name: workflowName.trim() || "Untitled workflow",
        description: workflowDescription.trim(),
        version: normalizeWorkflowVersion(workflowVersion),
        icon: normalizeWorkflowIcon(workflowIcon),
        nodes: nodesToSave,
        edges: edgesToSave,
        draft: false,
      }),
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
    const persisted = await loadPersistedWorkflowState(workflowId);
    const w = parseWorkflowSnapshot(persisted?.graphJson ?? null);
    if (!w) {
      emit(
        "No saved workflow found",
        "workflow.load.miss",
        undefined,
        "warning",
      );
      return;
    }
    activeChatWorkspaceRef.current = persisted?.workspacePath ?? null;
    userMutatedWorkflow.current = true;
    pushHistory();
    applyGraph(
      w.nodes,
      w.edges,
      workflowId,
      isTauri() ? "Loaded from SQLite" : "Loaded locally",
      w.migrationNotices,
    );
    emit("Workflow reopened", "workflow.loaded");
  };
  const resetToSeed = () => {
    userMutatedWorkflow.current = true;
    pushHistory();
    const factory = cloneTemplateGraphLaidOut(getTemplate(workflowId));
    applyGraph(factory.nodes, factory.edges, workflowId, "Seed template");
    emit(
      `Factory template restored · ${getTemplate(workflowId).name}`,
      "workflow.seed",
    );
    requestAnimationFrame(() =>
      flowRef.current?.fitView({ padding: 0.12, duration: 300 }),
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

  const loadPortfolioRunSummaries = async () => {
    try {
      if (isTauri()) {
        setPortfolioRunSummaries(
          await invoke<PortfolioRunSummary[]>("list_portfolio_run_summaries"),
        );
      } else {
        setPortfolioRunSummaries(
          summarizePortfolioRuns(
            parseRunRecords(localStorage.getItem(RUNS_STORAGE_KEY)),
          ),
        );
      }
    } catch {
      // Preserve already-loaded totals; the active history remains available.
      setPortfolioRunSummaries((previous) => previous);
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
        const graphJson = serializeWorkflowSnapshot(nodes, edges);
        const leaving = getTemplate(leavingId);
        await saveWorkflowMutation.mutateAsync({
          id: leavingId,
          name: leaving.name,
          graphJson,
          workspacePath: activeChatWorkspaceRef.current,
          templateJson: JSON.stringify({
            ...leaving,
            schemaVersion: WORKFLOW_SCHEMA_VERSION,
            nodes,
            edges,
          }),
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
      const persisted = await loadPersistedWorkflowState(nextId);
      const saved = parseWorkflowSnapshot(persisted?.graphJson ?? null);
      activeChatWorkspaceRef.current = persisted?.workspacePath ?? null;
      if (saved) {
        applyGraph(
          saved.nodes,
          saved.edges,
          nextId,
          isTauri() ? "Loaded from SQLite" : "Loaded locally",
          saved.migrationNotices,
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
    // Factory/template seeds use coarse index positions — auto-layout so first
    // open matches the Auto layout command.
    const factory = cloneTemplateGraphLaidOut(template);
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

  /** Instantiate a catalog template as an independently owned user workflow. */
  const instantiateTemplateAsWorkflow = async (
    templateId: string,
    mode: "editor" | "chat",
  ) => {
    if (running) return;
    const source = getTemplate(templateId);
    const instance = createWorkflowFromTemplate(source);
    await persistArchitectWorkflow(instance);
    await switchTemplate(instance.id, mode);
  };

  /** Built-ins are immutable blueprints, so chat must operate on a user-owned copy. */
  const openCatalogChat = async (templateId: string) => {
    const source = getTemplate(templateId);
    if (source.templateOrigin === "built-in") {
      await instantiateTemplateAsWorkflow(templateId, "chat");
      return;
    }
    await switchTemplate(templateId, "chat");
  };

  const validate = async (nodesToValidate = nodes, edgesToValidate = edges) => {
    let found = validateWorkflow(nodesToValidate, edgesToValidate);
    if (isTauri())
      try {
        const nativeProblems = await invoke<typeof found>("validate_workflow", {
          graphJson: serializeWorkflowSnapshot(
            nodesToValidate,
            edgesToValidate,
          ),
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
    const decision: "approved" | "declined" = approved
      ? "approved"
      : "declined";
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
    const resolution: NativeApprovalResolution = request.nativeRequestId
      ? resolveNativeApproval(
          approvalsRef.current,
          request.nativeRequestId,
          decision,
        )
      : {
          requests: approvalsRef.current.map((item) =>
            item.id === request.id ? { ...item, status: decision } : item,
          ),
          resumeNodeId: null,
        };
    approvalsRef.current = resolution.requests;
    setApprovals(resolution.requests);
    if (resolution.resumeNodeId && !request.runId) {
      setNodes((nodes) =>
        nodes.map((node) =>
          node.id === resolution.resumeNodeId && node.data.status === "approval"
            ? {
                ...node,
                data: {
                  ...node.data,
                  status: "running",
                  trace: [
                    ...node.data.trace,
                    `Codex tool approval ${decision}`,
                  ],
                },
              }
            : node,
        ),
      );
    }
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
  const preparedLocalTestRuns = useRef(new Set<string>());
  const prepareLocalTestForRun = async (completedRunId: string) => {
    if (!isTauri() || preparedLocalTestRuns.current.has(completedRunId)) return;
    preparedLocalTestRuns.current.add(completedRunId);
    try {
      const session = await invoke<LocalTestSession>("prepare_local_test", {
        workflowId,
        runId: completedRunId,
      });
      const planSafety = isSafeLocalLaunchPlan(
        session.plan,
        session.workspacePath,
      );
      if (!planSafety.ok) throw new Error(planSafety.reason);
      setLocalTest(session);
      appendMediatorMessageToStore(
        workflowId,
        formatLocalTestPrompt(session),
        "test",
      );
      setApprovalCenterOpen(true);
      setDrawer(true);
      setDrawerTab("approvals");
      emit(
        "Release Bundle verified · local test launch is awaiting your approval",
        "local-test.ready",
      );
    } catch (error) {
      preparedLocalTestRuns.current.delete(completedRunId);
      appendMediatorMessageToStore(
        workflowId,
        `The Release Bundle completed, but Codex Corp could not prepare a local test: ${String(error)}`,
        "error",
      );
      emit(
        `Local test preparation failed: ${String(error)}`,
        "local-test.prepare.failed",
        undefined,
        "error",
      );
    }
  };
  const resolveLocalTestLaunch = async (approved: boolean) => {
    if (!localTest || !isTauri()) return;
    try {
      const next = await invoke<LocalTestSession>("approve_local_test_launch", {
        sessionId: localTest.id,
        approved,
      });
      const planSafety = isSafeLocalLaunchPlan(next.plan, next.workspacePath);
      if (!planSafety.ok) throw new Error(planSafety.reason);
      setLocalTest(next);
      if (next.status === "running") {
        appendMediatorMessageToStore(
          workflowId,
          "The local app is running. Test it as a user, then use the test card below to approve it or request changes.",
          "status",
        );
        emit(
          "Local app started · test it in the selected workspace",
          "local-test.started",
        );
      } else if (next.status === "declined") {
        appendMediatorMessageToStore(
          workflowId,
          "Local testing was skipped. The verified Release Bundle remains available for review.",
          "status",
        );
        emit(
          "Local test launch declined",
          "local-test.declined",
          undefined,
          "warning",
        );
      } else if (next.status === "launch_failed") {
        throw new Error(next.lastError || "local app launch failed");
      }
      setApprovalCenterOpen(
        activeQuestion !== null ||
          approvalsRef.current.some((item) => item.status === "pending"),
      );
    } catch (error) {
      appendMediatorMessageToStore(
        workflowId,
        `The local app could not be started: ${String(error)}`,
        "error",
      );
      emit(
        `Local test launch failed: ${String(error)}`,
        "local-test.launch.failed",
        undefined,
        "error",
      );
    }
  };
  const submitLocalTestFeedback = async (
    approved: boolean,
    feedback: string,
  ) => {
    if (!localTest || !isTauri()) return;
    try {
      const next = await invoke<LocalTestSession>(
        "submit_local_test_feedback",
        {
          sessionId: localTest.id,
          approved,
          feedback,
        },
      );
      const planSafety = isSafeLocalLaunchPlan(next.plan, next.workspacePath);
      if (!planSafety.ok) throw new Error(planSafety.reason);
      setLocalTest(next);
      if (approved) {
        appendMediatorMessageToStore(
          workflowId,
          "Operator approved the local test. The Release Bundle is ready for handoff.",
          "status",
        );
        emit("Local test approved by operator", "local-test.approved");
        return;
      }
      const rerun = prepareLocalTestRerun(nodes, edges, feedback);
      appendMediatorMessageToStore(
        workflowId,
        `Operator requested changes after local testing:\n${
          rerun.ok ? rerun.feedback : feedback.trim()
        }`,
        "test",
      );
      if (!rerun.ok) {
        emit(
          `Local test feedback was saved, but ${rerun.error.toLowerCase()}`,
          "local-test.rerun.unavailable",
          undefined,
          "error",
        );
        return;
      }
      emit(
        `Local test feedback routed to ${rerun.rerunNode.data.label}`,
        "local-test.feedback.routed",
        rerun.rerunNode.id,
      );
      await run(rerun.rerunNode.id, undefined, rerun.nodes);
    } catch (error) {
      emit(
        `Could not save local test feedback: ${String(error)}`,
        "local-test.feedback.failed",
        undefined,
        "error",
      );
    }
  };
  const stopLocalTest = async () => {
    if (!localTest || !isTauri()) return;
    try {
      const next = await invoke<LocalTestSession>("stop_local_test", {
        sessionId: localTest.id,
      });
      setLocalTest(next);
      emit(
        "Local test process stopped",
        "local-test.stopped",
        undefined,
        "warning",
      );
    } catch (error) {
      emit(
        `Could not stop the local test process: ${String(error)}`,
        "local-test.stop.failed",
        undefined,
        "error",
      );
    }
  };
  const run = async (
    startNodeId?: string,
    missionOverride?: string,
    nodesOverride?: FlowNode[],
  ) => {
    if (running) return false;
    const sourceNodes = nodesOverride ?? nodes;
    const authorizedNodes = missionOverride?.trim()
      ? sourceNodes.map((node) =>
          node.data.kind === "input"
            ? {
                ...node,
                data: { ...node.data, output: missionOverride.trim() },
              }
            : node,
        )
      : sourceNodes;
    const missionNode = authorizedNodes.find(
      (node) => node.data.kind === "input",
    );
    if (!isConcreteMission(missionNode?.data.output)) {
      emit(
        "Add a concrete product request to the Mission brief before starting the company.",
        "run.mission.required",
        missionNode?.id,
        "error",
      );
      setDrawer(true);
      setDrawerTab("timeline");
      return false;
    }
    if (!(await validate(authorizedNodes, edges))) return false;
    if (!isTauri()) {
      emit(
        "Live Codex runs require the desktop app.",
        "run.desktop.required",
        undefined,
        "error",
      );
      return false;
    }
    setRunning(true);
    setLocalTest(null);
    setDrawer(true);
    setDrawerTab("timeline");
    eventsRef.current = [];
    setEvents([]);
    try {
      const persisted = await save(false, authorizedNodes, edges);
      if (!persisted) {
        setRunning(false);
        return false;
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
      setNodes(
        prepareNodesForRun(authorizedNodes, undefined, edges, startNodeId),
      );
      emit(`Native run ${record.id.slice(-8)} queued`, "run.queued");
      return true;
    } catch (error) {
      setRunning(false);
      emit(
        `Native run failed to start: ${String(error)}`,
        "run.start.failed",
        undefined,
        "error",
      );
      return false;
    }
  };

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
        if (activeConfirmation || activeQuestion) {
          closeDecisionCenter();
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
    const def = defaultNodeModelFromList(codexModels);
    if (!def) return;
    setNodes((ns) => {
      let changed = false;
      const next = ns.map((node) => {
        if (!isSpecialistKind(node.data.kind)) return node;
        if (!needsLiveModelDefault(node.data.model, codexModels)) return node;
        changed = true;
        const effort = defaultNodeEffortForModel(codexModels, def);
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
      if (freshAppNeedsNativeReset && isTauri()) {
        try {
          await invoke("clear_all_company_data");
        } catch {
          /* continue booting from the existing native data if reset fails */
        }
      }
      try {
        await hydrateWorkflowCatalog();
        await Promise.all(
          [
            DEFAULT_TEMPLATE_ID,
            ...listWorkflows({ includeDrafts: true }).map(({ id }) => id),
          ].map((id) => hydrateChatStore(id)),
        );
        if (!cancelled) setCatalogRevision((value) => value + 1);
      } catch {
        /* keep the browser migration cache available */
      }
      const activeId = readActiveWorkflowId(
        localStorage.getItem(ACTIVE_WORKFLOW_KEY),
        DEFAULT_TEMPLATE_ID,
      );
      // Keep metadata in lockstep with the graph selected during bootstrap.
      // Without this, saving an auto-restored graph overwrites its catalog
      // metadata with the editor's initial placeholder values.
      if (
        !cancelled &&
        shouldApplyAutoloadSnapshot(userMutatedWorkflow.current)
      ) {
        const metadata = getTemplate(activeId);
        setWorkflowName(metadata.name);
        setWorkflowDescription(metadata.description ?? "");
        setWorkflowVersion(metadata.version || "v0.1");
        setWorkflowIcon(normalizeWorkflowIcon(metadata.icon));
      }
      // 1) Auto-load last saved workflow for the active template when present.
      // Skip if the user already Seeded/edited after first paint (late-load race).
      try {
        const persisted = await loadPersistedWorkflowState(activeId);
        const snapshot = parseWorkflowSnapshot(persisted?.graphJson ?? null);
        if (
          !cancelled &&
          shouldApplyAutoloadSnapshot(userMutatedWorkflow.current)
        ) {
          if (snapshot) {
            activeChatWorkspaceRef.current = persisted?.workspacePath ?? null;
            setWorkflowId(activeId);
            setNodes(snapshot.nodes);
            setEdges(snapshot.edges);
            setSaved(isTauri() ? "Loaded from SQLite" : "Loaded locally");
            snapshot.migrationNotices?.forEach((notice) =>
              emit(notice, "workflow.snapshot.migrated", undefined, "warning"),
            );
            emit(
              isTauri()
                ? `Restored workflow from SQLite · ${getTemplate(activeId).name}`
                : `Restored workflow from local storage · ${getTemplate(activeId).name}`,
              "workflow.autoload",
            );
          } else if (activeId !== DEFAULT_TEMPLATE_ID) {
            const factory = cloneTemplateGraphLaidOut(getTemplate(activeId));
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

      // 3) Compact lifetime portfolio totals for Dashboards.
      try {
        if (isTauri()) {
          const summaries = await invoke<PortfolioRunSummary[]>(
            "list_portfolio_run_summaries",
          );
          if (!cancelled) setPortfolioRunSummaries(summaries);
        } else if (!cancelled) {
          setPortfolioRunSummaries(
            summarizePortfolioRuns(
              parseRunRecords(localStorage.getItem(RUNS_STORAGE_KEY)),
            ),
          );
        }
      } catch {
        if (!cancelled) setPortfolioRunSummaries([]);
      }
      try {
        if (isTauri()) {
          const settings = await invoke<any>("get_app_settings");
          if (
            !cancelled &&
            settings &&
            typeof settings.costPer1kTokensUsd === "number"
          ) {
            setCostPer1k(settings.costPer1kTokensUsd);
          }
        }
      } catch {
        /* keep default */
      }
      if (!cancelled) setCatalogReady(true);
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const onSettingsChanged = (event: Event) => {
      const settings = (event as CustomEvent).detail;
      if (settings && typeof settings.costPer1kTokensUsd === "number") {
        setCostPer1k(settings.costPer1kTokensUsd);
      }
    };
    window.addEventListener("codex-corp:settings-changed", onSettingsChanged);
    return () =>
      window.removeEventListener(
        "codex-corp:settings-changed",
        onSettingsChanged,
      );
  }, []);
  useEffect(() => {
    const onPersistenceError = (event: Event) => {
      const detail = (event as CustomEvent<PersistenceErrorDetail>).detail;
      emit(
        `${detail?.area || "Data"} was not saved: ${detail?.message || "unknown persistence error"}`,
        "persistence.failed",
        undefined,
        "error",
      );
    };
    window.addEventListener(PERSISTENCE_ERROR_EVENT, onPersistenceError);
    return () =>
      window.removeEventListener(PERSISTENCE_ERROR_EVENT, onPersistenceError);
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    void invoke<LocalTestSession | null>("get_local_test", { workflowId })
      .then((session) => {
        if (disposed) return;
        if (session) {
          const planSafety = isSafeLocalLaunchPlan(
            session.plan,
            session.workspacePath,
          );
          if (!planSafety.ok) {
            setLocalTest(null);
            return;
          }
          if (session.status === "launch_pending") {
            setApprovalCenterOpen(true);
            setDrawer(true);
            setDrawerTab("approvals");
          }
        }
        setLocalTest(session);
      })
      .catch(() => {
        if (!disposed) setLocalTest(null);
      });
    return () => {
      disposed = true;
    };
  }, [workflowId]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisteners: Promise<() => void>[] = [];
    unlisteners.push(
      listen<LocalTestSession>("local-test-event", (event) => {
        if (disposed || event.payload.workflowId !== workflowId) return;
        const planSafety = isSafeLocalLaunchPlan(
          event.payload.plan,
          event.payload.workspacePath,
        );
        if (!planSafety.ok) {
          appendMediatorMessageToStore(
            workflowId,
            `The native local-test event was rejected: ${planSafety.reason}`,
            "error",
          );
          return;
        }
        setLocalTest(event.payload);
        if (event.payload.status === "exited") {
          appendMediatorMessageToStore(
            workflowId,
            event.payload.lastError
              ? `The local test process exited: ${event.payload.lastError}`
              : "The local test process exited. You can still record the result in workflow chat.",
            event.payload.lastError ? "error" : "test",
          );
        }
      }),
    );
    unlisteners.push(
      listen<{
        nodeId: string;
        eventType: string;
        message: string;
        threadId?: string;
        turnId?: string;
        tokens?: number;
      }>("codex-agent-event", (event) => {
        if (disposed) return;
        const payload = event.payload;
        const lifecycle = isCodexAgentLifecycleEvent(payload.eventType);
        const canonicalType = normalizeStreamEventType(payload.eventType);
        const streaming = isAgentMessageDelta(canonicalType);
        const streamingTrace = isStreamingTraceEvent(payload.eventType);
        const streamKind = classifyStreamKind(canonicalType);
        const tokenEvent =
          isTokenUsageEventType(payload.eventType) ||
          typeof payload.tokens === "number";
        const tokens = Math.max(
          Number(payload.tokens) || 0,
          extractTotalTokensFromPayload(payload),
          extractTotalTokensFromPayload(payload.message),
        );
        if (
          !lifecycle &&
          !streaming &&
          !streamingTrace &&
          !streamKind &&
          !tokenEvent &&
          tokens <= 0
        )
          return;
        let streamBufferForNode: ExecutionStreamBuffer | undefined;
        if (streamKind) {
          const streamKey = `${runId ?? "draft"}/${payload.nodeId}/${payload.turnId ?? "current"}`;
          const existing = streamBuffersRef.current[payload.nodeId];
          const buffer =
            existing && existing.streamKey === streamKey
              ? existing
              : createStreamBuffer(streamKey, payload.nodeId, "workflow-node");
          streamBufferForNode = appendStreamEvent(buffer, {
            streamKey,
            nodeId: payload.nodeId,
            surface: "workflow-node",
            kind: streamKind,
            text: payload.message,
            at: Date.now(),
            threadId: payload.threadId,
            turnId: payload.turnId,
          });
          streamBuffersRef.current = {
            ...streamBuffersRef.current,
            [payload.nodeId]: streamBufferForNode,
          };
          setActiveStreamNodeId(payload.nodeId);
        }
        if (lifecycle) {
          const existing = streamBuffersRef.current[payload.nodeId];
          if (existing && !existing.complete) {
            const completed = { ...existing, complete: true };
            streamBuffersRef.current = {
              ...streamBuffersRef.current,
              [payload.nodeId]: completed,
            };
            streamBufferForNode = completed;
          }
        }
        setNodes((ns) =>
          ns.map((n) => {
            if (n.id !== payload.nodeId) return n;
            let next = n;
            if (tokens > 0) next = applyTokenUsageToNode(next, tokens);
            const traceEntry = streamingTrace
              ? {
                  eventType: payload.eventType,
                  text: payload.message,
                  at: Date.now(),
                  threadId: payload.threadId,
                  turnId: payload.turnId,
                }
              : undefined;
            return {
              ...next,
              data: {
                ...next.data,
                threadId: payload.threadId ?? next.data.threadId,
                streamingPreview: streaming
                  ? appendStreamPreview(
                      next.data.streamingPreview,
                      payload.message,
                    )
                  : lifecycle
                    ? undefined
                    : next.data.streamingPreview,
                streamBuffer: streamBufferForNode ?? next.data.streamBuffer,
                trace: lifecycle
                  ? [...next.data.trace, payload.message].slice(-80)
                  : traceEntry
                    ? appendTypedTrace(next.data.trace, traceEntry)
                    : next.data.trace,
              },
            };
          }),
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
      listen<{ message: string }>("codex-hook-persistence-error", (event) => {
        if (disposed) return;
        emit(
          `Hook history was not saved: ${event.payload.message}`,
          "hook.persistence.failed",
          undefined,
          "error",
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
        const structured = parseStructuredApproval(
          payload.method,
          payload.params,
        );
        const request: ApprovalRequest = {
          id: crypto.randomUUID(),
          nativeRequestId: payload.requestId,
          nodeId: payload.nodeId,
          title:
            structured.kind === "fileChange"
              ? "Approve proposed file changes"
              : structured.kind === "execCommand"
                ? `Approve command execution`
                : payload.method.includes("fileChange")
                  ? "Approve proposed file changes"
                  : "Approve Codex tool action",
          detail: JSON.stringify(payload.params, null, 2),
          risk: "Review the command, paths, working directory and requested permission. This decision applies once.",
          status: "pending",
          structured,
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
    unlisteners.push(
      listen<{
        requestId: string;
        nodeId: string;
        decision: "accept" | "decline";
      }>("codex-approval-resolved", (event) => {
        if (disposed) return;
        const payload = event.payload;
        const status = payload.decision === "accept" ? "approved" : "declined";
        const resolution = resolveNativeApproval(
          approvalsRef.current,
          payload.requestId,
          status,
        );
        if (resolution.requests === approvalsRef.current) return;
        approvalsRef.current = resolution.requests;
        setApprovals(resolution.requests);
        setActiveApproval(
          resolution.requests.find((item) => item.status === "pending") ?? null,
        );
        if (resolution.resumeNodeId) {
          setNodes((nodes) =>
            nodes.map((node) =>
              node.id === resolution.resumeNodeId &&
              node.data.status === "approval"
                ? {
                    ...node,
                    data: {
                      ...node.data,
                      status: "running",
                      trace: [
                        ...node.data.trace,
                        `Codex tool approval ${status}`,
                      ],
                    },
                  }
                : node,
            ),
          );
        }
      }),
    );
    // Handle user-input and elicitation requests (reuse approval broker).
    unlisteners.push(
      listen<{
        requestId: string;
        nodeId: string;
        method: string;
        params: Record<string, unknown>;
      }>("codex-user-input-requested", (event) => {
        if (disposed) return;
        const p = event.payload;
        interactionQueue.current = interactionQueue.current
          .then(async () => {
            let payload = buildUserInputResponse([]);
            try {
              const questions = parseUserInputQuestions(p.params);
              const answers: MediatorQuestionAnswer[] = [];
              const timeoutMs = Number(p.params.autoResolutionMs) || 0;
              const collect = async () => {
                for (const question of questions) {
                  const answer = await askMediatorQuestion(question);
                  if (!answer) return null;
                  answers.push(answer);
                }
                return answers;
              };
              const collected =
                timeoutMs > 0
                  ? await Promise.race([
                      collect(),
                      new Promise<null>((resolve) =>
                        setTimeout(() => resolve(null), timeoutMs),
                      ),
                    ])
                  : await collect();
              if (collected) payload = buildUserInputResponse(collected);
              else {
                questionResolver.current?.(null);
                questionResolver.current = null;
                setActiveQuestion(null);
              }
            } catch (failure) {
              emit(
                `Invalid Codex question: ${failure instanceof Error ? failure.message : String(failure)}`,
                "interaction.invalid",
                p.nodeId,
                "error",
              );
            }
            await invoke("respond_user_input", {
              requestId: p.requestId,
              payload,
            });
          })
          .catch((failure) => {
            emit(
              `Could not answer Codex question: ${String(failure)}`,
              "interaction.failed",
              p.nodeId,
              "error",
            );
          });
      }),
    );
    unlisteners.push(
      listen<{
        requestId: string;
        nodeId: string;
        method: string;
        params: Record<string, unknown>;
      }>("codex-elicitation-requested", (event) => {
        if (disposed) return;
        const p = event.payload;
        interactionQueue.current = interactionQueue.current
          .then(async () => {
            let payload: Record<string, unknown> = {
              action: "cancel",
              content: {},
              _meta: null,
            };
            try {
              const fields = parseElicitationForm(p.params);
              const content: Record<string, unknown> = {};
              for (const field of fields) {
                const answer = await askMediatorQuestion(field.question);
                if (!answer) {
                  await invoke("respond_user_input", {
                    requestId: p.requestId,
                    payload,
                  });
                  return;
                }
                const raw = answer.freeText ?? answer.optionIds[0] ?? "";
                content[field.id] =
                  field.valueType === "number"
                    ? Number(raw)
                    : field.valueType === "boolean"
                      ? raw === "true"
                      : raw;
              }
              payload = {
                action: "accept",
                content,
                _meta: p.params._meta ?? null,
              };
            } catch (failure) {
              emit(
                `Invalid MCP elicitation: ${failure instanceof Error ? failure.message : String(failure)}`,
                "interaction.invalid",
                p.nodeId,
                "error",
              );
            }
            await invoke("respond_user_input", {
              requestId: p.requestId,
              payload,
            });
          })
          .catch((failure) => {
            emit(
              `Could not answer MCP elicitation: ${String(failure)}`,
              "interaction.failed",
              p.nodeId,
              "error",
            );
          });
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
        if (
          runId &&
          !shouldAcceptRunEvent(
            runId,
            payload.runId,
            payload.sequence,
            lastRunEventCursor.current,
          )
        ) {
          return;
        }
        if (runId) {
          lastRunEventCursor.current = {
            runId,
            sequence: payload.sequence,
          };
        }
        const nodeStatus = nodeStatusForRunEvent(payload.eventType);
        if (
          payload.nodeId &&
          (nodeStatus || payload.eventType === "revision.routed")
        ) {
          const diag = payload.diagnostics ?? {};
          setNodes((items) =>
            items.map((node) => {
              if (node.id !== payload.nodeId) return node;
              const revisions = revisionCountForRunEvent(
                payload.eventType,
                diag,
                node.data.revisions ?? 0,
              );
              return {
                ...node,
                data: {
                  ...node.data,
                  status: nodeStatus ?? node.data.status,
                  ...(revisions !== undefined ? { revisions } : {}),
                  // Host-slimmed diagnostics hydrate specialists and
                  // deterministic controls without artifact bodies.
                  ...nodeOutputPatchForRunEvent(
                    payload.eventType,
                    diag,
                    typeof node.data.structuredOutput === "object" &&
                      node.data.structuredOutput
                      ? node.data.structuredOutput
                      : undefined,
                  ),
                  trace: [...node.data.trace, payload.message].slice(-80),
                },
              };
            }),
          );
        }
        const runEvent: RunEvent = {
          id: `${payload.runId}:${payload.sequence}`,
          at: payload.at,
          type: payload.eventType,
          message: payload.message,
          nodeId: payload.nodeId,
          level: payload.level,
          attemptId: payload.attemptId,
          itemType:
            typeof payload.diagnostics?.itemType === "string"
              ? payload.diagnostics.itemType
              : undefined,
          status:
            typeof payload.diagnostics?.status === "string"
              ? payload.diagnostics.status
              : payload.level,
          elapsedMs:
            typeof payload.diagnostics?.elapsedMs === "number"
              ? payload.diagnostics.elapsedMs
              : undefined,
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
          void loadPortfolioRunSummaries();
          if (payload.eventType === "run.completed") {
            void prepareLocalTestForRun(payload.runId);
          }
        }
        const diagTokens = extractTotalTokensFromPayload(payload.diagnostics);
        if (payload.nodeId && diagTokens > 0) {
          setNodes((items) =>
            items.map((node) =>
              node.id === payload.nodeId
                ? applyTokenUsageToNode(node, diagTokens)
                : node,
            ),
          );
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
          risk: "This explicit human decision authorizes the verified release bundle for this run only.",
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
            confirmation={activeConfirmation}
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
            onResolveConfirmation={resolveOperatorConfirmation}
            onResolveQuestion={resolveMediatorQuestion}
            localTest={localTest}
            onResolveLocalTestLaunch={resolveLocalTestLaunch}
            onClose={closeDecisionCenter}
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

  if (!catalogReady) {
    return (
      <div className="app-bootstrap" role="status" aria-live="polite">
        <Sparkles size={22} />
        <span>Loading native company data…</span>
      </div>
    );
  }

  if (appView === "overview") {
    return (
      <>
        <FeatureBoundary name="Workflows overview">
          <OverviewPage
            activeWorkflowId={workflowId}
            running={running}
            runHistory={runHistory}
            portfolioRunSummaries={portfolioRunSummaries}
            codexInfo={codexInfo}
            onOpenChat={(id) => {
              void openCatalogChat(id);
            }}
            onEditWorkflow={(id) => {
              void switchTemplate(id, "editor");
            }}
            onUseTemplate={(id) => {
              void instantiateTemplateAsWorkflow(id, "editor");
            }}
            onDeleteWorkflow={(id) => {
              void (async () => {
                deleteWorkflowFromCatalog(id);
                localStorage.removeItem(workflowStorageKey(id));
                setCatalogRevision((value) => value + 1);
                if (id === workflowId) {
                  const fallback = listWorkflows()[0];
                  if (fallback) await switchTemplate(fallback.id, "stay");
                }
              })();
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
        <FeatureBoundary name="Byte">
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
            voiceContext={{
              developerInstructions: WORKFLOW_ARCHITECT_SYSTEM_PROMPT,
              contextDigest: buildArchitectContextDigest(),
              dynamicTools: workflowArchitectDynamicTools(),
            }}
            onVoiceToolCall={resolveVoiceTool}
            voiceAvailable={
              codexCapabilitiesStatus === "live" &&
              codexCapabilities.realtimeConversationAvailable &&
              !realtimeRuntimeUnavailable
            }
            onVoiceUnavailable={() => setRealtimeRuntimeUnavailable(true)}
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
              (activeQuestion ? 1 : 0) +
              (localTest?.status === "launch_pending" ? 1 : 0)
            }
            localTest={localTest}
            onOpenApprovals={() => setApprovalCenterOpen(true)}
            onSubmitLocalTestFeedback={submitLocalTestFeedback}
            onStopLocalTest={stopLocalTest}
            onBack={() => {
              setAppView("overview");
            }}
            onEditWorkflow={(id) => {
              void switchTemplate(id, "editor");
            }}
            onMediatorTurn={handleMediatorTurn}
            voiceContext={{
              developerInstructions: COMPANY_MEDIATOR_SYSTEM_PROMPT,
              contextDigest: buildMediatorContextDigest(mediatorHostContext()),
              dynamicTools: companyMediatorDynamicTools(),
            }}
            onVoiceToolCall={resolveVoiceTool}
            voiceAvailable={
              codexCapabilitiesStatus === "live" &&
              codexCapabilities.realtimeConversationAvailable &&
              !realtimeRuntimeUnavailable
            }
            onVoiceUnavailable={() => setRealtimeRuntimeUnavailable(true)}
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
          <button
            type="button"
            className="workflow-identity-trigger"
            onClick={openIdentityEditor}
            title="Edit workflow name, icon, version, and description"
            aria-haspopup="dialog"
            aria-expanded={identityOpen}
          >
            {(() => {
              const IdentityIcon = workflowIconComponent(workflowIcon);
              return (
                <span className="workflow-identity-glyph" aria-hidden>
                  <IdentityIcon size={16} />
                </span>
              );
            })()}
            <div className="workflow-identity-copy">
              <div className="workflow-identity-title">
                <strong>{workflowName || "Untitled workflow"}</strong>
                <span className="workflow-version-tag">{workflowVersion}</span>
              </div>
              <span className="workflow-identity-desc">
                {workflowDescription.trim() || "Add a description…"}
              </span>
            </div>
            <span className="workflow-identity-edit" aria-hidden>
              <Pencil size={13} />
            </span>
          </button>
        </div>
        <div className="top-actions">
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
                ? "Byte cannot modify this workflow"
                : "Allow Byte to modify this workflow"
            }
            aria-pressed={Boolean(activeTemplate.locked)}
            aria-label={
              activeTemplate.locked
                ? "Unlock workflow for Byte"
                : "Lock workflow from Byte"
            }
          >
            {activeTemplate.locked ? <Lock size={14} /> : <Unlock size={14} />}
            {activeTemplate.locked ? "Locked" : "Unlocked"}
          </button>
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
                (activeQuestion ? 1 : 0) +
                (localTest?.status === "launch_pending" ? 1 : 0)}
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
              <Search size={13} className="library-search-icon" aria-hidden />
              <input
                ref={librarySearchRef}
                type="text"
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
                autoComplete="off"
                spellCheck={false}
              />
              {libraryQuery ? (
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
              ) : null}
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
              {filteredSpecialists.map((pack) => {
                const PackIcon = iconForPack(pack);
                return (
                  <button
                    className="profile-item"
                    key={pack.id}
                    onClick={() => createNodeFromPack(pack)}
                  >
                    <PackIcon size={13} aria-hidden />
                    {pack.label}
                  </button>
                );
              })}
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
            createNode(kind, p, undefined, {
              openRoleCatalogAt: { x: e.clientX, y: e.clientY },
            });
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
            <div className="inspector-chrome">
              <span className="inspector-chrome-label">Inspector</span>
              <button
                type="button"
                className="panel-collapse-btn"
                aria-label="Collapse inspector"
                title="Collapse inspector"
                onClick={() => setInspectorOpen(false)}
              >
                <ChevronRight size={14} />
              </button>
            </div>
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
                inboundEdges={edges.filter(
                  (edge) => edge.target === selected.id,
                )}
                workflowInput={
                  nodes.find((node) => node.data.kind === "input")?.data
                    .output ?? ""
                }
                events={events}
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
              {(verificationLoops.length > 0 ||
                inspectedDeliveryStatus !== "pending") && (
                <div className="drawer-verification-loops">
                  {inspectedDeliveryStatus !== "pending" && (
                    <span
                      className={`delivery-preview-chip delivery-preview-${inspectedDeliveryStatus}`}
                      title={
                        inspectedDeliveryStatus === "failed"
                          ? "Runtime verification or artifact pair-compare contradicts this delivery."
                          : "Runtime verification rows back this delivery."
                      }
                    >
                      Delivery{" "}
                      {inspectedDeliveryStatus === "success"
                        ? "trusted"
                        : inspectedDeliveryStatus}
                    </span>
                  )}
                  {verificationLoops.map((loop) => (
                    <span
                      key={loop.nodeId}
                      className="verification-loops-chip"
                      title={`criterionIds: ${loop.criterionIds.join(", ") || "—"}`}
                    >
                      {loop.verificationRevisions} verification loop
                      {loop.verificationRevisions === 1 ? "" : "s"} ·{" "}
                      {loop.nodeId}
                    </span>
                  ))}
                </div>
              )}
              <nav>
                {(
                  [
                    "timeline",
                    "runs",
                    "approvals",
                    "stream",
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
                        {approvals.filter((a) => a.status === "pending")
                          .length +
                          (localTest?.status === "launch_pending" ? 1 : 0)}
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
                {drawerTab === "stream" && (
                  <div className="drawer-stream-view">
                    {nodes
                      .filter(
                        (node) =>
                          node.data.streamBuffer &&
                          node.data.streamBuffer.lines.length > 0,
                      )
                      .map((node) => (
                        <ExecutionStreamDisclosure
                          key={node.id}
                          buffer={node.data.streamBuffer}
                          expanded={activeStreamNodeId === node.id}
                          onToggle={() =>
                            setActiveStreamNodeId((current) =>
                              current === node.id ? null : node.id,
                            )
                          }
                          label={`${node.data.label} stream`}
                        />
                      ))}
                    {nodes.every(
                      (node) =>
                        !node.data.streamBuffer ||
                        node.data.streamBuffer.lines.length === 0,
                    ) && <span>No active streams.</span>}
                  </div>
                )}
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
                      value={`$${estimateTokenCostUsd(
                        nodes.reduce((s, n) => s + n.data.tokens, 0),
                        costPer1k,
                      ).toFixed(2)}`}
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
                    createNode("agent", undefined, undefined, {
                      openRoleCatalogAt: {
                        x: contextMenu.x,
                        y: contextMenu.y,
                      },
                    });
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
      {roleCatalog && (
        <RoleCatalogMenu
          x={roleCatalog.x}
          y={roleCatalog.y}
          onCancel={() => setRoleCatalog(null)}
          onSelect={(pack) => {
            createNodeFromPack(pack, roleCatalog.position);
            setRoleCatalog(null);
          }}
        />
      )}
      {identityOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setIdentityOpen(false);
          }}
        >
          <div
            className="workflow-identity-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workflow-identity-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="workflow-identity-modal-header">
              <div>
                <span className="workflow-identity-modal-eyebrow">
                  Workflow identity
                </span>
                <h2 id="workflow-identity-title">
                  Name, icon, version & description
                </h2>
              </div>
              <button
                type="button"
                className="modal-close"
                aria-label="Close identity editor"
                onClick={() => setIdentityOpen(false)}
              >
                <X size={15} />
              </button>
            </header>
            <div className="workflow-identity-modal-body">
              <div
                className="workflow-identity-field workflow-identity-icon-field"
                role="group"
                aria-label="Homescreen icon"
              >
                <span>Icon</span>
                <p className="workflow-identity-icon-help">
                  Shown on the workflows homescreen card for this company.
                </p>
                <div className="workflow-icon-picker">
                  {WORKFLOW_ICON_OPTIONS.map(({ id, label, Icon }) => {
                    const selected =
                      normalizeWorkflowIcon(identityDraft.icon) === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`workflow-icon-option${selected ? " selected" : ""}`}
                        title={label}
                        aria-label={label}
                        aria-pressed={selected}
                        onClick={() =>
                          setIdentityDraft((draft) => ({
                            ...draft,
                            icon: id,
                          }))
                        }
                      >
                        <Icon size={16} aria-hidden />
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="workflow-identity-field">
                <span>Name</span>
                <input
                  value={identityDraft.name}
                  onChange={(event) =>
                    setIdentityDraft((draft) => ({
                      ...draft,
                      name: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      saveIdentityEditor();
                    }
                    if (event.key === "Escape") setIdentityOpen(false);
                  }}
                  autoFocus
                  placeholder="Untitled workflow"
                  aria-label="Workflow name"
                />
              </label>
              <label className="workflow-identity-field workflow-identity-version">
                <span>Version</span>
                <input
                  value={identityDraft.version}
                  onChange={(event) =>
                    setIdentityDraft((draft) => ({
                      ...draft,
                      version: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      saveIdentityEditor();
                    }
                    if (event.key === "Escape") setIdentityOpen(false);
                  }}
                  placeholder="v0.1"
                  title="Semantic product version (e.g. v0.1, v1.2)"
                  aria-label="Workflow version"
                />
              </label>
              <label className="workflow-identity-field workflow-identity-description">
                <span>Description</span>
                <textarea
                  value={identityDraft.description}
                  onChange={(event) =>
                    setIdentityDraft((draft) => ({
                      ...draft,
                      description: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setIdentityOpen(false);
                  }}
                  rows={3}
                  placeholder="What this company workflow does…"
                  aria-label="Workflow description"
                />
              </label>
            </div>
            <footer className="workflow-identity-modal-footer">
              <button
                type="button"
                className="workflow-identity-cancel"
                onClick={() => setIdentityOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="workflow-identity-save"
                onClick={saveIdentityEditor}
              >
                <Check size={14} aria-hidden />
                Save details
              </button>
            </footer>
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

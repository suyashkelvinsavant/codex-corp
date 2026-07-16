/**
 * Sole Live Codex desktop evidence orchestrator.
 *
 * 1) Records launchIso
 * 2) Polls CodexCorp SQLite for software-company save_run with created_at > launchIso
 * 3) Hard-fails unless all five agent threadIds are non-demo-* Live Codex threads
 * 4) If revision events appear, requires revision.live.started + live re-review events
 * 5) Writes {SCRATCH} artifacts from that row only (never re-harvests older runs)
 *
 * Env:
 *   SCRATCH — evidence dir (default: implementer temp from goal harness)
 *   EVIDENCE_TIMEOUT_MS — poll budget (default 25 min)
 *   LAUNCH_ISO — optional override if process already launched
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");

const SCRATCH =
  process.env.SCRATCH ||
  path.join(
    process.env.LOCALAPPDATA || process.env.TEMP || ".",
    "Temp",
    "grok-goal-5c1d6399aed2",
    "implementer",
  );

const DB_PATH = path.join(
  process.env.LOCALAPPDATA || "",
  "CodexCorp",
  "codex-corp.sqlite",
);
const WS_ROOT = path.join(
  process.env.LOCALAPPDATA || "",
  "CodexCorp",
  "workspaces",
);

const AGENT_IDS = ["research", "architect", "designer", "builder", "reviewer"];
const TIMEOUT_MS = Number(process.env.EVIDENCE_TIMEOUT_MS || 25 * 60 * 1000);
const POLL_MS = 8000;

function fail(msg) {
  console.error("EVIDENCE_FAIL:", msg);
  process.exit(1);
}

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(SCRATCH, "desktop-evidence.log"), line + "\n");
}

function isDemoThread(id) {
  return !id || /^demo-/i.test(String(id).trim());
}

function listTree(dir, depth = 4, prefix = "") {
  const out = [];
  if (depth < 0 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".agents")
      continue;
    const p = path.join(dir, e.name);
    out.push(
      prefix + e.name + (e.isDirectory() ? "/" : ` (${fs.statSync(p).size})`),
    );
    if (e.isDirectory()) out.push(...listTree(p, depth - 1, prefix + "  "));
  }
  return out;
}

/** SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' (UTC-ish, no Z). */
function toSqliteStamp(d = new Date()) {
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function parseSqliteStamp(s) {
  if (!s) return 0;
  // Treat as UTC for comparison with launchIso
  const t = Date.parse(String(s).replace(" ", "T") + "Z");
  return Number.isFinite(t) ? t : 0;
}

fs.mkdirSync(SCRATCH, { recursive: true });
fs.writeFileSync(path.join(SCRATCH, "desktop-evidence.log"), "");

const launchIso =
  process.env.LAUNCH_ISO || new Date().toISOString();
const launchStamp = toSqliteStamp(new Date(launchIso));
const launchMs = Date.parse(launchIso);

log(`launchIso=${launchIso} launchStamp=${launchStamp}`);
log(`db=${DB_PATH}`);
log(`scratch=${SCRATCH}`);

if (!fs.existsSync(DB_PATH)) fail(`missing sqlite ${DB_PATH}`);

const deadline = Date.now() + TIMEOUT_MS;
let hit = null;

while (Date.now() < deadline) {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const runs = db
      .prepare(
        `SELECT id, workflow_id, status, created_at,
                length(events_json) AS elen,
                length(nodes_json) AS nlen,
                events_json, nodes_json
         FROM runs
         WHERE workflow_id = 'software-company'
         ORDER BY datetime(created_at) DESC
         LIMIT 8`,
      )
      .all();

    const ws = fs.existsSync(WS_ROOT)
      ? fs.readdirSync(WS_ROOT).join(",")
      : "";
    log(
      `poll workspaces=[${ws}] runs=${runs
        .map(
          (r) =>
            `${r.id.slice(0, 8)}:${r.status}:n=${r.nlen}:e=${r.elen}:${r.created_at}`,
        )
        .join(" | ")}`,
    );

    hit = runs.find((r) => {
      if ((r.nlen || 0) < 100) return false;
      const createdMs = parseSqliteStamp(r.created_at);
      // Accept runs created at/after launch (2 min clock skew pad)
      return createdMs + 120_000 >= launchMs;
    });

    if (hit) {
      log(`HIT run ${hit.id} created=${hit.created_at} status=${hit.status}`);
      break;
    }
  } catch (e) {
    log(`poll error: ${e}`);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

if (!hit) fail(`no software-company save_run after launchIso=${launchIso}`);

// --- Hard-fail harvest ---
const events = JSON.parse(hit.events_json || "[]");
const nodes = JSON.parse(hit.nodes_json || "[]");
const agents = nodes.filter(
  (n) => n.data?.kind === "agent" || n.data?.kind === "creative",
);

const agentMap = Object.fromEntries(agents.map((n) => [n.id, n]));
for (const id of AGENT_IDS) {
  const n = agentMap[id];
  if (!n) fail(`missing agent node ${id} in nodes_json`);
  if (n.data?.status !== "completed")
    fail(`agent ${id} status=${n.data?.status} (want completed)`);
  const model = String(n.data?.model || "").toLowerCase();
  if (!model.includes("luna"))
    fail(`agent ${id} model=${n.data?.model} (want 5.6 luna)`);
  if (String(n.data?.effort || "") !== "low")
    fail(`agent ${id} effort=${n.data?.effort} (want low)`);
  const threadId = n.data?.threadId;
  if (isDemoThread(threadId))
    fail(
      `agent ${id} threadId=${threadId} is demo/missing — Live Codex required`,
    );
}

const revisionSignals = events.some((e) =>
  /needs_revision|node\.revision|revision\.routed/i.test(
    `${e.type || ""} ${e.message || ""}`,
  ),
);
const hasLiveRevisionStart = events.some(
  (e) => e.type === "revision.live.started",
);
const hasLiveRereview = events.some(
  (e) =>
    e.type === "revision.review" &&
    /live re-review/i.test(String(e.message || "")),
);

if (revisionSignals) {
  if (!hasLiveRevisionStart)
    fail(
      "revision events present but missing revision.live.started (demo revision path)",
    );
  if (!hasLiveRereview)
    fail("revision events present but missing live re-review event");
}

const freshStarts = events.filter((e) =>
  /Fresh Codex thread started/i.test(String(e.message || "")),
);
const freshByNode = {};
for (const e of freshStarts) {
  if (e.nodeId) freshByNode[e.nodeId] = (freshByNode[e.nodeId] || 0) + 1;
}
for (const id of AGENT_IDS) {
  if (!freshByNode[id])
    fail(`no Fresh Codex thread started event for ${id}`);
}

// --- Write SCRATCH artifacts from THIS run only ---
const deliveryDir = path.join(SCRATCH, "delivery");
fs.rmSync(deliveryDir, { recursive: true, force: true });
fs.mkdirSync(deliveryDir, { recursive: true });

// run-events.log: real events only
const eventsLog = path.join(SCRATCH, "run-events.log");
fs.writeFileSync(
  eventsLog,
  JSON.stringify({
    at: new Date().toISOString(),
    type: "harvest.source",
    message: `SQLite save_run id=${hit.id} status=${hit.status} created=${hit.created_at}`,
    runId: hit.id,
    launchIso,
    source: "scripts/desktop-live-evidence.mjs",
  }) + "\n",
);
for (const ev of events) {
  fs.appendFileSync(
    eventsLog,
    JSON.stringify({
      at: ev.at,
      type: ev.type,
      message: ev.message,
      nodeId: ev.nodeId,
      level: ev.level,
      id: ev.id,
      source: "save_run.eventsJson",
    }) + "\n",
  );
}

fs.writeFileSync(
  path.join(SCRATCH, "desktop-run-events.json"),
  JSON.stringify(events, null, 2),
);
fs.writeFileSync(
  path.join(SCRATCH, "desktop-run-nodes.json"),
  JSON.stringify(nodes, null, 2),
);

for (const n of agents) {
  const dir = path.join(deliveryDir, n.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        nodeId: n.id,
        label: n.data.label,
        role: n.data.role,
        status: n.data.status,
        model: n.data.model,
        effort: n.data.effort,
        summary: n.data.output,
        threadId: n.data.threadId,
        structuredOutput: n.data.structuredOutput,
        artifacts: n.data.artifacts,
        source: "desktop save_run nodes_json",
      },
      null,
      2,
    ),
  );
}

// Workspaces + react app
const wsListing = listTree(WS_ROOT, 4);
fs.writeFileSync(
  path.join(SCRATCH, "codexcorp-workspaces-listing.txt"),
  wsListing.join("\n"),
);

function findAppRoots(root) {
  const hits = [];
  const walk = (d, depth) => {
    if (depth < 0 || !fs.existsSync(d)) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (fs.existsSync(path.join(d, "package.json"))) hits.push(d);
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git")
        continue;
      walk(path.join(d, e.name), depth - 1);
    }
  };
  walk(root, 5);
  return hits;
}

const appRoots = findAppRoots(WS_ROOT);
if (appRoots.length) {
  const prefer =
    appRoots.find((r) => r.includes(`${path.sep}builder${path.sep}`)) ||
    appRoots[0];
  fs.writeFileSync(
    path.join(SCRATCH, "react-app-listing.txt"),
    [prefer, ...listTree(prefer, 4)].join("\n"),
  );
  const dest = path.join(deliveryDir, "react-landing-starter");
  fs.mkdirSync(dest, { recursive: true });
  for (const f of [
    "package.json",
    "index.html",
    "vite.config.js",
    "vite.config.ts",
  ]) {
    const src = path.join(prefer, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, f));
  }
  if (fs.existsSync(path.join(prefer, "src"))) {
    fs.cpSync(path.join(prefer, "src"), path.join(dest, "src"), {
      recursive: true,
    });
  }
}

// node-config dump from final agents
const input = nodes.find((n) => n.data?.kind === "input");
const nodeConfig = {
  workflowId: "software-company",
  runtime: "Live Codex",
  model: "gpt-5.6-luna",
  effort: "low",
  mission: input?.data?.output || "",
  agents: AGENT_IDS.map((id) => ({
    id,
    model: agentMap[id].data.model,
    effort: agentMap[id].data.effort,
    threadId: agentMap[id].data.threadId,
    status: agentMap[id].data.status,
    summary: String(agentMap[id].data.output || "").slice(0, 200),
  })),
  allAgentsUseLunaLow: AGENT_IDS.every(
    (id) =>
      String(agentMap[id].data.model).toLowerCase().includes("luna") &&
      agentMap[id].data.effort === "low",
  ),
  allAgentsLiveThread: AGENT_IDS.every(
    (id) => !isDemoThread(agentMap[id].data.threadId),
  ),
  runId: hit.id,
  launchIso,
  source: "scripts/desktop-live-evidence.mjs",
  updatedAt: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(SCRATCH, "node-config.json"),
  JSON.stringify(nodeConfig, null, 2),
);

const bundle = {
  source: "scripts/desktop-live-evidence.mjs",
  runId: hit.id,
  status: hit.status,
  createdAt: hit.created_at,
  launchIso,
  eventCount: events.length,
  freshByNode,
  revisionSignals,
  hasLiveRevisionStart,
  agents: nodeConfig.agents,
  reactAppRoots: appRoots,
  at: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(deliveryDir, "delivery-bundle.json"),
  JSON.stringify(bundle, null, 2),
);
fs.writeFileSync(
  path.join(SCRATCH, "run-summary.json"),
  JSON.stringify(bundle, null, 2),
);

// Health snippet append
fs.appendFileSync(
  path.join(SCRATCH, "codex-health.log"),
  `\n=== evidence harvest ${new Date().toISOString()} ===\n` +
    `runId=${hit.id}\nstatus=${hit.status}\nevents=${events.length}\n` +
    `liveThreads=${AGENT_IDS.map((id) => id + ":" + agentMap[id].data.threadId).join(", ")}\n` +
    `revisionLive=${hasLiveRevisionStart}\n`,
);

log(
  `PASS run=${hit.id} liveAgents=${AGENT_IDS.length} events=${events.length} revisionLive=${hasLiveRevisionStart}`,
);
console.log(JSON.stringify({ ok: true, ...bundle }, null, 2));
process.exit(0);

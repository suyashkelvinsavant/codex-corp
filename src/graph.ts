import type { FlowEdge, FlowNode, ValidationProblem } from "./model";
import { isSpecialistKind } from "./model";
import { validateConditionRule } from "./condition-rules";
import { isValidCronExpression } from "./cron-trigger";

const executable = (node: FlowNode) => node.data.kind !== "note";

export function upstreamLineage(
  nodeId: string,
  edges: FlowEdge[],
): Set<string> {
  const seen = new Set<string>(nodeId ? [nodeId] : []);
  const visit = (id: string) => {
    for (const edge of edges) {
      if (edge.target !== id || edge.data?.edgeType === "revision") continue;
      if (!seen.has(edge.source)) {
        seen.add(edge.source);
        visit(edge.source);
      }
    }
  };
  if (nodeId) visit(nodeId);
  return seen;
}

export function standardCycle(edges: FlowEdge[]): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.data?.edgeType === "revision") continue;
    adjacency.set(edge.source, [
      ...(adjacency.get(edge.source) ?? []),
      edge.target,
    ]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const id of adjacency.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

export function validateWorkflow(
  nodes: FlowNode[],
  edges: FlowEdge[],
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const inputs = nodes.filter((node) => node.data.kind === "input");
  const outputs = nodes.filter((node) => node.data.kind === "output");
  const cronTriggers = nodes.filter((node) => node.data.kind === "cron");
  if (!inputs.length)
    problems.push({
      id: "missing-input",
      severity: "error",
      message: "Add at least one Input node.",
    });
  if (!outputs.length)
    problems.push({
      id: "missing-output",
      severity: "error",
      message: "Add at least one Output node.",
    });

  for (const node of nodes) {
    if (node.data.kind === "cron") {
      if (!isValidCronExpression(node.data.cronExpression ?? "")) {
        problems.push({
          id: `cron-expression-${node.id}`,
          severity: "error",
          nodeId: node.id,
          message: `${node.data.label} needs a valid five-field cron expression.`,
        });
      }
      const targets = edges
        .filter((edge) => edge.source === node.id)
        .map((edge) => byId.get(edge.target));
      if (!targets.some((target) => target?.data.kind === "input")) {
        problems.push({
          id: `cron-input-${node.id}`,
          severity: "error",
          nodeId: node.id,
          message: `${node.data.label} must connect to an Input node.`,
        });
      }
    }
    if (node.data.kind !== "condition") continue;
    for (const [index, message] of validateConditionRule(
      node.data.conditionRule,
    ).entries()) {
      problems.push({
        id: `condition-rule-${node.id}-${index}`,
        severity: "error",
        nodeId: node.id,
        message,
      });
    }
    const inbound = edges.filter(
      (edge) => edge.target === node.id && edge.data?.edgeType !== "revision",
    );
    if (inbound.length > 1 && !node.data.conditionRule?.sourceNodeId) {
      problems.push({
        id: `condition-source-${node.id}`,
        severity: "error",
        nodeId: node.id,
        message:
          "Conditions with multiple upstream nodes require an explicit source node.",
      });
    }
  }

  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      problems.push({
        id: `dangling-${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message: "Edge references a missing node.",
      });
    }
    if (edge.source === edge.target) {
      problems.push({
        id: `self-${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message: "Self-connections are not allowed.",
      });
    }
    if (
      edge.data?.edgeType === "revision" &&
      !(edge.data.maxRevisions && edge.data.maxRevisions > 0)
    ) {
      problems.push({
        id: `revision-limit-${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message: "Revision edges require a positive limit.",
      });
    }
    if (edge.data?.edgeType === "conditional" && !edge.data.condition?.trim()) {
      problems.push({
        id: `condition-${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message: "Conditional edges require a result condition.",
      });
    }
    for (const [field, path] of Object.entries(edge.data?.mapping ?? {})) {
      if (!field.trim() || !path.startsWith("$.")) {
        problems.push({
          id: `mapping-${edge.id}-${field}`,
          severity: "error",
          edgeId: edge.id,
          message:
            "Edge field mappings must use non-empty fields and $. paths.",
        });
      }
    }
    const target = byId.get(edge.target);
    if (
      edge.data?.edgeType === "approval" &&
      target?.data.kind !== "approval"
    ) {
      problems.push({
        id: `approval-target-${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message: "Approval edges must terminate at an Approval node.",
      });
    }
    if (edge.data?.edgeType === "merge" && target?.data.kind !== "merge") {
      problems.push({
        id: `merge-target-${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message: "Merge dependencies must terminate at a Merge node.",
      });
    }
    if (
      edge.data?.edgeType === "revision" &&
      target &&
      !isSpecialistKind(target.data.kind)
    ) {
      problems.push({
        id: `revision-target-${edge.id}`,
        severity: "error",
        edgeId: edge.id,
        message:
          "Revision feedback must return to an Agent or Creative Studio node.",
      });
    }
  }

  for (const node of nodes.filter(executable)) {
    const inbound = edges.some((edge) => edge.target === node.id);
    const outbound = edges.some((edge) => edge.source === node.id);
    if (
      node.data.kind === "input" || node.data.kind === "cron"
        ? !outbound
        : node.data.kind === "output"
          ? !inbound
          : !inbound || !outbound
    ) {
      problems.push({
        id: `disconnected-${node.id}`,
        severity: "error",
        nodeId: node.id,
        message: `${node.data.label} is disconnected from an executable path.`,
      });
    }
    if (isSpecialistKind(node.data.kind) && !node.data.prompt.trim()) {
      problems.push({
        id: `prompt-${node.id}`,
        severity: "error",
        nodeId: node.id,
        message: `${node.data.label} needs instructions.`,
      });
    }
    if (isSpecialistKind(node.data.kind) && !node.data.model.trim()) {
      problems.push({
        id: `model-${node.id}`,
        severity: "error",
        nodeId: node.id,
        message: `${node.data.label} needs a Codex model (Config → Model, or Refresh models).`,
      });
    }
    for (const [label, schema] of [
      ["input", node.data.inputSchema],
      ["output", node.data.outputSchema],
    ] as const) {
      if (!schema) continue;
      try {
        const parsed = JSON.parse(schema);
        if (!parsed || parsed.type !== "object") throw new Error();
      } catch {
        problems.push({
          id: `${label}-schema-${node.id}`,
          severity: "error",
          nodeId: node.id,
          message: `${node.data.label} has an invalid ${label} JSON Schema.`,
        });
      }
    }
  }

  const cycle = standardCycle(edges);
  if (cycle)
    problems.push({
      id: "standard-cycle",
      severity: "error",
      message: `Standard cycle detected: ${cycle.join(" → ")}. Use a bounded revision edge instead.`,
    });

  if (inputs.length && outputs.length) {
    const reachable = new Set(
      (cronTriggers.length ? cronTriggers : inputs).map((node) => node.id),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges.filter(
        (edge) => edge.data?.edgeType !== "revision",
      )) {
        if (reachable.has(edge.source) && !reachable.has(edge.target)) {
          reachable.add(edge.target);
          changed = true;
        }
      }
    }
    for (const output of outputs)
      if (!reachable.has(output.id)) {
        problems.push({
          id: `unreachable-${output.id}`,
          severity: "error",
          nodeId: output.id,
          message: `${output.data.label} is not reachable from an Input node.`,
        });
      }
  }
  return problems;
}

export function readyNodeIds(
  nodes: FlowNode[],
  edges: FlowEdge[],
  completed: Set<string>,
  skipped = new Set<string>(),
): string[] {
  return nodes
    .filter((node) => {
      if (
        !executable(node) ||
        completed.has(node.id) ||
        skipped.has(node.id) ||
        node.data.kind === "input" ||
        node.data.kind === "cron"
      )
        return false;
      const inbound = edges.filter(
        (edge) => edge.target === node.id && edge.data?.edgeType !== "revision",
      );
      return (
        inbound.length > 0 &&
        inbound.every(
          (edge) => completed.has(edge.source) || skipped.has(edge.source),
        )
      );
    })
    .map((node) => node.id);
}

/** Approximate on-canvas card size — used so edges have room to arc outside nodes. */
const LAYOUT_NODE_WIDTH = 286;
const LAYOUT_NODE_HEIGHT = 140;
const LAYOUT_COL_GAP = 96;
const LAYOUT_ROW_GAP = 72;
/** Extra gap between a revision pair stacked in the same column. */
const LAYOUT_LOOP_GAP = 56;
const LAYOUT_ORIGIN_X = 56;
const LAYOUT_ORIGIN_Y = 64;

const isForwardEdge = (edge: FlowEdge) => edge.data?.edgeType !== "revision";

function median(values: number[]): number {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Layered auto-layout with co-column revision / feedback stacks:
 * 1. Union revision pairs and any forward-edge SCCs (design loops) into stacks
 * 2. Longest-path columns on the *stack DAG* (never unbounded — cycles are stacked)
 * 3. Barycenter ordering for remaining crossings
 * 4. Vertical packing so cards never overlap
 *
 * RCA note: a previous `while (changed)` depth-push assumed forward edges form a
 * DAG. Standard-edge cycles (e.g. designer ↔ creative) made that loop diverge
 * and freeze the UI on Auto layout.
 */
export function autoLayout(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
  if (!nodes.length) return nodes;

  const ids = nodes.map((node) => node.id);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const idSet = new Set(ids);
  const forward = edges.filter(
    (edge) =>
      isForwardEdge(edge) &&
      idSet.has(edge.source) &&
      idSet.has(edge.target) &&
      edge.source !== edge.target,
  );
  const revisions = edges.filter(
    (edge) =>
      edge.data?.edgeType === "revision" &&
      idSet.has(edge.source) &&
      idSet.has(edge.target) &&
      edge.source !== edge.target,
  );

  // Union-find: revision pairs + forward SCCs share a vertical stack / column.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const id of ids) parent.set(id, id);
  for (const edge of revisions) union(edge.source, edge.target);

  // Kosaraju SCC on forward graph — multi-node components are design loops.
  const layoutIds = ids.filter((id) => byId.get(id)?.data.kind !== "note");
  const fwdAdj = new Map<string, string[]>();
  const revAdj = new Map<string, string[]>();
  for (const id of layoutIds) {
    fwdAdj.set(id, []);
    revAdj.set(id, []);
  }
  for (const edge of forward) {
    if (!fwdAdj.has(edge.source) || !fwdAdj.has(edge.target)) continue;
    fwdAdj.get(edge.source)!.push(edge.target);
    revAdj.get(edge.target)!.push(edge.source);
  }
  const order: string[] = [];
  const seen1 = new Set<string>();
  const dfs1 = (id: string) => {
    if (seen1.has(id)) return;
    seen1.add(id);
    for (const next of fwdAdj.get(id) ?? []) dfs1(next);
    order.push(id);
  };
  for (const id of layoutIds) dfs1(id);
  const seen2 = new Set<string>();
  const dfs2 = (id: string, bucket: string[]) => {
    if (seen2.has(id)) return;
    seen2.add(id);
    bucket.push(id);
    for (const next of revAdj.get(id) ?? []) dfs2(next, bucket);
  };
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (seen2.has(id)) continue;
    const component: string[] = [];
    dfs2(id, component);
    if (component.length > 1) {
      for (let j = 1; j < component.length; j++)
        union(component[0], component[j]);
    }
  }

  const rebuildStacks = () => {
    const map = new Map<string, string[]>();
    for (const id of layoutIds) {
      const root = find(id);
      const list = map.get(root) ?? [];
      list.push(id);
      map.set(root, list);
    }
    return map;
  };
  let stackMembers = rebuildStacks();

  // --- Column assignment on the stack condensation DAG (cycle-safe) ---
  const stackRoots = [...stackMembers.keys()];
  const stackPred = new Map<string, Set<string>>();
  for (const root of stackRoots) stackPred.set(root, new Set());
  const layoutIdSet = new Set(layoutIds);
  for (const edge of forward) {
    if (!layoutIdSet.has(edge.source) || !layoutIdSet.has(edge.target))
      continue;
    const a = find(edge.source);
    const b = find(edge.target);
    if (a === b) continue; // intra-stack wire (loop / revision vertical)
    stackPred.get(b)!.add(a);
  }

  const stackDepthMemo = new Map<string, number>();
  const stackDepthOf = (root: string, seen = new Set<string>()): number => {
    if (stackDepthMemo.has(root)) return stackDepthMemo.get(root)!;
    if (seen.has(root)) return 0; // residual cycle: pin and continue
    seen.add(root);
    const preds = [...(stackPred.get(root) ?? [])];
    const value = preds.length
      ? 1 + Math.max(...preds.map((p) => stackDepthOf(p, new Set(seen))))
      : 0;
    stackDepthMemo.set(root, value);
    return value;
  };
  for (const root of stackRoots) stackDepthOf(root);

  const depth = new Map<string, number>();
  for (const [root, members] of stackMembers) {
    const col = stackDepthMemo.get(root) ?? 0;
    for (const id of members) depth.set(id, col);
  }

  // Compact columns to 0..n-1 (drop empties).
  const usedCols = [
    ...new Set([...depth.values()].filter((value) => Number.isFinite(value))),
  ].sort((a, b) => a - b);
  const colMap = new Map(usedCols.map((col, index) => [col, index]));
  for (const [id, col] of depth) {
    depth.set(id, colMap.get(col) ?? 0);
  }

  const columnCount =
    Math.max(0, ...[...depth.values()], 0) + (depth.size ? 1 : 0);
  const layers: string[][] = Array.from({ length: columnCount }, () => []);

  const seedOrder = layoutIds;
  for (const id of seedOrder) {
    layers[depth.get(id) ?? 0]?.push(id);
  }
  // Refresh stack map after any path compression from find() during depth pass.
  stackMembers = rebuildStacks();

  // --- 3. Order within each column ---
  // Revision stack order: target above source (and transitive for multi-node stacks).
  // Prefer forward topological order inside a stack, then barycenter vs neighbors.
  const mustAbove = new Map<string, Set<string>>(); // id -> nodes that must be above id
  for (const edge of revisions) {
    // target must be above source
    const set = mustAbove.get(edge.source) ?? new Set();
    set.add(edge.target);
    mustAbove.set(edge.source, set);
  }
  // Forward edges inside same stack: source above target (b above c for b→c)
  for (const edge of forward) {
    if (find(edge.source) !== find(edge.target)) continue;
    const set = mustAbove.get(edge.target) ?? new Set();
    set.add(edge.source);
    mustAbove.set(edge.target, set);
  }

  const stackSortKey = (id: string, layer: string[]): number => {
    // Rank = how many stack-mates must sit above this node (approx topo level)
    const mates = new Set(layer.filter((other) => find(other) === find(id)));
    let rank = 0;
    const visit = (nodeId: string, seen: Set<string>) => {
      if (seen.has(nodeId)) return;
      seen.add(nodeId);
      for (const above of mustAbove.get(nodeId) ?? []) {
        if (!mates.has(above)) continue;
        rank += 1;
        visit(above, seen);
      }
    };
    visit(id, new Set());
    return rank;
  };

  const indexInLayer = (layer: string[]) => {
    const map = new Map<string, number>();
    layer.forEach((id, index) => map.set(id, index));
    return map;
  };

  const sortLayer = (
    layer: string[],
    left: string[] | null,
    right: string[] | null,
  ): string[] => {
    if (layer.length <= 1) return layer;
    const leftIndex = left ? indexInLayer(left) : null;
    const rightIndex = right ? indexInLayer(right) : null;

    const scored = layer.map((id, original) => {
      const parentScores = forward
        .filter((edge) => edge.target === id)
        .map((edge) => leftIndex?.get(edge.source))
        .filter((value): value is number => value != null);
      const childScores = forward
        .filter((edge) => edge.source === id)
        .map((edge) => rightIndex?.get(edge.target))
        .filter((value): value is number => value != null);
      const bary = median([...parentScores, ...childScores]);
      return {
        id,
        original,
        stackKey: stackSortKey(id, layer),
        bary,
        // Keep revision stack mates contiguous: group by union root
        group: find(id),
      };
    });

    // Sort primarily by stack-internal order, then barycenter, keep groups tight.
    scored.sort((a, b) => {
      if (a.group === b.group && a.stackKey !== b.stackKey) {
        return a.stackKey - b.stackKey;
      }
      if (a.bary !== b.bary) return a.bary - b.bary;
      if (a.group !== b.group) return a.group.localeCompare(b.group);
      if (a.stackKey !== b.stackKey) return a.stackKey - b.stackKey;
      return a.original - b.original;
    });

    // Ensure every revision constraint inside the layer: target index < source index.
    const ordered = scored.map((item) => item.id);
    for (let pass = 0; pass < ordered.length; pass++) {
      let swapped = false;
      for (const edge of revisions) {
        const si = ordered.indexOf(edge.source);
        const ti = ordered.indexOf(edge.target);
        if (si === -1 || ti === -1) continue;
        if (ti > si) {
          ordered.splice(ti, 1);
          ordered.splice(si, 0, edge.target);
          swapped = true;
        }
      }
      for (const edge of forward) {
        if (find(edge.source) !== find(edge.target)) continue;
        const si = ordered.indexOf(edge.source);
        const ti = ordered.indexOf(edge.target);
        if (si === -1 || ti === -1) continue;
        // source above target inside stack
        if (si > ti) {
          ordered.splice(si, 1);
          ordered.splice(ti, 0, edge.source);
          swapped = true;
        }
      }
      if (!swapped) break;
    }
    return ordered;
  };

  for (let pass = 0; pass < 4; pass++) {
    for (let col = 0; col < layers.length; col++) {
      layers[col] = sortLayer(
        layers[col],
        col > 0 ? layers[col - 1] : null,
        col + 1 < layers.length ? layers[col + 1] : null,
      );
    }
  }

  // --- 4. Coordinates: same column ⇒ same x; stack top-to-bottom ---
  const colStep = LAYOUT_NODE_WIDTH + LAYOUT_COL_GAP;
  const baseRowStep = LAYOUT_NODE_HEIGHT + LAYOUT_ROW_GAP;
  const position = new Map<string, { x: number; y: number }>();

  for (let col = 0; col < layers.length; col++) {
    let y = LAYOUT_ORIGIN_Y;
    const layer = layers[col];
    for (let i = 0; i < layer.length; i++) {
      const id = layer[i];
      const next = layer[i + 1];
      // Extra gap between a revision pair sitting one under the other.
      const pairedWithNext =
        !!next &&
        revisions.some(
          (edge) =>
            (edge.source === next && edge.target === id) ||
            (edge.source === id && edge.target === next) ||
            (find(id) === find(next) && find(id) === find(edge.source)),
        );
      position.set(id, {
        x: LAYOUT_ORIGIN_X + col * colStep,
        y,
      });
      y += baseRowStep + (pairedWithNext ? LAYOUT_LOOP_GAP : 0);
    }
  }

  // Notes under the graph.
  const noteIds = ids.filter((id) => byId.get(id)?.data.kind === "note");
  if (noteIds.length) {
    const maxY = Math.max(
      LAYOUT_ORIGIN_Y,
      ...[...position.values()].map((point) => point.y),
      0,
    );
    noteIds.forEach((id, index) => {
      position.set(id, {
        x: LAYOUT_ORIGIN_X,
        y: maxY + baseRowStep + index * baseRowStep,
      });
    });
  }

  return nodes.map((node) => ({
    ...node,
    position: position.get(node.id) ?? node.position,
  }));
}

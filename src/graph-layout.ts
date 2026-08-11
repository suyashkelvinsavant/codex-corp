import type { FlowEdge, FlowNode } from "./model";

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

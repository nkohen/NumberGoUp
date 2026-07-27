/**
 * Tree decomposition for drawing.
 *
 * An interaction net is not a tree, but it decomposes into A FOREST PLUS A
 * WIRING, which is what lets us reuse the game's tidy binary-tree layout
 * (`src/render/layout.ts`) instead of inventing a force-directed one.
 *
 * The forest comes from the principal ports: agent `A` is a child of agent `B`
 * exactly when `A`'s principal port is wired to one of `B`'s auxiliary ports.
 * Since every agent has exactly one principal port, every agent has at most one
 * parent — so the parent relation is a functional graph, and each connected
 * component is a tree, possibly with one cycle in it. An agent is a ROOT when
 * its principal port is wired to
 *
 *   - a free port,
 *   - another agent's principal port (an active pair), or
 *   - an auxiliary port of one of its own descendants — a cycle, which we break
 *     by demoting that agent to a root and remembering the severed edge as a
 *     BACK-ARC.
 *
 * Everything the forest can't express comes back as an ARC to be drawn as a
 * curve: root-to-root equations, back-arcs, and any wire between two auxiliary
 * ports.
 *
 * Coordinates are abstract (column, depth), exactly like `render/layout.ts` —
 * the renderer maps them into pixels. This module is DOM-free.
 */
import type { TreeNode } from "../core/tree";
import { layoutTree } from "../render/layout";
import {
  aux,
  endpointKey,
  isFree,
  principal,
  type AgentId,
  type Endpoint,
  type Net,
  type PortRef,
  type Sym,
} from "./net";

export interface AgentNode {
  id: AgentId;
  symbol: Sym;
  arity: number;
  col: number;
  depth: number;
  /** Index of the tree this agent belongs to. */
  tree: number;
  /** The aux port this agent hangs from, or null if it is a root. */
  parent: { id: AgentId; aux: number } | null;
}

/**
 * The visible end of a wire that leaves the forest: an aux port with no child
 * under it, or a root's principal port. A stub gets a position of its own so
 * the tidy layout reserves space for the wire even when nothing hangs there.
 */
export interface Stub {
  port: PortRef;
  col: number;
  depth: number;
  tree: number;
  /** The wire leaves upward out of the bubble (true only for root principals). */
  up: boolean;
  /** The free port this wire ends at, or null when it continues to an arc. */
  freeId: number | null;
}

export type ArcKind =
  /** Two roots wired principal-to-principal: an active pair. */
  | "equation"
  /** A cycle we had to break to get a forest. */
  | "back"
  /** Any other wire between two aux ports, within or across trees. */
  | "cross";

export interface Arc {
  a: Endpoint;
  b: Endpoint;
  kind: ArcKind;
}

/** Where a wire end sits, in layout coordinates. */
export interface Anchor {
  col: number;
  depth: number;
  tree: number;
  up: boolean;
  /** The agent this anchor belongs to, or null for a stub/free port. */
  agent: AgentId | null;
}

export interface ForestLayout {
  agents: AgentNode[];
  stubs: Stub[];
  arcs: Arc[];
  /** Parent-to-child wires, drawn as ordinary tree edges. */
  edges: Array<{ parent: AgentId; aux: number; child: AgentId }>;
  /** Wires with an agent at neither end. Legal, and easy to forget about. */
  looseWires: Array<[Endpoint, Endpoint]>;
  /** Position of every wire end, keyed by `endpointKey`. */
  anchors: Map<string, Anchor>;
  trees: number;
  cols: number;
  depths: number;
}

/** Blank columns left between adjacent trees. */
const TREE_GAP = 1;

export function layoutForest(net: Net): ForestLayout {
  const agentList = net.agents().sort((x, y) => x.id - y.id);

  // --- 1. Parent links from principal ports ------------------------------------
  const parentOf = new Map<AgentId, { id: AgentId; aux: number }>();
  for (const a of agentList) {
    const q = net.follow(principal(a.id));
    if (q && !isFree(q) && q.port > 0) parentOf.set(a.id, { id: q.agent, aux: q.port - 1 });
  }

  // --- 2. Break cycles ---------------------------------------------------------
  // Walk upward from every agent. Because each agent has at most one parent, a
  // component contains at most one cycle, and the first walk that enters it
  // finds it. We sever the edge above the highest agent id so the choice is
  // deterministic (and so re-laying-out the same net twice looks the same).
  const backArcs = new Set<AgentId>();
  const settled = new Set<AgentId>();
  for (const start of agentList) {
    if (settled.has(start.id)) continue;
    const path: AgentId[] = [];
    const onPath = new Set<AgentId>();
    let cur: AgentId | undefined = start.id;
    while (cur !== undefined && !settled.has(cur) && !onPath.has(cur)) {
      path.push(cur);
      onPath.add(cur);
      const up: { id: AgentId; aux: number } | undefined = backArcs.has(cur)
        ? undefined
        : parentOf.get(cur);
      cur = up?.id;
    }
    if (cur !== undefined && onPath.has(cur)) {
      const cycle = path.slice(path.indexOf(cur));
      backArcs.add(Math.max(...cycle));
    }
    for (const id of path) settled.add(id);
  }

  // --- 3. Children per aux port ------------------------------------------------
  const childAt = new Map<AgentId, Array<AgentId | undefined>>();
  for (const a of agentList) childAt.set(a.id, new Array(a.arity).fill(undefined));
  for (const [child, p] of parentOf) {
    if (backArcs.has(child)) continue;
    childAt.get(p.id)![p.aux] = child;
  }

  const roots = agentList.filter((a) => !parentOf.has(a.id) || backArcs.has(a.id));

  // --- 4. Lay out each tree with the game's tidy layout ------------------------
  // The tidy layout speaks `TreeNode`, so we hand it a shim: an agent with
  // auxiliary ports becomes an "op" node, an eraser (arity 0) and every stub
  // become leaves. Note this assumes binary agents, which is all the base
  // combinators have.
  const agents: AgentNode[] = [];
  const stubs: Stub[] = [];
  const edges: ForestLayout["edges"] = [];
  const anchors = new Map<string, Anchor>();

  type Shim = { kind: "agent"; id: AgentId } | { kind: "stub"; port: PortRef; up: boolean };
  let colOffset = 0;
  let maxDepth = 0;
  let treeIndex = 0;

  for (const root of roots) {
    const meta = new Map<number, Shim>();
    let nextNodeId = 0;

    const stubNode = (port: PortRef, up: boolean): TreeNode => {
      const id = nextNodeId++;
      meta.set(id, { kind: "stub", port, up });
      return { id, type: "slot" };
    };
    const build = (agentId: AgentId): TreeNode => {
      const id = nextNodeId++;
      meta.set(id, { kind: "agent", id: agentId });
      const agent = net.agent(agentId)!;
      if (agent.arity === 0) return { id, type: "value", value: 0 };
      const kids = childAt.get(agentId)!;
      const branch = (i: number): TreeNode => {
        const child = kids[i];
        return child === undefined ? stubNode(aux(agentId, i), false) : build(child);
      };
      // Arity is 2 for every base combinator that has aux ports.
      return { id, type: "op", op: "+", left: branch(0), right: branch(1) };
    };

    const shimRoot = build(root.id);
    const lay = layoutTree(shimRoot);

    for (const [nodeId, info] of meta) {
      const nl = lay.nodes.get(nodeId)!;
      const col = colOffset + nl.col;
      maxDepth = Math.max(maxDepth, nl.depth);
      if (info.kind === "agent") {
        const agent = net.agent(info.id)!;
        const parent = backArcs.has(info.id) ? null : (parentOf.get(info.id) ?? null);
        agents.push({
          id: info.id,
          symbol: agent.symbol,
          arity: agent.arity,
          col,
          depth: nl.depth,
          tree: treeIndex,
          parent,
        });
        anchors.set(endpointKey(principal(info.id)), {
          col,
          depth: nl.depth,
          tree: treeIndex,
          up: true,
          agent: info.id,
        });
        if (parent) edges.push({ parent: parent.id, aux: parent.aux, child: info.id });
      } else {
        const partner = net.follow(info.port);
        const freeId = partner && isFree(partner) ? partner.free : null;
        stubs.push({ port: info.port, col, depth: nl.depth, tree: treeIndex, up: false, freeId });
        const anchor: Anchor = { col, depth: nl.depth, tree: treeIndex, up: false, agent: null };
        anchors.set(endpointKey(info.port), anchor);
        if (freeId !== null) anchors.set(`f${freeId}`, anchor);
      }
    }

    // A root's principal port leaves upward out of the top of the bubble.
    const rootPartner = net.follow(principal(root.id));
    if (rootPartner && isFree(rootPartner)) {
      const at = anchors.get(endpointKey(principal(root.id)))!;
      stubs.push({
        port: principal(root.id),
        col: at.col,
        depth: at.depth,
        tree: treeIndex,
        up: true,
        freeId: rootPartner.free,
      });
      anchors.set(`f${rootPartner.free}`, { ...at, agent: null, up: true });
    }

    colOffset += lay.cols + TREE_GAP;
    treeIndex++;
  }

  // --- 5. Everything the forest could not express ------------------------------
  const arcs: Arc[] = [];
  const looseWires: ForestLayout["looseWires"] = [];
  const isTreeEdge = new Set<string>();
  for (const e of edges) {
    isTreeEdge.add(endpointKey(aux(e.parent, e.aux)));
    isTreeEdge.add(endpointKey(principal(e.child)));
  }

  for (const [a, b] of net.wires()) {
    const aFree = isFree(a);
    const bFree = isFree(b);
    if (aFree && bFree) {
      looseWires.push([a, b]);
      continue;
    }
    if (aFree || bFree) continue; // drawn as a stub
    if (isTreeEdge.has(endpointKey(a)) && isTreeEdge.has(endpointKey(b))) continue;
    const aPrincipal = !aFree && a.port === 0;
    const bPrincipal = !bFree && b.port === 0;
    const kind: ArcKind =
      aPrincipal && bPrincipal ? "equation" : aPrincipal || bPrincipal ? "back" : "cross";
    arcs.push({ a, b, kind });
  }

  return {
    agents,
    stubs,
    arcs,
    edges,
    looseWires,
    anchors,
    trees: treeIndex,
    cols: Math.max(1, colOffset - TREE_GAP),
    depths: maxDepth + 1,
  };
}

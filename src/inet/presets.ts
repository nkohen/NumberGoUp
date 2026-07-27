/**
 * Canned starting nets for the sandbox and the tests.
 *
 * Each preset is a `build()` that returns a fresh, well-formed net, so callers
 * can reduce one destructively and rebuild it.
 */
import { aux, Net, principal, type AgentId, type Sym } from "./net";

export interface Preset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  build(): Net;
}

/**
 * A complete binary tree of `symbol` agents of the given depth (depth 0 is a
 * single agent). Children hang off their parent's aux ports by their principal
 * ports; the root's principal port and all the leaves' aux ports stay free.
 */
function buildTree(net: Net, symbol: Sym, depth: number): AgentId {
  const agent = net.addAgentWired(symbol);
  if (depth > 0) {
    for (let i = 0; i < agent.arity; i++) {
      const child = buildTree(net, symbol, depth - 1);
      net.link(aux(agent.id, i), principal(child));
    }
  }
  return agent.id;
}

/** Two agents wired principal-to-principal, everything else free. */
function redex(net: Net, a: Sym, b: Sym): [AgentId, AgentId] {
  const x = net.addAgentWired(a);
  const y = net.addAgentWired(b);
  net.link(principal(x.id), principal(y.id));
  return [x.id, y.id];
}

export const PRESETS: readonly Preset[] = [
  {
    id: "commute",
    name: "γδ bloom",
    description:
      "The smallest commutation: one constructor meets one duplicator and the pair blooms into four agents.",
    build() {
      const net = new Net();
      redex(net, "γ", "δ");
      return net;
    },
  },
  {
    id: "annihilate",
    name: "γγ annihilation",
    description:
      "The smallest annihilation: two constructors meet, vanish, and thread their aux wires straight through.",
    build() {
      const net = new Net();
      redex(net, "γ", "γ");
      return net;
    },
  },
  {
    id: "dup-tree",
    name: "δ duplicates a tree",
    description:
      "A duplicator meets the root of a 7-agent constructor tree and copies it, one interaction at a time.",
    build() {
      const net = new Net();
      const root = buildTree(net, "γ", 2);
      const dup = net.addAgentWired("δ");
      net.link(principal(dup.id), principal(root));
      return net;
    },
  },
  {
    id: "erase-tree",
    name: "ε eats a tree",
    description:
      "An eraser meets a 15-agent constructor tree. Each interaction splits the eraser in two — a wave that consumes the tree from the root down.",
    build() {
      const net = new Net();
      const root = buildTree(net, "γ", 3);
      const era = net.addAgentWired("ε");
      net.link(principal(era.id), principal(root));
      return net;
    },
  },
  {
    id: "wide",
    name: "wide front",
    description:
      "Eight independent γδ redexes side by side — maximum simultaneous activity, minimum depth.",
    build() {
      const net = new Net();
      for (let i = 0; i < 8; i++) redex(net, "γ", "δ");
      return net;
    },
  },
  {
    id: "double-dup",
    name: "two duplicators, one tree",
    description:
      "Two duplicators stacked on the same constructor tree: the first copy is still being made while the second starts copying it.",
    build() {
      const net = new Net();
      const root = buildTree(net, "γ", 2);
      const inner = net.addAgentWired("δ");
      const outer = net.addAgentWired("δ");
      net.link(principal(inner.id), principal(root));
      net.link(principal(outer.id), aux(inner.id, 0));
      return net;
    },
  },
  {
    id: "loops",
    name: "closed wires",
    description:
      "A γγ annihilation whose aux ports are wired to each other. Both agents vanish and leave two closed, agent-free loops behind — legal, inert, and the thing naive implementations crash on.",
    build() {
      const net = new Net();
      const [x, y] = redex(net, "γ", "γ");
      net.link(aux(x, 0), aux(y, 0));
      net.link(aux(x, 1), aux(y, 1));
      return net;
    },
  },
  {
    id: "diverge",
    name: "never normalizes",
    description:
      "A γδ redex with both aux ports cross-wired. Every commutation reproduces the same shape twice over, so this one runs until it exhausts fuel.",
    build() {
      const net = new Net();
      const [x, y] = redex(net, "γ", "δ");
      net.link(aux(x, 0), aux(y, 0));
      net.link(aux(x, 1), aux(y, 1));
      return net;
    },
  },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

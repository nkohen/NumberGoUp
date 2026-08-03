/**
 * The hand-authored levels for the "clear the net" demo.
 *
 * Every `par` here was produced by the solver, not by guesswork, and
 * `tests/inet/solver.test.ts` re-derives all of them — so if a level is edited
 * into something unsolvable, or its intended lesson stops being the cheapest
 * line, the suite goes red.
 *
 * The progression is a teaching order, not a difficulty curve: each level is
 * built to make exactly one property of the rewrite rules unavoidable.
 */
import { aux, Net, principal, type AgentId, type Sym } from "./net";
import { agentCard, WIRE_CARD, type Card, type LevelDef } from "./level";

/** A chain of agents hanging off each other's first aux port. */
function chain(net: Net, symbols: Sym[]): AgentId[] {
  const ids = symbols.map((s) => net.addAgentWired(s).id);
  for (let i = 1; i < ids.length; i++) net.link(aux(ids[i - 1], 0), principal(ids[i]));
  return ids;
}

const G = agentCard("γ");
const D = agentCard("δ");
const E = agentCard("ε");
const W = WIRE_CARD;

export const LEVELS: readonly LevelDef[] = [
  {
    id: "mirror",
    name: "Mirror",
    teaches: "Two agents of the SAME symbol annihilate. Meet it with its own kind.",
    build() {
      const net = new Net();
      net.addAgentWired("γ");
      return net;
    },
    hand: [G, E, E, E] as Card[],
    par: 1,
  },
  {
    id: "flamethrower",
    name: "Flamethrower",
    teaches:
      "ε erases anything — but erasing a two-port agent leaves an ε on each of its wires. Erasure does not clean up after itself.",
    build() {
      const net = new Net();
      net.addAgentWired("γ");
      return net;
    },
    hand: [E, E, E] as Card[],
    par: 3,
  },
  {
    id: "fold",
    name: "Fold",
    teaches:
      "A wire card joins two loose ends, so one erasure wave splits and meets ITSELF head-on. Two erasers that meet annihilate.",
    build() {
      const net = new Net();
      net.addAgentWired("γ");
      return net;
    },
    hand: [W, E] as Card[],
    par: 2,
  },
  {
    id: "wrong-kind",
    name: "Wrong Kind",
    teaches:
      "No γ in hand. δ against γ does not annihilate — it COMMUTES, and four agents stand where two did. Sometimes that is still the move.",
    build() {
      const net = new Net();
      chain(net, ["γ", "γ"]);
      return net;
    },
    hand: [D, E, W, W] as Card[],
    par: 4,
  },
  {
    id: "stack",
    name: "Stack",
    teaches: "Only the exposed principal port can be attacked. Work down from the top.",
    build() {
      const net = new Net();
      chain(net, ["γ", "γ", "γ"]);
      return net;
    },
    hand: [G, G, G, W, W] as Card[],
    par: 3,
  },
  {
    id: "copycat",
    name: "Copycat",
    teaches: "A δ in the enemy net copies whatever you feed it. Feed it something it annihilates with.",
    build() {
      const net = new Net();
      chain(net, ["δ", "γ"]);
      return net;
    },
    hand: [D, G, E, W] as Card[],
    par: 2,
  },
  {
    id: "pair",
    name: "Facing Pair",
    teaches:
      "This one is already reacting, and stepping it makes it BIGGER. You cannot refuse — but you can decide what is waiting when it lands.",
    build() {
      const net = new Net();
      const a = net.addAgentWired("γ");
      const b = net.addAgentWired("δ");
      net.link(principal(a.id), principal(b.id));
      return net;
    },
    hand: [E, E, W, W] as Card[],
    par: 2,
  },
  {
    id: "knot",
    name: "Knot",
    teaches: "Everything at once. Mind which wires lead to a principal port.",
    build() {
      const net = new Net();
      const ids = chain(net, ["γ", "δ", "γ", "γ"]);
      net.link(aux(ids[0], 1), aux(ids[2], 1));
      return net;
    },
    hand: [G, G, D, E, W, W] as Card[],
    par: 4,
  },
];

export function levelById(id: string): LevelDef | undefined {
  return LEVELS.find((l) => l.id === id);
}

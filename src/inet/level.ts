/**
 * The "clear the net" game layer.
 *
 * A level is an ENEMY NET with some free wires. The player has a hand of cards
 * and wins by reducing the net to ZERO AGENTS. Leftover wiring and closed loops
 * are fine — the goal is that nothing is left that can compute.
 *
 * Two card types, which is the whole action space:
 *
 *   AGENT CARD (γ, δ, ε)  plugs into a free wire, principal port first.
 *   WIRE CARD             splices two free wires into one.
 *
 * Three things about that action space are what make this a game rather than a
 * sequence of obvious moves, and all three come straight from the rewrite rules:
 *
 *  - Plugging a card in only starts a reaction if the wire leads to a PRINCIPAL
 *    port. A wire that leads to an aux port is inert — you can build there, but
 *    nothing happens. So the enemy's interface is its attack surface.
 *  - Matching the symbol ANNIHILATES (cheap, surgical, no fallout), while ε
 *    ERASES (broad, but every erased binary agent spawns two more erasers that
 *    have to go somewhere). Erasure does not clean up after itself: it strands
 *    an ε on every free wire it reaches. Wire cards are how you make two erasure
 *    waves meet head-on so they annihilate instead.
 *  - γ and δ each bring two new free wires with them; ε brings none. The
 *    interface is a resource you open and close.
 *
 * Pure and DOM-free.
 */
import { symbolDef, type Alphabet } from "./alphabet";
import { isFree, Net, principal, type Sym } from "./net";
import { activePairs, reduce, step, type ActivePair } from "./reduce";

export type Card = { readonly kind: "agent"; readonly symbol: Sym } | { readonly kind: "wire" };

export function agentCard(symbol: Sym): Card {
  return { kind: "agent", symbol };
}

export const WIRE_CARD: Card = { kind: "wire" };

export function cardLabel(card: Card): string {
  return card.kind === "wire" ? "⌇" : card.symbol;
}

/** Tooltip for a card, taken from the alphabet so new symbol sets describe
 *  themselves rather than needing the UI updated. */
export function cardName(card: Card, alphabet: Alphabet): string {
  if (card.kind === "wire") return "wire — splice two loose ends together";
  const def = symbolDef(alphabet, card.symbol);
  if (!def) return card.symbol;
  return `${def.symbol} ${def.name} (arity ${def.arity})`;
}

export type Move =
  | { readonly kind: "plug"; readonly free: number; readonly symbol: Sym }
  | { readonly kind: "splice"; readonly a: number; readonly b: number };

export function moveLabel(move: Move): string {
  return move.kind === "plug" ? `${move.symbol} → wire ${move.free}` : `wire ${move.a}–${move.b}`;
}

// --- The two actions ---------------------------------------------------------------

/**
 * Play an agent card into a free wire. The new agent's PRINCIPAL port takes the
 * place of the loose end, so it faces whatever was at the far end — which is
 * what may or may not start a reaction.
 */
export function plug(net: Net, freeId: number, symbol: Sym): boolean {
  const far = net.follow({ free: freeId });
  if (!far) return false;
  const agent = net.addAgentWired(symbol);
  net.link(principal(agent.id), far);
  return true;
}

/**
 * Play a wire card: join two loose ends. A free port is one END of a wire, so
 * this splices the two wires into a single one and both free ports disappear
 * with the halves they belonged to.
 */
export function splice(net: Net, a: number, b: number): boolean {
  if (a === b) return false;
  const fa = net.follow({ free: a });
  const fb = net.follow({ free: b });
  if (!fa || !fb) return false;
  net.link(fa, fb);
  return true;
}

export function applyMove(net: Net, move: Move): boolean {
  return move.kind === "plug" ? plug(net, move.free, move.symbol) : splice(net, move.a, move.b);
}

/** The card a move spends. */
export function cardFor(move: Move): Card {
  return move.kind === "plug" ? agentCard(move.symbol) : WIRE_CARD;
}

/** Every move the current net and the cards in hand allow. */
export function legalMoves(net: Net, hand: readonly Card[]): Move[] {
  const free = net.freePorts();
  const symbols = new Set<Sym>();
  let hasWire = false;
  for (const card of hand) {
    if (card.kind === "wire") hasWire = true;
    else symbols.add(card.symbol);
  }
  const out: Move[] = [];
  for (const f of free) for (const s of symbols) out.push({ kind: "plug", free: f, symbol: s });
  if (hasWire) {
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) out.push({ kind: "splice", a: free[i], b: free[j] });
    }
  }
  return out;
}

/** Remove one matching card from a hand, returning the rest. Null if absent. */
export function spend(hand: readonly Card[], card: Card): Card[] | null {
  const index = hand.findIndex((c) =>
    c.kind === "wire" ? card.kind === "wire" : card.kind === "agent" && c.symbol === card.symbol,
  );
  if (index < 0) return null;
  return [...hand.slice(0, index), ...hand.slice(index + 1)];
}

/** The win condition: nothing left that can compute. */
export function isCleared(net: Net): boolean {
  return net.agentCount === 0;
}

// --- Levels --------------------------------------------------------------------------

export interface LevelDef {
  readonly id: string;
  readonly name: string;
  /** One line shown to the player: what this level is trying to teach. */
  readonly teaches: string;
  readonly build: () => Net;
  readonly hand: readonly Card[];
  /**
   * Fewest cards that clear it. Verified by the solver in
   * `tests/inet/solver.test.ts`, which fails if a level drifts off its par or
   * becomes unsolvable.
   */
  readonly par: number;
}

// --- Playing a level -------------------------------------------------------------------

export interface RunSnapshot {
  net: Net;
  hand: Card[];
  cardsPlayed: number;
  interactions: number;
}

/**
 * A level in progress. Every mutation pushes an undo snapshot — this is a
 * puzzle, and a puzzle without undo is a puzzle you play with a notepad.
 */
export class LevelRun {
  net: Net;
  hand: Card[];
  cardsPlayed = 0;
  interactions = 0;
  private history: RunSnapshot[] = [];

  constructor(readonly level: LevelDef) {
    this.net = level.build();
    this.hand = [...level.hand];
  }

  get cleared(): boolean {
    return isCleared(this.net);
  }

  get redexes(): ActivePair[] {
    return activePairs(this.net);
  }

  /** Nothing left to do and not cleared: the run is lost. */
  get stuck(): boolean {
    if (this.cleared) return false;
    return this.redexes.length === 0 && legalMoves(this.net, this.hand).length === 0;
  }

  get canUndo(): boolean {
    return this.history.length > 0;
  }

  private save(): void {
    this.history.push({
      net: this.net.clone(),
      hand: [...this.hand],
      cardsPlayed: this.cardsPlayed,
      interactions: this.interactions,
    });
  }

  /** Play a card. Returns false (changing nothing) if the move is not legal. */
  play(move: Move): boolean {
    const rest = spend(this.hand, cardFor(move));
    if (!rest) return false;
    this.save();
    if (!applyMove(this.net, move)) {
      this.history.pop();
      return false;
    }
    this.hand = rest;
    this.cardsPlayed++;
    return true;
  }

  /** Fire one redex. Returns false if the net is already in normal form. */
  stepOnce(pair?: ActivePair): boolean {
    const pairs = this.redexes;
    if (pairs.length === 0) return false;
    this.save();
    step(this.net, pair ?? pairs[0]);
    this.interactions++;
    return true;
  }

  /** Reduce to normal form (or until fuel runs out). */
  runToNormalForm(fuel = 2000): boolean {
    if (this.redexes.length === 0) return false;
    this.save();
    const result = reduce(this.net, { fuel });
    this.interactions += result.interactions;
    return !result.fuelExhausted;
  }

  undo(): boolean {
    const previous = this.history.pop();
    if (!previous) return false;
    this.net = previous.net;
    this.hand = previous.hand;
    this.cardsPlayed = previous.cardsPlayed;
    this.interactions = previous.interactions;
    return true;
  }

  reset(): void {
    this.net = this.level.build();
    this.hand = [...this.level.hand];
    this.cardsPlayed = 0;
    this.interactions = 0;
    this.history = [];
  }
}

/**
 * Every agent must be reachable from the interface. An agent inside a component
 * that the free wires cannot reach can never be given a redex, so a level
 * containing one is unwinnable no matter how well it is played.
 */
export function allReachable(net: Net): boolean {
  const seen = new Set<number>();
  const queue: number[] = [];
  const visit = (id: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    queue.push(id);
  };
  for (const f of net.freePorts()) {
    const q = net.follow({ free: f });
    if (q && !isFree(q)) visit(q.agent);
  }
  for (let i = 0; i < queue.length; i++) {
    const agent = net.agent(queue[i]);
    if (!agent) continue;
    for (let port = 0; port <= agent.arity; port++) {
      const q = net.follow({ agent: queue[i], port });
      if (q && !isFree(q)) visit(q.agent);
    }
  }
  return seen.size === net.agentCount;
}

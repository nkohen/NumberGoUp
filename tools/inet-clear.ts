/**
 * SCRATCH — feasibility probe for the "clear the enemy net" game concept.
 * Run: `npx vite-node tools/inet-clear.ts`.
 *
 * The concept: a level is an enemy net with some free wires. The player plugs
 * agents from a deck into those wires and steps the computation, aiming to end
 * with the EMPTY net (zero agents).
 *
 * The questions that decide whether that is a game or a toy:
 *   1. Does plugging ε into everything just win? (Is erasure dominant?)
 *   2. If not, what does it actually take to reach zero?
 *   3. Does the minimum cost VARY between nets — i.e. is there a skill gradient?
 */
import { Rng } from "../src/core/rng";
import { isFree, Net, principal, SYMBOLS, type AgentId, type Sym } from "../src/inet/net";
import { activePairs, reduce } from "../src/inet/reduce";
import { randomNet } from "../src/inet/generate";

// --- The two player actions ------------------------------------------------------

/**
 * Play an agent card into a free wire: the new agent's PRINCIPAL port takes the
 * place of the loose end. Note what this does to the interface — γ and δ each
 * bring two fresh free wires with them, ε brings none.
 */
function plug(net: Net, freeId: number, symbol: Sym): void {
  const far = net.follow({ free: freeId });
  if (!far) return;
  const agent = net.addAgentWired(symbol);
  net.link(principal(agent.id), far);
}

/** Play a wire card: join two loose ends, splicing the two wires into one. */
function splice(net: Net, a: number, b: number): void {
  const fa = net.follow({ free: a });
  const fb = net.follow({ free: b });
  if (!fa || !fb) return;
  net.link(fa, fb);
}

// --- Enemy generation --------------------------------------------------------------

/** Every agent must be reachable from the interface, or it can never be killed. */
function allReachable(net: Net): boolean {
  const seen = new Set<AgentId>();
  const queue: AgentId[] = [];
  for (const f of net.freePorts()) {
    const q = net.follow({ free: f });
    if (q && !isFree(q) && !seen.has(q.agent)) {
      seen.add(q.agent);
      queue.push(q.agent);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const agent = net.agent(queue[i])!;
    for (let p = 0; p <= agent.arity; p++) {
      const q = net.follow({ agent: queue[i], port: p });
      if (q && !isFree(q) && !seen.has(q.agent)) {
        seen.add(q.agent);
        queue.push(q.agent);
      }
    }
  }
  return seen.size === net.agentCount;
}

/** A level: at rest (no redexes), fully reachable, with a workable interface. */
function makeEnemy(seed: number, agents: number): Net | null {
  const net = randomNet(new Rng(seed), agents, { γ: 1, δ: 0.7, ε: 0 }, { wireFraction: 0.62 });
  if (net.agentCount !== agents) return null;
  if (activePairs(net).length > 0) return null; // must start at rest
  if (!allReachable(net)) return null; // unreachable agents = unwinnable
  const free = net.freePorts().length;
  if (free < 2 || free > 7) return null;
  return net;
}

// --- Strategies ----------------------------------------------------------------------

const FUEL = 4000;

interface Outcome {
  cleared: boolean;
  cards: number;
  agentsLeft: number;
  interactions: number;
  diverged: boolean;
}

/** Plug ε into every free wire, reducing between plays. The obvious strategy. */
function epsilonSpam(net: Net): Outcome {
  let cards = 0;
  let interactions = 0;
  for (let guard = 0; guard < 60; guard++) {
    const r = reduce(net, { fuel: FUEL });
    interactions += r.interactions;
    if (r.fuelExhausted) return { cleared: false, cards, agentsLeft: net.agentCount, interactions, diverged: true };
    if (net.agentCount === 0) break;
    const free = net.freePorts();
    if (free.length === 0) break;
    plug(net, free[0], "ε");
    cards++;
  }
  const r = reduce(net, { fuel: FUEL });
  interactions += r.interactions;
  return {
    cleared: net.agentCount === 0,
    cards,
    agentsLeft: net.agentCount,
    interactions,
    diverged: r.fuelExhausted,
  };
}

/** Pair the interface off with wire cards first, then erase what is left. */
function pairThenErase(net: Net): Outcome {
  let cards = 0;
  let interactions = 0;
  for (let guard = 0; guard < 60; guard++) {
    const r = reduce(net, { fuel: FUEL });
    interactions += r.interactions;
    if (r.fuelExhausted) return { cleared: false, cards, agentsLeft: net.agentCount, interactions, diverged: true };
    if (net.agentCount === 0) break;
    const free = net.freePorts();
    if (free.length >= 2) {
      splice(net, free[0], free[1]);
      cards++;
    } else if (free.length === 1) {
      plug(net, free[0], "ε");
      cards++;
    } else break;
  }
  return {
    cleared: net.agentCount === 0,
    cards,
    agentsLeft: net.agentCount,
    interactions,
    diverged: false,
  };
}

// --- Optimal play (iterative deepening over move sequences) --------------------------

interface Move {
  kind: "plug" | "splice";
  a: number;
  b?: number;
  symbol?: Sym;
}

function movesFor(net: Net): Move[] {
  const free = net.freePorts();
  const out: Move[] = [];
  for (const f of free) for (const s of SYMBOLS) out.push({ kind: "plug", a: f, symbol: s });
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) out.push({ kind: "splice", a: free[i], b: free[j] });
  }
  return out;
}

/** Search fuel is low on purpose: a line that has not settled by here has blown
 *  up, and a player would never choose it. */
const SEARCH_FUEL = 300;
const SEARCH_AGENT_CAP = 80;

function apply(net: Net, move: Move): boolean {
  if (move.kind === "plug") plug(net, move.a, move.symbol!);
  else splice(net, move.a, move.b!);
  const r = reduce(net, { fuel: SEARCH_FUEL });
  return !r.fuelExhausted && net.agentCount <= SEARCH_AGENT_CAP;
}

/** Fewest cards to reach the empty net, or null if not found within `maxCards`. */
function minCards(start: Net, maxCards: number): { cards: number; line: Move[] } | null {
  for (let depth = 0; depth <= maxCards; depth++) {
    const seen = new Set<string>();
    const line: Move[] = [];
    const search = (net: Net, left: number): boolean => {
      if (net.agentCount === 0) return true;
      if (left === 0) return false;
      const key = `${left}|${net.signature()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      for (const move of movesFor(net)) {
        const next = net.clone();
        if (!apply(next, move)) continue; // diverged: not a line worth playing
        line.push(move);
        if (search(next, left - 1)) return true;
        line.pop();
      }
      return false;
    };
    const root = start.clone();
    reduce(root, { fuel: SEARCH_FUEL });
    if (search(root, depth)) return { cards: depth, line: [...line] };
  }
  return null;
}

// --- Report ----------------------------------------------------------------------------

function describeMove(m: Move): string {
  return m.kind === "plug" ? `${m.symbol}→f${m.a}` : `wire f${m.a}–f${m.b}`;
}

console.log("Can a net be cleared to the EMPTY program, and what does it cost?\n");

// The smallest possible level, traced by hand first as a sanity check.
{
  const net = new Net();
  net.addAgentWired("γ");
  console.log("-- one γ, all three ports free --");
  const spam = net.clone();
  console.log("   ε into every free wire:", JSON.stringify(epsilonSpam(spam)));
  const paired = net.clone();
  console.log("   pair the interface first:", JSON.stringify(pairThenErase(paired)));
  const best = minCards(net, 4);
  console.log("   optimal:", best ? `${best.cards} cards — ${best.line.map(describeMove).join(", ")}` : "not found");
}

const SIZES = [2, 3, 4];
for (const size of SIZES) {
  const levels: Net[] = [];
  for (let seed = 1; levels.length < 25 && seed < 8000; seed++) {
    const net = makeEnemy(seed * 131, size);
    if (net) levels.push(net);
  }
  if (levels.length === 0) continue;

  let spamCleared = 0;
  let pairCleared = 0;
  let spamLeftover = 0;
  const optima: number[] = [];
  const lines: Move[][] = [];
  let unsolved = 0;

  for (const level of levels) {
    const s = epsilonSpam(level.clone());
    if (s.cleared) spamCleared++;
    else spamLeftover += s.agentsLeft;
    const p = pairThenErase(level.clone());
    if (p.cleared) pairCleared++;
    const best = minCards(level, 3);
    if (best) {
      optima.push(best.cards);
      lines.push(best.line);
    } else unsolved++;
  }

  const histogram = new Map<number, number>();
  for (const o of optima) histogram.set(o, (histogram.get(o) ?? 0) + 1);
  const usage = new Map<string, number>();
  for (const line of lines) {
    for (const m of line) {
      const k = m.kind === "plug" ? m.symbol! : "wire";
      usage.set(k, (usage.get(k) ?? 0) + 1);
    }
  }
  const cardMix = [...usage.entries()].sort().map(([k, v]) => `${k}:${v}`).join("  ");
  const spread = [...histogram.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`);

  console.log(`\n-- ${size}-agent enemies (${levels.length} levels) --`);
  console.log(`   ε-into-everything clears:   ${spamCleared}/${levels.length}` +
    (spamCleared < levels.length ? `   (avg ${(spamLeftover / Math.max(1, levels.length - spamCleared)).toFixed(1)} agents left over)` : ""));
  console.log(`   pair-the-interface clears:  ${pairCleared}/${levels.length}`);
  console.log(`   optimal cards to clear:     ${spread.join("  ")}${unsolved ? `   (${unsolved} need >3)` : ""}`);
  console.log(`   cards used in optimal lines: ${cardMix}`);
}

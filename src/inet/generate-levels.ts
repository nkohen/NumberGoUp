/**
 * Solver-verified level generation, for any alphabet.
 *
 * Hand-authoring a level set for each candidate alphabet is not practical while
 * the alphabets are still changing, and it would not be honest either: the point
 * of trying five rule sets is to feel what a TYPICAL puzzle in each one is like,
 * not what my favourite puzzle in each one is like.
 *
 * So levels are generated and then verified. A candidate enemy has to be
 *
 *   - at rest (no redex already on the board — the player opens the action),
 *   - fully reachable from the interface (an agent the free wires cannot reach
 *     can never be given a redex, so a level containing one is unwinnable),
 *   - small enough to read and to solve exhaustively,
 *
 * and then the solver has to find a line within the hand. Its `par` is whatever
 * the solver actually found, never a guess.
 *
 * Cheap enough to run in the browser at page load for 3-agent enemies; the
 * budget parameters exist so it stays that way.
 */
import { Rng } from "../core/rng";
import type { Alphabet } from "./alphabet";
import { randomNet } from "./generate";
import { allReachable, agentCard, WIRE_CARD, type Card, type LevelDef } from "./level";
import { Net } from "./net";
import { activePairs } from "./reduce";
import { solve } from "./solver";

export interface GenerateOptions {
  /** Agents in the enemy net. 3 is the sweet spot: readable and fast to solve. */
  agents?: number;
  /** Cards offered. Defaults to two of every symbol plus two wires. */
  hand?: Card[];
  /** Only keep levels whose par falls in this range, so the set has a curve. */
  minPar?: number;
  maxPar?: number;
  /** Give up after this many candidate nets. */
  attempts?: number;
}

/** The default hand: two of everything the alphabet has, plus two wire cards. */
export function defaultHand(alphabet: Alphabet): Card[] {
  const cards: Card[] = [];
  for (const def of alphabet.symbols) {
    cards.push(agentCard(def.symbol), agentCard(def.symbol));
  }
  cards.push(WIRE_CARD, WIRE_CARD);
  return cards;
}

/** A candidate enemy net, or null if this seed produced an unusable one. */
export function makeEnemy(alphabet: Alphabet, seed: number, agents: number): Net | null {
  // Nullary symbols are excluded from enemies: a net made of erasers is not a
  // puzzle, it is a pile of things that have already gone off.
  const weights: Record<string, number> = {};
  for (const def of alphabet.symbols) weights[def.symbol] = def.arity === 0 ? 0 : 1;
  const net = randomNet(new Rng(seed), agents, weights, { wireFraction: 0.6 }, alphabet);
  if (net.agentCount !== agents) return null;
  if (activePairs(net).length > 0) return null;
  if (!allReachable(net)) return null;
  const free = net.freePorts().length;
  if (free < 2 || free > 7) return null;
  return net;
}

/**
 * Generate `count` solvable levels for an alphabet, easiest first.
 *
 * The returned `build` closures replay a stored seed rather than capturing a
 * net, so a level can be reset and replayed exactly.
 */
export function generateLevels(
  alphabet: Alphabet,
  count: number,
  seed = 1,
  options: GenerateOptions = {},
): LevelDef[] {
  const agents = options.agents ?? 3;
  const hand = options.hand ?? defaultHand(alphabet);
  const minPar = options.minPar ?? 1;
  const maxPar = options.maxPar ?? 4;
  const attempts = options.attempts ?? 900;

  const found: Array<{ level: LevelDef; par: number }> = [];
  const rng = new Rng(seed);

  for (let i = 0; i < attempts && found.length < count; i++) {
    const netSeed = rng.int(1, 2 ** 30);
    const net = makeEnemy(alphabet, netSeed, agents);
    if (!net) continue;
    const result = solve(net.clone(), hand, { maxCards: maxPar, fuel: 400 });
    const par = result.solution?.cards;
    if (par === undefined || par < minPar || par > maxPar) continue;

    const verbs = new Set(
      result.solution!.line.map((m) => (m.kind === "plug" ? m.symbol : "wire")),
    );
    found.push({
      par,
      level: {
        id: `${alphabet.id}-${found.length + 1}`,
        name: `${alphabet.name} ${found.length + 1}`,
        teaches:
          `${agents} agents, ${net.freePorts().length} loose ends. ` +
          `Solvable in ${par} card${par === 1 ? "" : "s"} using ${[...verbs].join(" ")}.`,
        build: () => makeEnemy(alphabet, netSeed, agents)!,
        hand,
        par,
      },
    });
  }

  // Easiest first, so a set read top-to-bottom has some sort of curve.
  found.sort((a, b) => a.par - b.par);
  return found.map((f, index) => ({
    ...f.level,
    id: `${alphabet.id}-${index + 1}`,
    name: `${alphabet.name} ${index + 1}`,
  }));
}

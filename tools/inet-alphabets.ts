/**
 * Alphabet bake-off. Run: `npx vite-node tools/inet-alphabets.ts`.
 *
 * The complaint this is trying to answer: with γ δ ε the only mechanics that
 * matter are annihilation and erasure, so "clear the net" is always "match it or
 * burn it". An alphabet is better if optimal play has to reach for MORE VERBS.
 *
 * For each alphabet we generate enemy nets, solve them optimally, and measure:
 *
 *   verbs/level      distinct rewrite verbs an optimal line actually triggers.
 *                    This is the headline number — the base alphabet's ceiling
 *                    is 3 and its realised value is what prompted the search.
 *   cards/level      distinct card types an optimal line spends. An alphabet
 *                    where one card dominates is a one-button game.
 *   cascade          interactions per card played. High means a single card
 *                    sets off a chain, which is where the drama is.
 *   solvable         fraction of generated nets that can be cleared at all.
 *                    Too low is a generation problem, too high means the goal
 *                    is not really a constraint.
 *   skill gap        how much worse a greedy "play whatever kills most now"
 *                    policy is than optimal. If greedy ties optimal there is
 *                    nothing to think about.
 */
import { Rng } from "../src/core/rng";
import { ALPHABETS } from "../src/inet/alphabets";
import { lookupRule, type Alphabet } from "../src/inet/alphabet";
import { allReachable, applyMove, cardFor, cardLabel, isCleared, legalMoves, spend, type Card, type Move } from "../src/inet/level";
import { Net } from "../src/inet/net";
import { activePairs, hasRule, reduce, step } from "../src/inet/reduce";
import { randomNet } from "../src/inet/generate";
import { solve } from "../src/inet/solver";

const TRIALS = 60;
const ENEMY_SIZE = 3;
const MAX_CARDS = 4;

/** A hand with a couple of each symbol plus wires — the same shape for every alphabet. */
function handFor(alphabet: Alphabet): Card[] {
  const cards: Card[] = [];
  for (const def of alphabet.symbols) {
    cards.push({ kind: "agent", symbol: def.symbol });
    cards.push({ kind: "agent", symbol: def.symbol });
  }
  cards.push({ kind: "wire" }, { kind: "wire" });
  return cards;
}

/** An enemy net: at rest, fully reachable, with a usable interface. */
function makeEnemy(alphabet: Alphabet, seed: number): Net | null {
  // Erasers are excluded from enemies: a net made of voids is not a puzzle.
  const weights: Record<string, number> = {};
  for (const def of alphabet.symbols) weights[def.symbol] = def.arity === 0 ? 0 : 1;
  const net = randomNet(new Rng(seed), ENEMY_SIZE, weights, { wireFraction: 0.6 }, alphabet);
  if (net.agentCount !== ENEMY_SIZE) return null;
  if (activePairs(net).length > 0) return null;
  if (!allReachable(net)) return null;
  const free = net.freePorts().length;
  if (free < 2 || free > 7) return null;
  return net;
}

/** Which rewrite verbs fire while reducing this net to normal form. */
function verbsWhileReducing(net: Net): string[] {
  const seen: string[] = [];
  let guard = 0;
  while (guard++ < 400) {
    const pairs = activePairs(net).filter((p) => hasRule(net, p));
    if (pairs.length === 0) break;
    const [x, y] = pairs[0];
    const a = net.agent(x)!;
    const b = net.agent(y)!;
    const verb = lookupRule(net.alphabet, a.symbol, b.symbol)?.rule.verb;
    if (verb) seen.push(verb);
    step(net, pairs[0]);
  }
  return seen;
}

interface Play {
  verbs: string[];
  interactions: number;
  cards: number;
  cardKinds: Set<string>;
}

/** Replay a line and record what it actually did. */
function replay(start: Net, line: Move[]): Play {
  const net = start.clone();
  const play: Play = { verbs: [], interactions: 0, cards: line.length, cardKinds: new Set() };
  play.verbs.push(...verbsWhileReducing(net));
  for (const move of line) {
    play.cardKinds.add(cardLabel(cardFor(move)));
    applyMove(net, move);
    const verbs = verbsWhileReducing(net);
    play.verbs.push(...verbs);
    play.interactions += verbs.length;
    if (isCleared(net)) break;
  }
  return play;
}

/** Greedy baseline: play whichever legal card removes the most agents right now. */
function greedy(start: Net, hand: readonly Card[]): number | null {
  let net = start.clone();
  reduce(net, { fuel: 400 });
  let cards: readonly Card[] = hand;
  for (let played = 0; played <= MAX_CARDS; played++) {
    if (isCleared(net)) return played;
    let best: { move: Move; net: Net; rest: readonly Card[]; score: number } | null = null;
    for (const move of legalMoves(net, cards)) {
      const rest = spend(cards, cardFor(move));
      if (!rest) continue;
      const next = net.clone();
      if (!applyMove(next, move)) continue;
      const r = reduce(next, { fuel: 400 });
      if (r.fuelExhausted || next.agentCount > 120) continue;
      const score = net.agentCount - next.agentCount;
      if (!best || score > best.score) best = { move, net: next, rest, score };
    }
    if (!best) return null;
    net = best.net;
    cards = best.rest;
  }
  return isCleared(net) ? MAX_CARDS : null;
}

// --- Run ---------------------------------------------------------------------------------

function pct(n: number, d: number): string {
  return d === 0 ? "  -  " : `${((100 * n) / d).toFixed(0).padStart(3)}%`;
}

console.log("Alphabet bake-off — does optimal play need more than two mechanics?\n");
console.log(`${TRIALS} candidate enemies of ${ENEMY_SIZE} agents each, hand = 2 of every symbol + 2 wires\n`);

const header =
  "alphabet".padEnd(10) +
  "verbs".padStart(7) +
  "used".padStart(7) +
  "cards".padStart(7) +
  "cascade".padStart(9) +
  "solvable".padStart(10) +
  "par".padStart(6) +
  "greedy=opt".padStart(12);
console.log(header);
console.log("-".repeat(header.length));

for (const alphabet of ALPHABETS) {
  const hand = handFor(alphabet);
  const levels: Net[] = [];
  for (let seed = 1; levels.length < TRIALS && seed < 40000; seed++) {
    const net = makeEnemy(alphabet, seed * 977);
    if (net) levels.push(net);
  }

  let solvable = 0;
  const verbsPerLevel: number[] = [];
  const cardsPerLevel: number[] = [];
  const pars: number[] = [];
  const cascades: number[] = [];
  const verbTally = new Map<string, number>();
  let greedyMatches = 0;
  let greedyComparable = 0;

  for (const level of levels) {
    const result = solve(level.clone(), hand, { maxCards: MAX_CARDS, fuel: 400 });
    if (!result.solution) continue;
    solvable++;
    const play = replay(level, result.solution.line);
    const distinctVerbs = new Set(play.verbs);
    for (const v of distinctVerbs) verbTally.set(v, (verbTally.get(v) ?? 0) + 1);
    verbsPerLevel.push(distinctVerbs.size);
    cardsPerLevel.push(play.cardKinds.size);
    pars.push(result.solution.cards);
    cascades.push(play.cards === 0 ? 0 : play.interactions / play.cards);

    const g = greedy(level, hand);
    greedyComparable++;
    if (g !== null && g === result.solution.cards) greedyMatches++;
  }

  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const ruleVerbs = new Set([...alphabet.rules.values()].map((r) => r.verb));

  console.log(
    alphabet.id.padEnd(10) +
      String(ruleVerbs.size).padStart(7) +
      mean(verbsPerLevel).toFixed(2).padStart(7) +
      mean(cardsPerLevel).toFixed(2).padStart(7) +
      mean(cascades).toFixed(2).padStart(9) +
      pct(solvable, levels.length).padStart(10) +
      mean(pars).toFixed(2).padStart(6) +
      pct(greedyMatches, greedyComparable).padStart(12),
  );
  const tally = [...verbTally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([v, n]) => `${v} ${pct(n, solvable).trim()}`)
    .join(", ");
  console.log(`          verbs in optimal lines: ${tally || "(none)"}`);
}

console.log(
  "\nverbs   = distinct rewrite rules the alphabet defines" +
    "\nused    = distinct verbs an optimal line actually triggers (the headline)" +
    "\ncards   = distinct card types an optimal line spends" +
    "\ncascade = interactions per card played" +
    "\ngreedy=opt = how often a greedy policy matches optimal (lower is more skill)",
);

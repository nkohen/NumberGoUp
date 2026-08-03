/**
 * Random search over RULE TABLES. Run: `npx vite-node tools/inet-search.ts`.
 *
 * The hand-designed alphabets in `alphabets.ts` are guesses. This generates
 * random-but-legal rule tables over a fixed symbol set and scores them on the
 * same measures as the bake-off, to find out whether hand-design was actually
 * doing anything — and whether there is a better rule table nobody would think
 * to write.
 *
 * A random rule for α(m) ⋈ β(n) is: pick a multiset of agents to create such
 * that m + n + Σ(arity + 1) is EVEN (the parity constraint — see alphabet.ts),
 * then pair every port up at random. Any perfect matching is a legal rule, so
 * the generator cannot produce something invalid; it can only produce something
 * boring.
 *
 * Score rewards the two things the base alphabet lacks:
 *   - verbs an optimal line has to reach for (base scores 1.14 of 3)
 *   - how often greedy play FAILS to match optimal (base: greedy ties 86%)
 * subject to enough levels being solvable to build a game from.
 */
import { Rng } from "../src/core/rng";
import {
  agentSlot,
  ifaceSlot,
  pairKey,
  lookupRule,
  splitPairKey,
  validateAlphabet,
  type Alphabet,
  type Rule,
  type Slot,
  type Sym,
  type SymbolDef,
} from "../src/inet/alphabet";

import { ALPHABETS } from "../src/inet/alphabets";
import {
  allReachable,
  applyMove,
  cardFor,
  isCleared,
  legalMoves,
  spend,
  type Card,
  type Move,
} from "../src/inet/level";
import { Net } from "../src/inet/net";
import { activePairs, hasRule, reduce, step } from "../src/inet/reduce";
import { randomNet } from "../src/inet/generate";
import { solve } from "../src/inet/solver";

const CANDIDATES = 90;
const LEVELS = 26;
const ENEMY_SIZE = 3;
const MAX_CARDS = 4;

/** Two binary symbols, one unary, one nullary — the shape that has room for the
 *  verbs binary-only alphabets cannot express. */
const SYMBOLS: SymbolDef[] = [
  { symbol: "○", arity: 2, name: "node", color: { a: "#7CF29B", b: "#27B36B", glow: "rgba(124,242,155,0.55)" } },
  { symbol: "□", arity: 2, name: "shell", color: { a: "#7ee6ff", b: "#2b9fd6", glow: "rgba(126,230,255,0.55)" } },
  { symbol: "†", arity: 1, name: "spike", color: { a: "#b79bff", b: "#7a4fe0", glow: "rgba(183,155,255,0.55)" } },
  { symbol: "✕", arity: 0, name: "void", color: { a: "#ff9be0", b: "#d24fb8", glow: "rgba(255,155,224,0.55)" } },
];

const arityOfSym = (s: Sym): number => SYMBOLS.find((d) => d.symbol === s)!.arity;

// --- Random rule generation ---------------------------------------------------------

/** Multisets of created agents (size 0..2) whose parity closes the rule. */
function creationOptions(m: number, n: number): Sym[][] {
  const options: Sym[][] = [];
  const names = SYMBOLS.map((s) => s.symbol);
  const ok = (creates: Sym[]): boolean =>
    (m + n + creates.reduce((t, s) => t + arityOfSym(s) + 1, 0)) % 2 === 0;
  if (ok([])) options.push([]);
  for (const x of names) if (ok([x])) options.push([x]);
  for (const x of names) for (const y of names) if (ok([x, y])) options.push([x, y]);
  return options;
}

function randomRule(rng: Rng, symA: Sym, symB: Sym): Rule | null {
  const m = arityOfSym(symA);
  const n = arityOfSym(symB);
  const options = creationOptions(m, n);
  if (options.length === 0) return null;
  const creates = rng.pick(options);

  const slots: Slot[] = [];
  for (let i = 0; i < m; i++) slots.push(ifaceSlot("a", i));
  for (let i = 0; i < n; i++) slots.push(ifaceSlot("b", i));
  creates.forEach((s, index) => {
    for (let port = 0; port <= arityOfSym(s); port++) slots.push(agentSlot(index, port));
  });
  if (slots.length % 2 !== 0) return null;

  const shuffled = rng.shuffle(slots);
  const links: Array<readonly [Slot, Slot]> = [];
  for (let i = 0; i < shuffled.length; i += 2) links.push([shuffled[i], shuffled[i + 1]]);
  const verb = creates.length === 0 ? "vanish" : `make${creates.join("")}`;
  return { verb, creates, links };
}

/** Annihilation for a same-symbol pair: nothing created, aux wires threaded. */
function selfAnnihilate(sym: Sym): Rule {
  const arity = arityOfSym(sym);
  return {
    verb: "annihilate",
    creates: [],
    links: Array.from(
      { length: arity },
      (_, i) => [ifaceSlot("a", i), ifaceSlot("b", i)] as const,
    ),
  };
}

function randomAlphabet(rng: Rng, index: number): Alphabet {
  const rules = new Map<string, Rule>();
  for (let i = 0; i < SYMBOLS.length; i++) {
    for (let j = i; j < SYMBOLS.length; j++) {
      // Generate in SORTED order: rules are stored keyed by sorted pair and are
      // interpreted with the first symbol as side "a", so generating in
      // declaration order would silently swap the sides — and with different
      // arities on the two sides, that means slot indices land out of range.
      const [x, y] =
        SYMBOLS[i].symbol <= SYMBOLS[j].symbol
          ? [SYMBOLS[i].symbol, SYMBOLS[j].symbol]
          : [SYMBOLS[j].symbol, SYMBOLS[i].symbol];
      if (x === y) {
        // Self-annihilation is what makes reaching the EMPTY net possible at
        // all; a purely random table almost never can, so the search fixes it
        // and explores the cross rules instead. One symbol may still be
        // armoured against itself, which is the interesting special case.
        if (rng.next() < 0.15) continue;
        rules.set(pairKey(x, y), selfAnnihilate(x));
        continue;
      }
      // A chance of leaving the pair with NO rule — deadlock as armour, which
      // is what the hand-designed "warded" alphabet exploits.
      if (rng.next() < 0.2) continue;
      const rule = randomRule(rng, x, y);
      if (rule) rules.set(pairKey(x, y), rule);
    }
  }
  return {
    id: `rnd${index}`,
    name: `random ${index}`,
    blurb: "generated",
    symbols: SYMBOLS,
    rules,
  };
}

// --- Scoring (same measures as the bake-off) ---------------------------------------

function handFor(alphabet: Alphabet): Card[] {
  const cards: Card[] = [];
  for (const def of alphabet.symbols) {
    cards.push({ kind: "agent", symbol: def.symbol });
    cards.push({ kind: "agent", symbol: def.symbol });
  }
  cards.push({ kind: "wire" }, { kind: "wire" });
  return cards;
}

function makeEnemy(alphabet: Alphabet, seed: number): Net | null {
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

function verbsWhileReducing(net: Net): string[] {
  const seen: string[] = [];
  let guard = 0;
  while (guard++ < 300) {
    const pairs = activePairs(net).filter((p) => hasRule(net, p));
    if (pairs.length === 0) break;
    const a = net.agent(pairs[0][0])!;
    const b = net.agent(pairs[0][1])!;
    const verb = lookupRule(net.alphabet, a.symbol, b.symbol)?.rule.verb;
    if (verb) seen.push(verb);
    step(net, pairs[0]);
    if (net.agentCount > 150) break;
  }
  return seen;
}

function greedy(start: Net, hand: readonly Card[]): number | null {
  let net = start.clone();
  reduce(net, { fuel: 300 });
  let cards: readonly Card[] = hand;
  for (let played = 0; played <= MAX_CARDS; played++) {
    if (isCleared(net)) return played;
    let best: { net: Net; rest: readonly Card[]; score: number } | null = null;
    for (const move of legalMoves(net, cards)) {
      const rest = spend(cards, cardFor(move));
      if (!rest) continue;
      const next = net.clone();
      if (!applyMove(next, move)) continue;
      const r = reduce(next, { fuel: 300 });
      if (r.fuelExhausted || next.agentCount > 100) continue;
      const score = net.agentCount - next.agentCount;
      if (!best || score > best.score) best = { net: next, rest, score };
    }
    if (!best) return null;
    net = best.net;
    cards = best.rest;
  }
  return isCleared(net) ? MAX_CARDS : null;
}

const rejects = { invalid: 0, fewLevels: 0, unclearable: 0, kept: 0 };

interface Score {
  verbsUsed: number;
  greedyTies: number;
  solvable: number;
  par: number;
  score: number;
  tally: string;
}

function evaluate(alphabet: Alphabet, levelCount: number): Score | null {
  if (validateAlphabet(alphabet).length > 0) {
    rejects.invalid++;
    return null;
  }
  const hand = handFor(alphabet);
  const levels: Net[] = [];
  for (let seed = 1; levels.length < levelCount && seed < 30000; seed++) {
    const net = makeEnemy(alphabet, seed * 977);
    if (net) levels.push(net);
  }
  if (levels.length < levelCount / 2) {
    rejects.fewLevels++;
    return null;
  }

  let solvable = 0;
  let greedyTies = 0;
  let verbSum = 0;
  let parSum = 0;
  const tally = new Map<string, number>();
  for (const level of levels) {
    const result = solve(level.clone(), hand, { maxCards: MAX_CARDS, fuel: 300 });
    if (!result.solution) continue;
    solvable++;
    parSum += result.solution.cards;
    const net = level.clone();
    const verbs = new Set(verbsWhileReducing(net));
    for (const move of result.solution.line) {
      applyMove(net, move);
      for (const v of verbsWhileReducing(net)) verbs.add(v);
      if (isCleared(net)) break;
    }
    verbSum += verbs.size;
    for (const v of verbs) tally.set(v, (tally.get(v) ?? 0) + 1);
    if (greedy(level, hand) === result.solution.cards) greedyTies++;
  }
  if (solvable === 0) {
    rejects.unclearable++;
    return null;
  }
  rejects.kept++;

  const solvableFrac = solvable / levels.length;
  const verbsUsed = verbSum / solvable;
  const greedyFrac = greedyTies / solvable;
  // Reward verb variety and punish a game greedy can play, but only count
  // alphabets that produce enough solvable levels to build on.
  const usable = solvableFrac >= 0.5 && solvableFrac <= 0.95 ? 1 : 0.25;
  return {
    verbsUsed,
    greedyTies: greedyFrac,
    solvable: solvableFrac,
    par: parSum / solvable,
    score: usable * (verbsUsed + 2 * (1 - greedyFrac)),
    tally: [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([v, n]) => `${v} ${Math.round((100 * n) / solvable)}%`)
      .join(", "),
  };
}

// --- Run ---------------------------------------------------------------------------

console.log("Random rule-table search — can generated rules beat hand-designed ones?\n");
console.log(`symbols: ${SYMBOLS.map((s) => `${s.symbol}(${s.arity})`).join(" ")}`);
console.log(`${CANDIDATES} candidates x ${LEVELS} levels each\n`);

const baselines: Array<{ label: string; score: Score }> = [];
for (const alphabet of ALPHABETS) {
  const score = evaluate(alphabet, LEVELS);
  if (score) baselines.push({ label: alphabet.id, score });
}

const rng = new Rng(20260803);
const found: Array<{ alphabet: Alphabet; score: Score }> = [];
for (let i = 0; i < CANDIDATES; i++) {
  const alphabet = randomAlphabet(rng, i);
  const score = evaluate(alphabet, LEVELS);
  if (score) found.push({ alphabet, score });
}
found.sort((a, b) => b.score.score - a.score.score);

const row = (label: string, s: Score): string =>
  label.padEnd(12) +
  s.score.toFixed(2).padStart(7) +
  s.verbsUsed.toFixed(2).padStart(8) +
  `${Math.round(100 * s.greedyTies)}%`.padStart(9) +
  `${Math.round(100 * s.solvable)}%`.padStart(10) +
  s.par.toFixed(2).padStart(6);

console.log("candidate".padEnd(12) + "score".padStart(7) + "verbs".padStart(8) + "greedy".padStart(9) + "solvable".padStart(10) + "par".padStart(6));
console.log("-".repeat(52));
for (const b of baselines) console.log(row(b.label, b.score));
console.log("-".repeat(52));
for (const f of found.slice(0, 6)) console.log(row(f.alphabet.id, f.score));

console.log(
  `\nof ${CANDIDATES} generated tables: ${rejects.kept} scored, ` +
    `${rejects.unclearable} could not clear a single level, ` +
    `${rejects.fewLevels} produced too few valid enemies, ${rejects.invalid} were invalid`,
);
console.log("\nBest generated table's rules:");
const best = found[0];
if (best) {
  for (const [key, rule] of best.alphabet.rules) {
    const [x, y] = key.split(" ");
    console.log(`  ${x} ⋈ ${y}  ->  ${rule.creates.length ? rule.creates.join(" + ") : "(nothing)"}`);
  }
  const missing: string[] = [];
  for (let i = 0; i < SYMBOLS.length; i++) {
    for (let j = i; j < SYMBOLS.length; j++) {
      const key = pairKey(SYMBOLS[i].symbol, SYMBOLS[j].symbol);
      if (!best.alphabet.rules.has(key)) missing.push(`${SYMBOLS[i].symbol} ⋈ ${SYMBOLS[j].symbol}`);
    }
  }
  console.log(`  deadlocked pairs (no rule): ${missing.join(", ") || "none"}`);
  console.log(`  verbs in optimal lines: ${best.score.tally}`);
}

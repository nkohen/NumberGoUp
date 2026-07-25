/**
 * Deck power analysis (a balancing tool, not shipped in the game).
 *
 * Two complementary measures of how strong a deck is at a given tree-depth cap:
 *
 *   maxScore(deck, depth)      — the HIGHEST score the deck's numbers can reach
 *                                in a tree of height <= depth (optimal play).
 *                                This is the skill ceiling.
 *   randomStats(deck, opts)    — the score distribution of an UNSKILLED player
 *                                who plays random legal moves until stuck, then
 *                                evaluates. Models "natural" power / the floor.
 *
 * Comparing the two tells us how much room skill has to matter, and comparing
 * either against the target curve tells us whether a round is winnable.
 *
 * Run with: `npx vite-node tools/analyze.ts` (see that file).
 */
import type { Card } from "../src/core/cards";
import { Rng } from "../src/core/rng";
import { newTree, place, legalTargets, evaluate } from "../src/core/tree";

// --- optimal ceiling ---------------------------------------------------------

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

/**
 * The maximum value obtainable from the deck's number cards in a tree of height
 * <= `depth`. Operators are assumed ample (the total-operator budget only caps
 * how many leaves can be joined). Uses a bitmask DP over the top candidate
 * numbers: `solve(mask, d)` = best value of a tree whose leaf set is exactly the
 * numbers in `mask`, height <= d, combining subtrees with + or ×.
 */
export function maxScore(deck: readonly Card[], depth: number): number {
  const nums = deck
    .filter((c): c is Extract<Card, { kind: "number" }> => c.kind === "number")
    .map((c) => c.value)
    .sort((a, b) => b - a);
  if (nums.length === 0) return 0;

  const opCount = deck.filter((c) => c.kind === "op").length;
  const leafCap = Math.min(2 ** depth, opCount + 1, nums.length);
  // Candidates: never need more than `leafCap` leaves; a couple extra small
  // numbers can still help via distribution ((a+b)*c), so include a small margin.
  const candCount = Math.min(nums.length, Math.min(12, leafCap + 2));
  const cand = nums.slice(0, candCount);
  const n = cand.length;

  const memo = new Map<number, number>();
  const solve = (mask: number, d: number): number => {
    const key = mask * 8 + d;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let best: number;
    if (popcount(mask) === 1) {
      best = cand[Math.log2(mask & -mask) | 0];
    } else if (d < 1) {
      best = -Infinity;
    } else {
      best = -Infinity;
      const low = mask & -mask; // keep `low` in the left subset to avoid dup pairs
      for (let sub = (mask - 1) & mask; sub > 0; sub = (sub - 1) & mask) {
        if (!(sub & low)) continue;
        const rest = mask ^ sub;
        if (rest === 0) continue;
        const l = solve(sub, d - 1);
        if (l === -Infinity) continue;
        const r = solve(rest, d - 1);
        if (r === -Infinity) continue;
        const v = Math.max(l + r, l * r);
        if (v > best) best = v;
      }
    }
    memo.set(key, best);
    return best;
  };

  let best = 0;
  for (let mask = 1; mask < 1 << n; mask++) {
    if (popcount(mask) > leafCap) continue;
    const v = solve(mask, depth);
    if (v > best) best = v;
  }
  return best;
}

/**
 * All distinct scores a tree of height <= `depth` can produce from the deck's
 * numbers (with ample operators) — the same bitmask DP as `maxScore` but
 * tracking the full reachable-value set instead of just the maximum.
 */
export function achievableValues(deck: readonly Card[], depth: number): number[] {
  const nums = deck
    .filter((c): c is Extract<Card, { kind: "number" }> => c.kind === "number")
    .map((c) => c.value)
    .sort((a, b) => b - a);
  if (nums.length === 0) return [0];

  const opCount = deck.filter((c) => c.kind === "op").length;
  // Cap the analysis depth: beyond ~4 levels the reachable-value SET explodes
  // combinatorially while precision is already effectively perfect, so deeper
  // analysis costs a lot and tells us nothing new.
  const effDepth = Math.min(depth, 4);
  const leafCap = Math.min(2 ** effDepth, opCount + 1, nums.length);
  const candCount = Math.min(nums.length, Math.min(8, leafCap + 2));
  const cand = nums.slice(0, candCount);
  const n = cand.length;

  const memo = new Map<number, Set<number>>();
  const solve = (mask: number, d: number): Set<number> => {
    const key = mask * 8 + d;
    const hit = memo.get(key);
    if (hit) return hit;
    const out = new Set<number>();
    if (popcount(mask) === 1) {
      out.add(cand[Math.log2(mask & -mask) | 0]);
    } else if (d >= 1) {
      const low = mask & -mask;
      for (let sub = (mask - 1) & mask; sub > 0; sub = (sub - 1) & mask) {
        if (!(sub & low)) continue;
        const rest = mask ^ sub;
        if (rest === 0) continue;
        const ls = solve(sub, d - 1);
        const rs = solve(rest, d - 1);
        for (const l of ls) for (const r of rs) {
          out.add(l + r);
          out.add(l * r);
        }
      }
    }
    memo.set(key, out);
    return out;
  };

  const all = new Set<number>();
  for (let mask = 1; mask < 1 << n; mask++) {
    if (popcount(mask) > leafCap) continue;
    for (const v of solve(mask, effDepth)) all.add(v);
  }
  return [...all].sort((a, b) => a - b);
}

/** The smallest reachable score that still clears `target`, or null if none. */
export function closestAtLeast(
  deck: readonly Card[],
  depth: number,
  target: number,
): number | null {
  for (const v of achievableValues(deck, depth)) if (v >= target) return v;
  return null;
}

// --- random / unskilled play -------------------------------------------------

/**
 * Simulate one round: replicate the game's draw-and-play loop (draw a hand, play
 * ONE random legal move, return the rest and redraw) until no legal move
 * remains, then evaluate the tree. Mirrors `Game` mechanics but with a random
 * policy and no early "Evaluate".
 */
export function simulateRandomRound(
  deck: readonly Card[],
  handSize: number,
  maxDepth: number,
  rng: Rng,
): number {
  let tree = newTree();
  let roundDeck = rng.shuffle(deck);
  let hand: Card[] = [];

  const drawHand = (): void => {
    if (hand.length > 0) {
      roundDeck = roundDeck.concat(hand);
      hand = [];
    }
    roundDeck = rng.shuffle(roundDeck);
    const k = Math.min(handSize, roundDeck.length);
    hand = roundDeck.slice(0, k);
    roundDeck = roundDeck.slice(k);
  };

  drawHand();
  for (;;) {
    const moves: Array<{ h: number; target: number }> = [];
    for (let h = 0; h < hand.length; h++) {
      for (const t of legalTargets(tree.root, hand[h], maxDepth)) {
        moves.push({ h, target: t });
      }
    }
    if (moves.length === 0) break;
    const m = rng.pick(moves);
    const res = place(tree, m.target, hand[m.h], maxDepth)!;
    tree = res.tree;
    hand = hand.filter((_, i) => i !== m.h);
    if (hand.length === 0 && roundDeck.length === 0) break;
    drawHand();
  }
  return evaluate(tree.root);
}

export interface RandomStats {
  avg: number;
  median: number;
  p90: number;
  max: number;
  /** Fraction of rounds that scored 0 (e.g. an unfilled × slot zeroed it). */
  zeroRate: number;
}

/** Aggregate `trials` random rounds into summary statistics. */
export function randomStats(
  deck: readonly Card[],
  opts: { handSize: number; maxDepth: number; trials: number; seed: number },
): RandomStats {
  const rng = new Rng(opts.seed);
  const scores: number[] = [];
  for (let i = 0; i < opts.trials; i++) {
    scores.push(simulateRandomRound(deck, opts.handSize, opts.maxDepth, rng));
  }
  scores.sort((a, b) => a - b);
  const sum = scores.reduce((s, v) => s + v, 0);
  const zeros = scores.filter((v) => v === 0).length;
  const at = (q: number) => scores[Math.min(scores.length - 1, Math.floor(q * scores.length))];
  return {
    avg: sum / scores.length,
    median: at(0.5),
    p90: at(0.9),
    max: scores[scores.length - 1],
    zeroRate: zeros / scores.length,
  };
}

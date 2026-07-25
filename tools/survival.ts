/**
 * Typical-player survival sim (balancing tool, not shipped).
 *
 * analyze.ts models the OPTIMAL precise player. This models the opposite end:
 * a semi-skilled player who plays a reasonable-but-not-perfect greedy policy and
 * banks focus by the tiered model, to measure how the empty-×=1 forgiveness buff
 * and candidate target curves move the *floor* of the difficulty band.
 *
 * Policy per round: draw/play greedily to get as close to the target from above
 * as a one-ply lookahead allows (never overshoot on purpose), evaluate, grade,
 * bank focus, then spend the shop like analyze.ts (grow just-in-time, else the
 * upgrade that best lowers next round's overshoot, else skip). Run: many seeds,
 * report the distribution of the round reached.
 *
 * Run: `npx vite-node tools/survival.ts [growth]`
 */
import { starterDeck } from "../src/core/cards";
import { DEFAULT_CONFIG, costToGrow, MAX_DEPTH, gradeLand } from "../src/core/game";
import { generateOffers, applyUpgrade } from "../src/core/upgrades";
import { Rng } from "../src/core/rng";
import { newTree, place, legalTargets, evaluate } from "../src/core/tree";
import type { Card } from "../src/core/cards";

const HAND = DEFAULT_CONFIG.handSize;

/**
 * Play one round with a greedy "land closest above target" policy, mirroring the
 * real draw-one-play-one loop. Returns the finalized score. The player evaluates
 * early the moment the live tree is already >= target (locking a tight clear).
 */
function playGreedyRound(
  deck: readonly Card[],
  depth: number,
  target: number,
  rng: Rng,
): number {
  let tree = newTree();
  let roundDeck = rng.shuffle(deck);
  let hand: Card[] = [];
  const draw = () => {
    if (hand.length) { roundDeck = roundDeck.concat(hand); hand = []; }
    roundDeck = rng.shuffle(roundDeck);
    const k = Math.min(HAND, roundDeck.length);
    hand = roundDeck.slice(0, k); roundDeck = roundDeck.slice(k);
  };
  draw();
  for (;;) {
    const cur = evaluate(tree.root);
    // Lock in a clear as soon as we're above target (precision: stop early).
    if (cur >= target) return cur;
    // Enumerate legal moves; pick the one whose resulting score is the best
    // (closest to target from below, else the largest — keep climbing).
    let best: { h: number; t: number; score: number } | null = null;
    for (let h = 0; h < hand.length; h++) {
      for (const t of legalTargets(tree.root, hand[h], depth)) {
        const res = place(tree, t, hand[h], depth)!;
        const s = evaluate(res.tree.root);
        if (
          best === null ||
          // prefer a move that reaches/exceeds target with least overshoot,
          // otherwise the move that climbs highest toward it
          (s >= target && (best.score < target || s < best.score)) ||
          (best.score < target && s > best.score)
        ) {
          best = { h, t, score: s };
        }
      }
    }
    if (best === null) break; // stuck
    const res = place(tree, best.t, hand[best.h], depth)!;
    tree = res.tree;
    hand = hand.filter((_, i) => i !== best!.h);
    if (hand.length === 0 && roundDeck.length === 0) break;
    draw();
  }
  return evaluate(tree.root);
}

function runOnce(growth: number, seed: number): number {
  const cfg = { ...DEFAULT_CONFIG, targetGrowth: growth };
  const rng = new Rng(seed);
  let deck = starterDeck();
  let depth = cfg.startDepth;
  let focus = 0;
  let round = 1;
  for (; round <= 60; round++) {
    const target = Math.ceil(cfg.baseTarget * Math.pow(growth, round - 1));
    const score = playGreedyRound(deck, depth, target, rng);
    const { won, focusEarned } = gradeLand(score, target, "tiered");
    if (!won) return round - 1; // rounds cleared
    focus += focusEarned;
    // Shop: grow if it helps next round and affordable, else best upgrade, else skip.
    const nextT = Math.ceil(cfg.baseTarget * Math.pow(growth, round));
    // crude: grow when target roughly doubles past our reach; use maxScore proxy
    const offers = generateOffers(deck, rng, round, cfg.upgradeChoices, "classic");
    // Evaluate each option by a quick greedy playout of next round (cheap proxy).
    type Opt = { deck: Card[]; depth: number; focus: number; score: number };
    const opts: Opt[] = [];
    opts.push({ deck, depth, focus: focus + 1, score: playGreedyRound(deck, depth, nextT, new Rng(seed + round)) });
    if (depth < MAX_DEPTH && focus >= costToGrow(depth)) {
      opts.push({ deck, depth: depth + 1, focus: focus - costToGrow(depth), score: playGreedyRound(deck, depth + 1, nextT, new Rng(seed + round)) });
    }
    for (const off of offers) {
      const d2 = applyUpgrade(deck, off);
      opts.push({ deck: d2, depth, focus, score: playGreedyRound(d2, depth, nextT, new Rng(seed + round)) });
    }
    // pick option that best clears next target (closest above, else highest).
    const best = opts.reduce((a, b) => {
      const aClear = a.score >= nextT, bClear = b.score >= nextT;
      if (aClear && bClear) return b.score < a.score ? b : a;
      if (aClear !== bClear) return aClear ? a : b;
      return b.score > a.score ? b : a;
    });
    deck = best.deck; depth = best.depth; focus = best.focus;
  }
  return round - 1;
}

const growth = process.argv[2] ? Number(process.argv[2]) : DEFAULT_CONFIG.targetGrowth;
const TRIALS = 200;
const reached: number[] = [];
for (let s = 0; s < TRIALS; s++) reached.push(runOnce(growth, 1000 + s * 7));
reached.sort((a, b) => a - b);
const avg = reached.reduce((s, v) => s + v, 0) / reached.length;
const q = (p: number) => reached[Math.floor(p * reached.length)];
console.log(`growth=${growth}  trials=${TRIALS}  greedy(semi-skilled) player`);
console.log(`  rounds cleared: avg ${avg.toFixed(1)}  median ${q(0.5)}  p10 ${q(0.1)}  p90 ${q(0.9)}  max ${reached[reached.length - 1]}`);

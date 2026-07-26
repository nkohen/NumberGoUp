/**
 * Precision-MODE balance sim (balancing tool, not shipped).
 *
 * Not to be confused with `survival.ts`, which measures how long a semi-skilled
 * player lasts in CLASSIC. This one models the Precision game mode: a target
 * drawn uniformly from `[1, cap(round))`, 100 HP, and damage equal to the
 * absolute distance from the target. The question it answers is what
 * `precisionRangeGrowth` (how fast that range widens) makes for a run that is
 * neither over in three rounds nor endless.
 *
 * Player policy per round: greedy hill-climbing on |score - target|, with a
 * one-card lookahead so that operator plays — which barely move the score on
 * their own but open a slot — are valued by what they'd enable. The player
 * stops (hits Analyze) as soon as no move can improve the distance, which is
 * the whole point of the mode's manual finalize.
 *
 * Shop policy: pick the option (upgrade / grow / skip) that minimises average
 * damage against sample targets drawn from NEXT round's range.
 *
 * Run: `npx vite-node tools/precisionmode.ts [growth ...]`
 */
import { starterDeck } from "../src/core/cards";
import type { Card } from "../src/core/cards";
import {
  DEFAULT_CONFIG,
  GameConfig,
  costToGrow,
  MAX_DEPTH,
  gradePrecision,
  precisionRangeCap,
  PRECISION_WIN_ROUND,
} from "../src/core/game";
import { generateOffers, applyUpgrade } from "../src/core/upgrades";
import { Rng } from "../src/core/rng";
import { newTree, place, legalTargets, evaluate, Tree } from "../src/core/tree";

const HAND = DEFAULT_CONFIG.handSize;
/** Give up on a run this long — it's effectively unkillable at that point. */
const ROUND_CAP = 80;

const dist = (score: number, target: number) => Math.abs(score - target);

/**
 * Value of a resulting tree: its own distance, or the best distance reachable
 * by then dropping one more number card from the deck into it. Without this
 * lookahead a greedy player never plays `×` (it doesn't improve the score by
 * itself) and so can never build anything big.
 */
function lookaheadValue(
  tree: Tree,
  target: number,
  deck: readonly Card[],
  depth: number,
): number {
  let best = dist(evaluate(tree.root), target);
  const numbers = deck.filter((c) => c.kind === "number");
  const seen = new Set<number>();
  for (const card of numbers) {
    const v = (card as Extract<Card, { kind: "number" }>).value;
    if (seen.has(v)) continue;
    seen.add(v);
    for (const t of legalTargets(tree.root, card, depth)) {
      const res = place(tree, t, card, depth);
      if (!res) continue;
      best = Math.min(best, dist(evaluate(res.tree.root), target));
    }
  }
  return best;
}

/** Play one precision round; returns the score the player finalizes on. */
function playRound(
  deck: readonly Card[],
  depth: number,
  target: number,
  rng: Rng,
): number {
  let tree = newTree();
  let roundDeck = rng.shuffle(deck);
  let hand: Card[] = [];
  const draw = () => {
    if (hand.length) {
      roundDeck = roundDeck.concat(hand);
      hand = [];
    }
    roundDeck = rng.shuffle(roundDeck);
    const k = Math.min(HAND, roundDeck.length);
    hand = roundDeck.slice(0, k);
    roundDeck = roundDeck.slice(k);
  };
  draw();
  for (;;) {
    const cur = dist(evaluate(tree.root), target);
    let best: { h: number; t: number; value: number } | null = null;
    for (let h = 0; h < hand.length; h++) {
      for (const t of legalTargets(tree.root, hand[h], depth)) {
        const res = place(tree, t, hand[h], depth);
        if (!res) continue;
        const value = lookaheadValue(res.tree, target, [...hand, ...roundDeck], depth);
        if (best === null || value < best.value) best = { h, t, value };
      }
    }
    // Nothing playable, or nothing that gets us closer → finalize here.
    if (best === null || best.value >= cur) break;
    tree = place(tree, best.t, hand[best.h], depth)!.tree;
    hand = hand.filter((_, i) => i !== best!.h);
    if (hand.length === 0 && roundDeck.length === 0) break;
    draw();
  }
  return evaluate(tree.root);
}

/** One full run. Returns the number of rounds survived. */
function runOnce(cfg: GameConfig, seed: number, samples: number): number {
  const rng = new Rng(seed);
  let deck = starterDeck();
  let depth = cfg.startDepth;
  let focus = 0;
  let hp = cfg.precisionHp;

  for (let round = 1; round <= ROUND_CAP; round++) {
    const target = rng.int(1, precisionRangeCap(round, cfg) - 1);
    const score = playRound(deck, depth, target, rng);
    const { damage, focusEarned } = gradePrecision(score, target);
    hp -= damage;
    if (hp <= 0) return round - 1;
    focus += focusEarned;

    // Shop: score each option by average damage across sample next-round targets.
    const nextCap = precisionRangeCap(round + 1, cfg);
    const probes = Array.from({ length: samples }, (_, i) =>
      Math.max(1, Math.round(((i + 1) * (nextCap - 1)) / (samples + 1))),
    );
    type Opt = { deck: Card[]; depth: number; focus: number; cost: number };
    const opts: Opt[] = [{ deck, depth, focus: focus + 1, cost: 0 }]; // skip
    if (depth < MAX_DEPTH && focus >= costToGrow(depth)) {
      opts.push({ deck, depth: depth + 1, focus: focus - costToGrow(depth), cost: 0 });
    }
    for (const off of generateOffers(deck, rng, round, cfg.upgradeChoices, "precision")) {
      opts.push({ deck: applyUpgrade(deck, off), depth, focus, cost: 0 });
    }
    for (const o of opts) {
      let total = 0;
      for (const p of probes) {
        total += dist(playRound(o.deck, o.depth, p, new Rng(seed + round * 31)), p);
      }
      o.cost = total / probes.length;
    }
    const best = opts.reduce((a, b) => (b.cost < a.cost ? b : a));
    deck = best.deck;
    depth = best.depth;
    focus = best.focus;
  }
  return ROUND_CAP;
}

const growths = process.argv.slice(2).map(Number);
const CANDIDATES = growths.length ? growths : [1.25, 1.35, 1.45, 1.6, 1.9];
const TRIALS = Number(process.env.TRIALS ?? 40);
const SAMPLES = 2;

console.log(
  `precision mode · HP ${DEFAULT_CONFIG.precisionHp} · range [1, cap) ` +
    `start ${DEFAULT_CONFIG.precisionRangeStart} → max ${DEFAULT_CONFIG.precisionRangeMax} · ` +
    `${TRIALS} trials`,
);
for (const growth of CANDIDATES) {
  const cfg: GameConfig = {
    ...DEFAULT_CONFIG,
    mode: "precision",
    precisionRangeGrowth: growth,
  };
  const capAt = (r: number) => precisionRangeCap(r, cfg);
  const reached: number[] = [];
  for (let s = 0; s < TRIALS; s++) reached.push(runOnce(cfg, 1000 + s * 7, SAMPLES));
  reached.sort((a, b) => a - b);
  const avg = reached.reduce((a, b) => a + b, 0) / reached.length;
  const q = (p: number) => reached[Math.floor(p * (reached.length - 1))];
  const fullAt = Array.from({ length: ROUND_CAP }, (_, i) => i + 1).find(
    (r) => capAt(r) >= DEFAULT_CONFIG.precisionRangeMax,
  );
  // How often this modelled player would actually reach the win round — the
  // number that says whether the finish line is a goal or a fantasy.
  const wins = reached.filter((r) => r >= PRECISION_WIN_ROUND).length;
  console.log(
    `growth ${growth.toFixed(2)}  caps ${[1, 3, 5, 8, 12].map(capAt).join("/")} ` +
      `(full range @ r${fullAt})  →  rounds survived: avg ${avg.toFixed(1)} ` +
      `median ${q(0.5)}  p10 ${q(0.1)}  p90 ${q(0.9)}  max ${reached[reached.length - 1]}` +
      `   WIN(r${PRECISION_WIN_ROUND}) ${((100 * wins) / reached.length).toFixed(0)}%`,
  );
}

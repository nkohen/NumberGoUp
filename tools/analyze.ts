/**
 * Balancing report for Number Go Up. Run: `npx vite-node tools/analyze.ts`.
 *
 * Prints, for the starter deck and for the deck as it evolved across a real
 * logged run, the optimal ceiling (maxScore) and the unskilled random-play
 * distribution at each depth cap — alongside the current target curve — so we
 * can see where skill is required and where a round becomes impossible.
 */
import fs from "node:fs";
import path from "node:path";
import type { Card } from "../src/core/cards";
import { numberCard, opCard, varCard } from "../src/core/cards";
import { starterDeck } from "../src/core/cards";
import { DEFAULT_CONFIG, targetForRound, costToGrow, MAX_DEPTH } from "../src/core/game";
import { generateOffers, applyUpgrade } from "../src/core/upgrades";
import { Rng } from "../src/core/rng";
import { maxScore, randomStats, closestAtLeast } from "./deckpower";

const HAND = DEFAULT_CONFIG.handSize;
const TRIALS = 4000;

/** Turn a logged `{ "10":2, "×":3, ... }` tally back into a Card[] deck. */
function deckFromCounts(counts: Record<string, number>): Card[] {
  const out: Card[] = [];
  for (const [k, v] of Object.entries(counts)) {
    for (let i = 0; i < v; i++) {
      if (k === "+") out.push(opCard("+"));
      else if (k === "×") out.push(opCard("*"));
      else if (k === "ƒ") out.push(opCard("@"));
      else if (k === "x") out.push(varCard());
      else out.push(numberCard(Number(k)));
    }
  }
  return out;
}

function fmt(n: number): string {
  return n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(n < 10 ? 1 : 0);
}

function reportDeck(label: string, deck: Card[], depths: number[]): void {
  console.log(`\n${label}  (${deck.length} cards)`);
  console.log(
    "  depth |     max |   avg |  median |    p90 | zero% ",
  );
  for (const d of depths) {
    const mx = maxScore(deck, d);
    const rs = randomStats(deck, { handSize: HAND, maxDepth: d, trials: TRIALS, seed: 12345 });
    console.log(
      `  ${String(d).padStart(5)} | ${fmt(mx).padStart(7)} | ${fmt(rs.avg).padStart(5)} | ${fmt(rs.median).padStart(7)} | ${fmt(rs.p90).padStart(6)} | ${(rs.zeroRate * 100).toFixed(0).padStart(4)}%`,
    );
  }
}

// --- 1) The starter deck at each depth ---------------------------------------
console.log("=".repeat(64));
console.log("STARTER DECK — power vs depth cap");
console.log("=".repeat(64));
reportDeck("Classic starter {1,1,2,2,+,+,×,×}", starterDeck(), [2, 3, 4, 5]);

// --- 2) Run model from a real logged session ---------------------------------
// Compare, per round, the current target against optimal & random power at
// depth 2 vs depth 3, using the deck as it actually evolved.
const logDir = path.resolve(__dirname, "../dev-logs");
const archives = fs
  .readdirSync(logDir)
  .filter((f) => f.startsWith("session-") && f.endsWith(".ndjson"))
  .sort();
if (archives.length > 0) {
  const file = path.join(logDir, archives[archives.length - 1]);
  const allRounds = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "round_start");
  // A file can hold several playthroughs; keep only the first (its rounds count
  // strictly up from 1 until the counter resets for the next run).
  const rounds: typeof allRounds = [];
  for (const ev of allRounds) {
    if (rounds.length > 0 && ev.round <= rounds[rounds.length - 1].round) break;
    rounds.push(ev);
  }

  console.log("\n" + "=".repeat(64));
  console.log(`RUN MODEL — deck evolution from ${archives[archives.length - 1]}`);
  console.log("current curve: base", DEFAULT_CONFIG.baseTarget, "growth", DEFAULT_CONFIG.targetGrowth);
  console.log("=".repeat(64));
  console.log("       |        | ---- depth 2 ---- | ---- depth 3 ----");
  console.log(" round | target |    max |  avg(rnd) |    max |  avg(rnd)");
  for (const ev of rounds) {
    const deck = deckFromCounts(ev.deck);
    const target = targetForRound(ev.round, DEFAULT_CONFIG);
    const d2 = maxScore(deck, 2);
    const d3 = maxScore(deck, 3);
    const r2 = randomStats(deck, { handSize: HAND, maxDepth: 2, trials: TRIALS, seed: 7 }).avg;
    const r3 = randomStats(deck, { handSize: HAND, maxDepth: 3, trials: TRIALS, seed: 7 }).avg;
    const flag = (m: number) => (m < target ? " ✗" : "  ");
    console.log(
      `  ${String(ev.round).padStart(4)} | ${fmt(target).padStart(6)} | ${fmt(d2).padStart(6)}${flag(d2)}| ${fmt(r2).padStart(8)} | ${fmt(d3).padStart(6)}${flag(d3)}| ${fmt(r3).padStart(8)}`,
    );
  }
  console.log("\n  ✗ = optimal play cannot reach the target at that depth (round unwinnable)");

  // --- 3) Precision model --------------------------------------------------
  // Under the proposed mechanic the skill is landing JUST above the target.
  // Show the closest achievable score >= target at each depth, and the smallest
  // overshoot % (0% = a perfect land). Where depth 2 can't get close but depth 3
  // can, the player is motivated to have banked enough to grow the tree.
  console.log("\n" + "=".repeat(64));
  console.log("PRECISION MODEL — closest score that still clears the target");
  console.log("=".repeat(64));
  console.log("       |        | ---- depth 2 ---- | ---- depth 3 ----");
  console.log(" round | target | closest | overshoot | closest | overshoot");
  for (const ev of rounds) {
    const deck = deckFromCounts(ev.deck);
    const target = targetForRound(ev.round, DEFAULT_CONFIG);
    const c2 = closestAtLeast(deck, 2, target);
    const c3 = closestAtLeast(deck, 3, target);
    const cell = (c: number | null) =>
      c === null
        ? `${"—".padStart(7)} | ${"unreach".padStart(9)}`
        : `${fmt(c).padStart(7)} | ${(((c - target) / target) * 100).toFixed(0).padStart(7)}% `;
    console.log(`  ${String(ev.round).padStart(4)} | ${fmt(target).padStart(6)} | ${cell(c2)} | ${cell(c3)}`);
  }
  console.log("\n  overshoot% = how far above target the tightest clear lands (0% = perfect)");
} else {
  console.log("\n(no dev-logs/session-*.ndjson found; skipping run model)");
}

// --- 4) Full-run economy sim -------------------------------------------------
// A perfectly-precise player: each round lands the tightest possible clear,
// banks focus by the tiered model, grows depth just-in-time, and drafts the
// upgrade that best sharpens the NEXT round. Shows whether depth actually
// scales and how long a skilled run lasts under the current numbers.
function tieredFocus(overshoot: number): number {
  if (overshoot === 0) return 5;
  if (overshoot <= 0.05) return 4;
  if (overshoot <= 0.1) return 3;
  if (overshoot <= 0.15) return 2;
  if (overshoot <= 0.2) return 1;
  return 0;
}

function overshootAt(deck: ReturnType<typeof starterDeck>, depth: number, target: number): number | null {
  const c = closestAtLeast(deck, depth, target);
  return c === null ? null : (c - target) / target;
}

console.log("\n" + "=".repeat(64));
console.log("ECONOMY SIM — a perfectly-precise player (tiered model)");
console.log("=".repeat(64));
console.log(" round | depth | target | closest | over% | grade  | focus | grew");
{
  const rng = new Rng(20260724);
  let deck = starterDeck();
  let depth = DEFAULT_CONFIG.startDepth;
  let focus = 0;
  let round = 1;
  for (; round <= 40; round++) {
    const target = targetForRound(round, DEFAULT_CONFIG);
    const o = overshootAt(deck, depth, target);
    if (o === null) {
      console.log(`  ${String(round).padStart(4)} | ${String(depth).padStart(5)} | ${fmt(target).padStart(6)} |  ${"UNREACHABLE — run ends".padStart(7)}`);
      break;
    }
    const closest = closestAtLeast(deck, depth, target)!;
    focus += tieredFocus(o);
    const grade = o === 0 ? "PERFECT" : o <= 0.05 ? "SHARP" : o <= 0.15 ? "CLOSE" : "CLEARED";

    // ONE shop action per round: grow the tree, OR take an upgrade, OR skip.
    // Enumerate every option's effect on the NEXT round and pick the best:
    // lowest reachable overshoot; if nothing is reachable, the most raw power.
    const nextTarget = targetForRound(round + 1, DEFAULT_CONFIG);
    type Cand = { over: number | null; max: number; deck: typeof deck; depth: number; focus: number; label: string };
    const cands: Cand[] = [];
    // skip (banks +1 focus, tiered)
    cands.push({ over: overshootAt(deck, depth, nextTarget), max: maxScore(deck, depth), deck, depth, focus: focus + 1, label: "skip +1◆" });
    // grow (spend focus, +1 depth)
    if (depth < MAX_DEPTH && focus >= costToGrow(depth)) {
      const nd = depth + 1;
      cands.push({ over: overshootAt(deck, nd, nextTarget), max: maxScore(deck, nd), deck, depth: nd, focus: focus - costToGrow(depth), label: `grow→${nd}` });
    }
    // each upgrade
    for (const off of generateOffers(deck, rng, round, DEFAULT_CONFIG.upgradeChoices, "classic")) {
      const d2 = applyUpgrade(deck, off);
      cands.push({ over: overshootAt(d2, depth, nextTarget), max: maxScore(d2, depth), deck: d2, depth, focus, label: "upgrade" });
    }
    const reachable = cands.filter((c) => c.over !== null);
    const best = reachable.length
      ? reachable.reduce((a, b) => (b.over! < a.over! ? b : a))
      : cands.reduce((a, b) => (b.max > a.max ? b : a));
    deck = best.deck;
    depth = best.depth;
    focus = best.focus;
    const action = best.label;

    console.log(
      `  ${String(round).padStart(4)} | ${String(depth).padStart(5)} | ${fmt(target).padStart(6)} | ${fmt(closest).padStart(7)} | ${(o * 100).toFixed(0).padStart(4)}% | ${grade.padEnd(6)} | ${String(focus).padStart(5)} | ${action}`,
    );
  }
}

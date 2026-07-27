/**
 * Statistics harness for the interaction-combinator sandbox.
 * Run: `npm run inet:stats` (or `npx vite-node tools/inet-stats.ts`).
 *
 * Generates N random nets at several sizes, reduces each under a fuel cap and
 * reports the shape of the score space:
 *
 *   - the distribution of `interactions` (the canonical score),
 *   - the distribution of `peakParallelism` and `finalAgents`,
 *   - the divergence rate (fraction that hit the fuel cap),
 *   - the correlation between `interactions` and `peakParallelism`, which is the
 *     question of whether "most interactions" and "widest front" are two
 *     different games or the same one wearing a hat.
 *
 * Flags: --trials=N --fuel=N --seed=N --sizes=4,8,16 --csv
 */
import { Rng } from "../src/core/rng";
import { correlation, describe, randomNet, type Distribution } from "../src/inet/generate";
import { reduce, type ReduceResult } from "../src/inet/reduce";
import { PRESETS } from "../src/inet/presets";

function flag(name: string, fallback: number): number {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`));
  return raw ? Number(raw.split("=")[1]) : fallback;
}

const TRIALS = flag("trials", 1000);
// 5000 is far above anything a normalizing net of these sizes needs (the
// largest observed is two orders of magnitude smaller), so hitting the cap is
// as good as a divergence verdict — and it keeps a run of the whole harness to
// about a minute rather than tens of minutes.
const FUEL = flag("fuel", 5000);
const SEED = flag("seed", 12345);
const SIZES = (() => {
  const raw = process.argv.find((a) => a.startsWith("--sizes="));
  return raw ? raw.split("=")[1].split(",").map(Number) : [4, 8, 16, 32, 64];
})();
const CSV = process.argv.includes("--csv");

interface Row extends ReduceResult {
  size: number;
  seed: number;
}

function collect(size: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < TRIALS; i++) {
    const seed = SEED + size * 1_000_003 + i;
    const net = randomNet(new Rng(seed), size);
    // Reduce in parallel order so `rounds` is the true depth of the computation
    // rather than a restatement of `interactions`.
    rows.push({ ...reduce(net, { fuel: FUEL, order: "parallel" }), size, seed });
  }
  return rows;
}

function fmt(n: number, places = 1): string {
  return Number.isFinite(n) ? n.toFixed(places) : "-";
}

function line(label: string, d: Distribution): string {
  return [
    label.padEnd(16),
    String(d.min).padStart(6),
    fmt(d.median, 0).padStart(8),
    fmt(d.mean).padStart(9),
    fmt(d.p90, 0).padStart(7),
    fmt(d.p99, 0).padStart(7),
    String(d.max).padStart(8),
    fmt(d.cv, 2).padStart(7),
  ].join("");
}

const HEADER =
  "metric".padEnd(16) +
  "min".padStart(6) +
  "median".padStart(8) +
  "mean".padStart(9) +
  "p90".padStart(7) +
  "p99".padStart(7) +
  "max".padStart(8) +
  "cv".padStart(7);

if (CSV) {
  console.log("size,seed,interactions,rounds,peakParallelism,peakAgents,finalAgents,loops,diverged");
  for (const size of SIZES) {
    for (const r of collect(size)) {
      console.log(
        [
          r.size,
          r.seed,
          r.interactions,
          r.rounds,
          r.peakParallelism,
          r.peakAgents,
          r.finalAgents,
          r.loops,
          r.fuelExhausted ? 1 : 0,
        ].join(","),
      );
    }
  }
} else {
  console.log(`Interaction-combinator random-net statistics`);
  console.log(`trials=${TRIALS} per size, fuel=${FUEL}, seed=${SEED}, sizes=${SIZES.join(",")}`);
  console.log(`weights: γ 1.0, δ 1.0, ε 0.4 — ports paired uniformly at random\n`);

  for (const size of SIZES) {
    const rows = collect(size);
    const converged = rows.filter((r) => !r.fuelExhausted);
    const divergent = rows.length - converged.length;

    console.log(`── ${size} agents ` + "─".repeat(Math.max(0, 60 - String(size).length)));
    console.log(
      `diverged: ${divergent}/${rows.length} (${fmt((100 * divergent) / rows.length)}%)` +
        `   normalizing sample: ${converged.length}`,
    );
    if (converged.length === 0) {
      console.log("  (nothing normalized)\n");
      continue;
    }
    console.log(HEADER);
    console.log(line("interactions", describe(converged.map((r) => r.interactions))));
    console.log(line("rounds", describe(converged.map((r) => r.rounds))));
    console.log(line("peakParallelism", describe(converged.map((r) => r.peakParallelism))));
    console.log(line("peakAgents", describe(converged.map((r) => r.peakAgents))));
    console.log(line("finalAgents", describe(converged.map((r) => r.finalAgents))));
    console.log(line("loops", describe(converged.map((r) => r.loops))));

    const ints = converged.map((r) => r.interactions);
    const par = converged.map((r) => r.peakParallelism);
    // Average width = interactions per round: the wide-vs-deep SHAPE of the
    // computation with its raw size divided out. If this is uncorrelated with
    // `interactions`, then "score the widest front" really is a second axis
    // rather than a restatement of "score the most work".
    const width = converged.map((r) => r.interactions / Math.max(1, r.rounds));
    console.log(line("avg width", describe(width.map((w) => Math.round(w * 10) / 10))));
    console.log(
      `\ncorrelation  interactions~peakParallelism ${fmt(correlation(ints, par), 3)}` +
        `   interactions~avgWidth ${fmt(correlation(ints, width), 3)}` +
        `   interactions~finalAgents ${fmt(
          correlation(ints, converged.map((r) => r.finalAgents)),
          3,
        )}` +
        `   interactions~rounds ${fmt(correlation(ints, converged.map((r) => r.rounds)), 3)}`,
    );

    // How much of the score space is reachable by "playing well"? Compare the
    // top decile to the median: a fat tail means skill has somewhere to go.
    const sorted = [...ints].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1;
    const p99 = sorted[Math.floor(sorted.length * 0.99)] || 1;
    console.log(`skill headroom  p99/median = ${fmt(p99 / Math.max(1, median), 2)}×\n`);
  }

  console.log("── presets " + "─".repeat(56));
  for (const preset of PRESETS) {
    const net = preset.build();
    const before = net.agentCount;
    const r = reduce(net, { fuel: FUEL, order: "parallel" });
    console.log(
      `${preset.id.padEnd(12)} ${String(before).padStart(3)} agents -> ` +
        `${String(r.finalAgents).padStart(4)}   ` +
        `interactions ${String(r.interactions).padStart(5)}   ` +
        `rounds ${String(r.rounds).padStart(4)}   ` +
        `peakPar ${String(r.peakParallelism).padStart(4)}   ` +
        `peakAgents ${String(r.peakAgents).padStart(5)}   ` +
        `loops ${r.loops}` +
        (r.fuelExhausted ? "   DIVERGED" : ""),
    );
  }
}

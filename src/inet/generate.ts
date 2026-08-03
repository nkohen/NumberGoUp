/**
 * Random net generation, for property tests and for the statistics harness
 * (`npm run inet:stats`).
 *
 * The generation strategy is deliberately dumb: create N agents, then pair up
 * their ports at random. Any pairing is a legal net, so nothing here can fail —
 * and because a shuffled pairing puts principal ports against principal ports
 * about as often as chance allows, the resulting nets have plenty of redexes.
 */
import { Rng } from "../core/rng";
import { BASE, type Alphabet } from "./alphabet";
import { Net, portsOf, type PortRef, type Sym } from "./net";
import { reduce, type ReduceOptions, type ReduceResult } from "./reduce";

export type SymbolWeights = Partial<Record<Sym, number>>;

/** Roughly the mix that produces interesting behaviour: erasers are rarer. */
export const DEFAULT_WEIGHTS: SymbolWeights = { γ: 1, δ: 1, ε: 0.4 };

export interface RandomNetOptions {
  /** Fraction of the maximum possible wiring to actually apply (0..1). Lower
   *  values leave a bigger free-port interface. Default 1. */
  wireFraction?: number;
}

function pickSymbol(rng: Rng, weights: SymbolWeights, alphabet: Alphabet): Sym {
  const entries = alphabet.symbols
    .map((s) => [s.symbol, weights[s.symbol] ?? 1] as const)
    .filter(([, w]) => w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng.next() * total;
  for (const [sym, w] of entries) {
    roll -= w;
    if (roll <= 0) return sym;
  }
  return entries[entries.length - 1][0];
}

/** Generate a well-formed random net with `agentCount` agents. */
export function randomNet(
  rng: Rng,
  agentCount: number,
  weights: SymbolWeights = DEFAULT_WEIGHTS,
  options: RandomNetOptions = {},
  alphabet: Alphabet = BASE,
): Net {
  const net = new Net(alphabet);
  const ports: PortRef[] = [];
  for (let i = 0; i < agentCount; i++) {
    const agent = net.addAgentWired(pickSymbol(rng, weights, alphabet));
    ports.push(...portsOf(agent));
  }

  const shuffled = rng.shuffle(ports);
  const maxWires = Math.floor(shuffled.length / 2);
  const wires = Math.round(maxWires * (options.wireFraction ?? 1));
  for (let i = 0; i < wires; i++) net.link(shuffled[2 * i], shuffled[2 * i + 1]);
  return net;
}

// --- Statistics ----------------------------------------------------------------

export interface NetSample extends ReduceResult {
  seed: number;
  agentCount: number;
  /** Agents at normal form divided by agents at the start. */
  growth: number;
}

/** Generate and reduce `trials` random nets of a given size. */
export function sampleNets(
  seed: number,
  trials: number,
  agentCount: number,
  weights: SymbolWeights = DEFAULT_WEIGHTS,
  reduceOptions: ReduceOptions = {},
): NetSample[] {
  const out: NetSample[] = [];
  for (let i = 0; i < trials; i++) {
    const netSeed = seed + i;
    const net = randomNet(new Rng(netSeed), agentCount, weights);
    const result = reduce(net, reduceOptions);
    out.push({
      ...result,
      seed: netSeed,
      agentCount,
      growth: result.finalAgents / Math.max(1, agentCount),
    });
  }
  return out;
}

export interface Distribution {
  n: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p90: number;
  p99: number;
  stdev: number;
  /** stdev / mean — the "is this a fat tail?" number. */
  cv: number;
}

export function describe(values: number[]): Distribution {
  if (values.length === 0) {
    return { n: 0, min: 0, max: 0, mean: 0, median: 0, p90: 0, p99: 0, stdev: 0, cv: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / sorted.length;
  const quantile = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const stdev = Math.sqrt(variance);
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median: quantile(0.5),
    p90: quantile(0.9),
    p99: quantile(0.99),
    stdev,
    cv: mean === 0 ? 0 : stdev / mean,
  };
}

/** Pearson correlation coefficient. */
export function correlation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * The reducer.
 *
 * Two agents wired principal-port-to-principal-port form an ACTIVE PAIR (a
 * redex). A net with no active pairs is in NORMAL FORM.
 *
 * For the base combinators there is no rule table. Given an active pair of
 * agents α (arity m) and β (arity n):
 *
 *   SAME SYMBOL  -> ANNIHILATE. Both agents vanish and their aux ports are
 *                   wired through pairwise: α.aux[j] ↔ β.aux[j].
 *
 *   DIFFERENT    -> COMMUTE. Each agent duplicates the other: n copies of α
 *                   (principal ports taking over β's aux wires), m copies of β
 *                   (principal ports taking over α's aux wires), cross-wired
 *                   α_k.aux[j] ↔ β_j.aux[k].
 *
 * Erasure falls out of the commutation case for free, because ε has arity 0:
 * commuting ε against an arity-m agent yields m copies of ε and 0 copies of the
 * other agent. `tests/inet/rules.test.ts` pins this against the classical six
 * rules (γγ, δδ, εε annihilate; γδ commutes; γε, δε erase).
 *
 * THE PROPERTY THAT MATTERS: interaction net reduction is strongly confluent.
 * Reducing redexes in any order — sequentially or in parallel — reaches the same
 * normal form in the same number of interactions. `tests/inet/confluence.test.ts`
 * asserts this over the presets and hundreds of random nets; it is the strongest
 * correctness signal available for this module.
 */
import { lookupRule, type Slot } from "./alphabet";
import { Rng } from "../core/rng";
import {
  aux,
  endpointKey,
  isFree,
  Net,
  NetError,
  portsOf,
  principal,
  type AgentId,
  type Endpoint,
  type Sym,
} from "./net";

export type ActivePair = [AgentId, AgentId];

/**
 * The verb an active pair will perform, or null when the alphabet has no rule
 * for the pair — in which case the redex is DEADLOCKED: permanently stuck, but
 * not an error. An alphabet can use that deliberately, as armour.
 */
export function verbFor(net: Net, a: Sym, b: Sym): string | null {
  return lookupRule(net.alphabet, a, b)?.rule.verb ?? null;
}

/** Does the alphabet know how to reduce this pair? */
export function hasRule(net: Net, pair: ActivePair): boolean {
  const a = net.agent(pair[0]);
  const b = net.agent(pair[1]);
  return !!a && !!b && lookupRule(net.alphabet, a.symbol, b.symbol) !== null;
}

/**
 * Every active pair, each listed once, with the lower agent id first.
 *
 * Note that an agent belongs to at most one active pair (it has one principal
 * port), so the pairs returned here are pairwise disjoint — which is what makes
 * `order: "parallel"` safe to execute as a batch.
 */
export function activePairs(net: Net): ActivePair[] {
  const out: ActivePair[] = [];
  for (const a of net.agents()) {
    const q = net.follow(principal(a.id));
    if (!q || isFree(q) || q.port !== 0 || q.agent === a.id) continue;
    if (q.agent > a.id) out.push([a.id, q.agent]);
  }
  return out;
}

/** The active pair `id` belongs to, if any. An agent is in at most one. */
export function pairOf(net: Net, id: AgentId): ActivePair | null {
  if (!net.hasAgent(id)) return null;
  const q = net.follow(principal(id));
  if (!q || isFree(q) || q.port !== 0 || q.agent === id) return null;
  return q.agent > id ? [id, q.agent] : [q.agent, id];
}

/**
 * Apply one rewrite in place.
 *
 * The interesting part is the rewiring. The rule is stated in terms of the aux
 * ports of agents that are about to vanish, so each "new wire" is really a
 * request to connect whatever those aux ports were attached to. We therefore
 * trace outward through the vanishing ports — alternating between the wire an
 * endpoint sits on and the substitution the rule prescribes for it — until we
 * land on an endpoint that survives. Chains collapse eagerly; no indirection
 * nodes ever enter the net.
 *
 * A trace that comes back to where it started is a closed, agent-free wire: it
 * has no surviving endpoints, so it is counted in `net.loops` and no wire is
 * created.
 *
 * Returns the agents this rewrite touched — the ones it created plus the ones it
 * rewired — which are the only agents whose redex status can have changed. The
 * result exists so {@link reduce} can maintain its worklist incrementally
 * instead of rescanning the whole net; callers that do not care may ignore it.
 */
export function step(net: Net, pair: ActivePair): AgentId[] {
  const [idA, idB] = pair;
  const a = net.agent(idA);
  const b = net.agent(idB);
  if (!a || !b) throw new NetError(`step: no such agent in pair ${idA},${idB}`);

  // Snapshot every wire incident to the pair before anything is deleted.
  const partners = new Map<string, Endpoint>();
  const deleted = new Set<string>();
  for (const p of [...portsOf(a), ...portsOf(b)]) {
    const q = net.follow(p);
    if (!q) throw new NetError(`step: dangling port ${endpointKey(p)}`);
    partners.set(endpointKey(p), q);
    deleted.add(endpointKey(p));
  }

  /** Wires the rule asks for, phrased in terms of the vanishing aux ports. */
  const pending: Array<[Endpoint, Endpoint]> = [];
  /** Wires between freshly created agents — no tracing needed. */
  const direct: Array<[Endpoint, Endpoint]> = [];
  const touched: AgentId[] = [];

  const oriented = lookupRule(net.alphabet, a.symbol, b.symbol);
  if (!oriented) throw new NetError(`step: no rule for ${a.symbol} ⋈ ${b.symbol} (deadlocked)`);
  const { rule, swap } = oriented;
  // The rule is written once per unordered pair, so half the time this agent
  // pair arrives in the other order.
  const sideA = swap ? idB : idA;
  const sideB = swap ? idA : idB;

  const created = rule.creates.map((symbol) => net.addAgent(symbol).id);
  touched.push(...created);

  const endpointOf = (slot: Slot): Endpoint =>
    slot.kind === "interface"
      ? aux(slot.side === "a" ? sideA : sideB, slot.index)
      : { agent: created[slot.agent], port: slot.port };

  for (const [x, y] of rule.links) {
    const ex = endpointOf(x);
    const ey = endpointOf(y);
    // A link touching a vanishing aux port has to be traced outward; a link
    // between two created agents can be made directly.
    if (x.kind === "interface" || y.kind === "interface") pending.push([ex, ey]);
    else direct.push([ex, ey]);
  }

  /** The rule's substitution for each vanishing port. */
  const substitution = new Map<string, Endpoint>();
  for (const [x, y] of pending) {
    if (deleted.has(endpointKey(x))) substitution.set(endpointKey(x), y);
    if (deleted.has(endpointKey(y))) substitution.set(endpointKey(y), x);
  }

  net.removeAgent(idA);
  net.removeAgent(idB);
  for (const [x, y] of direct) net.link(x, y);

  // Trace each vanishing port outward. `traced` doubles as the dedup set: a
  // chain visits every port along it, and the pending entry for any of those
  // ports would just re-derive the same wire.
  const traced = new Set<string>();
  const outward = (start: Endpoint): Endpoint | null => {
    let cur = start;
    for (;;) {
      traced.add(endpointKey(cur));
      const q = partners.get(endpointKey(cur))!;
      if (!deleted.has(endpointKey(q))) return q;
      if (traced.has(endpointKey(q))) return null; // closed loop
      traced.add(endpointKey(q));
      const s = substitution.get(endpointKey(q));
      // Only the two principal ports lack a substitution, and they are wired to
      // each other, so no chain can reach one.
      if (!s) throw new NetError(`step: no substitution for ${endpointKey(q)}`);
      if (!deleted.has(endpointKey(s))) return s;
      if (traced.has(endpointKey(s))) return null; // closed loop
      cur = s;
    }
  };

  for (const [x, y] of pending) {
    if (traced.has(endpointKey(x)) || traced.has(endpointKey(y))) continue;
    const endX = deleted.has(endpointKey(x)) ? outward(x) : x;
    const endY = deleted.has(endpointKey(y)) ? outward(y) : y;
    if (endX === null || endY === null) {
      net.loops++;
      continue;
    }
    net.link(endX, endY);
    if (!isFree(endX)) touched.push(endX.agent);
    if (!isFree(endY)) touched.push(endY.agent);
  }
  return touched;
}

/**
 * The reducer's worklist: the set of active pairs, with O(1) add, remove and
 * random access. Keeping it up to date incrementally is what stops reduction
 * from being quadratic on nets that blow up to thousands of agents.
 */
class RedexSet {
  private readonly pairs: ActivePair[] = [];
  private readonly index = new Map<string, number>();

  private static key(pair: ActivePair): string {
    return `${pair[0]}:${pair[1]}`;
  }

  get size(): number {
    return this.pairs.length;
  }

  at(i: number): ActivePair {
    return this.pairs[i];
  }

  snapshot(): ActivePair[] {
    return [...this.pairs];
  }

  add(pair: ActivePair): void {
    const key = RedexSet.key(pair);
    if (this.index.has(key)) return;
    this.index.set(key, this.pairs.length);
    this.pairs.push(pair);
  }

  remove(pair: ActivePair): void {
    const key = RedexSet.key(pair);
    const at = this.index.get(key);
    if (at === undefined) return;
    this.index.delete(key);
    const last = this.pairs.pop()!;
    if (at < this.pairs.length) {
      this.pairs[at] = last;
      this.index.set(RedexSet.key(last), at);
    }
  }
}

// --- Running to normal form ----------------------------------------------------

export type ReduceOrder = "first" | "random" | "parallel";

export interface ReduceOptions {
  /** Maximum interactions before giving up. Default 10_000. */
  fuel?: number;
  /** Redex selection strategy. Default `"first"`. */
  order?: ReduceOrder;
  /** Required by `order: "random"` so runs are reproducible. */
  rng?: Rng;
}

export interface ReduceResult {
  /** Total rewrites. Invariant across reduction orders — the canonical score. */
  interactions: number;
  /**
   * Scheduling rounds performed. Under `order: "parallel"` this is the depth of
   * the computation (how long it would take with unlimited parallelism); under a
   * sequential order it necessarily equals `interactions`.
   */
  rounds: number;
  /** Most simultaneous active pairs seen at any point. */
  peakParallelism: number;
  /** Most agents present at any point. */
  peakAgents: number;
  /** Agents remaining when reduction stopped. */
  finalAgents: number;
  /** Closed agent-free wire loops accumulated. */
  loops: number;
  fuelExhausted: boolean;
  /**
   * Active pairs the alphabet has no rule for. They are permanently stuck, so
   * reduction stops with them in place rather than looping or throwing.
   */
  deadlocked: number;
}

export const DEFAULT_FUEL = 10_000;

/** Reduce `net` IN PLACE to normal form (or until fuel runs out). */
export function reduce(net: Net, options: ReduceOptions = {}): ReduceResult {
  const fuel = options.fuel ?? DEFAULT_FUEL;
  const order = options.order ?? "first";
  const rng = options.rng;
  if (order === "random" && !rng) {
    throw new NetError('reduce: order "random" requires an rng');
  }

  let interactions = 0;
  let rounds = 0;
  let peakParallelism = 0;
  let peakAgents = net.agentCount;
  let fuelExhausted = false;

  const redexes = new RedexSet();
  let deadlocked = 0;
  for (const pair of activePairs(net)) {
    if (hasRule(net, pair)) redexes.add(pair);
    else deadlocked++;
  }

  /** Fire one redex and fold whatever it changed back into the worklist. */
  const fire = (pair: ActivePair): void => {
    redexes.remove(pair);
    for (const id of step(net, pair)) {
      const next = pairOf(net, id);
      if (!next) continue;
      if (hasRule(net, next)) redexes.add(next);
      else deadlocked++;
    }
    interactions++;
    peakAgents = Math.max(peakAgents, net.agentCount);
  };

  for (;;) {
    peakParallelism = Math.max(peakParallelism, redexes.size);
    if (redexes.size === 0) break;
    if (interactions >= fuel) {
      fuelExhausted = true;
      break;
    }
    rounds++;
    if (order === "parallel") {
      // The pairs are disjoint and each rewrite is local, so firing the whole
      // round as a batch is equivalent to firing them simultaneously. Redexes
      // created during the round belong to the next one.
      for (const pair of redexes.snapshot()) {
        if (interactions >= fuel) {
          fuelExhausted = true;
          break;
        }
        fire(pair);
      }
      if (fuelExhausted) break;
    } else {
      fire(order === "first" ? redexes.at(0) : redexes.at(rng!.int(0, redexes.size - 1)));
    }
  }

  return {
    interactions,
    rounds,
    peakParallelism,
    peakAgents,
    finalAgents: net.agentCount,
    loops: net.loops,
    fuelExhausted,
    deadlocked,
  };
}

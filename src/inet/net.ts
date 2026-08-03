/**
 * Interaction nets (Lafont 1997) — the data model.
 *
 * An interaction net is a graph of AGENTS. Every agent has one PRINCIPAL port
 * (index 0) and `arity` AUXILIARY ports (indices 1..arity). A WIRE connects
 * exactly two ports. A port that is not attached to an agent is a FREE port —
 * the collection of free ports is the net's interface.
 *
 * The three base combinators:
 *
 *   γ  constructor  arity 2
 *   δ  duplicator   arity 2
 *   ε  eraser       arity 0
 *
 * Design notes (the three things naive implementations get wrong):
 *
 * 1. AGENT-FREE WIRES are legal. Rewriting connects the *partners* of the aux
 *    ports of the agents it deletes, and both partners can be free ports, which
 *    leaves a wire with no agent on either end. We model wires as symmetric
 *    links between endpoints (not as edges of an agent graph), so such a wire is
 *    just an ordinary entry in the link map.
 *
 * 2. WIRE CHAINS are collapsed EAGERLY. There are no indirection/"wire" nodes in
 *    the net at any point. Instead {@link Net.link} always attaches two real
 *    endpoints, and the reducer (see `reduce.ts`) traces each dangling end
 *    *through* the vanishing agents before it creates a wire. The trade-off:
 *    rewriting does a little pointer chasing, but the net never needs a
 *    compaction pass and `assertWellFormed` holds after every single rewrite.
 *
 * 3. SELF-LOOPS / closed wires are legal and are not represented as links at
 *    all: a wire that closes on itself has no endpoints left to store, so the
 *    net just counts them in {@link Net.loops}. Reduction of a closed loop is a
 *    no-op, which is exactly right — a loop has no agents to interact.
 *
 * This module is pure: no DOM, no rendering, no game concepts.
 */

export type { Sym } from "./alphabet";
import { arityOf, BASE, type Alphabet, type Sym } from "./alphabet";

/** The base combinators, for callers that just want the default alphabet. */
export const SYMBOLS: readonly Sym[] = BASE.symbols.map((s) => s.symbol);

export type AgentId = number;

export interface Agent {
  readonly id: AgentId;
  readonly symbol: Sym;
  readonly arity: number;
}

/** Port 0 is the principal port; 1..arity are the auxiliary ports. */
export interface PortRef {
  readonly agent: AgentId;
  readonly port: number;
}

/** A free port of the net's interface, identified by a stable id. */
export interface FreeRef {
  readonly free: number;
}

export type Endpoint = PortRef | FreeRef;

export function isFree(e: Endpoint): e is FreeRef {
  return (e as FreeRef).free !== undefined;
}

/** The principal port of an agent. */
export function principal(agent: AgentId): PortRef {
  return { agent, port: 0 };
}

/** The `i`-th auxiliary port (0-based) of an agent, i.e. port index `i + 1`. */
export function aux(agent: AgentId, i: number): PortRef {
  return { agent, port: i + 1 };
}

export function isPrincipal(e: Endpoint): boolean {
  return !isFree(e) && e.port === 0;
}

/** Stable string key for an endpoint — the identity used by the link map. */
export function endpointKey(e: Endpoint): string {
  return isFree(e) ? `f${e.free}` : `${e.agent}:${e.port}`;
}

export function endpointFromKey(key: string): Endpoint {
  if (key.startsWith("f")) return { free: Number(key.slice(1)) };
  const [a, p] = key.split(":");
  return { agent: Number(a), port: Number(p) };
}

export function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
  return endpointKey(a) === endpointKey(b);
}

/** All ports of an agent, principal first. */
export function portsOf(agent: Agent): PortRef[] {
  const out: PortRef[] = [principal(agent.id)];
  for (let i = 0; i < agent.arity; i++) out.push(aux(agent.id, i));
  return out;
}

export class NetError extends Error {}

export class Net {
  /**
   * The symbols and rules this net is written in. Everything about what the net
   * MEANS lives here rather than in the model, so an alternative alphabet is a
   * value you pass in rather than a fork of the reducer.
   */
  readonly alphabet: Alphabet;

  constructor(alphabet: Alphabet = BASE) {
    this.alphabet = alphabet;
  }

  private readonly agentMap = new Map<AgentId, Agent>();
  /** Symmetric: `links[key(a)] === b` iff `links[key(b)] === a`. */
  private readonly links = new Map<string, Endpoint>();
  private readonly freeSet = new Set<number>();
  private nextAgentId = 0;
  private nextFreeId = 0;

  /**
   * Number of closed, agent-free wire loops the net has accumulated. These are
   * produced by rewriting (see pitfall 3 above) and are inert.
   */
  loops = 0;

  // --- Inspection -------------------------------------------------------------

  get agentCount(): number {
    return this.agentMap.size;
  }

  /** Agents in creation order. */
  agents(): Agent[] {
    return [...this.agentMap.values()];
  }

  agent(id: AgentId): Agent | undefined {
    return this.agentMap.get(id);
  }

  hasAgent(id: AgentId): boolean {
    return this.agentMap.has(id);
  }

  /** Free-port ids, ascending. */
  freePorts(): number[] {
    return [...this.freeSet].sort((a, b) => a - b);
  }

  /** The endpoint on the other end of `e`'s wire, if it has one. */
  follow(e: Endpoint): Endpoint | undefined {
    return this.links.get(endpointKey(e));
  }

  /** Every wire, each listed once, as an unordered pair. */
  wires(): Array<[Endpoint, Endpoint]> {
    const seen = new Set<string>();
    const out: Array<[Endpoint, Endpoint]> = [];
    for (const [k, other] of this.links) {
      if (seen.has(k)) continue;
      seen.add(k);
      seen.add(endpointKey(other));
      out.push([endpointFromKey(k), other]);
    }
    return out;
  }

  /** Ports with no wire attached. Empty in a well-formed net. */
  danglingPorts(): Endpoint[] {
    const out: Endpoint[] = [];
    for (const a of this.agentMap.values()) {
      for (const p of portsOf(a)) if (!this.links.has(endpointKey(p))) out.push(p);
    }
    for (const f of this.freeSet) if (!this.links.has(`f${f}`)) out.push({ free: f });
    return out;
  }

  // --- Construction -----------------------------------------------------------

  /**
   * Add an agent whose ports are all left DANGLING. The caller is responsible
   * for wiring every port before the net is well-formed again; this is the
   * entry point the reducer uses, since it wires everything it creates.
   * Interactive/authoring code wants {@link addAgentWired} instead.
   */
  addAgent(symbol: Sym): Agent {
    const agent: Agent = {
      id: this.nextAgentId++,
      symbol,
      arity: arityOf(this.alphabet, symbol),
    };
    this.agentMap.set(agent.id, agent);
    return agent;
  }

  /** Add an agent with a fresh free port on each of its ports. */
  addAgentWired(symbol: Sym): Agent {
    const agent = this.addAgent(symbol);
    for (const p of portsOf(agent)) this.link(p, this.addFree());
    return agent;
  }

  /**
   * Allocate a free-port id. The returned endpoint has no wire yet — link it to
   * something before calling {@link assertWellFormed}.
   */
  addFree(): FreeRef {
    const f: FreeRef = { free: this.nextFreeId++ };
    this.freeSet.add(f.free);
    return f;
  }

  /**
   * Wire `a` to `b`, breaking whatever either was attached to.
   *
   * Detaching maintains the invariant "every agent port has exactly one
   * partner": an agent port orphaned by this call is given a fresh free port.
   * A free port orphaned by this call is garbage-collected, since a free port is
   * nothing but one end of a wire.
   *
   * `a === b` is allowed: it stores a wire that closes on itself, which is a
   * legal (if inert) piece of an interaction net. That is a different thing from
   * {@link loops}, which counts closed wires with no endpoints left at all.
   */
  link(a: Endpoint, b: Endpoint): void {
    this.detach(a, b);
    this.detach(b, a);
    this.links.set(endpointKey(a), b);
    this.links.set(endpointKey(b), a);
    if (isFree(a)) this.freeSet.add(a.free);
    if (isFree(b)) this.freeSet.add(b.free);
  }

  /**
   * Cut `e`'s wire. Agent ports on either end get a fresh free port so the net
   * stays well-formed; free ports on either end disappear with the wire.
   */
  unlink(e: Endpoint): void {
    const q = this.follow(e);
    if (!q) return;
    this.links.delete(endpointKey(e));
    this.links.delete(endpointKey(q));
    for (const end of sameEndpoint(e, q) ? [e] : [e, q]) this.orphan(end);
  }

  /**
   * Remove an agent, leaving its partners DANGLING. Only the reducer should use
   * this (it immediately rewires them); interactive code wants
   * {@link deleteAgent}.
   */
  removeAgent(id: AgentId): void {
    const agent = this.agentMap.get(id);
    if (!agent) return;
    for (const p of portsOf(agent)) {
      const q = this.links.get(endpointKey(p));
      this.links.delete(endpointKey(p));
      if (q) this.links.delete(endpointKey(q));
    }
    this.agentMap.delete(id);
  }

  /**
   * Remove an agent, leaving a free port on any agent port it was attached to.
   * Wires that ran from the agent to a free port disappear along with that free
   * port — a free port is only ever one end of a wire.
   */
  deleteAgent(id: AgentId): void {
    const agent = this.agentMap.get(id);
    if (!agent) return;
    for (const p of portsOf(agent)) {
      const q = this.links.get(endpointKey(p));
      this.links.delete(endpointKey(p));
      if (!q) continue;
      this.links.delete(endpointKey(q));
      if (!sameEndpoint(q, p)) this.orphan(q);
    }
    this.agentMap.delete(id);
  }

  // --- Invariants -------------------------------------------------------------

  /**
   * Throws unless every port (agent or free) has exactly one partner and every
   * link is symmetric. Call it after every rewrite in tests.
   */
  assertWellFormed(context = ""): void {
    const where = context ? ` (${context})` : "";
    const fail = (msg: string): never => {
      throw new NetError(`${msg}${where}\n${this.toString()}`);
    };

    const expected = new Set<string>();
    for (const a of this.agentMap.values()) {
      for (const p of portsOf(a)) expected.add(endpointKey(p));
    }
    for (const f of this.freeSet) expected.add(`f${f}`);

    for (const key of expected) {
      const q = this.links.get(key);
      if (!q) fail(`port ${key} has no partner`);
      const back = this.links.get(endpointKey(q!));
      if (!back) fail(`partner ${endpointKey(q!)} of ${key} has no partner`);
      if (endpointKey(back!) !== key) {
        fail(`link is not symmetric: ${key} -> ${endpointKey(q!)} -> ${endpointKey(back!)}`);
      }
    }

    for (const key of this.links.keys()) {
      if (!expected.has(key)) fail(`link map has a stale entry for ${key}`);
      const e = endpointFromKey(key);
      if (!isFree(e)) {
        const owner = this.agentMap.get(e.agent);
        if (!owner) fail(`link ${key} refers to a missing agent`);
        if (e.port > owner!.arity) fail(`link ${key} refers to a port beyond the arity`);
      }
    }
  }

  // --- Copying & identity -----------------------------------------------------

  clone(): Net {
    const copy = new Net(this.alphabet);
    for (const a of this.agentMap.values()) copy.agentMap.set(a.id, a);
    for (const [k, v] of this.links) copy.links.set(k, v);
    for (const f of this.freeSet) copy.freeSet.add(f);
    copy.nextAgentId = this.nextAgentId;
    copy.nextFreeId = this.nextFreeId;
    copy.loops = this.loops;
    return copy;
  }

  /**
   * A canonical string for the net, up to renaming of agents.
   *
   * Agents are numbered by a breadth-first walk that starts at the free ports in
   * ascending id order, so two nets that are isomorphic *fixing the interface*
   * produce the same signature. Reduction never creates or destroys free ports,
   * so the interface is stable across reduction orders — which makes this a
   * usable equality test for the confluence property.
   *
   * Caveat: agents unreachable from the interface (possible only inside a
   * "vicious circle" of principal ports) are not canonically ordered, so they
   * are summarised by their symbol counts rather than their structure.
   */
  signature(): string {
    const canon = new Map<AgentId, number>();
    const queue: AgentId[] = [];
    const describe = (e: Endpoint | undefined): string => {
      if (!e) return "!";
      if (isFree(e)) return `f${e.free}`;
      let c = canon.get(e.agent);
      if (c === undefined) {
        c = canon.size;
        canon.set(e.agent, c);
        queue.push(e.agent);
      }
      return `a${c}.${e.port}`;
    };

    const lines: string[] = [];
    for (const f of this.freePorts()) lines.push(`f${f} = ${describe(this.follow({ free: f }))}`);
    for (let i = 0; i < queue.length; i++) {
      const agent = this.agentMap.get(queue[i])!;
      const ports = portsOf(agent).map((p) => describe(this.follow(p)));
      lines.push(`a${canon.get(agent.id)} ${agent.symbol}(${ports.join(", ")})`);
    }

    const unreachable: Record<string, number> = {};
    for (const a of this.agentMap.values()) {
      if (!canon.has(a.id)) unreachable[a.symbol] = (unreachable[a.symbol] ?? 0) + 1;
    }
    const extra = Object.keys(unreachable)
      .sort()
      .map((s) => `${s}x${unreachable[s]}`);
    if (extra.length) lines.push(`unreachable: ${extra.join(",")}`);
    lines.push(`loops=${this.loops}`);
    return lines.join("\n");
  }

  toString(): string {
    const lines = [`agents=${this.agentCount} free=${this.freeSet.size} loops=${this.loops}`];
    for (const a of this.agentMap.values()) {
      const ports = portsOf(a).map((p) => {
        const q = this.follow(p);
        return q ? endpointKey(q) : "-";
      });
      lines.push(`  ${a.id} ${a.symbol}(${ports.join(", ")})`);
    }
    return lines.join("\n");
  }

  // --- Internals --------------------------------------------------------------

  /** Break `e`'s wire in preparation for re-wiring it to `keep`. */
  private detach(e: Endpoint, keep: Endpoint): void {
    const q = this.links.get(endpointKey(e));
    if (!q) return;
    this.links.delete(endpointKey(e));
    this.links.delete(endpointKey(q));
    if (sameEndpoint(q, keep)) return; // already wired to the intended partner
    this.orphan(q);
  }

  /** Give an orphaned agent port a fresh free port; drop an orphaned free port. */
  private orphan(e: Endpoint): void {
    if (isFree(e)) {
      this.freeSet.delete(e.free);
      return;
    }
    if (!this.agentMap.has(e.agent)) return;
    const f = this.addFree();
    this.links.set(endpointKey(e), f);
    this.links.set(endpointKey(f), e);
  }
}

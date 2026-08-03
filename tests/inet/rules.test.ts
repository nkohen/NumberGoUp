import { describe, it, expect } from "vitest";
import {
  Net,
  aux,
  isFree,
  principal,
  SYMBOLS,
  type AgentId,
  type Sym,
} from "../../src/inet/net";
import { activePairs, step, verbFor } from "../../src/inet/reduce";

/** Two agents wired principal-to-principal; every aux port sits on a free port. */
function redex(a: Sym, b: Sym): { net: Net; a: AgentId; b: AgentId } {
  const net = new Net();
  const x = net.addAgentWired(a);
  const y = net.addAgentWired(b);
  net.link(principal(x.id), principal(y.id));
  net.assertWellFormed("redex");
  return { net, a: x.id, b: y.id };
}

describe("the three rewrites", () => {
  it("annihilates a γγ pair, threading the aux wires through", () => {
    const { net, a, b } = redex("γ", "γ");
    const ends = [
      net.follow(aux(a, 0))!,
      net.follow(aux(a, 1))!,
      net.follow(aux(b, 0))!,
      net.follow(aux(b, 1))!,
    ];
    step(net, [a, b]);
    net.assertWellFormed("after γγ");

    expect(net.agentCount).toBe(0);
    expect(net.loops).toBe(0);
    // α.aux[j] is now wired to β.aux[j] — i.e. their former partners are joined.
    expect(net.follow(ends[0])).toEqual(ends[2]);
    expect(net.follow(ends[1])).toEqual(ends[3]);
    // Both surviving ends are free ports: this is an agent-free wire.
    expect(ends.every(isFree)).toBe(true);
    expect(net.wires()).toHaveLength(2);
  });

  it("annihilates an εε pair into nothing", () => {
    const { net, a, b } = redex("ε", "ε");
    step(net, [a, b]);
    net.assertWellFormed("after εε");
    expect(net.agentCount).toBe(0);
    expect(net.freePorts()).toHaveLength(0);
    expect(net.wires()).toHaveLength(0);
  });

  it("commutes a γδ pair into four agents", () => {
    const { net, a, b } = redex("γ", "δ");
    const aEnds = [net.follow(aux(a, 0))!, net.follow(aux(a, 1))!];
    const bEnds = [net.follow(aux(b, 0))!, net.follow(aux(b, 1))!];
    step(net, [a, b]);
    net.assertWellFormed("after γδ");

    expect(net.agentCount).toBe(4);
    const symbols = net.agents().map((x) => x.symbol).sort();
    expect(symbols).toEqual(["γ", "γ", "δ", "δ"]);

    // Each of γ's former aux wires now ends on the principal port of a δ copy,
    // and vice versa.
    for (const end of aEnds) {
      const p = net.follow(end)!;
      expect(isFree(p)).toBe(false);
      if (!isFree(p)) {
        expect(p.port).toBe(0);
        expect(net.agent(p.agent)!.symbol).toBe("δ");
      }
    }
    for (const end of bEnds) {
      const p = net.follow(end)!;
      expect(isFree(p)).toBe(false);
      if (!isFree(p)) {
        expect(p.port).toBe(0);
        expect(net.agent(p.agent)!.symbol).toBe("γ");
      }
    }
    // The four copies form a complete bipartite square: every γ copy is wired
    // to every δ copy, and no wire in the square touches a free port.
    const gammas = net.agents().filter((x) => x.symbol === "γ");
    const deltas = net.agents().filter((x) => x.symbol === "δ");
    for (const g of gammas) {
      const seen = new Set<AgentId>();
      for (let i = 0; i < 2; i++) {
        const q = net.follow(aux(g.id, i))!;
        expect(isFree(q)).toBe(false);
        if (!isFree(q)) seen.add(q.agent);
      }
      expect([...seen].sort()).toEqual(deltas.map((d) => d.id).sort());
    }
  });

  it("erases: ε against γ leaves two erasers on the former aux wires", () => {
    const { net, a, b } = redex("ε", "γ");
    const ends = [net.follow(aux(b, 0))!, net.follow(aux(b, 1))!];
    step(net, [a, b]);
    net.assertWellFormed("after εγ");

    expect(net.agentCount).toBe(2);
    expect(net.agents().every((x) => x.symbol === "ε")).toBe(true);
    for (const end of ends) {
      const p = net.follow(end)!;
      expect(isFree(p)).toBe(false);
      if (!isFree(p)) {
        expect(p.port).toBe(0);
        expect(net.agent(p.agent)!.symbol).toBe("ε");
      }
    }
  });

  it("produces closed loops instead of crashing when a rewrite short-circuits", () => {
    const net = new Net();
    const x = net.addAgentWired("γ");
    const y = net.addAgentWired("γ");
    net.link(principal(x.id), principal(y.id));
    net.link(aux(x.id, 0), aux(y.id, 0));
    net.link(aux(x.id, 1), aux(y.id, 1));
    expect(net.freePorts()).toHaveLength(0);

    step(net, [x.id, y.id]);
    net.assertWellFormed("after looping γγ");
    expect(net.agentCount).toBe(0);
    expect(net.wires()).toHaveLength(0);
    expect(net.loops).toBe(2);
  });

  it("collapses a chain of vanishing ports into a single wire", () => {
    // γ0.aux0 — γ1.aux0, with γ1 also facing γ0? No: build a chain across two
    // redexes so that annihilating one pair must trace through the other's
    // former ports. Here x.aux0 is wired to y.aux1, so annihilating x against y
    // joins x.aux1's partner to y.aux0's partner directly.
    const net = new Net();
    const x = net.addAgentWired("δ");
    const y = net.addAgentWired("δ");
    net.link(principal(x.id), principal(y.id));
    net.link(aux(x.id, 0), aux(y.id, 1));
    const leftEnd = net.follow(aux(x.id, 1))!;
    const rightEnd = net.follow(aux(y.id, 0))!;

    step(net, [x.id, y.id]);
    net.assertWellFormed("after chained δδ");
    expect(net.agentCount).toBe(0);
    expect(net.loops).toBe(0);
    expect(net.follow(leftEnd)).toEqual(rightEnd);
    expect(net.wires()).toHaveLength(1);
  });
});

// --- Uniform formulation vs the classical six rules -----------------------------

/**
 * The six rules of the base system, transcribed one at a time exactly as they
 * are stated in the literature — no arity arithmetic, no shared formula. This
 * exists purely to check the uniform equal/differ rule in `reduce.ts` against an
 * independently written statement of the same thing.
 *
 * It assumes the canonical redex shape: both agents' aux ports are wired to
 * distinct free ports, so no wire chasing is needed.
 */
function classicalStep(net: Net, idA: AgentId, idB: AgentId): void {
  const a = net.agent(idA)!;
  const b = net.agent(idB)!;
  const outer = (id: AgentId, i: number) => {
    const q = net.follow(aux(id, i))!;
    if (!isFree(q)) throw new Error("classicalStep expects a canonical redex");
    return q;
  };

  const pair = `${a.symbol}${b.symbol}`;
  if (pair === "γγ" || pair === "δδ") {
    // Annihilation: the two agents disappear and their aux wires are joined
    // straight through, first to first and second to second.
    const a1 = outer(idA, 0);
    const a2 = outer(idA, 1);
    const b1 = outer(idB, 0);
    const b2 = outer(idB, 1);
    net.removeAgent(idA);
    net.removeAgent(idB);
    net.link(a1, b1);
    net.link(a2, b2);
    return;
  }
  if (pair === "εε") {
    // Two erasers meeting simply vanish.
    net.removeAgent(idA);
    net.removeAgent(idB);
    return;
  }
  if (pair === "γδ" || pair === "δγ") {
    // Commutation: four agents in a square. Writing γ's aux wires as a1, a2 and
    // δ's as b1, b2, the result is
    //   a copy of δ on a1 with aux (p, q)
    //   a copy of δ on a2 with aux (r, s)
    //   a copy of γ on b1 with aux (p, r)
    //   a copy of γ on b2 with aux (q, s)
    const [g, d] = a.symbol === "γ" ? [idA, idB] : [idB, idA];
    const a1 = outer(g, 0);
    const a2 = outer(g, 1);
    const b1 = outer(d, 0);
    const b2 = outer(d, 1);
    net.removeAgent(g);
    net.removeAgent(d);
    const dOnA1 = net.addAgent("δ").id;
    const dOnA2 = net.addAgent("δ").id;
    const gOnB1 = net.addAgent("γ").id;
    const gOnB2 = net.addAgent("γ").id;
    net.link(principal(dOnA1), a1);
    net.link(principal(dOnA2), a2);
    net.link(principal(gOnB1), b1);
    net.link(principal(gOnB2), b2);
    net.link(aux(dOnA1, 0), aux(gOnB1, 0)); // p
    net.link(aux(dOnA1, 1), aux(gOnB2, 0)); // q
    net.link(aux(dOnA2, 0), aux(gOnB1, 1)); // r
    net.link(aux(dOnA2, 1), aux(gOnB2, 1)); // s
    return;
  }
  // Erasure: ε against a binary agent leaves an ε on each of its aux wires.
  const [e, other] = a.symbol === "ε" ? [idA, idB] : [idB, idA];
  const o1 = outer(other, 0);
  const o2 = outer(other, 1);
  net.removeAgent(e);
  net.removeAgent(other);
  net.link(principal(net.addAgent("ε").id), o1);
  net.link(principal(net.addAgent("ε").id), o2);
}

describe("uniform rule vs the classical six", () => {
  const pairs: Array<[Sym, Sym]> = [];
  for (const a of SYMBOLS) for (const b of SYMBOLS) pairs.push([a, b]);

  for (const [symA, symB] of pairs) {
    it(`${symA} ⋈ ${symB} agrees with the classical rule`, () => {
      const uniform = redex(symA, symB);
      const classical = redex(symA, symB);
      // Both nets are built identically, so their free-port ids line up and the
      // signatures are directly comparable.
      expect(uniform.net.signature()).toBe(classical.net.signature());

      expect(activePairs(uniform.net)).toEqual([[uniform.a, uniform.b]]);
      step(uniform.net, [uniform.a, uniform.b]);
      classicalStep(classical.net, classical.a, classical.b);

      uniform.net.assertWellFormed("uniform");
      classical.net.assertWellFormed("classical");
      expect(uniform.net.signature()).toBe(classical.net.signature());
      expect(uniform.net.agentCount).toBe(classical.net.agentCount);
    });
  }

  it("classifies every pair the way the six rules do", () => {
    const net = new Net();
    expect(verbFor(net, "γ", "γ")).toBe("annihilate");
    expect(verbFor(net, "δ", "δ")).toBe("annihilate");
    expect(verbFor(net, "ε", "ε")).toBe("annihilate");
    expect(verbFor(net, "γ", "δ")).toBe("commute");
    // Erasure is commutation at arity 0; the base alphabet labels it separately
    // only so the analysis harness can tell the two apart.
    expect(verbFor(net, "γ", "ε")).toBe("erase");
    expect(verbFor(net, "δ", "ε")).toBe("erase");
  });
});

import { describe, it, expect } from "vitest";
import { Rng } from "../../src/core/rng";
import { aux, endpointKey, isFree, Net, principal } from "../../src/inet/net";
import { layoutForest } from "../../src/inet/layout";
import { PRESETS } from "../../src/inet/presets";
import { randomNet } from "../../src/inet/generate";
import { reduce } from "../../src/inet/reduce";

/**
 * The decomposition has to be lossless: every agent placed exactly once, and
 * every wire accounted for exactly once as a tree edge, a stub, an arc or a
 * loose wire. If it isn't, the renderer silently drops part of the net.
 */
function expectRoundTrip(net: Net, label: string): void {
  const layout = layoutForest(net);

  // Every agent placed exactly once.
  expect(new Set(layout.agents.map((a) => a.id)).size).toBe(net.agentCount);
  expect(layout.agents).toHaveLength(net.agentCount);

  // Every agent has an anchor for its principal port, and every stub/arc end
  // refers to a real port.
  for (const a of layout.agents) {
    expect(layout.anchors.has(endpointKey(principal(a.id)))).toBe(true);
  }

  // Partition the wires.
  const claimed = new Map<string, string>();
  const claim = (key: string, by: string): void => {
    expect(`${key} claimed by ${claimed.get(key) ?? by}`).toBe(`${key} claimed by ${by}`);
    claimed.set(key, by);
  };
  const wireKey = (a: { toString(): string }, b: { toString(): string }): string =>
    [String(a), String(b)].sort().join("~");

  for (const e of layout.edges) {
    claim(wireKey(endpointKey(aux(e.parent, e.aux)), endpointKey(principal(e.child))), "edge");
  }
  for (const s of layout.stubs) {
    // A stub whose partner is not a free port is only a position holder for one
    // end of an arc; the arc claims that wire.
    if (s.freeId === null) continue;
    const partner = net.follow(s.port)!;
    claim(wireKey(endpointKey(s.port), endpointKey(partner)), "stub");
  }
  for (const arc of layout.arcs) {
    claim(wireKey(endpointKey(arc.a), endpointKey(arc.b)), "arc");
  }
  for (const [a, b] of layout.looseWires) {
    claim(wireKey(endpointKey(a), endpointKey(b)), "loose");
  }

  const actual = net.wires().map(([a, b]) => wireKey(endpointKey(a), endpointKey(b)));
  expect(`${label}: ${[...claimed.keys()].sort().join(" ")}`).toBe(
    `${label}: ${[...actual].sort().join(" ")}`,
  );

  // Every arc end and every stub has a position.
  for (const arc of layout.arcs) {
    expect(layout.anchors.has(endpointKey(arc.a))).toBe(true);
    expect(layout.anchors.has(endpointKey(arc.b))).toBe(true);
  }

  // The forest really is a forest: following parents always terminates.
  const parent = new Map(layout.agents.map((a) => [a.id, a.parent?.id ?? null]));
  for (const a of layout.agents) {
    const seen = new Set<number>();
    let cur: number | null = a.id;
    while (cur !== null) {
      expect(seen.has(cur)).toBe(false);
      seen.add(cur);
      cur = parent.get(cur) ?? null;
    }
  }
}

describe("forest decomposition", () => {
  it("lays out a single agent with all ports free", () => {
    const net = new Net();
    const g = net.addAgentWired("γ");
    const layout = layoutForest(net);
    expect(layout.agents).toHaveLength(1);
    expect(layout.agents[0].parent).toBeNull();
    expect(layout.trees).toBe(1);
    // Two aux stubs below plus one principal stub above.
    expect(layout.stubs).toHaveLength(3);
    expect(layout.stubs.filter((s) => s.up)).toHaveLength(1);
    expect(layout.arcs).toHaveLength(0);
    expectRoundTrip(net, "single agent");
    void g;
  });

  it("hangs children off aux ports and calls an active pair an equation", () => {
    const net = new Net();
    const top = net.addAgentWired("γ");
    const kid = net.addAgentWired("δ");
    const other = net.addAgentWired("γ");
    net.link(aux(top.id, 0), principal(kid.id));
    net.link(principal(top.id), principal(other.id));

    const layout = layoutForest(net);
    expect(layout.edges).toEqual([{ parent: top.id, aux: 0, child: kid.id }]);
    const child = layout.agents.find((a) => a.id === kid.id)!;
    expect(child.parent).toEqual({ id: top.id, aux: 0 });
    expect(child.depth).toBe(1);
    expect(layout.arcs).toHaveLength(1);
    expect(layout.arcs[0].kind).toBe("equation");
    expect(layout.trees).toBe(2);
    expectRoundTrip(net, "pair");
  });

  it("breaks a cycle into a root plus a back-arc", () => {
    // A tight loop: γ's principal hangs off δ's aux, and δ's principal hangs off
    // γ's aux. Neither can be the other's ancestor, so one edge has to go.
    const net = new Net();
    const g = net.addAgentWired("γ");
    const d = net.addAgentWired("δ");
    net.link(principal(g.id), aux(d.id, 0));
    net.link(principal(d.id), aux(g.id, 0));

    const layout = layoutForest(net);
    expect(layout.agents).toHaveLength(2);
    expect(layout.agents.filter((a) => a.parent === null)).toHaveLength(1);
    expect(layout.edges).toHaveLength(1);
    expect(layout.arcs).toHaveLength(1);
    expect(layout.arcs[0].kind).toBe("back");
    expectRoundTrip(net, "2-cycle");
  });

  it("breaks a self-loop (principal wired to its own aux port)", () => {
    const net = new Net();
    const g = net.addAgentWired("γ");
    net.link(principal(g.id), aux(g.id, 1));
    const layout = layoutForest(net);
    expect(layout.agents).toHaveLength(1);
    expect(layout.agents[0].parent).toBeNull();
    expect(layout.arcs.map((a) => a.kind)).toEqual(["back"]);
    expectRoundTrip(net, "self-loop");
  });

  it("breaks a longer cycle deterministically", () => {
    const net = new Net();
    const ids = [0, 1, 2].map(() => net.addAgentWired("γ").id);
    for (let i = 0; i < 3; i++) {
      net.link(principal(ids[i]), aux(ids[(i + 1) % 3], 0));
    }
    const first = layoutForest(net);
    const second = layoutForest(net);
    expect(first.agents.map((a) => a.parent?.id ?? null)).toEqual(
      second.agents.map((a) => a.parent?.id ?? null),
    );
    expect(first.arcs.filter((a) => a.kind === "back")).toHaveLength(1);
    expectRoundTrip(net, "3-cycle");
  });

  it("calls an aux-to-aux wire a cross arc", () => {
    const net = new Net();
    const a = net.addAgentWired("γ");
    const b = net.addAgentWired("γ");
    net.link(aux(a.id, 0), aux(b.id, 1));
    const layout = layoutForest(net);
    expect(layout.arcs.map((x) => x.kind)).toEqual(["cross"]);
    expectRoundTrip(net, "cross");
  });

  it("keeps agent-free wires rather than losing them", () => {
    const net = new Net();
    const f1 = net.addFree();
    const f2 = net.addFree();
    net.link(f1, f2);
    const layout = layoutForest(net);
    expect(layout.agents).toHaveLength(0);
    expect(layout.looseWires).toHaveLength(1);
    expectRoundTrip(net, "loose");
  });

  it("round-trips every preset, before and after reduction", () => {
    for (const preset of PRESETS) {
      const net = preset.build();
      expectRoundTrip(net, `${preset.id} (initial)`);
      reduce(net, { fuel: 200 });
      expectRoundTrip(net, `${preset.id} (reduced)`);
    }
  });

  it("round-trips random nets, which are full of cycles", () => {
    let withCycles = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const net = randomNet(new Rng(seed * 31337), 10);
      const layout = layoutForest(net);
      if (layout.arcs.some((a) => a.kind === "back")) withCycles++;
      expectRoundTrip(net, `random ${seed}`);
      reduce(net, { fuel: 300 });
      expectRoundTrip(net, `random ${seed} reduced`);
    }
    // The sample has to actually exercise the cycle-breaking path.
    expect(withCycles).toBeGreaterThan(0);
  });

  it("gives every free port an anchor unless it is on a loose wire", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const net = randomNet(new Rng(seed * 7717), 8, undefined, { wireFraction: 0.6 });
      const layout = layoutForest(net);
      const loose = new Set(
        layout.looseWires.flatMap(([a, b]) => [endpointKey(a), endpointKey(b)]),
      );
      for (const f of net.freePorts()) {
        const key = `f${f}`;
        if (loose.has(key)) continue;
        const partner = net.follow({ free: f })!;
        // Non-loose free ports always sit opposite an agent port, so the stub
        // for that port is their position.
        expect(isFree(partner)).toBe(false);
        expect(layout.anchors.has(key)).toBe(true);
      }
    }
  });
});

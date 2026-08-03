import { describe, it, expect } from "vitest";
import { Rng } from "../../src/core/rng";
import { aux, Net, principal, portsOf, type AgentId } from "../../src/inet/net";
import { randomNet } from "../../src/inet/generate";
import {
  attachPoint,
  endpointPoint,
  outlineDirections,
  energy,
  portBaseAngle,
  portDirection,
  relaxStep,
  restAngle,
  turnToward,
  type Placements,
} from "../../src/inet/relax";

const R = 20;

/** Give every agent and free port a placement, jumbled by the seeded rng. */
function scatter(net: Net, seed: number, spread = 300): Placements {
  const rng = new Rng(seed);
  const places: Placements = { agents: new Map(), free: new Map() };
  for (const agent of net.agents()) {
    places.agents.set(agent.id, {
      x: rng.next() * spread,
      y: rng.next() * spread,
      angle: rng.next() * Math.PI * 2,
      anchor: null,
    });
  }
  for (const f of net.freePorts()) {
    places.free.set(f, { x: rng.next() * spread, y: rng.next() * spread, angle: 0 });
  }
  return places;
}

function relax(net: Net, places: Placements, sweeps: number): void {
  for (let i = 0; i < sweeps; i++) relaxStep(net, places, { radius: R });
}

describe("port geometry", () => {
  it("puts the principal port up and the aux ports down when unrotated", () => {
    expect(portDirection(2, 0)).toEqual({ x: expect.closeTo(0, 6), y: -1 });
    const a0 = portDirection(2, 1);
    const a1 = portDirection(2, 2);
    expect(a0.y).toBeGreaterThan(0);
    expect(a1.y).toBeGreaterThan(0);
    expect(a0.x).toBeLessThan(0); // aux 0 down-left
    expect(a1.x).toBeGreaterThan(0); // aux 1 down-right
  });

  it("rotates every port with the agent", () => {
    const turned = portDirection(2, 0, Math.PI / 2); // apex now points right
    expect(turned.x).toBeCloseTo(1, 6);
    expect(turned.y).toBeCloseTo(0, 6);
  });

  it("attaches wires at the corner, one radius out", () => {
    const p = attachPoint({ x: 100, y: 100, angle: 0 }, 2, 0, R);
    expect(p).toEqual({ x: expect.closeTo(100, 6), y: 80 });
  });

  it("points a one-port shape at its PRINCIPAL port, however it is rotated", () => {
    // Regression: the outline used to sort vertices by angle, and atan2 wraps to
    // (-pi, pi], so past a certain rotation the auxiliary port sorted first and
    // an arity-1 agent drew its point backwards.
    for (let step = 0; step < 32; step++) {
      const angle = (step / 32) * Math.PI * 2 - Math.PI;
      for (const arity of [0, 1]) {
        const dirs = outlineDirections(arity, angle);
        expect(dirs).toHaveLength(1);
        const principal = portDirection(arity, 0, angle);
        expect(dirs[0].x).toBeCloseTo(principal.x, 9);
        expect(dirs[0].y).toBeCloseTo(principal.y, 9);
      }
    }
  });

  it("orders a three-port outline into a simple polygon at any rotation", () => {
    for (let step = 0; step < 16; step++) {
      const angle = (step / 16) * Math.PI * 2 - Math.PI;
      const dirs = outlineDirections(2, angle);
      expect(dirs).toHaveLength(3);
      // Every port must appear exactly once, whatever the ordering.
      for (let port = 0; port <= 2; port++) {
        const want = portDirection(2, port, angle);
        const hits = dirs.filter(
          (d) => Math.abs(d.x - want.x) < 1e-9 && Math.abs(d.y - want.y) < 1e-9,
        );
        expect(hits).toHaveLength(1);
      }
      // Angles are non-decreasing, which is what makes the outline non-self-intersecting.
      const angles = dirs.map((d) => Math.atan2(d.y, d.x));
      for (let i = 1; i < angles.length; i++) expect(angles[i]).toBeGreaterThanOrEqual(angles[i - 1]);
    }
  });

  it("turnToward takes the short way round the circle", () => {
    // From just below 2π to just above 0: the short way is forward, not back.
    expect(turnToward(Math.PI * 1.9, Math.PI * 0.1, 1)).toBeCloseTo(Math.PI * 2.1, 6);
    expect(turnToward(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 6);
  });
});

describe("rest angle", () => {
  it("aims the principal port at what it is wired to", () => {
    const net = new Net();
    const a = net.addAgentWired("γ");
    const b = net.addAgentWired("δ");
    net.link(principal(a.id), principal(b.id));

    const places: Placements = { agents: new Map(), free: new Map() };
    // b sits directly to the RIGHT of a, so a's apex should end up pointing right.
    places.agents.set(a.id, { x: 0, y: 0, angle: 0, anchor: null });
    places.agents.set(b.id, { x: 100, y: 0, angle: 0, anchor: null });
    for (const f of net.freePorts()) places.free.set(f, { x: 0, y: 0, angle: 0 });

    const angle = restAngle(net, a.id, places)!;
    const apex = portDirection(2, 0, angle);
    expect(apex.x).toBeGreaterThan(0.8);
    expect(Math.abs(apex.y)).toBeLessThan(0.3);
  });

  it("points the two halves of a redex at each other", () => {
    const net = new Net();
    const a = net.addAgentWired("γ");
    const b = net.addAgentWired("γ");
    net.link(principal(a.id), principal(b.id));
    const places = scatter(net, 7);
    relax(net, places, 200);

    const pa = places.agents.get(a.id)!;
    const pb = places.agents.get(b.id)!;
    const apexA = portDirection(2, 0, pa.angle);
    const apexB = portDirection(2, 0, pb.angle);
    const toB = { x: pb.x - pa.x, y: pb.y - pa.y };
    const len = Math.hypot(toB.x, toB.y);
    // A's apex points at B, and the two apexes point in roughly opposite
    // directions: nose to nose. Not exactly, because the aux ports get a vote
    // too — the principal is weighted heavier, not treated as the only wire.
    expect((apexA.x * toB.x + apexA.y * toB.y) / len).toBeGreaterThan(0.7);
    expect(apexA.x * apexB.x + apexA.y * apexB.y).toBeLessThan(-0.7);
  });

  it("returns null for an agent with nothing to aim at", () => {
    const net = new Net();
    const a = net.addAgent("γ"); // bare: no wires at all
    const places: Placements = { agents: new Map(), free: new Map() };
    places.agents.set(a.id, { x: 5, y: 5, angle: 0, anchor: null });
    expect(restAngle(net, a.id, places)).toBeNull();
    expect(restAngle(net, 999 as AgentId, places)).toBeNull();
  });

  it("balances all three ports rather than only the principal", () => {
    // A parent with two children below it and a free principal above: the rest
    // angle should stay near upright.
    const net = new Net();
    const top = net.addAgentWired("γ");
    const left = net.addAgentWired("γ");
    const right = net.addAgentWired("γ");
    net.link(aux(top.id, 0), principal(left.id));
    net.link(aux(top.id, 1), principal(right.id));

    const places: Placements = { agents: new Map(), free: new Map() };
    places.agents.set(top.id, { x: 100, y: 0, angle: 2, anchor: null });
    places.agents.set(left.id, { x: 40, y: 80, angle: 0, anchor: null });
    places.agents.set(right.id, { x: 160, y: 80, angle: 0, anchor: null });
    for (const f of net.freePorts()) places.free.set(f, { x: 100, y: -60, angle: 0 });

    const angle = restAngle(net, top.id, places)!;
    expect(Math.abs(turnToward(angle, 0, 1))).toBeLessThan(0.35); // within ~20°
  });
});

describe("relaxation", () => {
  it("lowers the energy of a jumbled net", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const net = randomNet(new Rng(seed * 5779), 10);
      const places = scatter(net, seed);
      const before = energy(net, places, { radius: R });
      relax(net, places, 250);
      const after = energy(net, places, { radius: R });
      expect(after).toBeLessThan(before);
    }
  });

  it("pulls the ends of a wire to roughly the rest length", () => {
    const net = new Net();
    const a = net.addAgentWired("γ");
    const b = net.addAgentWired("γ");
    net.link(aux(a.id, 0), principal(b.id));
    const places = scatter(net, 3);
    relax(net, places, 400);
    const pa = endpointPoint(net, places, aux(a.id, 0), R)!;
    const pb = endpointPoint(net, places, principal(b.id), R)!;
    expect(Math.hypot(pb.x - pa.x, pb.y - pa.y)).toBeLessThan(R * 3);
  });

  it("separates agents that start exactly on top of each other", () => {
    const net = new Net();
    const a = net.addAgentWired("γ");
    const b = net.addAgentWired("δ");
    const places: Placements = { agents: new Map(), free: new Map() };
    places.agents.set(a.id, { x: 200, y: 200, angle: 0, anchor: null });
    places.agents.set(b.id, { x: 200, y: 200, angle: 0, anchor: null });
    for (const f of net.freePorts()) places.free.set(f, { x: 200, y: 200, angle: 0 });
    relax(net, places, 200);
    const pa = places.agents.get(a.id)!;
    const pb = places.agents.get(b.id)!;
    expect(Math.hypot(pb.x - pa.x, pb.y - pa.y)).toBeGreaterThan(R * 1.5);
    expect(Number.isFinite(pa.x)).toBe(true);
    expect(Number.isFinite(pb.y)).toBe(true);
  });

  it("keeps children below their parent", () => {
    const net = new Net();
    const top = net.addAgentWired("γ");
    const kid = net.addAgentWired("γ");
    net.link(aux(top.id, 0), principal(kid.id));
    const places: Placements = { agents: new Map(), free: new Map() };
    // Start the child ABOVE the parent; the hierarchy term should flip it.
    places.agents.set(top.id, { x: 200, y: 200, angle: 0, anchor: null });
    places.agents.set(kid.id, { x: 200, y: 120, angle: 0, anchor: null });
    for (const f of net.freePorts()) places.free.set(f, { x: 200, y: 160, angle: 0 });
    relax(net, places, 400);
    expect(places.agents.get(kid.id)!.y).toBeGreaterThan(places.agents.get(top.id)!.y);
  });

  it("never moves a pinned node", () => {
    const net = randomNet(new Rng(99), 8);
    const places = scatter(net, 4);
    const [first] = [...places.agents.keys()];
    const pinned = places.agents.get(first)!;
    pinned.pinned = true;
    const at = { x: pinned.x, y: pinned.y };
    relax(net, places, 100);
    expect(pinned.x).toBe(at.x);
    expect(pinned.y).toBe(at.y);
  });

  it("keeps anchored agents on a short leash from their tidy-layout position", () => {
    const net = randomNet(new Rng(1234), 10);
    const places = scatter(net, 5);
    for (const place of places.agents.values()) place.anchor = { x: place.x, y: place.y };
    const before = new Map([...places.agents].map(([id, p]) => [id, { x: p.x, y: p.y }]));
    relax(net, places, 300);
    for (const [id, place] of places.agents) {
      const was = before.get(id)!;
      expect(Math.hypot(place.x - was.x, place.y - was.y)).toBeLessThanOrEqual(R * 0.75 + 1e-6);
    }
  });

  it("keeps everything inside the bounds", () => {
    const net = randomNet(new Rng(555), 14);
    const places = scatter(net, 6, 2000);
    const bounds = { minX: 10, minY: 10, maxX: 590, maxY: 390 };
    for (let i = 0; i < 400; i++) relaxStep(net, places, { radius: R, bounds });
    for (const place of [...places.agents.values(), ...places.free.values()]) {
      expect(place.x).toBeGreaterThanOrEqual(9.9);
      expect(place.x).toBeLessThanOrEqual(590.1);
      expect(place.y).toBeGreaterThanOrEqual(9.9);
      expect(place.y).toBeLessThanOrEqual(390.1);
    }
  });

  it("is deterministic and never produces NaN, even on degenerate nets", () => {
    const net = new Net();
    const a = net.addAgentWired("γ");
    net.link(principal(a.id), aux(a.id, 0)); // an agent wired to itself
    const f1 = net.addFree();
    net.link(f1, f1); // a wire that closes on itself
    const run = (): Placements => {
      const places = scatter(net, 11);
      relax(net, places, 120);
      return places;
    };
    const first = run();
    const second = run();
    for (const [id, place] of first.agents) {
      expect(Number.isFinite(place.x)).toBe(true);
      expect(Number.isFinite(place.angle)).toBe(true);
      expect(place.x).toBe(second.agents.get(id)!.x);
      expect(place.angle).toBe(second.agents.get(id)!.angle);
    }
  });

  it("covers every port of every agent when aiming", () => {
    // Guards the arity-0 case: ε has a principal port and nothing else.
    const net = new Net();
    const e = net.addAgentWired("ε");
    const g = net.addAgentWired("γ");
    net.link(principal(e.id), principal(g.id));
    expect(portsOf(net.agent(e.id)!)).toHaveLength(1);
    const places = scatter(net, 2);
    relax(net, places, 200);
    const pe = places.agents.get(e.id)!;
    const pg = places.agents.get(g.id)!;
    const apex = portDirection(0, 0, pe.angle);
    const toG = { x: pg.x - pe.x, y: pg.y - pe.y };
    const len = Math.hypot(toG.x, toG.y) || 1;
    expect((apex.x * toG.x + apex.y * toG.y) / len).toBeGreaterThan(0.9);
    expect(portBaseAngle(0, 0)).toBeCloseTo(-Math.PI / 2, 6);
  });
});

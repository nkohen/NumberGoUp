import { describe, it, expect } from "vitest";
import { aux, Net, principal } from "../../src/inet/net";
import {
  agentCard,
  allReachable,
  applyMove,
  cardFor,
  isCleared,
  legalMoves,
  LevelRun,
  plug,
  spend,
  splice,
  WIRE_CARD,
  type Card,
} from "../../src/inet/level";
import { solve } from "../../src/inet/solver";
import { LEVELS } from "../../src/inet/levels";
import { reduce } from "../../src/inet/reduce";

const G = agentCard("γ");
const E = agentCard("ε");
const W = WIRE_CARD;

describe("player actions", () => {
  it("plugs a card in principal-port-first, creating a redex against a principal", () => {
    const net = new Net();
    const enemy = net.addAgentWired("γ");
    const principalWire = net.follow(principal(enemy.id))!;
    expect("free" in principalWire).toBe(true);
    if (!("free" in principalWire)) return;

    plug(net, principalWire.free, "γ");
    net.assertWellFormed("after plug");
    expect(net.agentCount).toBe(2);
    // The two principal ports now face each other: an active pair.
    const partner = net.follow(principal(enemy.id))!;
    expect("free" in partner).toBe(false);
    if (!("free" in partner)) expect(partner.port).toBe(0);
  });

  it("plugging into an AUX wire builds structure but starts nothing", () => {
    const net = new Net();
    const enemy = net.addAgentWired("γ");
    const auxWire = net.follow(aux(enemy.id, 0))!;
    if (!("free" in auxWire)) throw new Error("expected a free port");

    plug(net, auxWire.free, "γ");
    net.assertWellFormed("after aux plug");
    expect(net.agentCount).toBe(2);
    // The new agent's principal met an AUX port, so there is no redex.
    expect(reduce(net.clone(), { fuel: 50 }).interactions).toBe(0);
  });

  it("γ and δ each open two new free wires; ε opens none", () => {
    const before = (): { net: Net; free: number } => {
      const net = new Net();
      net.addAgentWired("γ");
      return { net, free: net.freePorts().length };
    };
    for (const [symbol, delta] of [
      ["γ", 1],
      ["δ", 1],
      ["ε", -1],
    ] as const) {
      const { net, free } = before();
      plug(net, net.freePorts()[0], symbol);
      // Plugging consumes the wire it went into and adds one per aux port.
      expect(net.freePorts().length - free).toBe(delta);
    }
  });

  it("splices two loose ends into one wire", () => {
    const net = new Net();
    const a = net.addAgentWired("γ");
    const free = net.freePorts();
    const count = free.length;
    splice(net, free[1], free[2]);
    net.assertWellFormed("after splice");
    expect(net.freePorts().length).toBe(count - 2);
    expect(net.follow(aux(a.id, 0))).toEqual(aux(a.id, 1));
  });

  it("refuses to splice a wire to itself", () => {
    const net = new Net();
    net.addAgentWired("γ");
    expect(splice(net, net.freePorts()[0], net.freePorts()[0])).toBe(false);
  });

  it("only offers moves the hand can pay for", () => {
    const net = new Net();
    net.addAgentWired("γ");
    expect(legalMoves(net, []).length).toBe(0);
    // No wire card: no splices offered.
    expect(legalMoves(net, [G]).every((m) => m.kind === "plug")).toBe(true);
    expect(legalMoves(net, [W]).every((m) => m.kind === "splice")).toBe(true);
  });

  it("spends one matching card at a time", () => {
    const hand: Card[] = [G, G, E];
    const rest = spend(hand, G)!;
    expect(rest).toHaveLength(2);
    expect(spend([E], G)).toBeNull();
    expect(spend([W], W)).toEqual([]);
    expect(cardFor({ kind: "splice", a: 0, b: 1 })).toEqual(W);
  });
});

describe("the smallest level", () => {
  it("matching the symbol clears a lone γ in one card", () => {
    const net = new Net();
    net.addAgentWired("γ");
    plug(net, net.freePorts()[0], "γ");
    reduce(net, { fuel: 100 });
    net.assertWellFormed("after annihilation");
    expect(isCleared(net)).toBe(true);
  });

  it("erasure alone does NOT clear it — it strands an ε on every wire", () => {
    const net = new Net();
    net.addAgentWired("γ");
    plug(net, net.freePorts()[0], "ε");
    reduce(net, { fuel: 100 });
    // The γ is gone, but erasing it spawned an ε on each of its aux wires.
    expect(net.agentCount).toBe(2);
    expect(net.agents().every((a) => a.symbol === "ε")).toBe(true);
    expect(isCleared(net)).toBe(false);
  });

  it("a wire card makes the erasure wave meet itself and annihilate", () => {
    const net = new Net();
    const g = net.addAgentWired("γ");
    const free = net.freePorts();
    const principalFree = net.follow(principal(g.id))!;
    if (!("free" in principalFree)) throw new Error("expected a free port");
    // Join the two aux ends, then erase from the top.
    splice(net, ...(free.filter((f) => f !== principalFree.free) as [number, number]));
    plug(net, principalFree.free, "ε");
    reduce(net, { fuel: 100 });
    net.assertWellFormed("after fold");
    expect(isCleared(net)).toBe(true);
  });
});

describe("solver", () => {
  it("finds the one-card annihilation", () => {
    const net = new Net();
    net.addAgentWired("γ");
    const result = solve(net, [G, E, E, E]);
    expect(result.solution?.cards).toBe(1);
    expect(result.solution?.line[0]).toMatchObject({ kind: "plug", symbol: "γ" });
  });

  it("reports unsolvable rather than guessing", () => {
    const net = new Net();
    net.addAgentWired("γ");
    // A single wire card cannot clear anything: nothing erases or annihilates.
    const result = solve(net, [W]);
    expect(result.solution).toBeNull();
    expect(result.exhaustive).toBe(true);
  });

  it("returns a line that actually clears the net when replayed", () => {
    for (const level of LEVELS) {
      const result = solve(level.build(), level.hand, { maxCards: 5 });
      expect(result.solution, `${level.id} should be solvable`).not.toBeNull();
      // Replay it move by move against a fresh net.
      const net = level.build();
      let hand: readonly Card[] = level.hand;
      reduce(net, { fuel: 2000 });
      for (const move of result.solution!.line) {
        const rest = spend(hand, cardFor(move));
        expect(rest, `${level.id}: line plays a card not in hand`).not.toBeNull();
        hand = rest!;
        expect(applyMove(net, move), `${level.id}: illegal move in line`).toBe(true);
        reduce(net, { fuel: 2000 });
        net.assertWellFormed(`${level.id} mid-line`);
      }
      expect(isCleared(net), `${level.id}: line did not clear the net`).toBe(true);
    }
  });
});

describe("shipped levels", () => {
  it("are all winnable, and every agent is reachable from the interface", () => {
    for (const level of LEVELS) {
      const net = level.build();
      net.assertWellFormed(level.id);
      expect(net.agentCount, `${level.id} has no enemy`).toBeGreaterThan(0);
      expect(
        allReachable(net),
        `${level.id} has agents the interface cannot reach — unwinnable`,
      ).toBe(true);
    }
  });

  it("each sit at exactly their declared par", () => {
    for (const level of LEVELS) {
      const result = solve(level.build(), level.hand, { maxCards: 5 });
      expect(result.exhaustive, `${level.id}: search hit its budget`).toBe(true);
      expect(result.solution?.cards, `${level.id} par drifted`).toBe(level.par);
    }
  });

  it("give the player enough cards to reach par, and no unusable hand", () => {
    for (const level of LEVELS) {
      expect(level.hand.length, `${level.id}`).toBeGreaterThanOrEqual(level.par);
      expect(level.teaches.length, `${level.id} needs a lesson`).toBeGreaterThan(10);
    }
  });
});

describe("LevelRun", () => {
  it("plays, steps, and detects the win", () => {
    const level = LEVELS[0];
    const run = new LevelRun(level);
    expect(run.cleared).toBe(false);
    const principalWire = run.net.freePorts()[0];
    expect(run.play({ kind: "plug", free: principalWire, symbol: "γ" })).toBe(true);
    expect(run.cardsPlayed).toBe(1);
    expect(run.hand).toHaveLength(level.hand.length - 1);
    run.runToNormalForm();
    expect(run.cleared).toBe(true);
    expect(run.interactions).toBeGreaterThan(0);
  });

  it("refuses a move the hand cannot pay for, changing nothing", () => {
    const run = new LevelRun(LEVELS[1]); // ε only
    const before = run.net.signature();
    expect(run.play({ kind: "plug", free: run.net.freePorts()[0], symbol: "γ" })).toBe(false);
    expect(run.net.signature()).toBe(before);
    expect(run.cardsPlayed).toBe(0);
    expect(run.canUndo).toBe(false);
  });

  it("undoes a card and a step", () => {
    const run = new LevelRun(LEVELS[0]);
    const before = run.net.signature();
    const hand = run.hand.length;
    run.play({ kind: "plug", free: run.net.freePorts()[0], symbol: "γ" });
    run.stepOnce();
    expect(run.net.signature()).not.toBe(before);
    run.undo();
    run.undo();
    expect(run.net.signature()).toBe(before);
    expect(run.hand).toHaveLength(hand);
    expect(run.cardsPlayed).toBe(0);
    expect(run.interactions).toBe(0);
    expect(run.canUndo).toBe(false);
  });

  it("knows when a run is stuck", () => {
    const run = new LevelRun(LEVELS[0]);
    run.hand = [];
    expect(run.stuck).toBe(true);
    expect(run.cleared).toBe(false);
  });

  it("resets to the starting position", () => {
    const run = new LevelRun(LEVELS[2]);
    const before = run.net.signature();
    run.play({ kind: "plug", free: run.net.freePorts()[0], symbol: "ε" });
    run.runToNormalForm();
    run.reset();
    expect(run.net.signature()).toBe(before);
    expect(run.cardsPlayed).toBe(0);
    expect(run.canUndo).toBe(false);
  });
});

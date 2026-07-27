import { describe, it, expect } from "vitest";
import { Rng } from "../../src/core/rng";
import { Net } from "../../src/inet/net";
import { activePairs, reduce, step, type ReduceOrder } from "../../src/inet/reduce";
import { PRESETS, presetById } from "../../src/inet/presets";
import { randomNet } from "../../src/inet/generate";

/**
 * Strong confluence is the whole reason interaction nets are interesting here:
 * whatever order you fire redexes in, you reach the same normal form after the
 * same number of interactions. That makes `interactions` a canonical property of
 * the net rather than an artifact of the evaluator — and it makes this the
 * strongest correctness check available for the reducer.
 */

const FUEL = 2000;
const RANDOM_ORDERS = 20;

interface Outcome {
  label: string;
  interactions: number;
  finalAgents: number;
  loops: number;
  signature: string;
  fuelExhausted: boolean;
}

function run(build: () => Net, order: ReduceOrder, seed = 0): Outcome {
  const net = build();
  const result = reduce(net, { order, fuel: FUEL, rng: new Rng(seed) });
  return {
    label: order === "random" ? `random#${seed}` : order,
    interactions: result.interactions,
    finalAgents: result.finalAgents,
    loops: result.loops,
    signature: net.signature(),
    fuelExhausted: result.fuelExhausted,
  };
}

/** Like `run("first")`, but asserts the net invariant after every single rewrite. */
function runChecked(build: () => Net): Outcome {
  const net = build();
  let interactions = 0;
  while (interactions < FUEL) {
    const pairs = activePairs(net);
    if (pairs.length === 0) break;
    step(net, pairs[0]);
    net.assertWellFormed(`after interaction ${interactions}`);
    interactions++;
  }
  return {
    label: "first+invariants",
    interactions,
    finalAgents: net.agentCount,
    loops: net.loops,
    signature: net.signature(),
    fuelExhausted: interactions >= FUEL && activePairs(net).length > 0,
  };
}

function expectAgreement(all: Outcome[]): void {
  const [first, ...rest] = all;
  for (const other of rest) {
    // Compare as one string so a failure names the offending order.
    expect(`${other.label}: ${other.interactions} interactions / ${other.finalAgents} agents`).toBe(
      `${other.label}: ${first.interactions} interactions / ${first.finalAgents} agents`,
    );
    expect(other.loops).toBe(first.loops);
    expect(other.signature).toBe(first.signature);
  }
}

/**
 * Reduce the same net under `first`, `parallel` and 20 random orders and assert
 * they all agree. Returns false if the net diverges (in which case it must
 * diverge under every order, which is what gets asserted instead).
 */
function expectConfluent(build: () => Net, checkInvariants = false): boolean {
  const probe = run(build, "first");
  const all: Outcome[] = [probe, run(build, "parallel")];
  for (let s = 1; s <= RANDOM_ORDERS; s++) all.push(run(build, "random", s));
  if (probe.fuelExhausted) {
    expect(all.map((o) => o.fuelExhausted)).toEqual(all.map(() => true));
    return false;
  }
  if (checkInvariants) all.push(runChecked(build));
  expectAgreement(all);
  return true;
}

describe("strong confluence", () => {
  for (const preset of PRESETS) {
    it(`${preset.id}: every reduction order agrees`, () => {
      const normalized = expectConfluent(() => preset.build(), true);
      if (!normalized) expect(preset.id).toBe("diverge"); // only this one may run forever
    });
  }

  it("the diverge preset really does exhaust fuel", () => {
    const net = presetById("diverge")!.build();
    const result = reduce(net, { fuel: 200 });
    expect(result.fuelExhausted).toBe(true);
    expect(result.interactions).toBe(200);
    net.assertWellFormed("diverged");
  });

  for (const size of [3, 6, 10, 16]) {
    it(`random nets of ${size} agents: every reduction order agrees`, () => {
      let compared = 0;
      let diverged = 0;
      for (let seed = 1; seed <= 25; seed++) {
        if (expectConfluent(() => randomNet(new Rng(seed * 7919 + size), size))) compared++;
        else diverged++;
      }
      // Sanity: the sample must not be degenerate in either direction.
      expect(compared).toBeGreaterThan(0);
      expect(diverged).toBeLessThan(25);
    });
  }

  it("holds the well-formedness invariant after every rewrite of a random net", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const build = () => randomNet(new Rng(seed * 104729), 8);
      const checked = runChecked(build);
      if (checked.fuelExhausted) continue;
      expectAgreement([checked, run(build, "parallel"), run(build, "random", 5)]);
    }
  });
});

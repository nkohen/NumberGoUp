import { describe, it, expect } from "vitest";
import { Rng } from "../../src/core/rng";
import {
  arityOf,
  BASE,
  lookupRule,
  pairKey,
  splitPairKey,
  uniformRules,
  validateAlphabet,
  type Alphabet,
} from "../../src/inet/alphabet";
import { ALPHABETS, FORGE, WARDED } from "../../src/inet/alphabets";
import { Net, principal } from "../../src/inet/net";
import { activePairs, hasRule, reduce, step, verbFor } from "../../src/inet/reduce";
import { randomNet } from "../../src/inet/generate";

describe("rule validation", () => {
  for (const alphabet of ALPHABETS) {
    it(`${alphabet.id} is a sound alphabet`, () => {
      const problems = validateAlphabet(alphabet);
      expect(problems.map((p) => `${p.pair}: ${p.message}`)).toEqual([]);
    });
  }

  it("catches a rule that leaves a port unwired", () => {
    const broken: Alphabet = {
      ...BASE,
      rules: new Map([[pairKey("γ", "γ"), { verb: "bad", creates: [], links: [] }]]),
    };
    const problems = validateAlphabet(broken);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.message.includes("wired 0 times"))).toBe(true);
  });

  it("catches the parity constraint that forbids two-into-one on binary symbols", () => {
    // "γ ⋈ γ fuses into a single γ" is arithmetically impossible: 4 interface
    // ports plus one 3-port agent is 7, which cannot be paired up.
    const broken: Alphabet = {
      ...BASE,
      rules: new Map([
        [
          pairKey("γ", "γ"),
          {
            verb: "fuse",
            creates: ["γ"],
            links: [
              [
                { kind: "interface", side: "a", index: 0 },
                { kind: "agent", agent: 0, port: 0 },
              ],
              [
                { kind: "interface", side: "a", index: 1 },
                { kind: "agent", agent: 0, port: 1 },
              ],
              [
                { kind: "interface", side: "b", index: 0 },
                { kind: "agent", agent: 0, port: 2 },
              ],
            ],
          },
        ],
      ]),
    };
    const problems = validateAlphabet(broken);
    expect(problems.some((p) => p.message.includes("parity"))).toBe(true);
  });

  it("stores at most one rule per unordered pair, which is what preserves confluence", () => {
    for (const alphabet of ALPHABETS) {
      for (const key of alphabet.rules.keys()) {
        const [x, y] = splitPairKey(key);
        expect(pairKey(x, y)).toBe(key);
        // Looking the pair up in either order finds the same rule.
        expect(lookupRule(alphabet, x, y)?.rule).toBe(lookupRule(alphabet, y, x)?.rule);
      }
    }
  });

  it("orients a reversed lookup so the rule still applies to the right side", () => {
    const [low, high] = ["γ", "δ"];
    expect(lookupRule(BASE, low, high)?.swap).toBe(false);
    expect(lookupRule(BASE, high, low)?.swap).toBe(true);
  });
});

describe("the base alphabet still behaves exactly as before", () => {
  it("uses the uniform rule for every pair", () => {
    const uniform = uniformRules(BASE.symbols);
    expect([...BASE.rules.keys()].sort()).toEqual([...uniform.keys()].sort());
    for (const [key, rule] of BASE.rules) {
      expect(rule.creates).toEqual(uniform.get(key)!.creates);
      expect(rule.links.length).toBe(uniform.get(key)!.links.length);
    }
  });

  it("names the verbs the analysis harness reports on", () => {
    const net = new Net();
    expect(verbFor(net, "γ", "γ")).toBe("annihilate");
    expect(verbFor(net, "γ", "δ")).toBe("commute");
    expect(verbFor(net, "γ", "ε")).toBe("erase");
  });
});

describe("alternative alphabets reduce correctly", () => {
  /** A redex of two agents with everything else free. */
  function redex(alphabet: Alphabet, x: string, y: string): Net {
    const net = new Net(alphabet);
    const a = net.addAgentWired(x);
    const b = net.addAgentWired(y);
    net.link(principal(a.id), principal(b.id));
    net.assertWellFormed(`${x} ⋈ ${y}`);
    return net;
  }

  it("Forge fuses two binary agents into one unary one", () => {
    const net = redex(FORGE, "▲", "■");
    const freeBefore = net.freePorts().length;
    step(net, activePairs(net)[0]);
    net.assertWellFormed("after fuse");
    expect(net.agentCount).toBe(1);
    expect(net.agents()[0].symbol).toBe("✦");
    // Reduction never creates or destroys free ports, so the count is unchanged
    // — but two of them are now joined to EACH OTHER as an agent-free wire, so
    // the net has two fewer interface points that touch an agent.
    expect(net.freePorts().length).toBe(freeBefore);
    const looseWires = net
      .wires()
      .filter(([x, y]) => "free" in x && "free" in y);
    expect(looseWires).toHaveLength(1);
  });

  it("Forge's spark converts a block into a prism", () => {
    const net = redex(FORGE, "✦", "■");
    step(net, activePairs(net)[0]);
    net.assertWellFormed("after convert");
    expect(net.agents().map((a) => a.symbol)).toEqual(["▲"]);
  });

  it("Forge's spark cuts a prism and leaves a void burning", () => {
    const net = redex(FORGE, "✦", "▲");
    step(net, activePairs(net)[0]);
    net.assertWellFormed("after cut");
    expect(net.agents().map((a) => a.symbol)).toEqual(["✕"]);
  });

  it("keeps every alternative alphabet well-formed over many random reductions", () => {
    for (const alphabet of ALPHABETS) {
      for (let seed = 1; seed <= 25; seed++) {
        const net = randomNet(new Rng(seed * 7717), 8, undefined, {}, alphabet);
        let guard = 0;
        while (guard++ < 200) {
          const pairs = activePairs(net).filter((p) => hasRule(net, p));
          if (pairs.length === 0) break;
          step(net, pairs[0]);
          net.assertWellFormed(`${alphabet.id} seed ${seed}`);
        }
      }
    }
  });

  it("deadlocks rather than throwing when a pair has no rule", () => {
    // Warded deliberately has no ▣ ⋈ ▣ rule.
    expect(lookupRule(WARDED, "▣", "▣")).toBeNull();
    const net = redex(WARDED, "▣", "▣");
    expect(activePairs(net)).toHaveLength(1);
    expect(hasRule(net, activePairs(net)[0])).toBe(false);
    const result = reduce(net, { fuel: 100 });
    expect(result.interactions).toBe(0);
    expect(result.deadlocked).toBe(1);
    expect(result.fuelExhausted).toBe(false);
    net.assertWellFormed("deadlocked");
  });

  it("arities are what the alphabet says they are", () => {
    expect(arityOf(FORGE, "✦")).toBe(1);
    expect(arityOf(FORGE, "✕")).toBe(0);
    const net = new Net(FORGE);
    expect(net.addAgent("✦").arity).toBe(1);
  });
});

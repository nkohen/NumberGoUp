/**
 * Precision mode: a random target each round, HP paid out for the distance you
 * land from it, and no auto-finish. These tests pin the rules that differ from
 * classic — and (in the last block) that classic itself is unchanged.
 */
import { describe, it, expect } from "vitest";
import {
  Game,
  DEFAULT_CONFIG,
  configForMode,
  gradePrecision,
  precisionRangeCap,
  targetForRound,
  WIN_ROUND,
  PRECISION_WIN_ROUND,
} from "../src/core/game";
import { starterDeck, numberCard, opCard, OPS } from "../src/core/cards";
import {
  newTree,
  place,
  evaluate,
  legalTargets,
  hasLegalTarget,
  listNodes,
} from "../src/core/tree";

const precisionCfg = () => configForMode("precision");

/** A precision game parked in the playing phase with a known target. */
function playing(seed = 7, target?: number): Game {
  const g = new Game(precisionCfg(), seed);
  g.startRun();
  if (target !== undefined) g.target = target;
  return g;
}

describe("precision target range", () => {
  it("widens each round until it reaches the configured maximum", () => {
    const cfg = precisionCfg();
    let prev = 0;
    for (let r = 1; r <= 14; r++) {
      const cap = precisionRangeCap(r, cfg);
      expect(cap).toBeGreaterThanOrEqual(prev);
      prev = cap;
    }
    expect(precisionRangeCap(1, cfg)).toBe(cfg.precisionRangeStart);
    expect(precisionRangeCap(50, cfg)).toBe(cfg.precisionRangeMax);
  });

  it("never exceeds the maximum, however long the run gets", () => {
    const cfg = precisionCfg();
    for (let r = 1; r <= 200; r++) {
      expect(precisionRangeCap(r, cfg)).toBeLessThanOrEqual(cfg.precisionRangeMax);
    }
    // …and it does settle there rather than creeping up forever.
    for (const r of [50, 100, 1000]) {
      expect(precisionRangeCap(r, cfg)).toBe(cfg.precisionRangeMax);
    }
  });

  it("reaches the full range BEFORE the win round", () => {
    // The design invariant behind the current growth tuning: you must not be
    // able to win without ever facing the full [1, precisionRangeMax). Slowing
    // the ramp much further (e.g. growth 1.25 → full range at round 22) would
    // push the plateau past the finish line, and this fails on purpose.
    const cfg = precisionCfg();
    expect(precisionRangeCap(PRECISION_WIN_ROUND, cfg)).toBe(cfg.precisionRangeMax);
  });

  it("draws each round's target uniformly from [1, cap)", () => {
    // Many seeds, since one target per run start.
    for (let seed = 1; seed <= 200; seed++) {
      const g = playing(seed);
      const cap = precisionRangeCap(1, g.cfg);
      expect(g.target).toBeGreaterThanOrEqual(1);
      expect(g.target).toBeLessThan(cap);
    }
  });

  it("re-rolls the target on every new round rather than following a curve", () => {
    const g = playing(3);
    const seen: number[] = [g.target];
    for (let i = 0; i < 6; i++) {
      g.target = g.currentScore; // land it exactly: 0 damage, always survives
      g.evaluate();
      expect(g.phase).toBe("shop");
      g.chooseUpgrade(null);
      seen.push(g.target);
    }
    // Not the classic rising curve.
    expect(seen).not.toEqual(seen.map((_, i) => targetForRound(i + 1, g.cfg)));
    for (let r = 0; r < seen.length; r++) {
      expect(seen[r]).toBeLessThan(precisionRangeCap(r + 1, g.cfg));
    }
  });
});

describe("gradePrecision", () => {
  it("charges the absolute distance from the target, from either side", () => {
    expect(gradePrecision(100, 100).damage).toBe(0);
    expect(gradePrecision(112, 100).damage).toBe(12);
    expect(gradePrecision(88, 100).damage).toBe(12);
  });

  it("rewards over- and undershooting by the same amount identically", () => {
    for (const delta of [0, 3, 7, 12, 19, 40]) {
      const over = gradePrecision(100 + delta, 100);
      const under = gradePrecision(100 - delta, 100);
      expect(over.damage).toBe(under.damage);
      expect(over.grade).toBe(under.grade);
      expect(over.focusEarned).toBe(under.focusEarned);
    }
  });

  it("banks focus on the same bands as classic precision", () => {
    expect(gradePrecision(100, 100)).toMatchObject({ grade: "PERFECT", focusEarned: 5 });
    expect(gradePrecision(105, 100)).toMatchObject({ grade: "SHARP", focusEarned: 4 });
    expect(gradePrecision(110, 100)).toMatchObject({ grade: "CLOSE", focusEarned: 3 });
    expect(gradePrecision(115, 100)).toMatchObject({ grade: "NEAR", focusEarned: 2 });
    expect(gradePrecision(120, 100)).toMatchObject({ grade: "LOOSE", focusEarned: 1 });
    expect(gradePrecision(160, 100)).toMatchObject({ grade: "CLEARED", focusEarned: 0 });
  });
});

describe("precision HP", () => {
  it("starts at the configured pool", () => {
    const g = playing();
    expect(g.hp).toBe(DEFAULT_CONFIG.precisionHp);
    expect(g.maxHp).toBe(DEFAULT_CONFIG.precisionHp);
  });

  it("deducts the distance from the target and continues the run", () => {
    const g = playing(11, 1);
    g.target = g.currentScore + 9; // 9 away
    const res = g.evaluate();
    expect(res.damage).toBe(9);
    expect(res.won).toBe(true);
    expect(g.hp).toBe(DEFAULT_CONFIG.precisionHp - 9);
    expect(res.hpLeft).toBe(g.hp);
    expect(g.phase).toBe("shop");
  });

  it("does not end the run on a miss while HP remains — unlike classic", () => {
    const g = playing(12);
    g.target = g.currentScore + 40; // a big miss
    expect(g.evaluate().won).toBe(true);
    expect(g.phase).toBe("shop");
  });

  it("ends the run when HP hits zero, and never goes negative", () => {
    const g = playing(13);
    g.hp = 5;
    g.target = g.currentScore + 500;
    const res = g.evaluate();
    expect(res.damage).toBe(500);
    expect(res.won).toBe(false);
    expect(g.hp).toBe(0);
    expect(g.phase).toBe("gameover");
  });

  it("never heals — HP is monotonically non-increasing across a run", () => {
    const g = playing(14);
    let prev = g.hp;
    for (let i = 0; i < 8 && g.phase !== "gameover"; i++) {
      g.target = g.currentScore; // land exactly: the best possible outcome
      g.evaluate();
      expect(g.hp).toBeLessThanOrEqual(prev);
      prev = g.hp;
      if (g.phase === "shop") g.chooseUpgrade(null);
    }
    expect(g.hp).toBeLessThanOrEqual(DEFAULT_CONFIG.precisionHp);
  });

  it("resets HP when a new run starts", () => {
    const g = playing(15);
    g.hp = 4;
    g.startRun();
    expect(g.hp).toBe(DEFAULT_CONFIG.precisionHp);
  });
});

describe("precision finalizing", () => {
  it("auto-scores on an EXACT hit — zero damage can't be improved on", () => {
    const g = playing(31);
    g.target = g.currentScore;
    expect(g.shouldAutoScore).toBe(true);
    expect(g.pendingDamage).toBe(0);
  });

  it("auto-scores once past the target too — no play can bring the score back", () => {
    const g = playing(30);
    // Play a number so there's a real score to overshoot with (a fresh tree is 0).
    const idx = g.hand.findIndex((c) => c.kind === "number");
    expect(idx).toBeGreaterThanOrEqual(0);
    g.play(idx, g.root.id);
    expect(g.currentScore).toBeGreaterThan(0);

    g.target = g.currentScore - 1; // already past it
    expect(g.pendingDamage).toBe(1);
    expect(g.shouldAutoScore).toBe(true);
  });

  it("does not auto-score while still short of the target", () => {
    const g = playing(32);
    g.target = g.currentScore + 5;
    expect(g.shouldAutoScore).toBe(false);
  });

  it("never auto-scores at the start of a round (target is always >= 1)", () => {
    // The opening tree is a bare slot worth 0, so an exact hit can only ever be
    // produced by a play — a fresh round must not resolve itself instantly.
    for (let seed = 1; seed <= 100; seed++) {
      const g = playing(seed);
      expect(g.currentScore).toBe(0);
      expect(g.target).toBeGreaterThanOrEqual(1);
      expect(g.shouldAutoScore).toBe(false);
    }
  });

  it("reports the HP an Analyze right now would cost", () => {
    const g = playing(16, 50);
    expect(g.pendingDamage).toBe(Math.abs(g.currentScore - 50));
    g.target = g.currentScore;
    expect(g.pendingDamage).toBe(0);
  });

  it(`wins the run on surviving round ${PRECISION_WIN_ROUND}`, () => {
    const g = playing(17);
    g.round = PRECISION_WIN_ROUND;
    g.target = g.currentScore;
    const res = g.evaluate();
    expect(res.won).toBe(true);
    expect(g.phase).toBe("won");
  });

  it("uses its own win round, not classic's", () => {
    expect(PRECISION_WIN_ROUND).not.toBe(WIN_ROUND);
    expect(playing().winRound).toBe(PRECISION_WIN_ROUND);
    const classic = new Game(DEFAULT_CONFIG, 7);
    expect(classic.winRound).toBe(WIN_ROUND);

    // Classic's round 30 is just another round here.
    const g = playing(18);
    g.round = WIN_ROUND;
    g.target = g.currentScore;
    g.evaluate();
    expect(g.phase).toBe("shop");
  });

  it("does not win early, and dying on the win round is still a loss", () => {
    const early = playing(19);
    early.round = PRECISION_WIN_ROUND - 1;
    early.target = early.currentScore;
    early.evaluate();
    expect(early.phase).toBe("shop");

    const fatal = playing(20);
    fatal.round = PRECISION_WIN_ROUND;
    fatal.hp = 2;
    fatal.target = fatal.currentScore + 500;
    expect(fatal.evaluate().won).toBe(false);
    expect(fatal.phase).toBe("gameover");
  });

  it("keeps going past the win round if the player continues", () => {
    // "Keep playing" reopens the shop; the win must fire once, not every round.
    const g = playing(21);
    g.round = PRECISION_WIN_ROUND;
    g.target = g.currentScore;
    g.evaluate();
    expect(g.phase).toBe("won");
    g.phase = "shop"; // what keepPlaying() does
    g.chooseUpgrade(null);
    expect(g.round).toBe(PRECISION_WIN_ROUND + 1);
    g.target = g.currentScore;
    g.evaluate();
    expect(g.phase).toBe("shop");
  });

  it("counts every survived round and opens the shop each time", () => {
    const g = playing(18);
    for (let i = 0; i < 5; i++) {
      g.target = g.currentScore + 1;
      g.evaluate();
      expect(g.phase).toBe("shop");
      expect(g.offers.length).toBeGreaterThan(0);
      g.chooseUpgrade(null);
    }
    expect(g.roundsCleared).toBe(5);
    expect(g.round).toBe(6);
  });
});

/**
 * The auto-analyze rule ("stop at or past the target") is only correct because
 * no placement can lower the tree's value — so an overshoot is unrecoverable and
 * there is nothing left to decide. That is a property of the CARD SET, not of
 * the game loop, and a subtraction or division card would destroy it: an
 * overshoot would become fixable, and precision would have to go back to
 * resolving only on an exact hit or it would end the round before the player
 * could correct.
 *
 * These tests exist to make that break loud. If you add `−` (or `/`) and they go
 * red, the fix is not to loosen them — it is to revisit `Game.shouldAutoScore`.
 */
describe("monotonicity — the assumption auto-analyze rests on", () => {
  it("no legal placement ever lowers the tree's value", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const g = playing(seed);
      let before = g.currentScore;
      for (let turn = 0; turn < 12; turn++) {
        // Try every legal placement from the current hand, not just the one we
        // take, so a value-lowering card can't hide behind our choice of move.
        for (let h = 0; h < g.hand.length; h++) {
          for (const nodeId of legalTargets(g.root, g.hand[h], g.currentDepth)) {
            const res = place(g.tree, nodeId, g.hand[h], g.currentDepth);
            if (res) expect(evaluate(res.tree.root)).toBeGreaterThanOrEqual(before);
          }
        }
        const idx = g.hand.findIndex((c) =>
          hasLegalTarget(g.root, c, g.currentDepth),
        );
        if (idx < 0) break;
        const nodeId = legalTargets(g.root, g.hand[idx], g.currentDepth)[0];
        if (g.play(idx, nodeId) === null) break;
        expect(g.currentScore).toBeGreaterThanOrEqual(before);
        before = g.currentScore;
      }
    }
  });

  // Deliberately driven off the OPS list rather than off a deck: a subtraction
  // card would most likely arrive as a shop upgrade, which a starter-deck-only
  // test would never see. This fails the moment such an operator is declared.
  it.each([...OPS])("operator %s never lowers the value it is played onto", (op) => {
    const base = 6;
    const seeded = place(newTree(), 0, numberCard(base), 4)!;
    expect(evaluate(seeded.tree.root)).toBe(base);

    // Placing the operator sprouts an empty slot; the identity must leave the
    // value where it was.
    const withOp = place(seeded.tree, seeded.tree.root.id, opCard(op), 4);
    expect(withOp).not.toBeNull();
    expect(evaluate(withOp!.tree.root)).toBe(base);

    // Then filling that slot with any number must not drag the value down.
    const slot = listNodes(withOp!.tree.root).find((n) => n.type === "slot");
    expect(slot).toBeDefined();
    for (const value of [1, 2, 3, 5, 9]) {
      const filled = place(withOp!.tree, slot!.id, numberCard(value), 4);
      if (!filled) continue;
      expect(evaluate(filled.tree.root)).toBeGreaterThanOrEqual(base);
    }
  });
});

describe("precision save/load", () => {
  it("round-trips HP through a snapshot", () => {
    const g = playing(19);
    g.target = g.currentScore + 17;
    g.evaluate();
    const restored = Game.fromSnapshot(JSON.parse(JSON.stringify(g.serialize())));
    expect(restored.hp).toBe(g.hp);
    expect(restored.cfg.mode).toBe("precision");
    expect(restored.isPrecision).toBe(true);
    expect(restored.target).toBe(g.target);
  });

  it("migrates a save from when the mode was called 'survival'", () => {
    // Pre-release playtest saves spell the mode and its config keys the old way.
    // Without migration they'd reload as an unrecognised mode: no HP, no random
    // target, maxHp undefined.
    const g = playing(40);
    const snap = JSON.parse(JSON.stringify(g.serialize()));
    snap.cfg = {
      ...snap.cfg,
      mode: "survival",
      survivalHp: 100,
      survivalRangeStart: 10,
      survivalRangeGrowth: 1.4,
      survivalRangeMax: 1000,
    };
    delete snap.cfg.precisionHp;
    delete snap.cfg.precisionRangeStart;
    delete snap.cfg.precisionRangeGrowth;
    delete snap.cfg.precisionRangeMax;

    const restored = Game.fromSnapshot(snap);
    expect(restored.cfg.mode).toBe("precision");
    expect(restored.isPrecision).toBe(true);
    expect(restored.maxHp).toBe(100);
    expect(restored.cfg.precisionRangeGrowth).toBe(1.4);
    expect(precisionRangeCap(1, restored.cfg)).toBe(10);
  });

  it("leaves an ordinary classic save untouched", () => {
    const g = new Game(DEFAULT_CONFIG, 41);
    g.startRun();
    const restored = Game.fromSnapshot(JSON.parse(JSON.stringify(g.serialize())));
    expect(restored.cfg).toEqual(g.cfg);
    expect(restored.isPrecision).toBe(false);
  });

  it("loads a pre-precision snapshot (no hp field) at full health", () => {
    const g = new Game(DEFAULT_CONFIG, 20);
    g.startRun();
    const snap = g.serialize();
    delete (snap as { hp?: number }).hp;
    const restored = Game.fromSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(restored.hp).toBe(DEFAULT_CONFIG.precisionHp);
    expect(restored.cfg.mode).toBe("classic");
  });
});

describe("classic mode is unaffected", () => {
  it("still uses the rising target curve and still ends on an undershoot", () => {
    const g = new Game(DEFAULT_CONFIG, 21);
    g.startRun();
    expect(g.isPrecision).toBe(false);
    expect(g.target).toBe(targetForRound(1, DEFAULT_CONFIG));
    g.target = 1_000_000;
    const res = g.evaluate();
    expect(res.won).toBe(false);
    expect(g.phase).toBe("gameover");
    expect(res.damage).toBeUndefined();
    expect(res.hpLeft).toBeUndefined();
  });

  it("uses the classic starter deck in precision too", () => {
    expect(playing().deck.map((c) => JSON.stringify(c))).toEqual(
      starterDeck().map((c) => JSON.stringify(c)),
    );
  });
});

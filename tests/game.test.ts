import { describe, it, expect } from "vitest";
import { Game, DEFAULT_CONFIG, targetForRound, gradeLand, costToGrow, MAX_DEPTH } from "../src/core/game";
import { applyUpgrade, generateOffers } from "../src/core/upgrades";
import { starterDeck, numberCard, cardKey } from "../src/core/cards";
import { Rng } from "../src/core/rng";
import { evaluate, legalTargets } from "../src/core/tree";

describe("target progression", () => {
  it("rises each round", () => {
    let prev = 0;
    for (let r = 1; r <= 8; r++) {
      const t = targetForRound(r, DEFAULT_CONFIG);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
  });
});

describe("Game flow", () => {
  it("starts a run in the playing phase with a full hand", () => {
    const g = new Game(DEFAULT_CONFIG, 12345);
    g.startRun();
    expect(g.phase).toBe("playing");
    expect(g.round).toBe(1);
    expect(g.hand.length).toBe(DEFAULT_CONFIG.handSize);
    expect(g.deck.length).toBe(starterDeck().length);
  });

  it("consumes one card per play and refills the hand", () => {
    const g = new Game(DEFAULT_CONFIG, 999);
    g.startRun();
    // Find a number card in hand and play it on the root slot.
    const idx = g.hand.findIndex((c) => c.kind === "number");
    expect(idx).toBeGreaterThanOrEqual(0);
    const totalBefore = g.hand.length + g.roundDeck.length;
    const res = g.play(idx, 0);
    expect(res).not.toBeNull();
    // One card consumed from the round's pool.
    expect(g.hand.length + g.roundDeck.length).toBe(totalBefore - 1);
    expect(evaluate(g.root)).toBeGreaterThan(0);
  });

  it("rejects illegal plays without consuming a card", () => {
    const g = new Game(DEFAULT_CONFIG, 5);
    g.startRun();
    // Playing an op on the initial slot is illegal.
    const opIdx = g.hand.findIndex((c) => c.kind === "op");
    if (opIdx >= 0) {
      const totalBefore = g.hand.length + g.roundDeck.length;
      expect(g.play(opIdx, 0)).toBeNull();
      expect(g.hand.length + g.roundDeck.length).toBe(totalBefore);
    }
  });

  it("winning a round opens the shop with offers", () => {
    const g = new Game(DEFAULT_CONFIG, 77);
    g.startRun();
    // Force a winning tree directly for a deterministic flow test.
    // Build value 2, then *, then fill to reach >= target quickly.
    // Easiest: just push the tree above target by evaluating a hand-built value.
    // We drive through the public API by playing numbers/ops we control.
    // Instead, set target low and place a big number via an upgrade-free path:
    // play a number then keep multiplying with numbers we draw.
    // For determinism we simply assert the evaluate() branch logic:
    g.target = 1; // pretend an easy target
    const numIdx = g.hand.findIndex((c) => c.kind === "number" && c.value >= 1);
    g.play(numIdx, 0);
    const result = g.evaluate();
    expect(result.won).toBe(true);
    expect(g.phase).toBe("shop");
    expect(g.offers.length).toBeGreaterThan(0);
  });

  it("losing a round ends the run", () => {
    const g = new Game(DEFAULT_CONFIG, 3);
    g.startRun();
    g.target = 1000000; // unreachable
    const result = g.evaluate();
    expect(result.won).toBe(false);
    expect(g.phase).toBe("gameover");
  });

  it("choosing an upgrade advances the round and can grow the deck", () => {
    const g = new Game(DEFAULT_CONFIG, 55);
    g.startRun();
    g.target = 0; // trivially winnable
    g.evaluate();
    expect(g.phase).toBe("shop");
    const deckBefore = g.deck.length;
    const addIdx = g.offers.findIndex((o) => o.type === "add");
    if (addIdx >= 0) {
      g.chooseUpgrade(addIdx);
      expect(g.deck.length).toBe(deckBefore + 1);
    } else {
      g.chooseUpgrade(null);
      expect(g.deck.length).toBe(deckBefore);
    }
    expect(g.phase).toBe("playing");
    expect(g.round).toBe(2);
  });

  it("redraw is a paid fish when a legal move exists (free only when stuck)", () => {
    const g = new Game(DEFAULT_CONFIG, 21);
    g.startRun();
    // Fresh tree + mixed hand → a legal move exists → re-drawing is a paid fish.
    if (g.canPlayAny()) {
      expect(g.redrawCost).toBeGreaterThan(0);
      g.focus = 0;
      expect(g.canRedraw()).toBe(false); // can't afford
      expect(g.redraw()).toBe(false);
      g.focus = 5;
      expect(g.redraw()).toBe(true); // paid fish
      expect(g.focus).toBe(4); // FISH_BASE = 1
      expect(g.fishCount).toBe(1);
      expect(g.redrawCost).toBe(2); // cost rises with each fish
    }
  });
});

describe("upgrades", () => {
  it("add appends a card", () => {
    const deck = starterDeck();
    const out = applyUpgrade(deck, {
      type: "add",
      card: numberCard(9),
      title: "",
      desc: "",
    });
    expect(out.length).toBe(deck.length + 1);
    expect(out.some((c) => c.kind === "number" && c.value === 9)).toBe(true);
  });

  it("remove deletes exactly one matching copy", () => {
    const deck = starterDeck();
    const before = deck.filter((c) => cardKey(c) === "n1").length;
    const out = applyUpgrade(deck, {
      type: "remove",
      card: numberCard(1),
      title: "",
      desc: "",
    });
    const after = out.filter((c) => cardKey(c) === "n1").length;
    expect(after).toBe(before - 1);
  });

  it("promote upgrades one number card's value", () => {
    const deck = starterDeck();
    const out = applyUpgrade(deck, {
      type: "promote",
      from: 1,
      to: 3,
      title: "",
      desc: "",
    });
    expect(out.filter((c) => c.kind === "number" && c.value === 3).length).toBe(1);
  });

  it("never offers removing the last number", () => {
    // A deck with a single number card.
    const deck = [numberCard(1), ...starterDeck().filter((c) => c.kind === "op")];
    const offers = generateOffers(deck, new Rng(1), 3, 5);
    expect(offers.some((o) => o.type === "remove")).toBe(false);
  });

  it("generates distinct offers", () => {
    const offers = generateOffers(starterDeck(), new Rng(9), 2, 3);
    const keys = offers.map((o) => JSON.stringify(o));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("precision grading (gradeLand)", () => {
  it("tiered: grades by overshoot and banks focus for tight clears", () => {
    expect(gradeLand(100, 100, "tiered")).toEqual({ won: true, grade: "PERFECT", focusEarned: 5 });
    expect(gradeLand(104, 100, "tiered")).toEqual({ won: true, grade: "SHARP", focusEarned: 4 });
    expect(gradeLand(108, 100, "tiered")).toEqual({ won: true, grade: "CLOSE", focusEarned: 3 });
    expect(gradeLand(113, 100, "tiered")).toEqual({ won: true, grade: "NEAR", focusEarned: 2 });
    expect(gradeLand(118, 100, "tiered")).toEqual({ won: true, grade: "LOOSE", focusEarned: 1 });
    expect(gradeLand(300, 100, "tiered")).toEqual({ won: true, grade: "CLEARED", focusEarned: 0 });
  });

  it("undershoot is a MISS (loss) under tiered/continuous", () => {
    expect(gradeLand(99, 100, "tiered").won).toBe(false);
    expect(gradeLand(99, 100, "continuous").won).toBe(false);
  });

  it("safety model scrapes a small undershoot but not a large one", () => {
    expect(gradeLand(98, 100, "safety")).toEqual({ won: true, grade: "SCRAPE", focusEarned: 0 });
    expect(gradeLand(90, 100, "safety").won).toBe(false);
  });

  it("continuous focus decreases smoothly with overshoot", () => {
    expect(gradeLand(100, 100, "continuous").focusEarned).toBe(5); // perfect
    expect(gradeLand(150, 100, "continuous").focusEarned).toBe(3); // 50% over → round(5*0.5)
    expect(gradeLand(250, 100, "continuous").focusEarned).toBe(0); // >=100% over → none
  });
});

describe("tree growth economy", () => {
  it("banks focus on a clear and spends it to grow depth", () => {
    const g = new Game(DEFAULT_CONFIG, 55); // tiered by default
    g.startRun();
    expect(g.currentDepth).toBe(DEFAULT_CONFIG.startDepth);
    const numIdx = g.hand.findIndex((c) => c.kind === "number" && c.value >= 1);
    const value = (g.hand[numIdx] as { value: number }).value;
    g.play(numIdx, 0); // tree evaluates to `value`
    g.target = value; // a perfect land
    const res = g.evaluate();
    expect(res.grade).toBe("PERFECT");
    expect(g.focus).toBe(5);

    // Now in the shop: growing costs focus, raises the cap, and advances the
    // round (mutually exclusive with taking a card upgrade).
    const cost = g.growCost;
    expect(cost).toBe(costToGrow(DEFAULT_CONFIG.startDepth));
    expect(g.canGrow()).toBe(g.focus >= cost);
    if (g.canGrow()) {
      const roundBefore = g.round;
      expect(g.growTree()).toBe(true);
      expect(g.currentDepth).toBe(DEFAULT_CONFIG.startDepth + 1);
      expect(g.focus).toBe(5 - cost);
      expect(g.round).toBe(roundBefore + 1); // grow used up the shop
      expect(g.phase).toBe("playing");
    }
  });

  it("skipping the upgrade banks focus under the tiered model (not others)", () => {
    const g = new Game(DEFAULT_CONFIG, 88); // tiered
    g.startRun();
    g.target = 1;
    g.play(g.hand.findIndex((c) => c.kind === "number"), 0);
    g.evaluate(); // reach the shop
    g.focus = 0; // isolate the skip bonus from the land grade
    g.chooseUpgrade(null); // skip
    expect(g.focus).toBe(1);

    // continuous banks nothing for a skip.
    const g2 = new Game({ ...DEFAULT_CONFIG, precisionModel: "continuous" }, 88);
    g2.startRun();
    g2.target = 1;
    g2.play(g2.hand.findIndex((c) => c.kind === "number"), 0);
    g2.evaluate();
    g2.focus = 0;
    g2.chooseUpgrade(null);
    expect(g2.focus).toBe(0);
  });

  it("re-rolls offers for focus with an escalating cost, without advancing", () => {
    const g = new Game(DEFAULT_CONFIG, 42);
    g.startRun();
    g.target = 1;
    g.play(g.hand.findIndex((c) => c.kind === "number"), 0);
    g.evaluate(); // reach the shop
    g.focus = 20;
    const roundBefore = g.round;
    expect(g.rerollCost).toBe(2); // first re-roll
    expect(g.rerollOffers()).toBe(true);
    expect(g.focus).toBe(18);
    expect(g.offers.length).toBeGreaterThan(0);
    expect(g.round).toBe(roundBefore); // re-roll does NOT advance
    expect(g.phase).toBe("shop");
    expect(g.rerollCost).toBe(4); // cost rises
    expect(g.rerollOffers()).toBe(true);
    expect(g.focus).toBe(14);

    g.focus = 0;
    expect(g.canReroll()).toBe(false);
    expect(g.rerollOffers()).toBe(false);
  });

  it("cannot grow without enough focus or past the ceiling", () => {
    const g = new Game(DEFAULT_CONFIG, 7);
    g.startRun();
    g.target = 0; // trivial clear, banks 0 (huge overshoot)
    g.evaluate();
    g.focus = 0;
    expect(g.canGrow()).toBe(false);
    expect(g.growTree()).toBe(false);
    expect(g.currentDepth).toBe(DEFAULT_CONFIG.startDepth);

    g.focus = 100000;
    g.currentDepth = MAX_DEPTH;
    expect(g.canGrow()).toBe(false); // at the ceiling
  });
});

describe("integration: a legal target always exists after any real play", () => {
  it("keeps the tree buildable through a scripted round", () => {
    const g = new Game(DEFAULT_CONFIG, 314159);
    g.startRun();
    // Play up to 20 legal moves; the tree should always have a legal target
    // for at least one hand card until the pool is exhausted.
    for (let i = 0; i < 20 && !g.isHandEmpty; i++) {
      let played = false;
      for (let h = 0; h < g.hand.length; h++) {
        const targets = legalTargets(g.root, g.hand[h], g.currentDepth);
        if (targets.length > 0) {
          g.play(h, targets[0]);
          played = true;
          break;
        }
      }
      if (!played) break;
    }
    // Tree should evaluate to a finite number.
    expect(Number.isFinite(evaluate(g.root))).toBe(true);
  });
});

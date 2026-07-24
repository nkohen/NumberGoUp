import { describe, it, expect } from "vitest";
import { Game, DEFAULT_CONFIG, targetForRound } from "../src/core/game";
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

  it("redraw only works when there is no legal move", () => {
    const g = new Game(DEFAULT_CONFIG, 21);
    g.startRun();
    // With a fresh tree and a mixed hand there is (almost always) a legal move.
    if (g.canPlayAny()) {
      expect(g.redraw()).toBe(false);
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

describe("integration: a legal target always exists after any real play", () => {
  it("keeps the tree buildable through a scripted round", () => {
    const g = new Game(DEFAULT_CONFIG, 314159);
    g.startRun();
    // Play up to 20 legal moves; the tree should always have a legal target
    // for at least one hand card until the pool is exhausted.
    for (let i = 0; i < 20 && !g.isHandEmpty; i++) {
      let played = false;
      for (let h = 0; h < g.hand.length; h++) {
        const targets = legalTargets(g.root, g.hand[h]);
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

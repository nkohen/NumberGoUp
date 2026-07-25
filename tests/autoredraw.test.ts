import { describe, it, expect } from "vitest";
import { Game, DEFAULT_CONFIG } from "../src/core/game";
import { numberCard, opCard } from "../src/core/cards";

// The app auto-redraws on exactly this Game state: the hand has no legal move
// (!canPlayAny) but the round can still progress (canProgress) because a
// playable card remains in the deck. This locks in the invariant the app's
// redraw loop relies on: such a state is a *free* redraw and redrawing
// eventually yields a playable hand.
describe("free-redraw safety net (auto-redraw invariant)", () => {
  function stuckButProgressableGame(): Game {
    const g = new Game(DEFAULT_CONFIG, 1);
    g.startRun();
    // Tree = (slot + slot) with the depth cap at 1, so every empty slot sits at
    // the cap: operators can't be placed (would deepen past the cap) but numbers
    // still fill the slots.
    g.currentDepth = 1;
    g.tree = {
      root: {
        id: 0,
        type: "op",
        op: "+",
        left: { id: 1, type: "slot" },
        right: { id: 2, type: "slot" },
      },
      nextId: 3,
    };
    // Hand is all operators (nothing legal); the deck still holds a number.
    g.hand = [opCard("+"), opCard("*")];
    g.roundDeck = [numberCard(2), numberCard(3)];
    g.fishCount = 0;
    return g;
  }

  it("recognizes the state: unplayable hand, still progressable, free redraw", () => {
    const g = stuckButProgressableGame();
    expect(g.canPlayAny()).toBe(false);
    expect(g.canProgress()).toBe(true);
    expect(g.redrawCost).toBe(0); // free, because you're stuck
    expect(g.canRedraw()).toBe(true);
  });

  it("redraw loop terminates on a playable hand without spending focus", () => {
    const g = stuckButProgressableGame();
    const focusBefore = g.focus;
    let guard = 0;
    while (!g.canPlayAny() && g.canRedraw() && guard++ < 200) g.redraw();
    expect(guard).toBeLessThan(200);
    expect(g.canPlayAny()).toBe(true);
    expect(g.focus).toBe(focusBefore); // free redraws cost nothing
    expect(g.fishCount).toBe(0); // and don't escalate the paid-fish cost
  });
});

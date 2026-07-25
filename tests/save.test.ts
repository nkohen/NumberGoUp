import { describe, it, expect } from "vitest";
import { Game, DEFAULT_CONFIG } from "../src/core/game";
import { makeSave } from "../src/ui/persistence";
import { treeToString } from "../src/core/tree";

/** Play a handful of legal moves to build up some mid-run state. */
function advance(g: Game, moves: number): void {
  for (let i = 0; i < moves; i++) {
    const idx = g.hand.findIndex((c) => c.kind === "number");
    const opIdx = g.hand.findIndex((c) => c.kind === "op");
    // Prefer a number on the root slot early, else drop whatever's legal.
    const slot = 0;
    if (idx >= 0 && g.root.type === "slot") g.play(idx, slot);
    else if (opIdx >= 0 && g.root.type === "value") g.play(opIdx, g.root.id);
    else if (idx >= 0) {
      // Fill the first empty slot somewhere in the tree.
      const empty = findSlot(g);
      if (empty !== null) g.play(idx, empty);
      else break;
    } else break;
  }
}

function findSlot(g: Game): number | null {
  const stack = [g.root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === "slot") return n.id;
    if (n.type === "op") {
      stack.push(n.left, n.right);
    }
  }
  return null;
}

describe("save / load round-trip", () => {
  it("restores identical run state", () => {
    const g = new Game(DEFAULT_CONFIG, 24680);
    g.startRun();
    advance(g, 3);

    const snap = g.serialize();
    const round = JSON.parse(JSON.stringify(snap)); // simulate JSON storage
    const g2 = Game.fromSnapshot(round);

    expect(g2.round).toBe(g.round);
    expect(g2.target).toBe(g.target);
    expect(g2.currentDepth).toBe(g.currentDepth);
    expect(g2.focus).toBe(g.focus);
    expect(g2.phase).toBe(g.phase);
    expect(g2.currentScore).toBe(g.currentScore);
    expect(treeToString(g2.root)).toBe(treeToString(g.root));
    expect(g2.hand.map((c) => c.kind)).toEqual(g.hand.map((c) => c.kind));
    expect(g2.deck.length).toBe(g.deck.length);
  });

  it("continues the exact same RNG draw sequence after restore", () => {
    const g = new Game(DEFAULT_CONFIG, 13579);
    g.startRun();
    advance(g, 2);

    const g2 = Game.fromSnapshot(JSON.parse(JSON.stringify(g.serialize())));

    // Drawing the same number of further moves on both must stay in lockstep.
    advance(g, 3);
    advance(g2, 3);
    expect(treeToString(g2.root)).toBe(treeToString(g.root));
    expect(g2.hand.map((c) => c.kind).sort()).toEqual(g.hand.map((c) => c.kind).sort());
  });

  it("wraps a snapshot as a versioned, timestamped payload", () => {
    const g = new Game(DEFAULT_CONFIG, 111);
    g.startRun();
    const save = makeSave(g.serialize());
    expect(save.v).toBe(1);
    expect(typeof save.ts).toBe("number");
    expect(save.game.seed).toBe(111);
  });
});

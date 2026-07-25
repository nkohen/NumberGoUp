import { describe, it, expect } from "vitest";
import { numberCard, opCard, varCard, functionsStarterDeck } from "../src/core/cards";
import {
  newTree,
  evaluate,
  place,
  legalTargets,
  treeToString,
  listNodes,
} from "../src/core/tree";
import { Game, configForMode } from "../src/core/game";
import { generateOffers } from "../src/core/upgrades";
import { Rng } from "../src/core/rng";

describe("variable x", () => {
  it("plays x onto a slot and evaluates to the ambient x (default 0)", () => {
    const t = newTree();
    const res = place(t, 0, varCard())!;
    expect(res.kind).toBe("leaf-on-slot");
    expect(res.tree.root.type).toBe("var");
    expect(evaluate(res.tree.root)).toBe(0); // unbound → 0
    expect(evaluate(res.tree.root, 7)).toBe(7); // bound to 7
    expect(treeToString(res.tree.root)).toBe("x");
  });

  it("allows operators on an x leaf", () => {
    let t = newTree();
    t = place(t, 0, varCard())!.tree; // root is x (id 0)
    expect(legalTargets(t.root, opCard("+"))).toEqual([0]);
    const res = place(t, 0, opCard("+"))!;
    t = res.tree;
    // x + 0, with x kept as the left child (same id)
    expect(treeToString(t.root)).toBe("(x + 0)");
    expect(evaluate(t.root, 5)).toBe(5); // 5 + 0
  });
});

describe("function application (ƒ / @)", () => {
  // Helper: build a tree by a scripted sequence of (targetId, card) placements.
  it("evaluates ƒ(x, a) = a", () => {
    let t = newTree();
    t = place(t, 0, varCard())!.tree; // x  (id 0)
    const ap = place(t, 0, opCard("@"))!; // apply(x, slot)
    t = ap.tree;
    const argSlot = ap.newNodeIds[1];
    t = place(t, argSlot, numberCard(4))!.tree; // apply(x, 4)
    expect(treeToString(t.root)).toBe("x(4)");
    expect(evaluate(t.root)).toBe(4);
  });

  it("evaluates ƒ(x×x, 3) = 9", () => {
    let t = newTree();
    t = place(t, 0, varCard())!.tree; // x (id 0)
    const ap = place(t, 0, opCard("@"))!; // apply(x, slot0)
    t = ap.tree;
    const [, argSlot] = ap.newNodeIds;
    // grow the function body: x -> x × 0 -> x × x
    const mul = place(t, 0, opCard("*"))!; // op on the left x (id 0)
    t = mul.tree;
    const [, mulSlot] = mul.newNodeIds;
    t = place(t, mulSlot, varCard())!.tree; // left is now x × x
    t = place(t, argSlot, numberCard(3))!.tree; // argument = 3
    expect(evaluate(t.root)).toBe(9);
  });

  it("handles nested application, rebinding x to the inner argument", () => {
    // Build apply( apply(x, x), 5 ) — inner x binds to outer x (5), so = 5.
    let t = newTree();
    t = place(t, 0, varCard())!.tree; // x (id 0)
    const outer = place(t, 0, opCard("@"))!; // apply(x, slotA)
    t = outer.tree;
    const [, slotA] = outer.newNodeIds;
    const inner = place(t, 0, opCard("@"))!; // apply(x, slotB) on the left x
    t = inner.tree;
    const [, slotB] = inner.newNodeIds;
    t = place(t, slotB, varCard())!.tree; // inner arg = x
    t = place(t, slotA, numberCard(5))!.tree; // outer arg = 5
    // apply(apply(x, x), 5): outer binds x=5 → apply(x, x)|x=5 = apply(5-as-x? )
    // inner: apply(x, x) with x=5 → evaluate left x at (right x = 5) = 5
    expect(evaluate(t.root)).toBe(5);
  });

  it("x outside any ƒ evaluates to 0", () => {
    let t = newTree();
    t = place(t, 0, varCard())!.tree;
    const add = place(t, 0, opCard("+"))!;
    t = add.tree;
    t = place(t, add.newNodeIds[1], numberCard(3))!.tree; // x + 3
    expect(evaluate(t.root)).toBe(3); // x unbound = 0
  });
});

describe("functions game mode", () => {
  it("uses the functions starter deck with x and ƒ cards", () => {
    const g = new Game(configForMode("functions"), 1);
    g.startRun();
    expect(g.deck.length).toBe(functionsStarterDeck().length);
    expect(g.deck.some((c) => c.kind === "var")).toBe(true);
    expect(g.deck.some((c) => c.kind === "op" && c.op === "@")).toBe(true);
  });

  it("classic mode never deals x or ƒ", () => {
    const g = new Game(configForMode("classic"), 1);
    g.startRun();
    expect(g.deck.some((c) => c.kind === "var")).toBe(false);
    expect(g.deck.some((c) => c.kind === "op" && c.op === "@")).toBe(false);
  });

  it("functions-mode shop can offer x and ƒ", () => {
    const deck = functionsStarterDeck();
    // Sample offers across several seeds to confirm x/ƒ are reachable.
    let sawVar = false;
    let sawApply = false;
    for (let seed = 0; seed < 40; seed++) {
      const offers = generateOffers(deck, new Rng(seed), 3, 3, "functions");
      for (const o of offers) {
        if (o.type === "add" && o.card.kind === "var") sawVar = true;
        if (o.type === "add" && o.card.kind === "op" && o.card.op === "@") sawApply = true;
      }
    }
    expect(sawVar).toBe(true);
    expect(sawApply).toBe(true);
  });

  it("keeps every node reachable/evaluable in a scripted functions round", () => {
    const g = new Game(configForMode("functions"), 999);
    g.startRun();
    for (let i = 0; i < 25 && !g.isHandEmpty; i++) {
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
    expect(Number.isFinite(evaluate(g.root))).toBe(true);
    // sanity: every node is one of the known types
    for (const n of listNodes(g.root)) {
      expect(["slot", "value", "var", "op"]).toContain(n.type);
    }
  });
});

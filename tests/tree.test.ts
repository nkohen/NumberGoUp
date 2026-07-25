import { describe, it, expect } from "vitest";
import { numberCard, opCard } from "../src/core/cards";
import {
  newTree,
  evaluate,
  place,
  legalTargets,
  hasLegalTarget,
  treeToString,
  listNodes,
  slotCount,
} from "../src/core/tree";

describe("tree placement & evaluation", () => {
  it("starts as a single slot evaluating to 0", () => {
    const t = newTree();
    expect(t.root.type).toBe("slot");
    expect(evaluate(t.root)).toBe(0);
    expect(treeToString(t.root)).toBe("0");
  });

  it("plays a number onto the root slot, morphing it in place (same id)", () => {
    const t = newTree();
    const res = place(t, 0, numberCard(2))!;
    expect(res).not.toBeNull();
    expect(res.kind).toBe("leaf-on-slot");
    expect(res.placedNodeId).toBe(0); // id preserved
    expect(res.newNodeIds).toEqual([]);
    expect(evaluate(res.tree.root)).toBe(2);
  });

  it("rejects a number onto a value node", () => {
    let t = newTree();
    t = place(t, 0, numberCard(2))!.tree;
    expect(place(t, 0, numberCard(1))).toBeNull();
  });

  it("plays an op onto a value, keeping the original value as the left child", () => {
    let t = newTree();
    t = place(t, 0, numberCard(2))!.tree; // root is value(2), id 0
    const res = place(t, 0, opCard("*"))!;
    expect(res.kind).toBe("op-on-leaf");
    // op node + new slot are new; left child reuses the original value id (0)
    expect(res.newNodeIds).toHaveLength(2);
    const root = res.tree.root;
    expect(root.type).toBe("op");
    if (root.type === "op") {
      expect(root.op).toBe("*");
      expect(root.left).toEqual({ id: 0, type: "value", value: 2 });
      expect(root.right.type).toBe("slot");
    }
    // [EXPERIMENT] An empty × factor is the identity 1, so 2 × (empty) === 2
    // (rather than collapsing to 0) until the slot is filled.
    expect(evaluate(res.tree.root)).toBe(2);
  });

  it("rejects an op onto a slot", () => {
    const t = newTree();
    expect(place(t, 0, opCard("+"))).toBeNull();
  });

  it("[experiment] empty slot = operator identity (1 under ×, 0 under +)", () => {
    let t = newTree();
    t = place(t, 0, numberCard(5))!.tree;
    // 5 × (empty) === 5 (identity 1), not 0
    expect(evaluate(place(t, 0, opCard("*"))!.tree.root)).toBe(5);
    // 5 + (empty) === 5 (identity 0)
    expect(evaluate(place(t, 0, opCard("+"))!.tree.root)).toBe(5);
    // a bare/root slot is still 0
    expect(evaluate(newTree().root)).toBe(0);
  });

  it("builds (2 + 1) * (2 + 1) = 9", () => {
    let t = newTree();
    // root slot -> 2
    t = place(t, 0, numberCard(2))!.tree;
    // 2 -> (2 * 0)
    const mul = place(t, 0, opCard("*"))!;
    t = mul.tree;
    const [, rightSlotOfMul] = mul.newNodeIds; // op id, slot id
    // fill right slot with 2
    t = place(t, rightSlotOfMul, numberCard(2))!.tree;

    // Now both leaves are value(2). Turn each into (2 + 0) then fill with 1.
    const leaves = () =>
      listNodes(t.root).filter((n) => n.type === "value") as Array<{
        id: number;
      }>;
    for (const leaf of leaves()) {
      const add = place(t, leaf.id, opCard("+"))!;
      t = add.tree;
      const slotId = add.newNodeIds[1];
      t = place(t, slotId, numberCard(1))!.tree;
    }
    expect(evaluate(t.root)).toBe(9);
    expect(treeToString(t.root)).toBe("((2 + 1) * (2 + 1))");
  });

  it("reports legal targets correctly", () => {
    let t = newTree();
    // number can go on the root slot; op cannot
    expect(legalTargets(t.root, numberCard(1))).toEqual([0]);
    expect(legalTargets(t.root, opCard("+"))).toEqual([]);
    expect(hasLegalTarget(t.root, opCard("+"))).toBe(false);

    t = place(t, 0, numberCard(1))!.tree;
    expect(legalTargets(t.root, opCard("+"))).toEqual([0]);
    expect(legalTargets(t.root, numberCard(1))).toEqual([]);
  });

  it("tracks slot count as the tree grows", () => {
    let t = newTree();
    expect(slotCount(t.root)).toBe(1);
    t = place(t, 0, numberCard(1))!.tree;
    expect(slotCount(t.root)).toBe(0);
    t = place(t, 0, opCard("+"))!.tree;
    expect(slotCount(t.root)).toBe(1); // the new right slot
  });

  it("does not mutate the input tree (structural sharing)", () => {
    const t = newTree();
    const before = treeToString(t.root);
    place(t, 0, numberCard(5));
    expect(treeToString(t.root)).toBe(before);
  });
});

describe("tree-height cap (maxDepth)", () => {
  // Build the deepest legal chain under a cap of 2 and verify further operators
  // are refused, while numbers may still fill the remaining slots.
  it("refuses operators that would exceed maxDepth but still allows numbers", () => {
    const MAX = 2;
    let t = newTree();
    // depth 0 leaf
    t = place(t, 0, numberCard(2), MAX)!.tree;
    // op on the depth-0 leaf -> children at depth 1 (allowed)
    const op1 = place(t, 0, opCard("*"), MAX)!;
    t = op1.tree;
    // the original leaf is now at depth 1; an op on it -> depth 2 (allowed)
    const leftLeaf = listNodes(t.root).find(
      (n) => n.type === "value" && n.value === 2,
    )!;
    const op2 = place(t, leftLeaf.id, opCard("*"), MAX)!;
    t = op2.tree;
    // that leaf now sits at depth 2; another op -> depth 3 (refused)
    const deepLeaf = listNodes(t.root).find(
      (n) => n.type === "value" && n.value === 2,
    )!;
    expect(place(t, deepLeaf.id, opCard("*"), MAX)).toBeNull();
    expect(legalTargets(t.root, opCard("*"), MAX)).not.toContain(deepLeaf.id);
    // ...but a number may still fill the deepest open slot.
    const openSlot = listNodes(t.root).find((n) => n.type === "slot")!;
    expect(legalTargets(t.root, numberCard(1), MAX)).toContain(openSlot.id);
    expect(place(t, openSlot.id, numberCard(1), MAX)).not.toBeNull();
  });

  it("with no cap (default) operators keep nesting arbitrarily deep", () => {
    let t = newTree();
    t = place(t, 0, numberCard(1))!.tree;
    // Six successive operators on the freshly-kept left leaf — all legal uncapped.
    for (let i = 0; i < 6; i++) {
      const leaf = listNodes(t.root).find((n) => n.type === "value")!;
      const res = place(t, leaf.id, opCard("+"));
      expect(res).not.toBeNull();
      t = res!.tree;
    }
    expect(hasLegalTarget(t.root, opCard("+"))).toBe(true);
  });
});

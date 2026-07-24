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
    // 2 * 0 === 0 until the slot is filled
    expect(evaluate(res.tree.root)).toBe(0);
  });

  it("rejects an op onto a slot", () => {
    const t = newTree();
    expect(place(t, 0, opCard("+"))).toBeNull();
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

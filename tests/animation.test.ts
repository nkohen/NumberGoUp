import { describe, it, expect } from "vitest";
import { newTree, place, listNodes } from "../src/core/tree";
import { numberCard, opCard } from "../src/core/cards";
import { EvaluateAnimation } from "../src/render/animation";

/** Build op(value(n), slot) by placing a number then an operator on it. */
function opWithEmptyRight(n: number, op: "+" | "*") {
  let t = newTree();
  t = place(t, 0, numberCard(n), Infinity)!.tree; // fill root slot → value(n)
  const valueId = listNodes(t.root).find((x) => x.type === "value")!.id;
  t = place(t, valueId, opCard(op), Infinity)!.tree; // → op(value(n), slot)
  return t;
}

describe("merge animation values honor empty-× = 1", () => {
  it("reveals 1 for an unfilled × slot and multiplies correctly (not 0)", () => {
    const t = opWithEmptyRight(5, "*");
    const anim = new EvaluateAnimation(t.root);
    const slot = listNodes(t.root).find((x) => x.type === "slot")!;
    const opNode = listNodes(t.root).find((x) => x.type === "op")!;
    expect(anim.stateFor(slot.id).value).toBe(1); // greyed bubble shows 1
    expect(anim.stateFor(opNode.id).value).toBe(5); // 5 × 1, NOT 5 × 0 = 0
  });

  it("keeps 0 for an unfilled + slot", () => {
    const t = opWithEmptyRight(5, "+");
    const anim = new EvaluateAnimation(t.root);
    const slot = listNodes(t.root).find((x) => x.type === "slot")!;
    const opNode = listNodes(t.root).find((x) => x.type === "op")!;
    expect(anim.stateFor(slot.id).value).toBe(0);
    expect(anim.stateFor(opNode.id).value).toBe(5); // 5 + 0
  });
});

/**
 * The arithmetic syntax tree the player builds during a round.
 *
 * Grammar & rules:
 *   - The tree starts as a single "slot" that displays 0.
 *   - A NUMBER card may be played onto any SLOT, turning it into a value.
 *   - The VARIABLE card `x` (Functions mode) may be played onto any SLOT,
 *     turning it into an `x` leaf.
 *   - An OPERATION card may be played onto any LEAF (a value or an `x`),
 *     replacing that leaf with `op(leaf, slot)` — one child keeps the original
 *     leaf and the other is a fresh empty slot (0).
 *
 * Operators:
 *   - `+`, `*` are ordinary arithmetic.
 *   - `@` is function application: `apply(F, a)` evaluates the left subtree `F`
 *     (a polynomial that may contain `x` leaves) at the value of the right
 *     subtree `a`. Concretely it rebinds `x` to `eval(a)` while evaluating `F`.
 *
 * Evaluation (with an ambient value `xEnv` for the variable, default 0):
 *   - slot        -> 0
 *   - value(n)    -> n
 *   - x           -> xEnv
 *   - op(+, a, b) -> eval(a) + eval(b)
 *   - op(*, a, b) -> eval(a) * eval(b)
 *   - op(@, F, a) -> evaluate F with xEnv := eval(a)
 *
 * Every node has a stable numeric `id`, preserved across immutable updates
 * wherever a bubble should visually persist, so the renderer can animate morphs
 * and sprouts smoothly.
 */
import type { Card, Op } from "./cards";

export type NodeId = number;

export type TreeNode =
  | { readonly id: NodeId; readonly type: "slot" }
  | { readonly id: NodeId; readonly type: "value"; readonly value: number }
  | { readonly id: NodeId; readonly type: "var" }
  | {
      readonly id: NodeId;
      readonly type: "op";
      readonly op: Op;
      readonly left: TreeNode;
      readonly right: TreeNode;
    };

/** A tree plus the allocator used to hand out fresh, unique node ids. */
export interface Tree {
  readonly root: TreeNode;
  readonly nextId: NodeId;
}

export function newTree(): Tree {
  return { root: { id: 0, type: "slot" }, nextId: 1 };
}

// --- Evaluation ---------------------------------------------------------------

/** Evaluate a node. `xEnv` is the current binding of the variable `x`. */
export function evaluate(node: TreeNode, xEnv = 0): number {
  switch (node.type) {
    case "slot":
      return 0;
    case "value":
      return node.value;
    case "var":
      return xEnv;
    case "op":
      switch (node.op) {
        case "+":
          return evaluate(node.left, xEnv) + evaluate(node.right, xEnv);
        case "*":
          return evaluate(node.left, xEnv) * evaluate(node.right, xEnv);
        case "@":
          // Apply: evaluate the function (left) at the point given by the right.
          return evaluate(node.left, evaluate(node.right, xEnv));
      }
  }
}

// --- Traversal helpers --------------------------------------------------------

/** Pre-order list of every node in the tree. */
export function listNodes(node: TreeNode, out: TreeNode[] = []): TreeNode[] {
  out.push(node);
  if (node.type === "op") {
    listNodes(node.left, out);
    listNodes(node.right, out);
  }
  return out;
}

export function findNode(node: TreeNode, id: NodeId): TreeNode | null {
  if (node.id === id) return node;
  if (node.type === "op") {
    return findNode(node.left, id) ?? findNode(node.right, id);
  }
  return null;
}

export function nodeCount(node: TreeNode): number {
  return node.type === "op"
    ? 1 + nodeCount(node.left) + nodeCount(node.right)
    : 1;
}

/** Number of empty slots remaining — useful for hints and AI/testing. */
export function slotCount(node: TreeNode): number {
  if (node.type === "slot") return 1;
  if (node.type === "op") return slotCount(node.left) + slotCount(node.right);
  return 0;
}

/** Is this node a "leaf" that an operation can be played onto (value or x)? */
export function isOpTarget(node: TreeNode): boolean {
  return node.type === "value" || node.type === "var";
}

// --- Legality -----------------------------------------------------------------

/** Can `card` legally be played onto this node? */
export function canPlaceOn(node: TreeNode, card: Card): boolean {
  switch (card.kind) {
    case "number":
    case "var":
      return node.type === "slot";
    case "op":
      return isOpTarget(node);
  }
}

/** Ids of every node onto which `card` may currently be played. */
export function legalTargets(root: TreeNode, card: Card): NodeId[] {
  return listNodes(root)
    .filter((n) => canPlaceOn(n, card))
    .map((n) => n.id);
}

/** Does the tree currently admit ANY legal placement of `card`? */
export function hasLegalTarget(root: TreeNode, card: Card): boolean {
  return listNodes(root).some((n) => canPlaceOn(n, card));
}

// --- Placement ----------------------------------------------------------------

/**
 * Result of placing a card, carrying enough information for the renderer to
 * animate the change.
 */
export interface PlaceResult {
  readonly tree: Tree;
  /** The node that now embodies the played card (morphed slot, or new op). */
  readonly placedNodeId: NodeId;
  /** Ids of nodes that did not exist before this placement (to "sprout"). */
  readonly newNodeIds: NodeId[];
  readonly kind: "leaf-on-slot" | "op-on-leaf";
}

/** Copy a leaf node, preserving its identity (used as the child under a new op). */
function copyLeaf(node: TreeNode): TreeNode {
  if (node.type === "value") return { id: node.id, type: "value", value: node.value };
  if (node.type === "var") return { id: node.id, type: "var" };
  return { id: node.id, type: "slot" };
}

/**
 * Returns a NEW tree with `card` played on node `targetId`, or `null` if the
 * placement is illegal. Structural sharing keeps untouched subtrees identical.
 */
export function place(tree: Tree, targetId: NodeId, card: Card): PlaceResult | null {
  const target = findNode(tree.root, targetId);
  if (!target || !canPlaceOn(target, card)) return null;

  let nextId = tree.nextId;
  const newNodeIds: NodeId[] = [];
  let placedNodeId: NodeId = targetId;
  let kind: PlaceResult["kind"];

  const replaced = replaceNode(tree.root, targetId, (node): TreeNode => {
    if (card.kind === "number") {
      // Morph the slot in place — keep the id so the bubble stays put.
      kind = "leaf-on-slot";
      placedNodeId = node.id;
      return { id: node.id, type: "value", value: card.value };
    }
    if (card.kind === "var") {
      kind = "leaf-on-slot";
      placedNodeId = node.id;
      return { id: node.id, type: "var" };
    }
    // Op on a leaf: keep the original leaf (its id) as the left child, spawn a
    // fresh op node (takes the target's screen position) and a new slot.
    kind = "op-on-leaf";
    const opId = nextId++;
    const slotId = nextId++;
    newNodeIds.push(opId, slotId);
    placedNodeId = opId;
    return {
      id: opId,
      type: "op",
      op: card.op,
      left: copyLeaf(node),
      right: { id: slotId, type: "slot" },
    };
  });

  return {
    tree: { root: replaced, nextId },
    placedNodeId,
    newNodeIds,
    kind: kind!,
  };
}

/** Immutably replace the node with `id` using `fn`, sharing untouched subtrees. */
function replaceNode(
  node: TreeNode,
  id: NodeId,
  fn: (n: TreeNode) => TreeNode,
): TreeNode {
  if (node.id === id) return fn(node);
  if (node.type === "op") {
    const left = replaceNode(node.left, id, fn);
    const right = replaceNode(node.right, id, fn);
    if (left === node.left && right === node.right) return node;
    return { ...node, left, right };
  }
  return node;
}

// --- Pretty printing (debugging / tests) --------------------------------------

export function treeToString(node: TreeNode): string {
  switch (node.type) {
    case "slot":
      return "0";
    case "value":
      return String(node.value);
    case "var":
      return "x";
    case "op":
      if (node.op === "@") {
        // Function application: F(a)
        return `${treeToString(node.left)}(${treeToString(node.right)})`;
      }
      return `(${treeToString(node.left)} ${node.op} ${treeToString(node.right)})`;
  }
}

/**
 * The arithmetic syntax tree the player builds during a round.
 *
 * Grammar & rules (from the game spec):
 *   - The tree starts as a single "slot" that displays 0.
 *   - A NUMBER card may be played onto any SLOT, turning it into a value.
 *   - An OPERATION card may be played onto any VALUE (a number leaf), replacing
 *     that value with `op(value, slot)` — i.e. one child keeps the original
 *     number and the other child is a fresh empty slot (0).
 *
 * Evaluation:
 *   - slot        -> 0
 *   - value(n)    -> n
 *   - op(+, a, b) -> eval(a) + eval(b)
 *   - op(*, a, b) -> eval(a) * eval(b)
 *
 * Every node has a stable numeric `id`. Ids are preserved across immutable
 * updates wherever a bubble should visually persist, which lets the renderer
 * animate morphs and sprouts smoothly.
 */
import type { Card, Op } from "./cards";

export type NodeId = number;

export type TreeNode =
  | { readonly id: NodeId; readonly type: "slot" }
  | { readonly id: NodeId; readonly type: "value"; readonly value: number }
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

export function evaluate(node: TreeNode): number {
  switch (node.type) {
    case "slot":
      return 0;
    case "value":
      return node.value;
    case "op":
      return node.op === "+"
        ? evaluate(node.left) + evaluate(node.right)
        : evaluate(node.left) * evaluate(node.right);
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

// --- Legality -----------------------------------------------------------------

/** Can `card` legally be played onto the node with this id? */
export function canPlaceOn(node: TreeNode, card: Card): boolean {
  if (card.kind === "number") return node.type === "slot";
  return node.type === "value"; // op cards go on number leaves
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
  readonly kind: "number-on-slot" | "op-on-value";
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
      kind = "number-on-slot";
      placedNodeId = node.id;
      return { id: node.id, type: "value", value: card.value };
    }
    // Op on a value: keep the original value bubble (its id) as the left child,
    // spawn a fresh op node (takes the target's screen position) and a new slot.
    kind = "op-on-value";
    const value = node as Extract<TreeNode, { type: "value" }>;
    const opId = nextId++;
    const slotId = nextId++;
    newNodeIds.push(opId, slotId);
    placedNodeId = opId;
    return {
      id: opId,
      type: "op",
      op: card.op,
      left: { id: value.id, type: "value", value: value.value },
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
    case "op":
      return `(${treeToString(node.left)} ${node.op} ${treeToString(node.right)})`;
  }
}

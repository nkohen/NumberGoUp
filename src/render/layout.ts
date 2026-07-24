/**
 * Tidy binary-tree layout.
 *
 * Produces a (column, depth) coordinate for every node. Leaves are assigned
 * successive columns in left-to-right traversal order; each internal node sits
 * at the midpoint of its two children. The renderer maps these abstract
 * coordinates into whatever pixel rectangle the tree panel currently occupies,
 * so the layout itself is resolution-independent.
 */
import { TreeNode, NodeId, listNodes } from "../core/tree";

export interface NodeLayout {
  id: NodeId;
  col: number; // horizontal position, fractional for internal nodes
  depth: number; // 0 = root
}

export interface TreeLayout {
  nodes: Map<NodeId, NodeLayout>;
  /** Number of leaf columns (>= 1). */
  cols: number;
  /** Number of depth levels (>= 1). */
  depths: number;
}

export function layoutTree(root: TreeNode): TreeLayout {
  const nodes = new Map<NodeId, NodeLayout>();
  let nextLeafCol = 0;
  let maxDepth = 0;

  function visit(node: TreeNode, depth: number): number {
    maxDepth = Math.max(maxDepth, depth);
    if (node.type === "op") {
      const lc = visit(node.left, depth + 1);
      const rc = visit(node.right, depth + 1);
      const col = (lc + rc) / 2;
      nodes.set(node.id, { id: node.id, col, depth });
      return col;
    }
    const col = nextLeafCol++;
    nodes.set(node.id, { id: node.id, col, depth });
    return col;
  }

  visit(root, 0);
  const cols = Math.max(1, nextLeafCol);
  return { nodes, cols, depths: maxDepth + 1 };
}

/** Depth (levels below, 0 for a leaf) of each node — used to stagger the merge. */
export function nodeHeights(root: TreeNode): Map<NodeId, number> {
  const heights = new Map<NodeId, number>();
  function visit(node: TreeNode): number {
    if (node.type === "op") {
      const h = 1 + Math.max(visit(node.left), visit(node.right));
      heights.set(node.id, h);
      return h;
    }
    heights.set(node.id, 0);
    return 0;
  }
  visit(root);
  return heights;
}

/** Convenience: parent id for each node (root maps to null). */
export function parentMap(root: TreeNode): Map<NodeId, NodeId | null> {
  const parents = new Map<NodeId, NodeId | null>();
  parents.set(root.id, null);
  for (const n of listNodes(root)) {
    if (n.type === "op") {
      parents.set(n.left.id, n.id);
      parents.set(n.right.id, n.id);
    }
  }
  return parents;
}

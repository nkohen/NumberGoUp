/**
 * Small animation toolkit: easing functions, a frame-rate-independent smoothing
 * helper, and the "evaluate" merge-animation sequencer.
 */
import { TreeNode, NodeId, listNodes } from "../core/tree";
import { nodeHeights, parentMap } from "./layout";

/**
 * Fill `map` with each node's evaluated value, threading the variable
 * environment `xEnv` through `@` (apply) nodes exactly like `evaluate` does.
 * Returns this node's value.
 *
 * `slotIdentity` is what a BARE slot contributes in this position — matching
 * `evaluate`, an unfilled slot is its parent operator's identity: `0` under `+`
 * (and at the root / under `@`) but **1 under `×`**, so an incomplete × branch
 * reveals its greyed "1" and multiplies correctly instead of collapsing to 0.
 */
function computeValues(
  node: TreeNode,
  xEnv: number,
  map: Map<NodeId, number>,
  slotIdentity = 0,
): number {
  let v: number;
  switch (node.type) {
    case "slot":
      v = slotIdentity;
      break;
    case "value":
      v = node.value;
      break;
    case "var":
      v = xEnv;
      break;
    case "op": {
      if (node.op === "@") {
        const arg = computeValues(node.right, xEnv, map, 0);
        v = computeValues(node.left, arg, map, 0); // function evaluated at `arg`
      } else {
        const id = node.op === "*" ? 1 : 0;
        const l = computeValues(node.left, xEnv, map, id);
        const r = computeValues(node.right, xEnv, map, id);
        v = node.op === "+" ? l + r : l * r;
      }
      break;
    }
  }
  map.set(node.id, v);
  return v;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Overshooting ease for satisfying "pop-in" spawns. */
export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/**
 * Exponential smoothing toward a target that is stable across variable frame
 * rates. `rate` is roughly "fraction closed per 60fps frame".
 */
export function smooth(current: number, target: number, rate: number, dt: number): number {
  const k = 1 - Math.pow(1 - rate, dt * 60);
  return current + (target - current) * k;
}

/**
 * Drives the bottom-up "bubbles merge into their aggregate" animation shown
 * when the player finalizes the tree. Each node is revealed (its numeric value
 * appears and it pops) once time passes its height-based threshold; its
 * children are considered "absorbed" and shrink into it.
 */
export interface NodeMergeState {
  /** 0..1 progress of this node revealing its aggregate value. */
  reveal: number;
  /** 0..1 progress of this node being absorbed into its parent (shrinks). */
  absorb: number;
  /** The evaluated numeric value to display once revealed. */
  value: number;
}

export class EvaluateAnimation {
  private elapsed = 0;
  private readonly stepDur = 0.42; // seconds per tree level
  private readonly values = new Map<NodeId, number>();
  private readonly heights: Map<NodeId, number>;
  private readonly parents: Map<NodeId, NodeId | null>;
  private readonly maxHeight: number;
  /** Levels (by height) whose merge sound has already fired. */
  private firedLevels = new Set<number>();

  constructor(root: TreeNode) {
    this.heights = nodeHeights(root);
    this.parents = parentMap(root);
    // Compute each node's displayed value WITH the variable environment
    // propagated through `@` (apply) nodes, so `x` leaves reveal the point they
    // were evaluated at and apply nodes reveal the function's value there.
    computeValues(root, 0, this.values);
    let mh = 0;
    for (const n of listNodes(root)) {
      mh = Math.max(mh, this.heights.get(n.id) ?? 0);
    }
    this.maxHeight = mh;
  }

  /** Advance the animation. Returns the set of levels that "merged" this frame. */
  update(dt: number): number[] {
    this.elapsed += dt;
    const justFired: number[] = [];
    // A level h reveals at time h*stepDur.
    for (let h = 0; h <= this.maxHeight; h++) {
      if (this.elapsed >= h * this.stepDur && !this.firedLevels.has(h)) {
        this.firedLevels.add(h);
        if (h > 0) justFired.push(h); // level 0 (leaves) makes no merge sound
      }
    }
    return justFired;
  }

  get done(): boolean {
    // Give a beat after the root reveals.
    return this.elapsed >= (this.maxHeight + 1) * this.stepDur + 0.35;
  }

  /** Fraction of total duration elapsed (0..1). */
  get progress(): number {
    return clamp01(this.elapsed / ((this.maxHeight + 1) * this.stepDur));
  }

  /** Per-node visual state for the current time. */
  stateFor(id: NodeId): NodeMergeState {
    const h = this.heights.get(id) ?? 0;
    const revealStart = h * this.stepDur;
    const reveal = clamp01((this.elapsed - revealStart) / this.stepDur);

    // A node begins to absorb into its parent once the parent starts revealing.
    const parent = this.parents.get(id) ?? null;
    let absorb = 0;
    if (parent !== null) {
      const ph = this.heights.get(parent) ?? 0;
      const parentRevealStart = ph * this.stepDur;
      absorb = clamp01((this.elapsed - parentRevealStart) / this.stepDur);
    }
    return { reveal, absorb, value: this.values.get(id) ?? 0 };
  }
}

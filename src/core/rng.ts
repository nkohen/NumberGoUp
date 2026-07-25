/**
 * Deterministic, seedable pseudo-random number generator.
 *
 * We deliberately avoid `Math.random()` in game logic so that:
 *  - runs can be reproduced from a seed (useful for debugging and daily-run style modes),
 *  - unit tests are deterministic.
 *
 * Uses the well-known `mulberry32` algorithm: tiny, fast, and good enough for a game.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Force to unsigned 32-bit. Avoid a zero state which would degrade the sequence.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Snapshot the internal state (for save/load — resumes the exact sequence). */
  saveState(): number {
    return this.state;
  }

  /** Restore a previously snapshotted state (see {@link saveState}). */
  loadState(state: number): void {
    this.state = (state >>> 0) || 0x9e3779b9;
  }

  /** Returns a float in [0, 1). */
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns an integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Returns a uniformly random element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /**
   * Fisher–Yates shuffle returning a NEW array (does not mutate the input).
   * Keeping game data immutable makes the state machine easier to reason about.
   */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

/** Convenience for creating a seed when the caller doesn't care about reproducibility. */
export function randomSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
}

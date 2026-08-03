/**
 * Level solver: fewest cards that clear a net to nothing.
 *
 * This exists because **you cannot tell by looking whether a net is clearable**.
 * A δ sitting in the wrong place duplicates whatever you throw at it and the
 * level is simply unwinnable; other nets need a specific three-card line. So
 * every shipped level is verified by this solver, and its `par` is whatever the
 * solver found — see `tests/inet/solver.test.ts`, which fails if a level drifts
 * off par or stops being solvable at all.
 *
 * Iterative deepening over move sequences, with the HAND as the branching
 * constraint (you can only play cards you have, which is what keeps the search
 * tractable). Between moves the net is reduced to normal form, so a state is
 * fully determined by its net — and since reduction is confluent, that normal
 * form is canonical, which makes `Net.signature()` a sound memo key. Nice
 * property to get for free from the theory.
 *
 * CAVEAT worth stating plainly: this searches the policy "reduce to normal form
 * between moves". A player can also stop reduction part-way and play a card into
 * a half-reduced net, and that is occasionally different — reduction never
 * creates or destroys free wires, so the same wires are always available, but
 * WHAT SITS AT THE FAR END of one can change as an erasure wave travels along
 * it. So `par` is an upper bound on the true minimum, not a proven floor. A
 * player who beats it has found something real, and the demo reports that as
 * under par rather than treating it as impossible.
 *
 * Pure and DOM-free.
 */
import { Net } from "./net";
import { reduce } from "./reduce";
import { applyMove, cardFor, isCleared, legalMoves, spend, type Card, type Move } from "./level";

export interface SolveOptions {
  /** Deepest line to consider. Search cost grows sharply with this. */
  maxCards?: number;
  /** Interactions allowed per move before the line is judged divergent. */
  fuel?: number;
  /** Abandon a line that blows up past this many agents. */
  agentCap?: number;
  /** Give up after this many search nodes rather than hanging. */
  nodeBudget?: number;
}

export interface Solution {
  cards: number;
  line: Move[];
}

export interface SolveResult {
  /** The shortest line found, or null if none exists within the limits. */
  solution: Solution | null;
  /** True if the search finished rather than running out of budget. */
  exhaustive: boolean;
  nodes: number;
}

const DEFAULTS = {
  maxCards: 4,
  fuel: 400,
  agentCap: 120,
  nodeBudget: 400_000,
};

/**
 * Reduce a net to normal form, reporting failure if it diverges or blows up.
 * A line that does either is one no player would choose, so the search prunes it.
 */
function settle(net: Net, fuel: number, agentCap: number): boolean {
  const result = reduce(net, { fuel });
  return !result.fuelExhausted && net.agentCount <= agentCap;
}

export function solve(start: Net, hand: readonly Card[], options: SolveOptions = {}): SolveResult {
  const maxCards = Math.min(options.maxCards ?? DEFAULTS.maxCards, hand.length);
  const fuel = options.fuel ?? DEFAULTS.fuel;
  const agentCap = options.agentCap ?? DEFAULTS.agentCap;
  const nodeBudget = options.nodeBudget ?? DEFAULTS.nodeBudget;

  let nodes = 0;
  let budgetHit = false;

  const root = start.clone();
  if (!settle(root, fuel, agentCap)) return { solution: null, exhaustive: false, nodes };

  for (let depth = 0; depth <= maxCards; depth++) {
    // Memo per depth: a state reached with fewer cards left is a different
    // (worse) state, so the budget has to be part of the key.
    const seen = new Set<string>();
    const line: Move[] = [];

    const search = (net: Net, cards: readonly Card[], left: number): boolean => {
      if (isCleared(net)) return true;
      if (left === 0) return false;
      if (nodes >= nodeBudget) {
        budgetHit = true;
        return false;
      }
      nodes++;
      const key = `${left}|${net.signature()}`;
      if (seen.has(key)) return false;
      seen.add(key);

      for (const move of legalMoves(net, cards)) {
        const rest = spend(cards, cardFor(move));
        if (!rest) continue;
        const next = net.clone();
        if (!applyMove(next, move)) continue;
        if (!settle(next, fuel, agentCap)) continue; // diverged or blew up
        line.push(move);
        if (search(next, rest, left - 1)) return true;
        line.pop();
        if (budgetHit) return false;
      }
      return false;
    };

    if (search(root, hand, depth)) {
      return { solution: { cards: depth, line: [...line] }, exhaustive: !budgetHit, nodes };
    }
    if (budgetHit) break;
  }
  return { solution: null, exhaustive: !budgetHit, nodes };
}

/** Convenience: the par of a level, or null if it cannot be cleared. */
export function parFor(start: Net, hand: readonly Card[], options: SolveOptions = {}): number | null {
  return solve(start, hand, options).solution?.cards ?? null;
}

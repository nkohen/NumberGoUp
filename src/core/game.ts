/**
 * The run/round state machine — the single source of truth for a play session.
 *
 * A "run" is a sequence of rounds with rising score targets. Within a round the
 * player builds an arithmetic tree one card at a time:
 *
 *   1. `startRound` copies the run deck, shuffles it, resets the tree to a slot,
 *      and draws an opening hand.
 *   2. Each turn the player either:
 *        - `play(handIndex, nodeId)` — place one card in the tree. The remaining
 *          hand cards return to the round deck, the played card is consumed, and
 *          a fresh hand is drawn (shuffle + draw). This matches the spec:
 *          "play one of their cards ... and put the rest ... back on their deck".
 *        - `evaluate()` — finalize. Score = value of the tree. If it meets the
 *          target the round is won (→ shop); otherwise the run ends.
 *   3. `chooseUpgrade` applies a deck upgrade and starts the next round.
 *
 * The class mutates internal state for ergonomics with the render loop, but all
 * randomness flows through a seeded `Rng`, so behavior is fully reproducible.
 */
import { Card } from "./cards";
import { starterDeck } from "./cards";
import { Rng, randomSeed } from "./rng";
import {
  Tree,
  TreeNode,
  newTree,
  evaluate,
  place,
  hasLegalTarget,
  PlaceResult,
} from "./tree";
import { Upgrade, generateOffers, applyUpgrade } from "./upgrades";

export type Phase = "title" | "playing" | "shop" | "gameover";

export interface GameConfig {
  handSize: number;
  /** Round-1 target score. */
  baseTarget: number;
  /** Multiplicative growth of the target per round. */
  targetGrowth: number;
  upgradeChoices: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  handSize: 5,
  // Round 1 (target 4) is gently winnable additively on the starter deck (e.g.
  // 2+2); the additive ceiling is 6 (1+1+2+2), so within a couple of rounds the
  // rising target forces you to discover multiplication. Tunable — see docs.
  baseTarget: 4,
  targetGrowth: 1.6,
  upgradeChoices: 3,
};

/** The target score for a given (1-indexed) round. */
export function targetForRound(round: number, cfg: GameConfig): number {
  return Math.ceil(cfg.baseTarget * Math.pow(cfg.targetGrowth, round - 1));
}

/** Result of finalizing a round, handed to the UI for animation & flow. */
export interface EvaluateResult {
  score: number;
  target: number;
  won: boolean;
  round: number;
}

export class Game {
  readonly cfg: GameConfig;
  readonly seed: number;
  private rng: Rng;

  phase: Phase = "title";

  /** The persistent deck for the whole run (upgrades modify this). */
  deck: Card[] = [];
  round = 1;
  target = 0;

  // --- round-scoped state ---
  tree: Tree = newTree();
  /** Cards still available to draw this round (the played card is removed). */
  roundDeck: Card[] = [];
  hand: Card[] = [];
  turn = 0;

  // --- shop / results state ---
  offers: Upgrade[] = [];
  lastResult: EvaluateResult | null = null;

  // --- run stats ---
  bestScore = 0;
  roundsCleared = 0;

  constructor(cfg: GameConfig = DEFAULT_CONFIG, seed: number = randomSeed()) {
    this.cfg = cfg;
    this.seed = seed;
    this.rng = new Rng(seed);
  }

  // --- run lifecycle ----------------------------------------------------------

  /** Begin a fresh run from the title screen. */
  startRun(): void {
    this.deck = starterDeck();
    this.round = 1;
    this.bestScore = 0;
    this.roundsCleared = 0;
    this.lastResult = null;
    this.startRound();
  }

  private startRound(): void {
    this.phase = "playing";
    this.target = targetForRound(this.round, this.cfg);
    this.tree = newTree();
    this.roundDeck = this.rng.shuffle(this.deck);
    this.hand = [];
    this.turn = 0;
    this.drawHand();
  }

  /** Shuffle the round deck and refill the hand up to `handSize`. */
  private drawHand(): void {
    // Return any leftover hand cards to the round deck first.
    if (this.hand.length > 0) {
      this.roundDeck = this.roundDeck.concat(this.hand);
      this.hand = [];
    }
    this.roundDeck = this.rng.shuffle(this.roundDeck);
    const n = Math.min(this.cfg.handSize, this.roundDeck.length);
    this.hand = this.roundDeck.slice(0, n);
    this.roundDeck = this.roundDeck.slice(n);
    this.turn += 1;
  }

  // --- queries ----------------------------------------------------------------

  /** Live value of the tree as currently built. */
  get currentScore(): number {
    return evaluate(this.tree.root);
  }

  /** True if at least one card in hand has a legal placement. */
  canPlayAny(): boolean {
    return this.hand.some((c) => hasLegalTarget(this.tree.root, c));
  }

  /** True when the round can no longer progress by playing (deck & hand spent). */
  get isHandEmpty(): boolean {
    return this.hand.length === 0;
  }

  // --- round actions ----------------------------------------------------------

  /**
   * Play the hand card at `handIndex` onto tree node `nodeId`.
   * Returns the placement result (for animation) or `null` if illegal.
   * On success, refills the hand for the next turn.
   */
  play(handIndex: number, nodeId: number): PlaceResult | null {
    if (this.phase !== "playing") return null;
    const card = this.hand[handIndex];
    if (!card) return null;

    const result = place(this.tree, nodeId, card);
    if (!result) return null;

    this.tree = result.tree;
    // Consume the played card; the rest of the hand returns to the deck.
    this.hand = this.hand.filter((_, i) => i !== handIndex);
    this.drawHand();
    return result;
  }

  /**
   * When the player is genuinely stuck (no card can be legally placed), allow a
   * free reshuffle of the hand rather than forcing a losing evaluate. This only
   * fires when there is truly no legal move, so it cannot be used to stall.
   */
  redraw(): boolean {
    if (this.phase !== "playing") return false;
    if (this.canPlayAny()) return false;
    if (this.roundDeck.length === 0) return false; // nothing new to draw
    this.drawHand();
    return true;
  }

  /** Finalize the round: score the tree and decide win/lose. */
  evaluate(): EvaluateResult {
    const score = this.currentScore;
    const won = score >= this.target;
    const result: EvaluateResult = {
      score,
      target: this.target,
      won,
      round: this.round,
    };
    this.lastResult = result;
    this.bestScore = Math.max(this.bestScore, score);

    if (won) {
      this.roundsCleared += 1;
      this.offers = generateOffers(
        this.deck,
        this.rng,
        this.round,
        this.cfg.upgradeChoices,
      );
      this.phase = "shop";
    } else {
      this.phase = "gameover";
    }
    return result;
  }

  // --- shop actions -----------------------------------------------------------

  /** Apply the chosen upgrade (or skip with `null`) and start the next round. */
  chooseUpgrade(index: number | null): void {
    if (this.phase !== "shop") return;
    if (index !== null && this.offers[index]) {
      this.deck = applyUpgrade(this.deck, this.offers[index]);
    }
    this.offers = [];
    this.round += 1;
    this.startRound();
  }

  /** Restart the whole run after a game over (or from anywhere). */
  restart(): void {
    this.rng = new Rng(this.seed);
    this.startRun();
  }

  // --- convenience for renderer ----------------------------------------------

  get root(): TreeNode {
    return this.tree.root;
  }
}

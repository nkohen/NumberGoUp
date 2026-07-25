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
import { starterDeck, functionsStarterDeck } from "./cards";
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

/**
 * Game variants:
 *  - `classic`   — numbers and +/× only (the original spec).
 *  - `functions` — additionally the variable `x` and the evaluate operator `ƒ`,
 *    letting you build a polynomial and evaluate it at a point.
 */
export type GameMode = "classic" | "functions";

/**
 * How landing near the target is rewarded (the "precision" mechanic). The skill
 * is to clear the target by as LITTLE as possible; the reward is banked as
 * `focus`, spent to grow the tree's depth.
 *   - `tiered`     — graded bands by overshoot → 5/4/3/2/1/0 focus.
 *   - `continuous` — focus scales smoothly with how close you landed.
 *   - `safety`     — like `tiered`, but a small UNDERshoot still clears (banks 0)
 *                    instead of ending the run.
 * Switchable at runtime (dev `?precision=`) so the models can be compared.
 */
export type PrecisionModel = "tiered" | "continuous" | "safety";

/** Descriptive grade for a finalized round (drives feedback + focus reward). */
export type LandGrade =
  | "PERFECT"
  | "SHARP"
  | "CLOSE"
  | "NEAR"
  | "LOOSE"
  | "CLEARED"
  | "SCRAPE"
  | "MISS";

export interface GameConfig {
  mode: GameMode;
  handSize: number;
  /** Round-1 target score. */
  baseTarget: number;
  /** Multiplicative growth of the target per round. */
  targetGrowth: number;
  upgradeChoices: number;
  /**
   * Starting tree-depth cap (root = depth 0), i.e. the deepest a node may sit.
   * A cap of D allows at most 2^D leaves. The player raises the *current* cap
   * during a run by spending `focus` (see `PrecisionModel`). Starts at 2 → four
   * leaves, so early rounds are a tight "pick your best four" puzzle.
   */
  startDepth: number;
  /** How precision (closeness to the target) is rewarded. */
  precisionModel: PrecisionModel;
}

export const DEFAULT_CONFIG: GameConfig = {
  mode: "classic",
  handSize: 5,
  // Round 1 (target 4) is gently winnable additively on the starter deck (e.g.
  // 2+2); the additive ceiling is 6 (1+1+2+2), so within a couple of rounds the
  // rising target forces you to discover multiplication. Tunable — see docs.
  baseTarget: 4,
  // Steeper than the original 1.6: with a shallow tree the best build climbs
  // fast as the deck improves, so a steep curve keeps the target chasing it.
  // Growing the tree (via focus) is what lets a skilled player keep pace.
  //
  // 1.85 → 1.90 after the placement-preview "empty × slot = 1 identity" change.
  // That change is a floor-only forgiveness buff: modeling (tools/analyze.ts +
  // tools/survival.ts) shows the OPTIMAL-play economy is byte-identical, while
  // the unskilled floor at depth ≥3 rises ~40% (avg 4.1→5.7) and the 8% zero
  // rate vanishes — i.e. it eases the MID-LATE game (depth 2 is unchanged).
  // Because targets compound, nudging growth re-pressures exactly there: rounds
  // 1–4 targets are identical (4, 8, 14, 26) so the fragile early bootstrap is
  // untouched, but round 10+ is ~40% higher, reclaiming the difficulty the buff
  // gives back — without penalising skilled players via a lower ceiling.
  targetGrowth: 1.9,
  upgradeChoices: 3,
  startDepth: 2,
  precisionModel: "tiered",
};

/** Hard ceiling on tree depth (keeps the game — and the analysis — tractable). */
export const MAX_DEPTH = 6;

/** Focus cost to raise the cap FROM `depth` to `depth + 1` (escalating). */
export function costToGrow(depth: number): number {
  return Math.round(6 * Math.pow(1.7, depth - 2));
}

/** Small undershoot still tolerated as a clear under the `safety` model. */
const SAFETY_MARGIN = 0.03;
/** Max focus a single perfect land can bank (shared by all models). */
const FOCUS_MAX = 5;
/** Focus banked for skipping the shop upgrade (tiered model only). */
const SKIP_FOCUS = 1;
/** Focus cost of the first shop re-roll; each further re-roll costs STEP more. */
const REROLL_BASE = 2;
const REROLL_STEP = 2;
/** Focus cost of the first paid re-draw in a round; rises with each one. */
const FISH_BASE = 1;
const FISH_STEP = 1;

/**
 * Overshoot bands for the tiered model: land within each ratio (or exactly on
 * target) to bank that much focus. Checked in order, tightest first.
 */
const TIERS: ReadonlyArray<{ maxOver: number; grade: LandGrade; focus: number }> = [
  { maxOver: 0, grade: "PERFECT", focus: 5 },
  { maxOver: 0.05, grade: "SHARP", focus: 4 },
  { maxOver: 0.1, grade: "CLOSE", focus: 3 },
  { maxOver: 0.15, grade: "NEAR", focus: 2 },
  { maxOver: 0.2, grade: "LOOSE", focus: 1 },
];

/** A display grade for a clear, from its overshoot ratio (feedback only). */
function gradeLabel(over: number): LandGrade {
  for (const t of TIERS) if (over <= t.maxOver) return t.grade;
  return "CLEARED";
}

/**
 * Grade a finalized score against the target under a precision model: whether
 * it clears, its grade, and the focus it banks. Reward is highest for the
 * tightest clear; a big overshoot banks nothing. Pure — exported for testing.
 */
export function gradeLand(
  score: number,
  target: number,
  model: PrecisionModel,
): { won: boolean; grade: LandGrade; focusEarned: number } {
  if (score < target) {
    // Under the safety model a tiny undershoot still scrapes a clear.
    if (model === "safety" && score >= target * (1 - SAFETY_MARGIN)) {
      return { won: true, grade: "SCRAPE", focusEarned: 0 };
    }
    return { won: false, grade: "MISS", focusEarned: 0 };
  }
  const over = target > 0 ? (score - target) / target : 0;
  if (model === "continuous") {
    // Whole-number focus (no fractions): 4 at a perfect land, scaling to 0 as
    // the overshoot approaches +100%.
    const focusEarned = Math.round(FOCUS_MAX * Math.max(0, 1 - over));
    return { won: true, grade: gradeLabel(over), focusEarned };
  }
  // tiered (and safety, for clears at/above target)
  for (const t of TIERS) {
    if (over <= t.maxOver) return { won: true, grade: t.grade, focusEarned: t.focus };
  }
  return { won: true, grade: "CLEARED", focusEarned: 0 };
}

/** Config for a given mode (currently the modes share the target curve). */
export function configForMode(mode: GameMode): GameConfig {
  return { ...DEFAULT_CONFIG, mode };
}

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
  /** score − target (negative if undershot). */
  overshoot: number;
  /** How the land was graded (drives feedback + focus reward). */
  grade: LandGrade;
  /** Focus banked from this land (0 unless a clear near the target). */
  focusEarned: number;
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
  /** Paid re-draws ("fishing") used this round (drives the escalating cost). */
  fishCount = 0;

  // --- shop / results state ---
  offers: Upgrade[] = [];
  lastResult: EvaluateResult | null = null;

  // --- run stats ---
  bestScore = 0;
  roundsCleared = 0;

  // --- precision mechanic ---
  /** Current tree-depth cap; grows during the run as focus is spent. */
  currentDepth = 2;
  /** Banked precision resource, spent to grow the tree. */
  focus = 0;
  /** Re-rolls used in the current shop visit (drives the escalating cost). */
  rerollCount = 0;

  constructor(cfg: GameConfig = DEFAULT_CONFIG, seed: number = randomSeed()) {
    this.cfg = cfg;
    this.seed = seed;
    this.rng = new Rng(seed);
    this.currentDepth = cfg.startDepth;
  }

  // --- run lifecycle ----------------------------------------------------------

  /** Begin a fresh run from the title screen. */
  startRun(deckOverride?: Card[]): void {
    this.deck =
      deckOverride ??
      (this.cfg.mode === "functions" ? functionsStarterDeck() : starterDeck());
    this.round = 1;
    this.bestScore = 0;
    this.roundsCleared = 0;
    this.currentDepth = this.cfg.startDepth;
    this.focus = 0;
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
    this.fishCount = 0;
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
    return this.hand.some((c) =>
      hasLegalTarget(this.tree.root, c, this.currentDepth),
    );
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

    const result = place(this.tree, nodeId, card, this.currentDepth);
    if (!result) return null;

    this.tree = result.tree;
    // Consume the played card; the rest of the hand returns to the deck.
    this.hand = this.hand.filter((_, i) => i !== handIndex);
    this.drawHand();
    return result;
  }

  /**
   * Focus cost to re-draw the hand right now. It's FREE when you're genuinely
   * stuck (no legal move — a safety net that can't be abused). Otherwise it's a
   * paid "fish": swap your hand hoping to draw a needed card (e.g. a ×), at an
   * escalating cost so you can't fish endlessly.
   */
  get redrawCost(): number {
    if (!this.canPlayAny()) return 0;
    return FISH_BASE + this.fishCount * FISH_STEP;
  }

  /** Whether a re-draw is possible now (cards remain, and free or affordable). */
  canRedraw(): boolean {
    if (this.phase !== "playing") return false;
    if (this.roundDeck.length === 0) return false; // nothing new to draw
    return this.focus >= this.redrawCost;
  }

  /**
   * Re-draw the hand. Free when stuck; otherwise spends focus (and counts toward
   * the escalating fish cost). Returns true on success.
   */
  redraw(): boolean {
    if (!this.canRedraw()) return false;
    const cost = this.redrawCost;
    if (cost > 0) {
      this.focus -= cost;
      this.fishCount += 1;
    }
    this.drawHand();
    return true;
  }

  /** Finalize the round: score the tree, grade the land, and decide win/lose. */
  evaluate(): EvaluateResult {
    const score = this.currentScore;
    const { won, grade, focusEarned } = gradeLand(
      score,
      this.target,
      this.cfg.precisionModel,
    );
    const result: EvaluateResult = {
      score,
      target: this.target,
      won,
      round: this.round,
      overshoot: score - this.target,
      grade,
      focusEarned,
    };
    this.lastResult = result;
    this.bestScore = Math.max(this.bestScore, score);
    this.focus += focusEarned;

    if (won) {
      this.roundsCleared += 1;
      this.rerollCount = 0;
      this.offers = generateOffers(
        this.deck,
        this.rng,
        this.round,
        this.cfg.upgradeChoices,
        this.cfg.mode,
      );
      this.phase = "shop";
    } else {
      this.phase = "gameover";
    }
    return result;
  }

  /** Focus cost of the next shop re-roll (rises with each re-roll this visit). */
  get rerollCost(): number {
    return REROLL_BASE + this.rerollCount * REROLL_STEP;
  }

  /** Whether the offers can be re-rolled now (in the shop and affordable). */
  canReroll(): boolean {
    return this.phase === "shop" && this.focus >= this.rerollCost;
  }

  /**
   * Spend focus to replace the current upgrade offers with a fresh draw. Does
   * NOT advance the round — it just refreshes your choices, e.g. when fishing
   * for a specific card. Returns true on success.
   */
  rerollOffers(): boolean {
    if (!this.canReroll()) return false;
    this.focus -= this.rerollCost;
    this.rerollCount += 1;
    this.offers = generateOffers(
      this.deck,
      this.rng,
      this.round,
      this.cfg.upgradeChoices,
      this.cfg.mode,
    );
    return true;
  }

  /** Focus cost to raise the current depth cap by one. */
  get growCost(): number {
    return costToGrow(this.currentDepth);
  }

  /** Whether the tree can be grown right now (affordable and below the ceiling). */
  canGrow(): boolean {
    return this.currentDepth < MAX_DEPTH && this.focus >= this.growCost;
  }

  /**
   * Spend focus to raise the depth cap by one, THEN advance to the next round.
   * Growing is mutually exclusive with taking a card upgrade — it uses up the
   * shop, so a round of growth costs you the upgrade you'd otherwise pick.
   * Returns true on success.
   */
  growTree(): boolean {
    if (this.phase !== "shop") return false;
    if (!this.canGrow()) return false;
    this.focus -= this.growCost;
    this.currentDepth += 1;
    this.advanceRound();
    return true;
  }

  // --- shop actions -----------------------------------------------------------

  /** Take the chosen card upgrade and advance to the next round. */
  chooseUpgrade(index: number | null): void {
    if (this.phase !== "shop") return;
    if (index !== null && this.offers[index]) {
      this.deck = applyUpgrade(this.deck, this.offers[index]);
    } else {
      // Skipping the upgrade banks a little focus under the tiered model, so
      // passing on a card is a small step toward growing the tree instead.
      if (this.cfg.precisionModel === "tiered") this.focus += SKIP_FOCUS;
    }
    this.advanceRound();
  }

  /** Close the shop and begin the next round. */
  private advanceRound(): void {
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

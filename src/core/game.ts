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

export type Phase = "title" | "playing" | "shop" | "gameover" | "won";

/**
 * Clearing this round wins a CLASSIC/FUNCTIONS run. The game is endless by
 * nature, but the late game converges on the same "big multiply tree + a small
 * additive tweak" shape, so round 30 is a satisfying finish line — a milestone
 * win (you can still choose to keep playing past it).
 */
export const WIN_ROUND = 30;

/**
 * Surviving this round wins a PRECISION run. It needs its own, shorter finish
 * line because the two modes run out of road differently. Classic's target curve
 * rises forever, so a run ends itself. Precision's target range STOPS widening
 * at `precisionRangeMax` (~round 15), after which nothing escalates: HP only
 * falls, so a deck precise enough to average ~0 damage would face no opposition
 * and could run indefinitely. Round 20 sits just past the plateau — long enough
 * that you have to survive the full range, short enough to be a real finish.
 */
export const PRECISION_WIN_ROUND = 20;

/** The round whose clear wins the run, for a given mode. */
export function winRoundFor(mode: GameMode): number {
  return mode === "precision" ? PRECISION_WIN_ROUND : WIN_ROUND;
}

/**
 * Game variants. All three share the same build-a-tree mechanics; they differ
 * only in what the target is and what happens when you land off it.
 *  - `classic`   — numbers and +/× only (the original spec). Rising target, and
 *    undershooting it ends the run.
 *  - `functions` — classic plus the variable `x` and the evaluate operator `ƒ`,
 *    letting you build a polynomial and evaluate it at a point.
 *  - `precision`  — the target is RANDOM each round rather than a rising curve,
 *    and missing it doesn't end the run: you take damage equal to your distance
 *    from it (over OR under) out of a fixed HP pool. Nothing to "clear" — you
 *    just survive as many rounds as your deck's precision can pay for.
 */
export type GameMode = "classic" | "functions" | "precision";

/**
 * How landing near the target is rewarded (the closeness → `focus` mechanic).
 *
 * ⚠️ Not to be confused with the **Precision game mode** (`GameMode`). This type
 * predates it and applies to every mode: it only picks the shape of the focus
 * reward curve. `cfg.precisionModel` = reward bands; `cfg.mode === "precision"`
 * = the HP/random-target variant, whose own knobs are the `precisionHp` /
 * `precisionRange*` fields below.
 *
 * The skill is to clear the target by as LITTLE as possible; the reward is
 * banked as `focus`, spent to grow the tree's depth.
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
  /**
   * How closeness to the target is rewarded, in ALL modes. Despite the name this
   * is not the Precision-mode switch — that's `mode` (see {@link PrecisionModel}).
   */
  precisionModel: PrecisionModel;

  // --- Precision mode only (mode === "precision") -------------------------------
  /** Starting (and maximum) HP. There is no healing — it only goes down. */
  precisionHp: number;
  /** Round-1 exclusive upper bound of the random target range. */
  precisionRangeStart: number;
  /** How fast that bound widens per round. */
  precisionRangeGrowth: number;
  /** The bound stops widening here — the range the mode ultimately settles on. */
  precisionRangeMax: number;
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

  // Precision: 100 HP, and a target drawn uniformly from a range that WIDENS
  // toward [1, 1000) rather than starting there. The starter deck tops out at a
  // score of 9, so an immediate [1, 1000) would average ~491 damage a round and
  // kill you on round 1 — the range has to start inside what the deck can build
  // and then outrun it.
  //
  // Growth 1.35 gives caps 10, 14, 19, 25, 34, 45, 61, 82, 111, 149 … reaching
  // the full [1, 1000) at round 17 — so the last few rounds before the win are
  // played at the full range.
  //
  // Set by `tools/precisionmode.ts` (greedy semi-skilled player, 100 trials),
  // balancing two things that pull against each other once PRECISION_WIN_ROUND
  // exists: the win has to be reachable, but it should not arrive BEFORE the
  // range has finished widening, or you'd win without ever facing [1, 1000).
  //   growth  full range at   median   wins @ r20
  //   1.25    r22 (too late)  18       30%
  //   1.30    r19             15       11%
  //   1.35    r17             14        3%   ← here
  //   1.40    r15             12        0%   (max run ever: 19 — unwinnable)
  // A human should beat this myopic one-ply model comfortably, so 3% for the sim
  // is meant to read as "a real stretch goal", not "impossible". Raise toward
  // 1.40 to make winning elite-only; drop toward 1.30 to make it routine.
  precisionHp: 100,
  precisionRangeStart: 10,
  precisionRangeGrowth: 1.35,
  precisionRangeMax: 1000,
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

/**
 * Grade a finalized score in PRECISION mode, where the target may be missed from
 * either side. Damage is the raw distance; the focus reward reuses the same
 * bands as {@link gradeLand} but on the ABSOLUTE relative distance, so
 * undershooting by 5% pays exactly what overshooting by 5% does. Pure.
 */
export function gradePrecision(
  score: number,
  target: number,
): { damage: number; grade: LandGrade; focusEarned: number } {
  const damage = Math.abs(score - target);
  const rel = target > 0 ? damage / target : 0;
  for (const t of TIERS) {
    if (rel <= t.maxOver) return { damage, grade: t.grade, focusEarned: t.focus };
  }
  return { damage, grade: "CLEARED", focusEarned: 0 };
}

/** Config for a given mode (the classic/functions modes share the target curve). */
export function configForMode(mode: GameMode): GameConfig {
  return { ...DEFAULT_CONFIG, mode };
}

/** The target score for a given (1-indexed) round. */
export function targetForRound(round: number, cfg: GameConfig): number {
  return Math.ceil(cfg.baseTarget * Math.pow(cfg.targetGrowth, round - 1));
}

/**
 * PRECISION: the exclusive upper bound of the random target range for a round —
 * the target is drawn uniformly from `[1, cap)`. It widens each round until it
 * reaches `precisionRangeMax`, then stays there forever. That ramp is the whole
 * difficulty curve: a fresh deck can land anywhere inside a narrow range, and
 * the pressure is the range outgrowing what your deck can precisely build.
 */
export function precisionRangeCap(round: number, cfg: GameConfig): number {
  const cap = Math.ceil(
    cfg.precisionRangeStart * Math.pow(cfg.precisionRangeGrowth, round - 1),
  );
  return Math.min(cfg.precisionRangeMax, cap);
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
  /** PRECISION only: HP lost — the absolute distance from the target. */
  damage?: number;
  /** PRECISION only: HP remaining after taking that damage. */
  hpLeft?: number;
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

  // --- precision mode ----------------------------------------------------------
  /** PRECISION: remaining health. Hits 0 → the run ends. Unused in other modes. */
  hp = 0;

  constructor(cfg: GameConfig = DEFAULT_CONFIG, seed: number = randomSeed()) {
    this.cfg = cfg;
    this.seed = seed;
    this.rng = new Rng(seed);
    this.currentDepth = cfg.startDepth;
    this.hp = cfg.precisionHp;
  }

  /** True in the mode where the target is random and misses cost HP. */
  get isPrecision(): boolean {
    return this.cfg.mode === "precision";
  }

  /** PRECISION: the starting/maximum HP (there is no healing). */
  get maxHp(): number {
    return this.cfg.precisionHp;
  }

  /** The round whose clear wins this run (mode-dependent). */
  get winRound(): number {
    return winRoundFor(this.cfg.mode);
  }

  /**
   * PRECISION: HP this tree would cost if finalized right now. The player is
   * shown this live, so ending the round is always an informed choice.
   */
  get pendingDamage(): number {
    return Math.abs(this.currentScore - this.target);
  }

  /**
   * Whether the round has reached an outcome the player cannot improve on, so it
   * can finalize itself instead of waiting for a click: the score is at or past
   * the target.
   *
   * This holds in EVERY mode, including precision, and rests on one property of
   * the current card set: **a placement can never lower the tree's value.** The
   * only operators are `+` and `×`, every leaf is non-negative (numbers are ≥ 1,
   * an empty slot contributes its parent's identity — 0 under `+`, 1 under `×`),
   * and both operators are monotonic in non-negative arguments. Filling a slot
   * can only raise it; placing an operator on a leaf `n` yields `n + 0` or
   * `n × 1` and leaves it unchanged.
   *
   * So a score that has reached the target can only move further away from it.
   * In the target-clearing modes that means further overshoot; in precision it
   * means strictly more damage. Either way there is nothing left to decide.
   *
   * ⚠️ **This is exactly what a subtraction (or division) card would break.**
   * With a `−` card an overshoot becomes recoverable, and precision in particular
   * would need to go back to stopping only on an exact hit — otherwise the round
   * would resolve itself before the player could correct. `tests/precisionmode.
   * test.ts` pins the monotonicity property, so adding such a card fails a test
   * rather than silently changing when rounds end.
   */
  get shouldAutoScore(): boolean {
    return this.currentScore >= this.target;
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
    this.hp = this.cfg.precisionHp;
    this.lastResult = null;
    this.startRound();
  }

  private startRound(): void {
    this.phase = "playing";
    // Precision draws a fresh random target from a widening range; the other
    // modes follow a fixed rising curve.
    this.target = this.isPrecision
      ? this.rng.int(1, precisionRangeCap(this.round, this.cfg) - 1)
      : targetForRound(this.round, this.cfg);
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

  /**
   * True if ANY remaining card — in hand OR still in the round deck — has a
   * legal placement on the current tree. A re-draw only reshuffles this same
   * pool, so when this is false no sequence of re-draws can ever produce a move:
   * the round genuinely can't progress (e.g. every slot is filled and no
   * operators remain to split a leaf), and there's no point making the player
   * burn re-draws before the run resolves.
   */
  canProgress(): boolean {
    return (
      this.hand.some((c) => hasLegalTarget(this.tree.root, c, this.currentDepth)) ||
      this.roundDeck.some((c) => hasLegalTarget(this.tree.root, c, this.currentDepth))
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
    if (this.isPrecision) return this.evaluatePrecision();
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
      // Clearing WIN_ROUND wins the run (fires exactly once — beyond it the
      // shop resumes so a player can keep going). Offers are still generated so
      // "Keep playing" can open the shop.
      this.phase = this.round === WIN_ROUND ? "won" : "shop";
    } else {
      this.phase = "gameover";
    }
    return result;
  }

  /**
   * PRECISION: finalize the round by paying the distance to the target in HP.
   *
   * There is no clearing and no failing a round — the run continues as long as
   * HP remains, so the shop opens every round. Surviving `PRECISION_WIN_ROUND`
   * wins the run (the mode's own, shorter finish line — see that constant).
   * Focus is still banked for a precise land, so precision funds the deck AND
   * saves your life.
   */
  private evaluatePrecision(): EvaluateResult {
    const score = this.currentScore;
    const { damage, grade, focusEarned } = gradePrecision(score, this.target);
    this.hp = Math.max(0, this.hp - damage);
    const survived = this.hp > 0;

    const result: EvaluateResult = {
      score,
      target: this.target,
      won: survived,
      round: this.round,
      overshoot: score - this.target,
      grade,
      focusEarned,
      damage,
      hpLeft: this.hp,
    };
    this.lastResult = result;
    this.bestScore = Math.max(this.bestScore, score);
    this.focus += focusEarned;

    if (survived) {
      this.roundsCleared += 1;
      this.rerollCount = 0;
      this.offers = generateOffers(
        this.deck,
        this.rng,
        this.round,
        this.cfg.upgradeChoices,
        this.cfg.mode,
      );
      // Surviving the win round takes the run (fires exactly once — past it the
      // shop resumes, so "Keep playing" carries on endlessly as in classic).
      this.phase = this.round === PRECISION_WIN_ROUND ? "won" : "shop";
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

  // --- save / load ------------------------------------------------------------

  /**
   * A complete, JSON-serializable snapshot of the run — every field needed to
   * resume mid-round, including the RNG state so the exact draw sequence
   * continues. Cards, tree nodes and upgrades are already plain data, so they
   * round-trip through JSON unchanged.
   */
  serialize(): GameSnapshot {
    return {
      cfg: this.cfg,
      seed: this.seed,
      rngState: this.rng.saveState(),
      phase: this.phase,
      deck: this.deck,
      round: this.round,
      target: this.target,
      tree: this.tree,
      roundDeck: this.roundDeck,
      hand: this.hand,
      turn: this.turn,
      fishCount: this.fishCount,
      offers: this.offers,
      lastResult: this.lastResult,
      bestScore: this.bestScore,
      roundsCleared: this.roundsCleared,
      currentDepth: this.currentDepth,
      focus: this.focus,
      rerollCount: this.rerollCount,
      hp: this.hp,
    };
  }

  /** Rebuild a Game from a {@link serialize} snapshot, restoring the RNG state. */
  static fromSnapshot(s: GameSnapshot): Game {
    const g = new Game(migrateConfig(s.cfg), s.seed);
    g.rng.loadState(s.rngState);
    g.phase = s.phase;
    g.deck = s.deck;
    g.round = s.round;
    g.target = s.target;
    g.tree = s.tree;
    g.roundDeck = s.roundDeck;
    g.hand = s.hand;
    g.turn = s.turn;
    g.fishCount = s.fishCount;
    g.offers = s.offers;
    g.lastResult = s.lastResult;
    g.bestScore = s.bestScore;
    g.roundsCleared = s.roundsCleared;
    g.currentDepth = s.currentDepth;
    g.focus = s.focus;
    g.rerollCount = s.rerollCount;
    // `hp` post-dates the first save format. Saves written before precision mode
    // existed are all classic/functions runs, which never read it, so falling
    // back to full HP keeps those saves loadable rather than invalidating them.
    g.hp = s.hp ?? s.cfg.precisionHp ?? DEFAULT_CONFIG.precisionHp;
    return g;
  }
}

/**
 * Config keys as they were spelled while the Precision mode was briefly called
 * "Survival" (pre-release, so this only ever affects a local playtest save).
 * Safe to delete once no such saves can be in the wild.
 */
interface LegacySurvivalConfig {
  survivalHp?: number;
  survivalRangeStart?: number;
  survivalRangeGrowth?: number;
  survivalRangeMax?: number;
}

/**
 * Bring a snapshot's config up to the current field names. Without this an
 * in-progress "survival" run would reload as an unrecognised mode: no HP, no
 * random target, and a `maxHp` of `undefined`.
 */
function migrateConfig(cfg: GameConfig): GameConfig {
  const legacy = cfg as GameConfig & LegacySurvivalConfig;
  // Widened to `string`: "survival" is no longer part of the GameMode union, so
  // a direct comparison would be a type error rather than the check we want.
  const wasSurvival = (cfg.mode as string) === "survival";
  if (!wasSurvival && legacy.survivalHp === undefined) return cfg;
  return {
    ...cfg,
    mode: wasSurvival ? "precision" : cfg.mode,
    precisionHp: cfg.precisionHp ?? legacy.survivalHp ?? DEFAULT_CONFIG.precisionHp,
    precisionRangeStart:
      cfg.precisionRangeStart ?? legacy.survivalRangeStart ?? DEFAULT_CONFIG.precisionRangeStart,
    precisionRangeGrowth:
      cfg.precisionRangeGrowth ?? legacy.survivalRangeGrowth ?? DEFAULT_CONFIG.precisionRangeGrowth,
    precisionRangeMax:
      cfg.precisionRangeMax ?? legacy.survivalRangeMax ?? DEFAULT_CONFIG.precisionRangeMax,
  };
}

/** A complete JSON-serializable snapshot of a run (see {@link Game.serialize}). */
export interface GameSnapshot {
  cfg: GameConfig;
  seed: number;
  rngState: number;
  phase: Phase;
  deck: Card[];
  round: number;
  target: number;
  tree: Tree;
  roundDeck: Card[];
  hand: Card[];
  turn: number;
  fishCount: number;
  offers: Upgrade[];
  lastResult: EvaluateResult | null;
  bestScore: number;
  roundsCleared: number;
  currentDepth: number;
  focus: number;
  rerollCount: number;
  /** Precision HP. Optional: saves predating precision mode don't carry it. */
  hp?: number;
}

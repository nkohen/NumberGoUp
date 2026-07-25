/**
 * Application controller: owns the game loop, input handling, screen flow, and
 * the glue between the pure `Game` model, the `Renderer`, and the `SoundEngine`.
 *
 * Screens:
 *   title      → press Play to start a run
 *   playing    → drag cards onto glowing bubbles; the round auto-resolves
 *                when you clear the target (or get stuck)
 *   evaluating → the merge animation plays out, then routes to shop/gameover
 *   shop       → pick one of three deck upgrades (or skip)
 *   gameover   → run summary; only exit is back to the title
 */
import { Game, GameConfig, GameMode, LandGrade, gradeLand, configForMode, targetForRound, MAX_DEPTH, WIN_ROUND } from "../core/game";
import { VictoryBubbles } from "./victory";
import { Card, cardLabel, numberCard, opCard } from "../core/cards";
import type { Upgrade } from "../core/upgrades";
import { NodeId, legalTargets, hasLegalTarget, listNodes, treeToString, treeHeight, place, evaluate } from "../core/tree";
import { sound } from "../audio/sound";
import { haptics } from "../audio/haptics";
import {
  Renderer,
  Rect,
  NodeCircle,
  HandCardRect,
  pointInRect,
} from "../render/renderer";
import { EvaluateAnimation } from "../render/animation";
import { devLog } from "../dev/devlog";
import {
  makeSave,
  saveLocal,
  loadLocal,
  clearLocal,
  writeBoundFile,
  clearBoundFile,
  bindAndSaveFile,
  hasBoundFile,
  canBindFile,
  boundFileName,
  downloadSave,
  openSaveFile,
  type SaveData,
} from "./persistence";

type Screen = "title" | "playing" | "evaluating" | "shop" | "gameover" | "won";

/** A single scripted beat of the interactive tutorial. */
type TutPhase = "play" | "explain" | "choice" | "outro";
/** A UI region to ring for the current beat. */
type TutHighlight =
  | "options" | "actions" | "option0"
  | "grow" | "reroll" | "skip" | "redraw" | "save";
/** The scripted shop action a "choice" beat performs when clicked. */
type TutChoice = "upgrade0" | "grow" | "reroll" | "skip";
interface TutBeat {
  phase: TutPhase;
  text: string;
  /** Auto-advance predicate (play / choice beats). */
  done: boolean;
  /** Hand-card index to highlight & allow (play beats). */
  hand?: number;
  /** Tree-node id to highlight as the drop target (play beats). */
  node?: number;
  /** A UI region to ring. */
  highlight?: TutHighlight;
  /** For "choice" beats: which shop button/action this beat requires. */
  choice?: TutChoice;
}
/** Fixed seed so the tutorial's hand order & shop offers are deterministic. */
const TUTORIAL_SEED = 42;
/** Step index of the terminal outro beat. */
const TUTORIAL_OUTRO = 21;

interface DragState {
  handIndex: number;
  card: Card;
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
}

interface UiBoxes {
  handRects: HandCardRect[];
  nodeCircles: NodeCircle[];
  redrawBtn?: Rect;
  muteRect?: Rect;
  classicBtn?: Rect;
  functionsBtn?: Rect;
  helpBtn?: Rect;
  tutorialBtn?: Rect;
  deckBtn?: Rect;
  saveBtn?: Rect;
  continueBtn?: Rect;
  loadBtn?: Rect;
  tutBack?: Rect;
  tutNext?: Rect;
  tutSkip?: Rect;
  restartBtn?: Rect;
  keepPlayingBtn?: Rect;
  shopOptions: Rect[];
  shopSkip?: Rect;
  shopGrow?: Rect;
  shopReroll?: Rect;
  backToTitle?: Rect;
}

export class App {
  private renderer: Renderer;
  private game: Game;
  private screen: Screen = "title";
  private time = 0;
  private lastTs = 0;
  /**
   * Render-on-demand flag. The loop only repaints when something changed
   * (`dirty`) or something is mid-animation (`isAnimating()`). Idling here
   * instead of painting a fresh full-screen frame at 60fps is the main battery
   * win on mobile. Set via `invalidate()` from every input/state change.
   */
  private dirty = true;

  private drag: DragState | null = null;
  private hoverNodeId: NodeId | null = null;
  private legalNow: Set<NodeId> = new Set();
  private evalAnim: EvaluateAnimation | null = null;
  private ui: UiBoxes = { handRects: [], nodeCircles: [], shopOptions: [] };
  private showHelp = false;
  /** True while the in-play deck panel is open. */
  private showDeck = false;
  /** True while the interactive tutorial is running. */
  private tutorialActive = false;
  /** Current guided step (beat index) in the interactive tutorial. */
  private tutorialStep = 0;
  /** Last step we ran one-shot enter-setup for (target/offers overrides). */
  private tutLastStep = -1;
  private hintShown = true;
  /** Eased 0..1 intensity of the "depth limit reached" beam. */
  private depthBeam = 0;

  /** Transient toast (e.g. "Saved to file") + the time it should fade out. */
  private toastMsg = "";
  private toastUntil = 0;
  /** Cached local autosave presence, refreshed when we enter the title screen. */
  private localSave: SaveData | null = null;
  /** Bouncing-bubble celebration, live only on the `won` screen. */
  private victory: VictoryBubbles | null = null;

  /** DEV/URL overrides applied on top of the chosen mode's config. */
  private overrideConfig: Partial<GameConfig>;
  private seedOverride?: number;

  constructor(
    private canvas: HTMLCanvasElement,
    opts: { config?: Partial<GameConfig>; seed?: number } = {},
  ) {
    this.renderer = new Renderer(canvas);
    this.overrideConfig = opts.config ?? {};
    this.seedOverride = opts.seed;
    // A placeholder game until the player picks a mode on the title screen.
    this.game = this.makeGame("classic");

    // Restore mute preference. Mute silences haptics too, so the existing mute
    // button doubles as the off-switch for the clearing-animation buzz.
    try {
      const muted = localStorage.getItem("ngu.muted") === "1";
      sound.setMuted(muted);
      haptics.setEnabled(!muted);
    } catch {
      /* ignore */
    }
    // Pick up any prior autosave so the title screen can offer "Continue".
    this.localSave = loadLocal();

    this.bindEvents();
    requestAnimationFrame(this.loop);
  }

  // --- event wiring -----------------------------------------------------------

  private bindEvents(): void {
    const onResize = () => {
      this.renderer.resize();
      this.invalidate();
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    // Mobile browsers show/hide the address bar without firing `resize`; the
    // visual viewport does report those changes, so we track it too.
    window.visualViewport?.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("scroll", onResize);
    const c = this.canvas;
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointermove", this.onPointerMove);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("pointercancel", this.onPointerUp);
    // Prevent scrolling / long-press menus on touch.
    c.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", this.onKey);
  }

  private pointerPos(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onKey = (e: KeyboardEvent): void => {
    this.invalidate();
    // Enter/space are only used on the title & game-over screens. They are NOT
    // bound to Evaluate during play — an accidental keypress there could end a
    // run, so evaluating is deliberately click-only.
    if (e.key === "Enter" || e.key === " ") {
      if (this.screen === "title") this.startRun("classic");
      else if (this.screen === "gameover") {
        // A loss sends you back to the title — there is no play-again shortcut.
        this.localSave = loadLocal();
        this.screen = "title";
      }
    }
    if (e.key === "m") this.toggleMute();
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.invalidate();
    sound.unlock();
    const { x, y } = this.pointerPos(e);

    // The How-to-play / deck overlays dismiss on any click (tap to close).
    if (this.showHelp || this.showDeck) {
      this.showHelp = false;
      this.showDeck = false;
      sound.click();
      return;
    }

    // Global: mute button (visible on all screens with a HUD).
    if (this.ui.muteRect && pointInRect(x, y, this.ui.muteRect)) {
      this.toggleMute();
      return;
    }

    // The interactive tutorial fully controls input while it runs — every
    // action is scripted, so nothing falls through to the normal handlers.
    if (this.tutorialActive) {
      this.onTutorialPointerDown(x, y);
      return;
    }

    switch (this.screen) {
      case "title":
        if (this.ui.continueBtn && pointInRect(x, y, this.ui.continueBtn)) {
          this.continueRun();
        } else if (this.ui.loadBtn && pointInRect(x, y, this.ui.loadBtn)) {
          void this.loadFromFile();
        } else if (this.ui.classicBtn && pointInRect(x, y, this.ui.classicBtn)) {
          sound.click();
          this.startRun("classic");
        } else if (this.ui.functionsBtn && pointInRect(x, y, this.ui.functionsBtn)) {
          sound.click();
          this.startRun("functions");
        } else if (this.ui.tutorialBtn && pointInRect(x, y, this.ui.tutorialBtn)) {
          sound.click();
          this.startTutorial();
        } else if (this.ui.helpBtn && pointInRect(x, y, this.ui.helpBtn)) {
          this.showHelp = !this.showHelp;
          sound.click();
        }
        return;
      case "playing":
        this.onPlayingPointerDown(x, y);
        return;
      case "shop":
        this.onShopPointerDown(x, y);
        return;
      case "gameover":
        if (this.ui.backToTitle && pointInRect(x, y, this.ui.backToTitle)) {
          sound.click();
          this.localSave = loadLocal();
          this.screen = "title";
        }
        return;
      case "won":
        if (this.ui.keepPlayingBtn && pointInRect(x, y, this.ui.keepPlayingBtn)) {
          sound.click();
          this.keepPlaying();
        } else if (this.ui.restartBtn && pointInRect(x, y, this.ui.restartBtn)) {
          sound.click();
          this.restart();
        } else if (this.ui.backToTitle && pointInRect(x, y, this.ui.backToTitle)) {
          sound.click();
          this.victory = null;
          this.localSave = loadLocal();
          this.screen = "title";
        }
        return;
      case "evaluating":
        return; // ignore input mid-animation
    }
  };

  private onPlayingPointerDown(x: number, y: number): void {
    // Help / deck toggles.
    if (this.ui.helpBtn && pointInRect(x, y, this.ui.helpBtn)) {
      this.showHelp = !this.showHelp;
      sound.click();
      return;
    }
    if (this.ui.deckBtn && pointInRect(x, y, this.ui.deckBtn)) {
      this.showDeck = !this.showDeck;
      sound.click();
      return;
    }
    if (this.ui.saveBtn && pointInRect(x, y, this.ui.saveBtn)) {
      void this.onSaveClicked();
      return;
    }
    // Buttons first.
    if (this.ui.redrawBtn && pointInRect(x, y, this.ui.redrawBtn)) {
      const cost = this.game.redrawCost;
      if (this.game.redraw()) {
        sound.pickup();
        devLog("redraw", {
          round: this.game.round,
          turn: this.game.turn,
          cost,
          paid: cost > 0,
          focusLeft: this.game.focus,
          hand: this.game.hand.map((c) => cardLabel(c)),
        });
        this.autosave();
        this.maybeAutoResolve(); // if the redraw landed unplayable, skip it too
      }
      return;
    }
    // Pick up a hand card.
    for (const hr of this.ui.handRects) {
      if (pointInRect(x, y, hr)) {
        this.hintShown = false;
        this.drag = {
          handIndex: hr.index,
          card: hr.card,
          x,
          y,
          startX: x,
          startY: y,
          moved: false,
        };
        this.legalNow = new Set(
          legalTargets(this.game.root, hr.card, this.game.currentDepth),
        );
        sound.pickup();
        return;
      }
    }
  }

  private onShopPointerDown(x: number, y: number): void {
    // Re-roll the offers (spend focus). Stays in the shop — just refreshes the
    // choices, e.g. when fishing for a specific card.
    if (this.ui.shopReroll && pointInRect(x, y, this.ui.shopReroll)) {
      const cost = this.game.rerollCost;
      if (this.game.rerollOffers()) {
        sound.click();
        devLog("reroll", {
          round: this.game.round,
          cost,
          focusLeft: this.game.focus,
          rerollCount: this.game.rerollCount,
          offers: this.game.offers.map((o) => o.title),
        });
        this.autosave();
      } else {
        sound.error();
      }
      return;
    }
    // Grow the tree (spend focus). This uses up the shop — mutually exclusive
    // with taking a card upgrade — and advances to the next round.
    if (this.ui.shopGrow && pointInRect(x, y, this.ui.shopGrow)) {
      const fromDepth = this.game.currentDepth;
      const fromRound = this.game.round;
      const cost = this.game.growCost;
      if (this.game.growTree()) {
        sound.upgrade();
        devLog("grow", {
          fromRound,
          fromDepth,
          toDepth: this.game.currentDepth,
          cost,
          focusLeft: this.game.focus,
          nextRound: this.game.round,
          nextTarget: this.game.target,
        });
        this.logRoundStart();
        this.screen = "playing";
        this.autosave();
        this.maybeAutoResolve(); // skip an unplayable opening hand
      } else {
        sound.error();
      }
      return;
    }
    for (let i = 0; i < this.ui.shopOptions.length; i++) {
      if (pointInRect(x, y, this.ui.shopOptions[i])) {
        sound.upgrade();
        const offer = this.game.offers[i];
        const fromRound = this.game.round;
        this.game.chooseUpgrade(i);
        devLog("upgrade", {
          fromRound,
          choice: offer.title,
          upgradeType: offer.type,
          desc: offer.desc,
          nextRound: this.game.round,
          nextTarget: this.game.target,
          deck: this.deckCounts(),
        });
        this.logRoundStart();
        this.screen = "playing";
        this.autosave();
        this.maybeAutoResolve(); // skip an unplayable opening hand
        return;
      }
    }
    if (this.ui.shopSkip && pointInRect(x, y, this.ui.shopSkip)) {
      sound.click();
      const fromRound = this.game.round;
      const focusBefore = this.game.focus;
      this.game.chooseUpgrade(null);
      devLog("upgrade", {
        fromRound,
        choice: "(skip)",
        focusEarned: this.game.focus - focusBefore,
        focusTotal: this.game.focus,
        nextRound: this.game.round,
        nextTarget: this.game.target,
        deck: this.deckCounts(),
      });
      this.logRoundStart();
      this.screen = "playing";
      this.autosave();
      this.maybeAutoResolve(); // skip an unplayable opening hand
    }
  }

  private onPointerMove = (e: PointerEvent): void => {
    // Only a live drag changes what's on screen; idle moves (no button held on
    // desktop, impossible on touch) shouldn't wake the render loop.
    if (this.drag) this.invalidate();
    const { x, y } = this.pointerPos(e);
    if (this.drag) {
      const dx = x - this.drag.startX;
      const dy = y - this.drag.startY;
      if (dx * dx + dy * dy > 36) this.drag.moved = true;
      this.drag.x = x;
      this.drag.y = y;
      // Determine hovered legal node.
      const prev = this.hoverNodeId;
      this.hoverNodeId = this.nodeAt(x, y, this.legalNow);
      if (this.hoverNodeId !== null && this.hoverNodeId !== prev) {
        sound.hoverTarget();
      }
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    this.invalidate();
    const { x, y } = this.pointerPos(e);
    const drag = this.drag;
    this.drag = null;
    const targetId = this.nodeAt(x, y, this.legalNow);
    this.hoverNodeId = null;

    if (targetId !== null) {
      const circle = this.ui.nodeCircles.find((c) => c.id === targetId);
      const roundBefore = this.game.round;
      const turnBefore = this.game.turn;
      const res = this.game.play(drag.handIndex, targetId);
      if (res && circle) {
        devLog("play", {
          round: roundBefore,
          turn: turnBefore,
          card: cardLabel(drag.card),
          targetNodeId: targetId,
          kind: res.kind,
          score: this.game.currentScore,
          target: this.game.target,
          depth: treeHeight(this.game.root),
          tree: treeToString(this.game.root),
          hand: this.game.hand.map((c) => cardLabel(c)),
        });
        if (res.kind === "op-on-leaf") {
          sound.sprout();
        } else {
          sound.place();
        }
        this.renderer.burst(
          circle.x,
          circle.y,
          Renderer.particleColor(drag.card),
          14,
          150,
        );
        this.autosave();
        this.maybeAutoResolve();
      } else {
        // Landed on a node but the game rejected the placement.
        devLog("play_failed", {
          round: this.game.round,
          turn: this.game.turn,
          card: cardLabel(drag.card),
          targetNodeId: targetId,
          reason: "rejected",
          legalTargetCount: this.legalNow.size,
        });
        sound.error();
      }
    } else if (drag.moved) {
      // Dropped in empty space / on no legal node.
      devLog("play_failed", {
        round: this.game.round,
        turn: this.game.turn,
        card: cardLabel(drag.card),
        targetNodeId: null,
        reason: "no_target",
        legalTargetCount: this.legalNow.size,
      });
      sound.error();
    }
    this.legalNow = new Set();
  };

  private nodeAt(x: number, y: number, allowed: Set<NodeId>): NodeId | null {
    // Test against a generous radius so dropping is forgiving.
    let best: NodeId | null = null;
    let bestD = Infinity;
    for (const c of this.ui.nodeCircles) {
      if (allowed.size > 0 && !allowed.has(c.id)) continue;
      const dx = x - c.x;
      const dy = y - c.y;
      const d = dx * dx + dy * dy;
      const rr = (c.r * 1.5) ** 2;
      if (d <= rr && d < bestD) {
        best = c.id;
        bestD = d;
      }
    }
    return best;
  }

  // --- screen transitions -----------------------------------------------------

  private makeGame(mode: GameMode): Game {
    const config = { ...configForMode(mode), ...this.overrideConfig };
    return this.seedOverride !== undefined
      ? new Game(config, this.seedOverride)
      : new Game(config);
  }

  private startRun(mode: GameMode): void {
    this.game = this.makeGame(mode);
    this.game.startRun();
    this.screen = "playing";
    this.hintShown = true;
    this.logRunStart("new");
    this.logRoundStart();
    this.maybeAutoResolve(); // skip an unplayable opening hand
  }

  private restart(): void {
    this.victory = null;
    this.game = this.makeGame(this.game.cfg.mode);
    this.game.startRun();
    this.screen = "playing";
    this.hintShown = true;
    this.logRunStart("restart");
    this.logRoundStart();
    this.autosave();
    this.maybeAutoResolve(); // skip an unplayable opening hand
  }

  // --- save / load ------------------------------------------------------------

  /**
   * Persist the current run. Called after every state-changing action. Always
   * writes the localStorage autosave (powers "Continue"); if the player has
   * bound a save file, mirrors the write there too. No-op during the tutorial
   * (scripted, fixed-seed) and on non-run screens.
   */
  private autosave(): void {
    if (this.tutorialActive) return;
    if (this.screen !== "playing" && this.screen !== "shop") return;
    const data = makeSave(this.game.serialize());
    this.localSave = data;
    saveLocal(data);
    if (hasBoundFile()) void writeBoundFile(data);
  }

  /** Show a short-lived toast message (save feedback, etc.). */
  private flash(msg: string): void {
    this.toastMsg = msg;
    this.toastUntil = this.time + 2.4;
    this.invalidate();
  }

  /**
   * The in-play "Save" button. On Chromium it binds a real file the first time
   * (and auto-saves to it thereafter); on other browsers it downloads a backup.
   * Either way the run is already continuously autosaved to localStorage.
   */
  private async onSaveClicked(): Promise<void> {
    sound.click();
    const data = makeSave(this.game.serialize());
    saveLocal(data);
    this.localSave = data;
    if (hasBoundFile()) {
      await writeBoundFile(data);
      this.flash(`Saved to ${boundFileName()}`);
    } else if (canBindFile()) {
      const ok = await bindAndSaveFile(data);
      this.flash(ok ? `Autosaving to ${boundFileName()}` : "Save cancelled");
    } else {
      downloadSave(data);
      this.flash("Save file downloaded");
    }
  }

  /** Resume a run from a save payload (from Continue or a loaded file). */
  private resumeFrom(data: SaveData): void {
    this.game = Game.fromSnapshot(data.game);
    this.localSave = data;
    // A finished run resumes to its summary; otherwise back into play/shop.
    this.screen =
      this.game.phase === "gameover"
        ? "gameover"
        : this.game.phase === "shop"
          ? "shop"
          : "playing";
    this.showHelp = false;
    this.showDeck = false;
    this.hintShown = true;
    sound.click();
    this.invalidate();
  }

  /** Title-screen "Continue": resume the most recent local autosave. */
  private continueRun(): void {
    const data = this.localSave ?? loadLocal();
    if (data) this.resumeFrom(data);
  }

  /** Title-screen "Load from file": pick a save file and resume it. */
  private async loadFromFile(): Promise<void> {
    // Start the picker FIRST, synchronously within the tap's user gesture, THEN
    // play the click sound — otherwise the browser rejects the first attempt
    // (the "have to tap Load twice" bug).
    const pending = openSaveFile();
    sound.click();
    const res = await pending;
    if (res.data) this.resumeFrom(res.data);
    else if (!res.cancelled) this.flash("Couldn't load that file");
  }

  private logRunStart(cause: "new" | "restart"): void {
    devLog("run_start", {
      cause,
      mode: this.game.cfg.mode,
      seed: this.game.seed,
      config: this.game.cfg,
      target: this.game.target,
      deck: this.deckCounts(),
    });
  }

  /** The canonical opening-hand event, fired whenever a round begins. */
  private logRoundStart(): void {
    devLog("round_start", {
      round: this.game.round,
      turn: this.game.turn,
      target: this.game.target,
      depthCap: this.game.currentDepth,
      focus: this.game.focus,
      hand: this.game.hand.map((c) => cardLabel(c)),
      deck: this.deckCounts(),
      deckRemaining: this.game.roundDeck.length + this.game.hand.length,
    });
  }

  /** Structured `{label: count}` view of the current run deck. */
  private deckCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const c of this.game.deck) {
      const k = cardLabel(c);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return counts;
  }

  private beginEvaluate(auto = false): void {
    if (this.screen !== "playing") return;
    // In the tutorial you can't lose to an early evaluate — ignore it until the
    // scripted tree actually reaches the target.
    if (this.tutorialActive && this.game.currentScore < this.game.target) return;
    // Auto-resolves aren't a button press, so no click blip (the drop sound
    // already fired, and win/lose chimes play when the merge finishes).
    if (!auto) sound.click();
    this.evalAnim = new EvaluateAnimation(this.game.root);
    const tree = treeToString(this.game.root);
    const depth = treeHeight(this.game.root);
    // Score now (updates game.phase & offers); the app stays on the animation
    // until it finishes, then routes based on the stored result.
    const result = this.game.evaluate();
    devLog("evaluate", {
      round: result.round,
      score: result.score,
      target: result.target,
      won: result.won,
      margin: result.overshoot,
      overshootPct: result.target > 0 ? result.overshoot / result.target : 0,
      grade: result.grade,
      focusEarned: result.focusEarned,
      focusTotal: this.game.focus,
      model: this.game.cfg.precisionModel,
      depthCap: this.game.currentDepth,
      depth,
      tree,
      bestScore: this.game.bestScore,
      roundsCleared: this.game.roundsCleared,
    });
    if (!result.won) {
      devLog("game_over", {
        reachedRound: result.round,
        score: result.score,
        target: result.target,
        bestScore: this.game.bestScore,
        roundsCleared: this.game.roundsCleared,
        deck: this.deckCounts(),
      });
    }
    this.screen = "evaluating";
  }

  /**
   * After any board change, resolve the round automatically instead of making
   * the player click:
   *  - **Target reached** → auto-evaluate. Precision means any further play only
   *    overshoots, so stopping the instant you clear is the optimal land.
   *  - **No legal move left** anywhere in the remaining pool (re-draws included)
   *    → auto-evaluate too. The tree can't grow, so the run ends here; the
   *    existing evaluate→game-over animation plays without a forced click.
   *  - **Unplayable hand, but the deck can still progress** → auto-redraw. A
   *    hand with no legal move where a re-draw is free is not a real decision;
   *    forcing the player to click the free "Redraw" button just to continue
   *    reads as a confusing chore, so we do it for them.
   */
  private maybeAutoResolve(): void {
    if (this.screen !== "playing" || this.evalAnim) return;
    const g = this.game;
    if (g.currentScore >= g.target) {
      // Auto-complete applies in the tutorial too, so it matches the real game
      // (no Evaluate button, no click — reaching the target just scores).
      this.beginEvaluate(true);
    } else if (!this.tutorialActive && !g.canProgress()) {
      // The stuck→game-over path stays disabled in the scripted tutorial.
      this.flash("No legal moves left — evaluating…");
      this.beginEvaluate(true);
    } else if (!this.tutorialActive && !g.canPlayAny()) {
      // Hand has no legal move but the round can still progress (a playable
      // card remains in the deck). Redraw automatically until the hand can be
      // played. These redraws are free (no focus, no fish escalation — see
      // Game.redrawCost) so this is pure convenience with zero gameplay cost.
      // The guard is a belt-and-suspenders cap against an impossible infinite
      // loop; a legal card is known to exist, so this exits after a few tries.
      let guard = 0;
      while (!g.canPlayAny() && g.canRedraw() && guard++ < 200) {
        g.redraw();
      }
      if (g.canPlayAny()) {
        sound.pickup();
        this.flash("No playable cards — redrew your hand");
        devLog("auto_redraw", {
          round: g.round,
          turn: g.turn,
          hand: g.hand.map((c) => cardLabel(c)),
        });
        this.autosave();
      }
    }
  }

  private toggleMute(): void {
    const m = sound.toggleMuted();
    haptics.setEnabled(!m);
    try {
      localStorage.setItem("ngu.muted", m ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  // --- main loop --------------------------------------------------------------

  /** Request a repaint on the next frame (call on any input or state change). */
  private invalidate(): void {
    this.dirty = true;
  }

  /**
   * Whether anything on screen is still moving and therefore needs continuous
   * repaints. When this is false and nothing is `dirty`, the loop parks itself
   * (an empty rAF tick) instead of repainting — saving battery on mobile.
   */
  private isAnimating(): boolean {
    if (this.evalAnim) return true;
    // While a card is held, the legal-target glow/pulse animates off `time`, so
    // keep painting even when the finger isn't moving.
    if (this.drag) return true;
    if (this.screen === "evaluating" || this.screen === "won") return true;
    if (this.tutorialActive) return true; // scripted beats drive their own motion
    if (this.toastMsg && this.time < this.toastUntil) return true;
    if (this.renderer.busy) return true; // particles or un-settled bubble tweens
    // Depth-cap beam is mid-fade (it snaps to its target once close — see
    // drawDepthBeamCue — so this is only true while actually transitioning).
    if (this.screen === "playing" || this.screen === "shop") {
      const atCap = treeHeight(this.game.root) >= this.game.currentDepth ? 1 : 0;
      if (this.depthBeam !== atCap) return true;
    }
    return false;
  }

  private loop = (ts: number): void => {
    const dt = this.lastTs ? Math.min(0.05, (ts - this.lastTs) / 1000) : 0.016;
    this.lastTs = ts;

    // Render-on-demand: skip the whole frame when idle so the phone isn't
    // repainting a static screen 60 times a second.
    if (!this.dirty && !this.isAnimating()) {
      requestAnimationFrame(this.loop);
      return;
    }
    this.dirty = false;
    this.time += dt;

    this.renderer.beginFrame(dt);
    switch (this.screen) {
      case "title":
        this.drawTitle();
        break;
      case "playing":
        this.drawPlaying(dt);
        break;
      case "evaluating":
        this.drawEvaluating(dt);
        break;
      case "shop":
        this.drawPlaying(dt, true); // tree stays in background
        this.drawShop();
        break;
      case "gameover":
        this.drawPlaying(dt, true);
        this.drawGameOver();
        break;
      case "won":
        this.drawPlaying(dt, true);
        this.drawVictory(dt);
        break;
    }
    this.drawToast();
    requestAnimationFrame(this.loop);
  };

  /** A brief bottom-center message (save confirmations, load errors). */
  private drawToast(): void {
    if (!this.toastMsg || this.time >= this.toastUntil) return;
    const r = this.renderer;
    const ctx = r.ctx;
    const fade = Math.min(1, (this.toastUntil - this.time) / 0.4);
    const w = Math.min(r.width - 40, 340);
    const h = 42;
    const x = r.width / 2 - w / 2;
    const y = r.height - r.handHeight - 92;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = "rgba(18,24,54,0.94)";
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, 12);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.strokeStyle = "rgba(150,170,255,0.5)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    r.text(this.toastMsg, r.width / 2, y + h / 2 + 1, { size: 15, weight: 700 });
    ctx.restore();
  }

  // --- drawing per screen -----------------------------------------------------

  private resetUi(): void {
    this.ui = { handRects: [], nodeCircles: [], shopOptions: [] };
  }

  private drawTitle(): void {
    this.resetUi();
    const r = this.renderer;
    const cx = r.width / 2;
    r.titleText("NUMBER", cx, r.height * 0.26, Math.min(84, r.width * 0.14));
    r.titleText("GO UP", cx, r.height * 0.26 + Math.min(78, r.width * 0.13), Math.min(84, r.width * 0.14));
    r.text("a minimalist roguelike deck-builder", cx, r.height * 0.44, {
      size: 18,
      color: "rgba(234,240,255,0.7)",
    });

    // Menu: Continue (if a run is saved), start a new game, tutorial, load.
    // Stacked from a running cursor so it adapts to whether a save exists and
    // stays inside short mobile viewports.
    const bw = Math.min(260, r.width * 0.62);
    const half = (bw - 12) / 2;
    const save = this.localSave;
    const gap = 10;
    let y = r.height * (save ? 0.47 : 0.54);
    const stack = (h: number): Rect => {
      const rect: Rect = { x: cx - bw / 2, y, w: bw, h };
      y += h + gap;
      return rect;
    };

    if (save) {
      // Resume is the primary call-to-action while a run is in progress.
      const cont = stack(56);
      r.drawButton(cont, `▶  Continue · Round ${save.game.round}`, { primary: true, time: this.time });
      this.ui.continueBtn = cont;
      const classicBtn = stack(46);
      r.drawButton(classicBtn, "New Classic game");
      this.ui.classicBtn = classicBtn;
    } else {
      this.ui.continueBtn = undefined;
      const classicBtn = stack(56);
      r.drawButton(classicBtn, "▶  Classic", { primary: true, time: this.time });
      this.ui.classicBtn = classicBtn;
    }

    // Functions mode is not ready to share yet — disabled placeholder.
    const funcBtn = stack(46);
    r.drawButton(funcBtn, "ƒ  Functions  (soon)", { enabled: false });
    this.ui.functionsBtn = undefined;

    // Tutorial + How-to-play, side by side.
    const rowY = y;
    y += 44 + gap;
    const tutorialBtn: Rect = { x: cx - bw / 2, y: rowY, w: half, h: 44 };
    r.drawButton(tutorialBtn, "📖  Tutorial", { primary: !save, time: this.time });
    this.ui.tutorialBtn = tutorialBtn;
    const helpBtn: Rect = { x: cx - bw / 2 + half + 12, y: rowY, w: half, h: 44 };
    r.drawButton(helpBtn, "How to play");
    this.ui.helpBtn = helpBtn;

    // Load a save file (always available; on Chromium it also re-binds the file
    // for auto-save, elsewhere it's a file picker).
    const loadBtn = stack(40);
    r.drawButton(loadBtn, "📂  Load from file");
    this.ui.loadBtn = loadBtn;

    if (this.showHelp) {
      this.drawRulesPanel();
    }
    r.text("v0.1 · built overnight 🌙", cx, r.height - 24, {
      size: 12,
      color: "rgba(234,240,255,0.4)",
    });
  }

  private drawRulesPanel(): void {
    const r = this.renderer;
    const depth = this.game.currentDepth;
    const lines = [
      "Build an arithmetic tree to reach the target score.",
      "",
      "• Each turn: draw 5 cards, play ONE, the rest go back.",
      "• Number cards (1,2…) fill empty bubbles.",
      "• + and × cards split a number into (number ○ ▢),",
      "   sprouting a fresh empty bubble to fill.",
      "• An unfilled bubble counts as its parent's identity:",
      "   1 under × (so × never zeroes you), 0 under +.",
      "• Reaching the target scores automatically — no click.",
      "• Re-draw your hand to fish for a card (e.g. a ×) —",
      "   free when stuck, else a small ◆ cost that rises.",
      `• The tree is ${depth} levels deep for now (up to ${2 ** depth} numbers) —`,
      "   grow it deeper by spending focus in the shop.",
      "",
      "PRECISION — clear by as LITTLE as possible to bank ◆ focus:",
      "   PERFECT (exactly on target)   → +5 ◆",
      "   SHARP   (within  5% over)     → +4 ◆",
      "   CLOSE   (within 10% over)     → +3 ◆",
      "   NEAR    (within 15% over)     → +2 ◆",
      "   LOOSE   (within 20% over)     → +1 ◆",
      "   CLEARED (more than 20% over)  → +0 ◆",
      "   UNDERSHOOT the target         → the run ends!",
      "",
      "• Skip a shop upgrade to bank +1 ◆.",
      "• Spend ◆ to GROW the tree one level deeper — OR take a",
      "   card upgrade. One action per round, so choose well.",
      "• Re-roll the shop (⟳) with ◆ to fish for a card.",
      "• 💾 Save writes a save file; runs also autosave, so",
      "   \"Continue\" on the title resumes where you left off.",
      "• Targets keep rising — clear round 30 to WIN.",
    ];
    // Only explain the Functions-mode cards when actually playing that mode.
    if (this.game.cfg.mode === "functions") {
      lines.push(
        "",
        "Functions mode adds two cards:",
        "• x — a variable leaf (fills a 0-slot).",
        "• ƒ — evaluate: ƒ turns a leaf into ƒ(F, a). The left F is",
        "   a polynomial (may use x); the right a is the point to",
        "   evaluate it at.  e.g.  ƒ(x×x, 3) = 9.",
      );
    }
    // Size the panel up to 92% of the screen, then fit the lines into the body
    // between the header and the footer so nothing overflows on short screens.
    const headerH = 70;
    const footerH = 30;
    const w = Math.min(600, r.width * 0.92);
    const h = Math.min(r.height * 0.92, headerH + lines.length * 23 + footerH);
    const bodyH = h - headerH - footerH;
    const lineH = Math.min(23, bodyH / Math.max(1, lines.length));
    const fontSize = Math.max(11, Math.min(15, lineH - 5));
    const rect: Rect = { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h };
    r.drawDimmer(0.5);
    r.drawPanel(rect);
    r.text("How to play", rect.x + rect.w / 2, rect.y + 36, { size: 22, weight: 800 });
    let y = rect.y + headerH;
    for (const line of lines) {
      r.text(line, rect.x + 26, y, { size: fontSize, align: "left", color: "rgba(234,240,255,0.85)" });
      y += lineH;
    }
    r.text("(tap anywhere to close)", rect.x + rect.w / 2, rect.y + h - 16, {
      size: 12,
      color: "rgba(234,240,255,0.45)",
    });
  }

  // --- interactive tutorial ---------------------------------------------------

  /**
   * Begin the guided tutorial — a continuous 3-round playthrough (FIXED seed) on
   * ONE deck that persists and grows: `[2,2,+,×]` → add a 2 → grow the tree.
   * Demonstrates numbers, ×, +, the empty-× = 1 rule, saving, evaluating,
   * precision/focus, upgrading, the depth-limit red line, GROWing the tree,
   * re-roll and skip. Every action is highlighted and input locked to the move.
   */
  private startTutorial(): void {
    this.game = new Game(configForMode("classic"), TUTORIAL_SEED);
    this.game.startRun([numberCard(2), numberCard(2), opCard("+"), opCard("*")]);
    this.tutorialActive = true;
    this.tutorialStep = 0;
    this.tutLastStep = -1;
    this.drag = null;
    this.screen = "playing";
    this.hintShown = false;
  }

  private endTutorial(): void {
    this.tutorialActive = false;
    this.tutorialStep = 0;
    this.tutLastStep = -1;
    this.drag = null;
    this.showHelp = false;
    this.showDeck = false;
    this.localSave = loadLocal();
    this.screen = "title";
  }

  /** One-shot setup when a beat is first entered (scripted offers / targets). */
  private tutorialEnterStep(step: number): void {
    const g = this.game;
    if (step === 4) {
      // Scripted shop offers so taking #1 deterministically adds a 2.
      g.offers = [
        { type: "add", card: numberCard(2), title: "Add a 2", desc: "Shuffle a 2 card into your deck." },
        { type: "add", card: opCard("+"), title: "Add a +", desc: "Shuffle an add card into your deck." },
        { type: "remove", card: numberCard(2), title: "Remove a 2", desc: "Thin your deck by one 2." },
      ] as Upgrade[];
    } else if (step === 7) {
      g.target = 8; // round 2 goal, reachable with (2+2)×2
    } else if (step === 16) {
      g.target = 4; // round 3: a quick clear to reach the last shop tools
    }
  }

  /**
   * Descriptor for the current beat. The deck is the SAME across rounds — round
   * transitions happen through the real upgrade (round 1) and grow (round 2).
   */
  private tutBeat(): TutBeat {
    const g = this.game;
    const numIdx = () => g.hand.findIndex((c) => c.kind === "number");
    const mulIdx = () => g.hand.findIndex((c) => c.kind === "op" && c.op === "*");
    const addIdx = () => g.hand.findIndex((c) => c.kind === "op" && c.op === "+");
    const slot = () => listNodes(g.root).find((n) => n.type === "slot")?.id;
    const value = () => listNodes(g.root).find((n) => n.type === "value")?.id;
    const values = () => listNodes(g.root).filter((n) => n.type === "value").length;
    const ops = () => listNodes(g.root).filter((n) => n.type === "op").length;
    switch (this.tutorialStep) {
      // --- Round 1: numbers, ×, empty-× = 1, saving, auto-score, precision --
      case 0:
        return { phase: "play", done: g.root.type !== "slot", hand: numIdx(), node: slot(),
          text: "Goal: reach the target of 4. Number cards fill empty bubbles — drag the highlighted 2 onto the glowing bubble." };
      case 1:
        return { phase: "explain", done: false, highlight: "save",
          text: "Anytime, 💾 Save writes your run to a file — and it autosaves as you play, so \"Continue\" on the title picks up where you left off. Tap to continue." };
      case 2:
        return { phase: "play", done: g.root.type === "op", hand: mulIdx(), node: value(),
          text: "Now multiply — drag the × card onto your 2." };
      case 3:
        return { phase: "play", done: g.currentScore >= g.target, hand: numIdx(), node: slot(),
          text: "An empty × bubble counts as 1 (2 × 1 = 2), so it won't zero you. Fill it with the last 2 → 2 × 2 = 4 — reaching the target scores automatically!" };
      case 4:
        return { phase: "explain", done: false, highlight: "options",
          text: "PERFECT landing! The closer you land above the target, the more ◆ focus you bank — +5 for exact, down to +0 for a big overshoot. Land BELOW target and the run ends. Tap to continue." };
      case 5:
        return { phase: "explain", done: false, highlight: "actions",
          text: "Below you can spend ◆ focus: Grow the tree, Re-roll offers, or Skip for +1 ◆. One shop action per round, so choose well. Tap to continue." };
      case 6:
        return { phase: "choice", choice: "upgrade0", done: g.round >= 2, highlight: "option0",
          text: "Take an upgrade — tap the highlighted card to add a 2 to your deck." };
      // --- Round 2: addition, the depth-limit RED LINE, then GROW ---------
      case 7:
        return { phase: "play", done: g.root.type !== "slot", hand: numIdx(), node: slot(),
          text: "Round 2, same deck + your new card. Build to 8 — drag a 2 onto the bubble." };
      case 8:
        return { phase: "play", done: ops() >= 1, hand: mulIdx(), node: value(),
          text: "Drag the × onto your 2." };
      case 9:
        return { phase: "play", done: values() >= 2, hand: numIdx(), node: slot(),
          text: "Fill the empty bubble with a 2 → 2 × 2 = 4." };
      case 10:
        return { phase: "play", done: ops() >= 2, hand: addIdx(), node: value(),
          text: "Now ADDITION — drag the + onto a 2. + adds its two bubbles (an empty + bubble counts as 0)." };
      case 11:
        return { phase: "explain", done: false,
          text: "See the RED line under the tree? That's your depth limit — 2 levels deep holds at most 4 numbers. Tap to continue." };
      case 12:
        return { phase: "play", done: g.currentScore >= g.target, hand: numIdx(), node: slot(),
          text: "Fill the last bubble → (2 + 2) × 2 = 8. It clears the target and scores on its own." };
      case 13:
        return { phase: "explain", done: false, highlight: "grow",
          text: "To fit MORE numbers, spend ◆ focus to GROW the tree deeper — the red line drops. Tap to continue." };
      case 14:
        return { phase: "choice", choice: "grow", done: g.round >= 3, highlight: "grow",
          text: "Tap Grow ↑ to make your tree one level deeper (2 → 3). Growing takes your shop action for the round." };
      // --- Round 3: room to grow, then Re-roll & Skip --------------------
      case 15:
        return { phase: "explain", done: false,
          text: "Depth 3 now — the red line is gone, so your tree has room to hold more numbers. Tap to continue." };
      case 16:
        return { phase: "play", done: g.root.type !== "slot", hand: numIdx(), node: slot(),
          text: "One quick round to reach the last tools. Drag a 2 onto the bubble." };
      case 17:
        return { phase: "play", done: ops() >= 1, hand: mulIdx(), node: value(),
          text: "Drag the × onto your 2." };
      case 18:
        return { phase: "play", done: g.currentScore >= g.target, hand: numIdx(), node: slot(),
          text: "Fill it with a 2 → 2 × 2 = 4 to clear the round." };
      case 19:
        return { phase: "choice", choice: "reroll", done: g.rerollCount >= 1, highlight: "reroll",
          text: "Re-roll draws a fresh set of offers for ◆ focus — tap Re-roll ⟳ to try it." };
      case 20:
        return { phase: "choice", choice: "skip", done: g.round >= 4, highlight: "skip",
          text: "And Skip banks +1 ◆ focus — tap Skip to finish the tutorial." };
      default:
        return { phase: "outro", done: true, text: "" };
    }
  }

  /** All tutorial input — fully scripted; nothing reaches the normal handlers. */
  private onTutorialPointerDown(x: number, y: number): void {
    const beat = this.tutBeat();
    if (beat.phase === "outro") {
      if (this.ui.tutNext && pointInRect(x, y, this.ui.tutNext)) {
        sound.click();
        this.tutorialActive = false;
        this.tutorialStep = 0;
        this.startRun("classic");
      } else if (this.ui.tutBack && pointInRect(x, y, this.ui.tutBack)) {
        sound.click();
        this.endTutorial();
      }
      return;
    }
    // Skip-tutorial is always available during the guided steps.
    if (this.ui.tutSkip && pointInRect(x, y, this.ui.tutSkip)) {
      sound.click();
      this.endTutorial();
      return;
    }
    switch (beat.phase) {
      case "play": {
        // Only the highlighted hand card can be picked up.
        if (beat.hand === undefined || beat.hand < 0) return;
        const hr = this.ui.handRects.find((h) => h.index === beat.hand);
        if (hr && pointInRect(x, y, hr)) {
          this.hintShown = false;
          this.drag = { handIndex: hr.index, card: hr.card, x, y, startX: x, startY: y, moved: false };
          this.legalNow = new Set(legalTargets(this.game.root, hr.card, this.game.currentDepth));
          sound.pickup();
        }
        return;
      }
      case "explain":
        // Everything else is locked; any tap advances the explanation.
        sound.click();
        this.tutorialStep += 1;
        return;
      case "choice":
        this.doTutorialChoice(beat.choice!, x, y);
        return;
    }
  }

  /** Perform a scripted shop action if its (only-clickable) button was tapped. */
  private doTutorialChoice(choice: TutChoice, x: number, y: number): void {
    const hit = (r?: Rect) => r !== undefined && pointInRect(x, y, r);
    switch (choice) {
      case "upgrade0":
        if (hit(this.ui.shopOptions[0])) {
          sound.upgrade();
          this.game.chooseUpgrade(0);
          this.screen = "playing";
        }
        return;
      case "grow":
        if (hit(this.ui.shopGrow) && this.game.growTree()) {
          sound.upgrade();
          this.screen = "playing";
        }
        return;
      case "reroll":
        if (hit(this.ui.shopReroll) && this.game.rerollOffers()) sound.click();
        return; // stays in the shop
      case "skip":
        if (hit(this.ui.shopSkip)) {
          sound.click();
          this.game.chooseUpgrade(null);
          this.screen = "playing";
        }
        return;
    }
  }

  /**
   * Advance auto-steps, run one-shot enter-setup, then draw the banner, Skip
   * button, and highlight ring(s). Called each frame from the play/shop screens.
   */
  private tutorialTick(): void {
    if (!this.tutorialActive) return;
    // Auto-advance past completed steps (play/evaluate/choice have predicates;
    // "explain" beats have done:false and advance on tap instead).
    while (this.tutorialStep < TUTORIAL_OUTRO && this.tutBeat().done) {
      this.tutorialStep += 1;
    }
    // Run one-shot setup (scripted offers / target overrides) on step entry.
    if (this.tutorialStep !== this.tutLastStep) {
      this.tutorialEnterStep(this.tutorialStep);
      this.tutLastStep = this.tutorialStep;
    }
    const beat = this.tutBeat();
    if (beat.phase === "outro") {
      this.drawTutorialOutro();
      return;
    }
    this.drawTutorialBanner(beat.text);
    this.drawTutorialSkip();

    // Highlights.
    if (beat.hand !== undefined && beat.hand >= 0) {
      const hr = this.ui.handRects.find((h) => h.index === beat.hand);
      if (hr) this.drawRingRect(hr, "#7CF29B");
    }
    if (beat.node !== undefined) {
      const c = this.ui.nodeCircles.find((n) => n.id === beat.node);
      if (c) this.drawRingCircle(c.x, c.y, c.r, "#7CF29B");
    }
    const ringBtn = (r: Rect | undefined, color: string) => { if (r) this.drawRingRect(r, color); };
    switch (beat.highlight) {
      case "redraw": ringBtn(this.ui.redrawBtn, "#8fe4ff"); break;
      case "grow": ringBtn(this.ui.shopGrow, "#7CF29B"); break;
      case "reroll": ringBtn(this.ui.shopReroll, "#7CF29B"); break;
      case "skip": ringBtn(this.ui.shopSkip, "#7CF29B"); break;
      case "option0": ringBtn(this.ui.shopOptions[0], "#7CF29B"); break;
      case "save": ringBtn(this.ui.saveBtn, "#8fe4ff"); break;
      case "options": for (const o of this.ui.shopOptions) this.drawRingRect(o, "#8fe4ff"); break;
      case "actions":
        for (const rr of [this.ui.shopGrow, this.ui.shopReroll, this.ui.shopSkip]) ringBtn(rr, "#8fe4ff");
        break;
    }
  }

  /** A pulsing highlight ring around a rectangle (button / card / option). */
  private drawRingRect(rect: Rect, color: string): void {
    const ctx = this.renderer.ctx;
    const pulse = 0.55 + 0.45 * Math.sin(this.time * 5);
    const p = 4;
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.roundRect(rect.x - p, rect.y - p, rect.w + 2 * p, rect.h + 2 * p, 12);
    ctx.stroke();
    ctx.restore();
  }

  /** A pulsing highlight ring around a tree bubble. */
  private drawRingCircle(cx: number, cy: number, rad: number, color: string): void {
    const ctx = this.renderer.ctx;
    const pulse = 0.55 + 0.45 * Math.sin(this.time * 5);
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(cx, cy, rad + 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawTutorialBanner(text: string): void {
    const r = this.renderer;
    const w = Math.min(560, r.width - 24);
    const fontSize = 14;
    const lineH = fontSize + 4;
    // Grow the banner to fit however many lines the text wraps to, so longer
    // rule explanations never spill past the box.
    const lines = this.wrapLines(text, w - 28, fontSize);
    const h = Math.max(54, 24 + lines.length * lineH);
    const x = (r.width - w) / 2;
    // Sit just below the top control row so it never covers the Evaluate button.
    const y = r.hudHeight + 58;
    const ctx = r.ctx;
    ctx.save();
    ctx.fillStyle = "rgba(20,26,60,0.96)";
    ctx.strokeStyle = "rgba(143,228,255,0.7)";
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 12);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    ctx.restore();
    let ty = y + h / 2 - ((lines.length - 1) * lineH) / 2;
    for (const line of lines) {
      r.text(line, x + w / 2, ty, { size: fontSize, color: "rgba(234,240,255,0.9)" });
      ty += lineH;
    }
  }

  /** Greedy word-wrap into lines that fit `maxW` at `size` px. */
  private wrapLines(text: string, maxW: number, size: number): string[] {
    const ctx = this.renderer.ctx;
    ctx.font = `500 ${size}px sans-serif`;
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(" ")) {
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  private drawTutorialSkip(): void {
    const r = this.renderer;
    const rect: Rect = { x: r.width - 132, y: r.height - 40, w: 120, h: 30 };
    r.drawButton(rect, "Skip tutorial ✕");
    this.ui.tutSkip = rect;
    this.ui.tutNext = undefined;
    this.ui.tutBack = undefined;
  }

  private drawTutorialOutro(): void {
    const r = this.renderer;
    r.drawDimmer(0.62);
    const w = Math.min(500, r.width * 0.9);
    const h = 268;
    const rect: Rect = { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h };
    r.drawPanel(rect);
    const cx = rect.x + rect.w / 2;
    r.text("You've got the loop! 🎉", cx, rect.y + 42, { size: 24, weight: 800, color: "#7CF29B" });
    const lines = [
      "Build toward the target, land CLOSE to bank ◆ focus,",
      "then spend focus to grow your tree and keep scaling.",
      "Clear round 30 to WIN. Ready for a real run?",
    ];
    let y = rect.y + 84;
    for (const line of lines) {
      r.text(line, cx, y, { size: 14, color: "rgba(234,240,255,0.9)" });
      y += 24;
    }
    const play: Rect = { x: cx - 150, y: rect.y + h - 96, w: 300, h: 48 };
    r.drawButton(play, "▶  Play a real run", { primary: true, time: this.time });
    this.ui.tutNext = play;
    const back: Rect = { x: cx - 150, y: rect.y + h - 40, w: 300, h: 34 };
    r.drawButton(back, "Back to title");
    this.ui.tutBack = back;
    this.ui.tutSkip = undefined;
  }

  private drawPlaying(dt: number, background = false): void {
    if (!background) this.resetUi();
    const r = this.renderer;
    const g = this.game;

    // Tree
    const circles = r.drawTree(g.root, dt, {
      legalTargets: this.drag ? this.legalNow : undefined,
      hoverId: this.hoverNodeId,
      evalAnim: null,
      time: this.time,
    });

    // Hand (dim unplayable cards)
    const playable = g.hand.map((c) =>
      hasLegalTarget(g.root, c, g.currentDepth),
    );
    const handRects = r.drawHand(g.hand, {
      draggingIndex: this.drag ? this.drag.handIndex : null,
      time: this.time,
      playableFlags: playable,
    });

    // HUD
    const { muteRect } = r.drawHUD({
      round: g.round,
      target: g.target,
      score: g.currentScore,
      deckRemaining: g.roundDeck.length + g.hand.length,
      deckTotal: g.deck.length,
      muted: sound.muted,
      depth: g.currentDepth,
      maxDepth: g.currentDepth,
      focus: g.focus,
    });

    if (!background) {
      this.ui.nodeCircles = circles;
      this.ui.handRects = handRects;
      this.ui.muteRect = muteRect;
      this.layoutPlayControls();
      this.drawPlayControls();
      this.drawDepthBeamCue(dt);
      this.drawHintMaybe();
      this.tutorialTick();
    }

    // Placement preview: while hovering a legal target, show the score & grade
    // this drop would produce, so precision doesn't require mental math.
    if (!background) this.drawPlacementPreview();

    // Dragged card on top.
    if (this.drag) {
      const cardH = Math.min(this.renderer.handHeight * 0.72, 120);
      const cardW = cardH * 0.72;
      r.drawDraggedCard(this.drag.card, this.drag.x, this.drag.y - 10, cardW, cardH);
    }
  }

  /**
   * [EXPERIMENT] Floating chip near the hovered target bubble showing what the
   * whole tree would score if the dragged card landed there. The chip's border
   * is tinted by the precision grade (green→red), but shows NO words — being
   * under target mid-build is normal, so a "miss" label would read as an error.
   */
  private drawPlacementPreview(): void {
    if (!this.drag || this.hoverNodeId === null) return;
    const g = this.game;
    const res = place(g.tree, this.hoverNodeId, this.drag.card, g.currentDepth);
    if (!res) return;
    const score = evaluate(res.tree.root);
    const { grade, won } = gradeLand(score, g.target, g.cfg.precisionModel);

    const r = this.renderer;
    const ctx = r.ctx;
    const label = `→ ${score.toLocaleString()}`;
    const color = won ? gradeColor(grade) : "#ff6b8a";

    ctx.save();
    ctx.font = "800 16px sans-serif";
    const cw = ctx.measureText(label).width + 26;
    const ch = 32;
    // Anchor to the CARD the player is holding, not the target bubble: on a big
    // tree the hovered bubble ends up hidden under the dragged card. Float the
    // chip just above the card (or below it near the top of the screen).
    const cardH = Math.min(r.handHeight * 0.72, 120) * 1.1;
    let bx = this.drag.x - cw / 2;
    let by = this.drag.y - 10 - cardH / 2 - ch - 12;
    if (by < r.hudHeight + 6) by = this.drag.y - 10 + cardH / 2 + 12;
    bx = Math.max(8, Math.min(r.width - cw - 8, bx));
    by = Math.max(r.hudHeight + 6, by);

    ctx.fillStyle = "rgba(8,12,30,0.92)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.roundRect(bx, by, cw, ch, 10);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    ctx.restore();

    r.text(label, bx + cw / 2, by + ch / 2 + 1, { size: 16, weight: 800, color });
  }

  private layoutPlayControls(): void {
    const y = this.renderer.hudHeight + 8;
    // Redraw button: free when stuck (safety net), otherwise a paid "fish" to
    // hunt for a card (e.g. a ×). Shown whenever a re-draw is possible.
    // (Rounds auto-resolve on clearing the target or getting stuck, so there is
    // no manual Evaluate button.)
    this.ui.redrawBtn = this.game.canRedraw() ? { x: 12, y, w: 148, h: 44 } : undefined;

    const btnY = this.renderer.height - this.renderer.handHeight - 44;
    this.ui.helpBtn = { x: 12, y: btnY, w: 40, h: 36 };
    this.ui.deckBtn = { x: 58, y: btnY, w: 84, h: 36 };
    this.ui.saveBtn = { x: 150, y: btnY, w: 84, h: 36 };
  }

  private drawPlayControls(): void {
    const r = this.renderer;
    if (this.ui.redrawBtn) {
      const cost = this.game.redrawCost;
      const label = cost > 0 ? `↻ Redraw  −${cost} ◆` : "↻ Redraw (free)";
      r.drawButton(this.ui.redrawBtn, label);
    }
    // Help / deck buttons are hidden during the tutorial to keep it focused.
    if (this.ui.helpBtn && !this.tutorialActive) {
      r.drawButton(this.ui.helpBtn, "?");
    } else {
      this.ui.helpBtn = undefined;
    }
    if (this.ui.deckBtn && !this.tutorialActive) {
      r.drawButton(this.ui.deckBtn, "🃏 Deck");
    } else {
      this.ui.deckBtn = undefined;
    }
    // Save is hidden during the tutorial too, EXCEPT on the beat that points it
    // out (so the tutorial can highlight it without letting you actually save).
    const showSave = !this.tutorialActive || this.tutBeat().highlight === "save";
    if (this.ui.saveBtn && showSave) {
      r.drawButton(this.ui.saveBtn, "💾 Save");
    } else {
      this.ui.saveBtn = undefined;
    }
    if (this.showHelp) this.drawRulesPanel();
    if (this.showDeck) this.drawDeckPanel();
  }

  /** Compact overlay listing the current run deck (toggled by the Deck button). */
  private drawDeckPanel(): void {
    const r = this.renderer;
    const tc = this.deckTypeCounts();
    const detail = this.deckDetailLine();
    const w = Math.min(560, r.width * 0.92);
    const h = 200;
    const rect: Rect = { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h };
    r.drawDimmer(0.55);
    r.drawPanel(rect);
    r.text("Your deck", rect.x + rect.w / 2, rect.y + 40, { size: 22, weight: 800 });
    r.text(tc.summary, rect.x + rect.w / 2, rect.y + 78, {
      size: 15,
      weight: 700,
      color: "rgba(234,240,255,0.92)",
    });
    this.wrapText(detail, rect.x + rect.w / 2, rect.y + 108, rect.w - 40, 14);
    r.text("(tap anywhere to close)", rect.x + rect.w / 2, rect.y + h - 20, {
      size: 12,
      color: "rgba(234,240,255,0.45)",
    });
  }

  /**
   * Visual depth-cap cue: a red beam glows below the tree when it has reached
   * its maximum depth. Eased so it fades in/out rather than snapping.
   */
  private drawDepthBeamCue(dt: number): void {
    const g = this.game;
    const atCap = treeHeight(g.root) >= g.currentDepth;
    const target = atCap ? 1 : 0;
    // Simple exponential ease toward the target intensity.
    this.depthBeam += (target - this.depthBeam) * Math.min(1, dt * 10);
    // Snap once close so it reaches a true resting value — otherwise it would
    // asymptote forever and keep the render loop awake (see isAnimating).
    if (Math.abs(target - this.depthBeam) < 0.01) this.depthBeam = target;
    // Position the beam just below the lowest bubble so it never cuts through
    // the bottom row; fall back to the tree-area floor if there are no circles.
    const circles = this.ui.nodeCircles;
    const r = this.renderer;
    const floor = r.treeRect.y + r.treeRect.h + 4;
    const bubbleBottom = circles.length
      ? Math.max(...circles.map((c) => c.y + c.r))
      : floor;
    const beamY = Math.max(floor, bubbleBottom + 12);
    this.renderer.drawDepthBeam(this.time, this.depthBeam, beamY);
  }

  private drawHintMaybe(): void {
    if (!this.hintShown || this.game.round !== 1) return;
    const r = this.renderer;
    // Sit above the bottom button row (?, Deck, Save) so the centered hint never
    // collides with them on narrow mobile widths.
    r.text(
      "Drag a card onto a glowing bubble ✨",
      r.width / 2,
      this.renderer.height - this.renderer.handHeight - 66,
      { size: 16, color: "rgba(124,242,155,0.9)", maxWidth: r.width - 24 },
    );
  }

  private drawEvaluating(dt: number): void {
    this.resetUi();
    const r = this.renderer;
    const g = this.game;
    if (this.evalAnim) {
      const fired = this.evalAnim.update(dt);
      // Merge sound + haptic buzz + particle burst per level as it collapses.
      for (const level of fired) {
        sound.merge(level, level >= 2);
        haptics.merge(level);
      }
      // Draw tree with merge animation.
      const circles = r.drawTree(g.root, dt, {
        evalAnim: this.evalAnim,
        time: this.time,
      });
      // Particles at the root when nearly done — at its zoomed/recentered
      // on-screen position so the burst lands on the bubble, not its layout slot.
      if (this.evalAnim.progress > 0.98 && !this.rootBurstDone) {
        const root = r.lastEvalRootScreen ?? circles.find((c) => c.id === g.root.id);
        if (root) r.burst(root.x, root.y, "#8fe4ff", 26, 220);
        this.rootBurstDone = true;
      }
    }

    // HUD stays visible.
    const { muteRect } = r.drawHUD({
      round: g.round,
      target: g.target,
      score: g.currentScore,
      deckRemaining: g.roundDeck.length + g.hand.length,
      deckTotal: g.deck.length,
      muted: sound.muted,
      depth: g.currentDepth,
      focus: g.focus,
    });
    this.ui.muteRect = muteRect;

    if (this.evalAnim && this.evalAnim.done) {
      this.evalAnim = null;
      this.rootBurstDone = false;
      // The screen changes below; make sure the new screen gets painted even
      // though the eval animation (which kept the loop awake) is now finished.
      this.invalidate();
      if (this.game.phase === "won") {
        // Beat the final round — win the run with a bubble celebration.
        sound.win();
        haptics.victory();
        this.startVictory();
        this.screen = "won";
        clearLocal();
        void clearBoundFile();
        this.localSave = null;
      } else if (this.game.phase === "gameover") {
        sound.lose();
        haptics.lose();
        this.screen = "gameover";
        // The run is over — drop the autosave (and empty the bound save file) so
        // a dead run can't be continued or re-loaded.
        clearLocal();
        void clearBoundFile();
        this.localSave = null;
      } else {
        sound.win();
        haptics.win();
        this.screen = "shop";
        this.autosave();
      }
    }
  }
  private rootBurstDone = false;

  private drawShop(): void {
    const r = this.renderer;
    const g = this.game;
    r.drawDimmer(0.6);

    const cx = r.width / 2;
    const pad = 20;
    const w = Math.min(680, r.width * 0.94);

    // --- Upgrade option cards: width and height are computed first so the panel
    // can be sized to fit their (wrapped) content. On a narrow phone the cards
    // get narrow, the descriptions wrap to more lines, and a fixed card height
    // would clip them — so we measure the text and size the cards to match.
    const n = g.offers.length;
    const gap = 12;
    const optW = Math.min(180, (w - 2 * pad - gap * (n - 1)) / Math.max(1, n));
    const descSize = optW < 118 ? 12 : 13;
    let maxLines = 1;
    for (const o of g.offers) {
      maxLines = Math.max(maxLines, this.wrapLineCount(o.desc, optW - 20, descSize));
    }
    const optH = 120 + maxLines * (descSize + 4) + 22;

    // Size the panel to the content (header + cards + footer), capped to the
    // viewport so it always fits on screen.
    const headerH = 128;
    const footerH = 116; // helper line + deck comp + button row
    const h = Math.min(r.height * 0.92, Math.max(440, headerH + optH + footerH));
    const panel: Rect = { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h };
    r.drawPanel(panel);

    const res = g.lastResult;
    const textMax = w - 2 * pad;
    // Header block flows from the top with a running cursor.
    let y = panel.y + 30;
    r.text(`Round ${res?.round ?? g.round} cleared! 🎉`, cx, y, {
      size: 24,
      weight: 800,
      color: "#7CF29B",
      maxWidth: textMax,
    });
    y += 28;
    r.text(
      `You scored ${(res?.score ?? 0).toLocaleString()} · needed ${(res?.target ?? g.target).toLocaleString()}.`,
      cx,
      y,
      { size: 15, color: "rgba(234,240,255,0.8)", maxWidth: textMax },
    );
    y += 24;
    // Precision grade + focus banked — the heart of the skill loop.
    if (res) {
      const label =
        res.focusEarned > 0
          ? `${res.grade} LAND    +${res.focusEarned} ◆ focus`
          : `${res.grade}    +0 ◆ focus`;
      r.text(label, cx, y, {
        size: 16,
        weight: 800,
        color: gradeColor(res.grade),
        maxWidth: textMax,
      });
      y += 24;
    }
    // Show the target the chosen upgrade will be tested against next round.
    const nextTarget = targetForRound(g.round + 1, g.cfg);
    r.text(`Next round target:  ${nextTarget.toLocaleString()}`, cx, y, {
      size: 16,
      weight: 800,
      color: "#FFC46B",
      maxWidth: textMax,
    });

    // Draw the option cards.
    const totalW = n * optW + (n - 1) * gap;
    let ox = cx - totalW / 2;
    const oy = panel.y + headerH;
    this.ui.shopOptions = [];
    for (let i = 0; i < n; i++) {
      const rect: Rect = { x: ox, y: oy, w: optW, h: optH };
      this.ui.shopOptions.push(rect);
      this.drawShopOption(rect, g.offers[i], i, descSize);
      ox += optW + gap;
    }
    // Make the one-action-per-round rule explicit (re-roll is free-standing).
    r.text(
      "Take ONE upgrade, grow the tree, or skip to advance · Re-roll just refreshes offers.",
      cx,
      oy + optH + 16,
      { size: 12, color: "rgba(234,240,255,0.6)", maxWidth: textMax },
    );

    // Bottom row: Grow the tree · Re-roll offers · Skip. Grow and Skip end the
    // round; Re-roll just refreshes the offers (both spend focus). Pinned to the
    // panel bottom; the deck composition sits just above it.
    const btnY = panel.y + h - 52;
    const bgap = 10;
    const bw = Math.min(158, (w - 2 * pad - 2 * bgap) / 3);

    // Deck composition, pinned just above the button row.
    const tc = this.deckTypeCounts();
    r.text(`Your deck — ${tc.summary}`, cx, btnY - 32, {
      size: 14,
      weight: 700,
      color: "rgba(234,240,255,0.9)",
      maxWidth: textMax,
    });
    r.text(this.deckDetailLine(), cx, btnY - 14, {
      size: 12,
      color: "rgba(234,240,255,0.55)",
      maxWidth: textMax,
    });

    const total = 3 * bw + 2 * bgap;
    let bx = cx - total / 2;

    const grow: Rect = { x: bx, y: btnY, w: bw, h: 40 };
    const maxed = g.currentDepth >= MAX_DEPTH;
    r.drawButton(grow, maxed ? "Tree maxed" : `Grow ↑  −${g.growCost} ◆`, {
      primary: g.canGrow(),
      enabled: !maxed && g.canGrow(),
      time: this.time,
    });
    this.ui.shopGrow = maxed ? undefined : grow;
    bx += bw + bgap;

    const reroll: Rect = { x: bx, y: btnY, w: bw, h: 40 };
    r.drawButton(reroll, `Re-roll ⟳  −${g.rerollCost} ◆`, {
      enabled: g.canReroll(),
    });
    this.ui.shopReroll = reroll;
    bx += bw + bgap;

    const skip: Rect = { x: bx, y: btnY, w: bw, h: 40 };
    // Skipping the upgrade banks +1 focus under the tiered model — surface that.
    const skipBanks = g.cfg.precisionModel === "tiered";
    r.drawButton(skip, skipBanks ? "Skip  +1 ◆" : "Skip");
    this.ui.shopSkip = skip;

    // mute still available
    const { muteRect } = this.peekMute();
    this.ui.muteRect = muteRect;

    // Tutorial guidance overlays the shop for the final scripted step.
    this.tutorialTick();
  }

  private drawShopOption(
    rect: Rect,
    offer: import("../core/upgrades").Upgrade,
    i: number,
    descSize = 13,
  ): void {
    const r = this.renderer;
    r.drawButton(rect, "", { time: this.time });
    // Icon glyph
    let glyph = "＋";
    let color = "#7CF29B";
    if (offer.type === "add") {
      glyph = cardLabel(offer.card);
      color = shopGlyphColor(offer.card);
    } else if (offer.type === "remove") {
      glyph = "－";
      color = "#ff6b8a";
    } else {
      glyph = "⬆";
      color = "#FFC46B";
    }
    const cx = rect.x + rect.w / 2;
    r.text(glyph, cx, rect.y + 50, { size: 44, weight: 800, color });
    // Title clamped to card width; description wraps within the card.
    r.text(offer.title, cx, rect.y + 104, { size: 15, weight: 800, maxWidth: rect.w - 12 });
    this.wrapText(offer.desc, cx, rect.y + 126, rect.w - 20, descSize);
    r.text(`[ ${i + 1} ]`, cx, rect.y + rect.h - 16, {
      size: 12,
      color: "rgba(234,240,255,0.5)",
    });
  }

  /** Counts how many lines `wrapText` will produce for the given width/size. */
  private wrapLineCount(text: string, maxW: number, size: number): number {
    const ctx = this.renderer.ctx;
    ctx.font = `500 ${size}px sans-serif`;
    let line = "";
    let lines = 0;
    for (const word of text.split(" ")) {
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > maxW && line) {
        lines++;
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines++;
    return Math.max(1, lines);
  }

  private wrapText(text: string, cx: number, y: number, maxW: number, size: number): void {
    const r = this.renderer;
    const words = text.split(" ");
    let line = "";
    let yy = y;
    const ctx = this.renderer.ctx;
    ctx.font = `500 ${size}px sans-serif`;
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > maxW && line) {
        r.text(line, cx, yy, { size, color: "rgba(234,240,255,0.75)" });
        line = word;
        yy += size + 4;
      } else {
        line = test;
      }
    }
    if (line) r.text(line, cx, yy, { size, color: "rgba(234,240,255,0.75)" });
  }

  private drawGameOver(): void {
    const r = this.renderer;
    const g = this.game;
    r.drawDimmer(0.68);
    const w = Math.min(460, r.width * 0.9);
    const h = 320;
    const panel: Rect = { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h };
    r.drawPanel(panel);
    const res = g.lastResult;
    r.text("Game Over", r.width / 2, panel.y + 48, { size: 32, weight: 900, color: "#ff6b8a" });
    r.text(
      `You reached round ${res?.round ?? g.round}.`,
      r.width / 2,
      panel.y + 96,
      { size: 18 },
    );
    r.text(
      `Final tree scored ${res?.score ?? 0} · needed ${res?.target ?? g.target}.`,
      r.width / 2,
      panel.y + 126,
      { size: 15, color: "rgba(234,240,255,0.75)" },
    );
    r.text(`Rounds cleared: ${g.roundsCleared}   Best score: ${g.bestScore}`, r.width / 2, panel.y + 156, {
      size: 15,
      color: "rgba(234,240,255,0.75)",
    });

    // A loss ends the run — the only way forward is back to the title screen.
    this.ui.restartBtn = undefined;
    const back: Rect = { x: r.width / 2 - 110, y: panel.y + h - 72, w: 220, h: 52 };
    r.drawButton(back, "Back to title", { primary: true, time: this.time });
    this.ui.backToTitle = back;

    const { muteRect } = this.peekMute();
    this.ui.muteRect = muteRect;
  }

  /** Kick off the win celebration: a bubble sprayed from the deck per card. */
  private startVictory(): void {
    const r = this.renderer;
    // Spray from the deck's home — bottom-centre, where the hand/deck sit.
    this.victory = new VictoryBubbles(
      this.game.deck,
      r.width / 2,
      r.height - r.handHeight * 0.5,
    );
  }

  /** From the win screen, resume the endless run by reopening the shop. */
  private keepPlaying(): void {
    this.game.phase = "shop"; // offers were generated on the winning evaluate
    this.victory = null;
    this.screen = "shop";
    this.autosave();
  }

  private drawVictory(dt: number): void {
    const r = this.renderer;
    const g = this.game;
    r.drawDimmer(0.6);
    // Bubbles bounce around the whole screen behind the panel.
    if (this.victory) {
      this.victory.update(dt, r.width, r.height, r.hudHeight);
      this.victory.draw(r.ctx);
    }

    const w = Math.min(460, r.width * 0.9);
    const h = 300;
    const panel: Rect = { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h };
    r.drawPanel(panel);
    r.text("YOU WIN! 🎉", r.width / 2, panel.y + 52, { size: 34, weight: 900, color: "#7cf29b" });
    r.text(`You beat all ${WIN_ROUND} rounds.`, r.width / 2, panel.y + 100, { size: 18 });
    r.text(
      `Best score: ${g.bestScore.toLocaleString()}`,
      r.width / 2,
      panel.y + 130,
      { size: 15, color: "rgba(234,240,255,0.75)" },
    );

    const keep: Rect = { x: r.width / 2 - 110, y: panel.y + h - 150, w: 220, h: 48 };
    r.drawButton(keep, "Keep playing →", { primary: true, time: this.time });
    this.ui.keepPlayingBtn = keep;
    const restart: Rect = { x: r.width / 2 - 110, y: panel.y + h - 94, w: 220, h: 44 };
    r.drawButton(restart, "↻  Play again");
    this.ui.restartBtn = restart;
    const back: Rect = { x: r.width / 2 - 110, y: panel.y + h - 40, w: 220, h: 30 };
    r.drawButton(back, "Back to title");
    this.ui.backToTitle = back;

    const { muteRect } = this.peekMute();
    this.ui.muteRect = muteRect;
  }

  private peekMute(): { muteRect: Rect } {
    // Re-draw a mute button top-right for overlay screens.
    const rect: Rect = { x: this.renderer.width - 46, y: this.renderer.hudHeight / 2 - 16, w: 32, h: 32 };
    return { muteRect: rect };
  }

  /** Dev-only introspection used by the smoke tests. */
  debugState(): Record<string, unknown> {
    return {
      screen: this.screen,
      mode: this.game.cfg.mode,
      round: this.game.round,
      target: this.game.target,
      score: this.game.currentScore,
      hand: this.game.hand.map((c) => cardLabel(c)),
      deckRemaining: this.game.roundDeck.length + this.game.hand.length,
      nodeCircles: this.ui.nodeCircles.map((c) => ({ id: c.id, x: Math.round(c.x), y: Math.round(c.y), r: Math.round(c.r), type: c.node.type })),
      treeStr: treeToString(this.game.root),
      treeNodes: listNodes(this.game.root).map((n) => ({
        id: n.id,
        type: n.type,
        op: n.type === "op" ? n.op : undefined,
        left: n.type === "op" ? n.left.id : undefined,
        right: n.type === "op" ? n.right.id : undefined,
        value: n.type === "value" ? n.value : undefined,
      })),
      legalNow: [...this.legalNow],
    };
  }

  /**
   * Deck composition by card *type*, plus a human summary. "Operations" counts
   * the arithmetic operators (+ ×); the evaluate operator ƒ is counted under
   * "functions" to match how the modes are described to the player.
   */
  private deckTypeCounts(): {
    numbers: number;
    operations: number;
    variables: number;
    functions: number;
    total: number;
    summary: string;
  } {
    let numbers = 0,
      operations = 0,
      variables = 0,
      functions = 0;
    for (const c of this.game.deck) {
      if (c.kind === "number") numbers++;
      else if (c.kind === "var") variables++;
      else if (c.op === "@") functions++;
      else operations++;
    }
    const total = this.game.deck.length;
    const parts = [`${numbers} numbers`, `${operations} operations`];
    if (variables > 0) parts.push(`${variables} variables`);
    if (functions > 0) parts.push(`${functions} functions`);
    return {
      numbers,
      operations,
      variables,
      functions,
      total,
      summary: `${total} cards  ·  ${parts.join("  ·  ")}`,
    };
  }

  /**
   * A per-card breakdown that avoids the old "2××" ambiguity: cards are listed
   * expanded under type headers, so "×,×" plainly reads as two multiply cards.
   */
  private deckDetailLine(): string {
    const nums: number[] = [];
    const ops: string[] = [];
    const vars: string[] = [];
    const funcs: string[] = [];
    for (const c of this.game.deck) {
      if (c.kind === "number") nums.push(c.value);
      else if (c.kind === "var") vars.push("x");
      else if (c.op === "@") funcs.push("ƒ");
      else ops.push(cardLabel(c));
    }
    nums.sort((a, b) => a - b);
    ops.sort();
    const sections: string[] = [];
    if (nums.length) sections.push(`Numbers ${nums.join(",")}`);
    if (ops.length) sections.push(`Ops ${ops.join(",")}`);
    if (vars.length) sections.push(`Vars ${vars.join(",")}`);
    if (funcs.length) sections.push(`Funcs ${funcs.join(",")}`);
    return sections.join("     ");
  }
}


/** Accent colour for a card glyph in the shop (mirrors the bubble palette). */
function shopGlyphColor(card: Card): string {
  if (card.kind === "number") return "#5ad1ff";
  if (card.kind === "var") return "#ff9be0";
  if (card.op === "*") return "#FFC46B";
  if (card.op === "@") return "#b79bff";
  return "#7CF29B";
}

/** Colour for a precision land grade, coolest (green) for the tightest land. */
function gradeColor(grade: LandGrade): string {
  switch (grade) {
    case "PERFECT":
      return "#7CF29B";
    case "SHARP":
      return "#8fe4ff";
    case "CLOSE":
      return "#FFC46B";
    case "NEAR":
      return "#ffa86b";
    case "LOOSE":
      return "#ff8f8f";
    case "SCRAPE":
      return "#ff9be0";
    case "MISS":
      return "#ff6b8a";
    default:
      return "rgba(234,240,255,0.7)"; // CLEARED
  }
}

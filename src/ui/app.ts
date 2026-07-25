/**
 * Application controller: owns the game loop, input handling, screen flow, and
 * the glue between the pure `Game` model, the `Renderer`, and the `SoundEngine`.
 *
 * Screens:
 *   title      → press Play to start a run
 *   playing    → drag cards onto glowing bubbles; Evaluate to finalize
 *   evaluating → the merge animation plays out, then routes to shop/gameover
 *   shop       → pick one of three deck upgrades (or skip)
 *   gameover   → run summary + restart
 */
import { Game, GameConfig, GameMode, LandGrade, configForMode, targetForRound, MAX_DEPTH } from "../core/game";
import { Card, cardLabel } from "../core/cards";
import { NodeId, legalTargets, hasLegalTarget, listNodes, treeToString, treeHeight } from "../core/tree";
import { sound } from "../audio/sound";
import {
  Renderer,
  Rect,
  NodeCircle,
  HandCardRect,
  pointInRect,
} from "../render/renderer";
import { EvaluateAnimation } from "../render/animation";
import { devLog } from "../dev/devlog";

type Screen = "title" | "playing" | "evaluating" | "shop" | "gameover";

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
  evaluateBtn?: Rect;
  redrawBtn?: Rect;
  muteRect?: Rect;
  classicBtn?: Rect;
  functionsBtn?: Rect;
  helpBtn?: Rect;
  restartBtn?: Rect;
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

  private drag: DragState | null = null;
  private hoverNodeId: NodeId | null = null;
  private legalNow: Set<NodeId> = new Set();
  private evalAnim: EvaluateAnimation | null = null;
  private ui: UiBoxes = { handRects: [], nodeCircles: [], shopOptions: [] };
  private showHelp = false;
  private hintShown = true;
  /** Eased 0..1 intensity of the "depth limit reached" beam. */
  private depthBeam = 0;

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

    // Restore mute preference.
    try {
      sound.setMuted(localStorage.getItem("ngu.muted") === "1");
    } catch {
      /* ignore */
    }

    this.bindEvents();
    requestAnimationFrame(this.loop);
  }

  // --- event wiring -----------------------------------------------------------

  private bindEvents(): void {
    const onResize = () => this.renderer.resize();
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
    // Enter/space are only used on the title & game-over screens. They are NOT
    // bound to Evaluate during play — an accidental keypress there could end a
    // run, so evaluating is deliberately click-only.
    if (e.key === "Enter" || e.key === " ") {
      if (this.screen === "title") this.startRun("classic");
      else if (this.screen === "gameover") this.restart();
    }
    if (e.key === "m") this.toggleMute();
  };

  private onPointerDown = (e: PointerEvent): void => {
    sound.unlock();
    const { x, y } = this.pointerPos(e);

    // Global: mute button (visible on all screens with a HUD).
    if (this.ui.muteRect && pointInRect(x, y, this.ui.muteRect)) {
      this.toggleMute();
      return;
    }

    switch (this.screen) {
      case "title":
        if (this.ui.classicBtn && pointInRect(x, y, this.ui.classicBtn)) {
          sound.click();
          this.startRun("classic");
        } else if (this.ui.functionsBtn && pointInRect(x, y, this.ui.functionsBtn)) {
          sound.click();
          this.startRun("functions");
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
        if (this.ui.restartBtn && pointInRect(x, y, this.ui.restartBtn)) {
          sound.click();
          this.restart();
        } else if (this.ui.backToTitle && pointInRect(x, y, this.ui.backToTitle)) {
          sound.click();
          this.screen = "title";
        }
        return;
      case "evaluating":
        return; // ignore input mid-animation
    }
  };

  private onPlayingPointerDown(x: number, y: number): void {
    // Help toggle.
    if (this.ui.helpBtn && pointInRect(x, y, this.ui.helpBtn)) {
      this.showHelp = !this.showHelp;
      sound.click();
      return;
    }
    // Buttons first.
    if (this.ui.evaluateBtn && pointInRect(x, y, this.ui.evaluateBtn)) {
      this.beginEvaluate();
      return;
    }
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
    }
  }

  private onPointerMove = (e: PointerEvent): void => {
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
  }

  private restart(): void {
    this.game = this.makeGame(this.game.cfg.mode);
    this.game.startRun();
    this.screen = "playing";
    this.hintShown = true;
    this.logRunStart("restart");
    this.logRoundStart();
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

  private beginEvaluate(): void {
    if (this.screen !== "playing") return;
    sound.click();
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

  private toggleMute(): void {
    const m = sound.toggleMuted();
    try {
      localStorage.setItem("ngu.muted", m ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  // --- main loop --------------------------------------------------------------

  private loop = (ts: number): void => {
    const dt = this.lastTs ? Math.min(0.05, (ts - this.lastTs) / 1000) : 0.016;
    this.lastTs = ts;
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
    }
    requestAnimationFrame(this.loop);
  };

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

    // Two modes: Classic (numbers & +/×) and Functions (adds x and ƒ).
    const bw = Math.min(260, r.width * 0.62);
    const y0 = r.height * 0.54;
    const classicBtn: Rect = { x: cx - bw / 2, y: y0, w: bw, h: 58 };
    r.drawButton(classicBtn, "▶  Classic", { primary: true, time: this.time });
    this.ui.classicBtn = classicBtn;

    // Functions mode is not ready to share yet — shown disabled as "Coming
    // soon" and left unclickable (we never register its hit-rect).
    const funcBtn: Rect = { x: cx - bw / 2, y: y0 + 70, w: bw, h: 58 };
    r.drawButton(funcBtn, "ƒ  Functions  (soon)", { enabled: false });
    this.ui.functionsBtn = undefined;
    r.text(
      "Functions mode (variable x + evaluate operator) — coming soon",
      cx,
      y0 + 70 + 78,
      { size: 13, color: "rgba(183,155,255,0.6)" },
    );

    const helpBtn: Rect = { x: cx - bw / 2, y: y0 + 156, w: bw, h: 44 };
    r.drawButton(helpBtn, this.showHelp ? "Hide rules" : "How to play");
    this.ui.helpBtn = helpBtn;

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
      "• Number cards (1,2…) fill empty 0-slots.",
      "• + and × cards split a number into (number ○ 0),",
      "   sprouting a fresh 0 to fill.",
      "• Careful: × by an unfilled 0 zeroes the whole branch!",
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
      "• Targets keep rising. See how far you can go.",
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
    r.text("(tap ? again to close)", rect.x + rect.w / 2, rect.y + h - 16, {
      size: 12,
      color: "rgba(234,240,255,0.45)",
    });
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
    }

    // Dragged card on top.
    if (this.drag) {
      const cardH = Math.min(this.renderer.handHeight * 0.72, 120);
      const cardW = cardH * 0.72;
      r.drawDraggedCard(this.drag.card, this.drag.x, this.drag.y - 10, cardW, cardH);
    }
  }

  private layoutPlayControls(): void {
    const r = this.renderer;
    const y = this.renderer.hudHeight + 8;
    const evalBtn: Rect = { x: r.width - 148, y, w: 136, h: 44 };
    this.ui.evaluateBtn = evalBtn;

    // Redraw button: free when stuck (safety net), otherwise a paid "fish" to
    // hunt for a card (e.g. a ×). Shown whenever a re-draw is possible.
    this.ui.redrawBtn = this.game.canRedraw() ? { x: 12, y, w: 148, h: 44 } : undefined;

    this.ui.helpBtn = { x: 12, y: this.renderer.height - this.renderer.handHeight - 44, w: 40, h: 36 };
  }

  private drawPlayControls(): void {
    const r = this.renderer;
    if (this.ui.evaluateBtn) {
      const canScore = this.game.currentScore >= this.game.target;
      r.drawButton(this.ui.evaluateBtn, "Evaluate ✓", {
        primary: canScore,
        time: this.time,
      });
    }
    if (this.ui.redrawBtn) {
      const cost = this.game.redrawCost;
      const label = cost > 0 ? `↻ Redraw  ${cost} ◆` : "↻ Redraw (free)";
      r.drawButton(this.ui.redrawBtn, label);
    }
    if (this.ui.helpBtn) {
      r.drawButton(this.ui.helpBtn, "?");
    }
    if (this.showHelp) this.drawRulesPanel();
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
    r.text(
      "Drag a card onto a glowing bubble ✨",
      r.width / 2,
      this.renderer.height - this.renderer.handHeight - 22,
      { size: 16, color: "rgba(124,242,155,0.9)" },
    );
  }

  private drawEvaluating(dt: number): void {
    this.resetUi();
    const r = this.renderer;
    const g = this.game;
    if (this.evalAnim) {
      const fired = this.evalAnim.update(dt);
      // Merge sound + particle burst per level as it collapses.
      for (const level of fired) {
        sound.merge(level, level >= 2);
      }
      // Draw tree with merge animation.
      const circles = r.drawTree(g.root, dt, {
        evalAnim: this.evalAnim,
        time: this.time,
      });
      // Particles at the root when nearly done.
      if (this.evalAnim.progress > 0.98 && !this.rootBurstDone) {
        const root = circles.find((c) => c.id === g.root.id);
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
      const won = this.game.lastResult?.won ?? false;
      this.evalAnim = null;
      this.rootBurstDone = false;
      if (won) {
        sound.win();
        this.screen = "shop";
      } else {
        sound.lose();
        this.screen = "gameover";
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
    r.drawButton(grow, maxed ? "Tree maxed" : `Grow ↑  ${g.growCost} ◆`, {
      primary: g.canGrow(),
      enabled: !maxed && g.canGrow(),
      time: this.time,
    });
    this.ui.shopGrow = maxed ? undefined : grow;
    bx += bw + bgap;

    const reroll: Rect = { x: bx, y: btnY, w: bw, h: 40 };
    r.drawButton(reroll, `Re-roll ⟳  ${g.rerollCost} ◆`, {
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

    const restart: Rect = { x: r.width / 2 - 110, y: panel.y + h - 96, w: 220, h: 52 };
    r.drawButton(restart, "↻  Play again", { primary: true, time: this.time });
    this.ui.restartBtn = restart;
    const back: Rect = { x: r.width / 2 - 110, y: panel.y + h - 36, w: 220, h: 30 };
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

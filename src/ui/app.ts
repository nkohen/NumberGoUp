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
import { Game, DEFAULT_CONFIG } from "../core/game";
import { Card, cardLabel } from "../core/cards";
import { NodeId, legalTargets, hasLegalTarget } from "../core/tree";
import { sound } from "../audio/sound";
import {
  Renderer,
  Rect,
  NodeCircle,
  HandCardRect,
  pointInRect,
} from "../render/renderer";
import { EvaluateAnimation } from "../render/animation";

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
  playBtn?: Rect;
  helpBtn?: Rect;
  restartBtn?: Rect;
  shopOptions: Rect[];
  shopSkip?: Rect;
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

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.game = new Game(DEFAULT_CONFIG);

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
    window.addEventListener("resize", () => this.renderer.resize());
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
    if (e.key === "Enter" || e.key === " ") {
      if (this.screen === "title" && this.ui.playBtn) this.startRun();
      else if (this.screen === "playing") this.beginEvaluate();
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
        if (this.ui.playBtn && pointInRect(x, y, this.ui.playBtn)) {
          sound.click();
          this.startRun();
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
      if (this.game.redraw()) sound.pickup();
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
        this.legalNow = new Set(legalTargets(this.game.root, hr.card));
        sound.pickup();
        return;
      }
    }
  }

  private onShopPointerDown(x: number, y: number): void {
    for (let i = 0; i < this.ui.shopOptions.length; i++) {
      if (pointInRect(x, y, this.ui.shopOptions[i])) {
        sound.upgrade();
        this.game.chooseUpgrade(i);
        this.screen = "playing";
        return;
      }
    }
    if (this.ui.shopSkip && pointInRect(x, y, this.ui.shopSkip)) {
      sound.click();
      this.game.chooseUpgrade(null);
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
      const res = this.game.play(drag.handIndex, targetId);
      if (res && circle) {
        if (res.kind === "op-on-value") {
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
        sound.error();
      }
    } else if (drag.moved) {
      // Dropped somewhere invalid.
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

  private startRun(): void {
    this.game.startRun();
    this.screen = "playing";
    this.hintShown = true;
  }

  private restart(): void {
    this.game = new Game(DEFAULT_CONFIG);
    this.game.startRun();
    this.screen = "playing";
    this.hintShown = true;
  }

  private beginEvaluate(): void {
    if (this.screen !== "playing") return;
    sound.click();
    this.evalAnim = new EvaluateAnimation(this.game.root);
    // Score now (updates game.phase & offers); the app stays on the animation
    // until it finishes, then routes based on the stored result.
    this.game.evaluate();
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

    const bw = Math.min(240, r.width * 0.6);
    const playBtn: Rect = { x: cx - bw / 2, y: r.height * 0.56, w: bw, h: 60 };
    r.drawButton(playBtn, "▶  Play", { primary: true, time: this.time });
    this.ui.playBtn = playBtn;

    const helpBtn: Rect = { x: cx - bw / 2, y: r.height * 0.56 + 76, w: bw, h: 48 };
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
    const w = Math.min(560, r.width * 0.9);
    const h = Math.min(300, r.height * 0.5);
    const rect: Rect = { x: (r.width - w) / 2, y: r.height * 0.5 - h - 10, w, h };
    r.drawPanel(rect);
    const lines = [
      "Build an arithmetic tree to reach the target score.",
      "",
      "• Each turn: draw 5 cards, play ONE, the rest go back.",
      "• Number cards (1,2…) fill empty 0-slots.",
      "• + and × cards split a number into (number ○ 0),",
      "   sprouting a fresh 0 to fill.",
      "• Careful: × by an unfilled 0 zeroes the whole branch!",
      "• Hit Evaluate to score. Clear the round → upgrade your deck.",
      "• Targets keep rising. See how far you can go.",
    ];
    let y = rect.y + 34;
    r.text("How to play", rect.x + rect.w / 2, y, { size: 22, weight: 800 });
    y += 34;
    for (const line of lines) {
      r.text(line, rect.x + 24, y, { size: 15, align: "left", color: "rgba(234,240,255,0.85)" });
      y += 25;
    }
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
    const playable = g.hand.map((c) => hasLegalTarget(g.root, c));
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
    });

    if (!background) {
      this.ui.nodeCircles = circles;
      this.ui.handRects = handRects;
      this.ui.muteRect = muteRect;
      this.layoutPlayControls();
      this.drawPlayControls();
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

    // Redraw button appears only when the player is genuinely stuck.
    const stuck = !this.game.canPlayAny() && this.game.roundDeck.length > 0;
    this.ui.redrawBtn = stuck ? { x: 12, y, w: 128, h: 44 } : undefined;

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
      r.drawButton(this.ui.redrawBtn, "↻ Redraw");
    }
    if (this.ui.helpBtn) {
      r.drawButton(this.ui.helpBtn, "?");
    }
    if (this.showHelp) this.drawRulesPanel();
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

    const w = Math.min(680, r.width * 0.94);
    const h = Math.min(440, r.height * 0.8);
    const panel: Rect = { x: (r.width - w) / 2, y: (r.height - h) / 2, w, h };
    r.drawPanel(panel);

    const res = g.lastResult;
    r.text(`Round ${res?.round ?? g.round} cleared! 🎉`, r.width / 2, panel.y + 40, {
      size: 26,
      weight: 800,
      color: "#7CF29B",
    });
    r.text(
      `You scored ${res?.score ?? 0} (needed ${res?.target ?? g.target}). Choose an upgrade:`,
      r.width / 2,
      panel.y + 74,
      { size: 15, color: "rgba(234,240,255,0.8)" },
    );

    // Upgrade option cards.
    const n = g.offers.length;
    const gap = 18;
    const optW = Math.min(180, (panel.w - 48 - gap * (n - 1)) / Math.max(1, n));
    const optH = 200;
    const totalW = n * optW + (n - 1) * gap;
    let ox = r.width / 2 - totalW / 2;
    const oy = panel.y + 108;
    this.ui.shopOptions = [];
    for (let i = 0; i < n; i++) {
      const rect: Rect = { x: ox, y: oy, w: optW, h: optH };
      this.ui.shopOptions.push(rect);
      this.drawShopOption(rect, g.offers[i], i);
      ox += optW + gap;
    }

    // Skip button + deck info.
    const skip: Rect = { x: r.width / 2 - 80, y: panel.y + h - 56, w: 160, h: 40 };
    r.drawButton(skip, "Skip upgrade");
    this.ui.shopSkip = skip;
    r.text(`Deck: ${this.deckSummary()}`, r.width / 2, panel.y + h - 74, {
      size: 13,
      color: "rgba(234,240,255,0.55)",
    });

    // mute still available
    const { muteRect } = this.peekMute();
    this.ui.muteRect = muteRect;
  }

  private drawShopOption(rect: Rect, offer: import("../core/upgrades").Upgrade, i: number): void {
    const r = this.renderer;
    r.drawButton(rect, "", { time: this.time });
    // Icon glyph
    let glyph = "＋";
    let color = "#7CF29B";
    if (offer.type === "add") {
      glyph = offer.card.kind === "op" ? cardLabel(offer.card) : String(offer.card.value);
      color = offer.card.kind === "op" ? (offer.card.op === "*" ? "#FFC46B" : "#7CF29B") : "#5ad1ff";
    } else if (offer.type === "remove") {
      glyph = "－";
      color = "#ff6b8a";
    } else {
      glyph = "⬆";
      color = "#FFC46B";
    }
    const cx = rect.x + rect.w / 2;
    r.text(glyph, cx, rect.y + 52, { size: 46, weight: 800, color });
    // wrap title/desc
    r.text(offer.title, cx, rect.y + 110, { size: 16, weight: 800 });
    this.wrapText(offer.desc, cx, rect.y + 134, rect.w - 20, 13);
    r.text(`[ ${i + 1} ]`, cx, rect.y + rect.h - 18, {
      size: 12,
      color: "rgba(234,240,255,0.5)",
    });
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
      round: this.game.round,
      target: this.game.target,
      score: this.game.currentScore,
      hand: this.game.hand.map((c) => cardLabel(c)),
      deckRemaining: this.game.roundDeck.length + this.game.hand.length,
      nodeCircles: this.ui.nodeCircles.map((c) => ({ id: c.id, x: Math.round(c.x), y: Math.round(c.y), r: Math.round(c.r), type: c.node.type })),
      legalNow: [...this.legalNow],
    };
  }

  private deckSummary(): string {
    const counts = new Map<string, number>();
    for (const c of this.game.deck) {
      const k = cardLabel(c);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].map(([k, v]) => `${v}×${k}`).join("  ");
  }
}

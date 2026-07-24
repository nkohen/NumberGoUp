/**
 * Canvas renderer for Number Go Up.
 *
 * Everything is drawn to a single 2D canvas: the arithmetic tree (bubbles +
 * sprouting edges), the hand, the HUD, floating particles, and the primitive
 * widgets (panels/buttons) that the screen overlays are composed from.
 *
 * The renderer owns a small amount of *visual* state — animated bubble
 * positions that ease toward their layout targets, and a particle system — but
 * it holds no game rules. The app feeds it the current `TreeNode` and options.
 *
 * Geometry used for hit-testing (node circles, hand-card rects, button rects)
 * is returned from the draw calls so the input layer can test against exactly
 * what was drawn.
 */
import { TreeNode, NodeId, listNodes } from "../core/tree";
import { Card, cardLabel } from "../core/cards";
import { layoutTree } from "./layout";
import {
  smooth,
  easeOutBack,
  clamp01,
  EvaluateAnimation,
  lerp,
} from "./animation";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NodeCircle {
  id: NodeId;
  x: number;
  y: number;
  r: number;
  node: TreeNode;
}

export interface HandCardRect {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  card: Card;
}

interface BubbleView {
  x: number;
  y: number;
  r: number;
  spawn: number; // 0..1 spawn animation progress
  born: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  r: number;
  color: string;
}

// --- Theme --------------------------------------------------------------------

const THEME = {
  bgTop: "#0b1026",
  bgBottom: "#131a3a",
  slotStroke: "rgba(150,170,255,0.55)",
  slotFill: "rgba(90,110,200,0.10)",
  number: { a: "#5ad1ff", b: "#2b7fff", glow: "rgba(90,209,255,0.55)" },
  add: { a: "#7CF29B", b: "#27B36B", glow: "rgba(124,242,155,0.5)" },
  mul: { a: "#FFC46B", b: "#F0862B", glow: "rgba(255,196,107,0.5)" },
  variable: { a: "#ff9be0", b: "#d24fb8", glow: "rgba(255,155,224,0.5)" },
  apply: { a: "#b79bff", b: "#7a4fe0", glow: "rgba(183,155,255,0.5)" },
  edge: "rgba(180,200,255,0.5)",
  text: "#eaf0ff",
  textDim: "rgba(234,240,255,0.6)",
  targetGlow: "rgba(124,242,155,0.9)",
  panel: "rgba(18,24,54,0.94)",
  panelStroke: "rgba(120,150,255,0.35)",
  accent: "#7CF29B",
  danger: "#ff6b8a",
};

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  private dpr = 1;

  private bubbles = new Map<NodeId, BubbleView>();
  private particles: Particle[] = [];
  private lastNodeCircles: NodeCircle[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // --- layout regions ---------------------------------------------------------

  get hudHeight(): number {
    return Math.max(64, Math.min(96, this.height * 0.11));
  }
  get handHeight(): number {
    return Math.max(120, Math.min(180, this.height * 0.22));
  }
  get treeRect(): Rect {
    const top = this.hudHeight;
    return {
      x: 12,
      y: top,
      w: this.width - 24,
      h: this.height - top - this.handHeight,
    };
  }

  // --- frame lifecycle --------------------------------------------------------

  beginFrame(dt: number): void {
    // background gradient
    const g = this.ctx.createLinearGradient(0, 0, 0, this.height);
    g.addColorStop(0, THEME.bgTop);
    g.addColorStop(1, THEME.bgBottom);
    this.ctx.fillStyle = g;
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.drawStars();
    this.updateParticles(dt);
  }

  private starSeedCache: Array<{ x: number; y: number; r: number; a: number }> | null = null;
  private drawStars(): void {
    // A few static, faint stars for depth (deterministic, not per-frame random).
    if (!this.starSeedCache) {
      this.starSeedCache = [];
      let s = 1337;
      const rnd = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
      for (let i = 0; i < 70; i++) {
        this.starSeedCache.push({ x: rnd(), y: rnd(), r: rnd() * 1.4 + 0.3, a: rnd() * 0.4 + 0.1 });
      }
    }
    for (const st of this.starSeedCache) {
      this.ctx.fillStyle = `rgba(200,215,255,${st.a})`;
      this.ctx.beginPath();
      this.ctx.arc(st.x * this.width, st.y * (this.height * 0.6), st.r, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }

  // --- tree scene -------------------------------------------------------------

  /**
   * Compute screen circles for the current tree, fit into the tree rect.
   * Pure geometry (no drawing) so input can call it too.
   */
  computeTreeCircles(root: TreeNode): NodeCircle[] {
    const rect = this.treeRect;
    const lay = layoutTree(root);
    const margin = 40;
    const innerW = Math.max(1, rect.w - margin * 2);
    const innerH = Math.max(1, rect.h - margin * 2);
    const colW = innerW / lay.cols;
    const rowH = lay.depths > 1 ? innerH / (lay.depths - 1) : 0;
    const r = Math.max(
      16,
      Math.min(46, colW * 0.42, (rowH || innerH) * 0.42),
    );
    const circles: NodeCircle[] = [];
    for (const n of listNodes(root)) {
      const nl = lay.nodes.get(n.id)!;
      const x = rect.x + margin + (nl.col + 0.5) * colW;
      const y =
        lay.depths > 1
          ? rect.y + margin + nl.depth * rowH
          : rect.y + rect.h / 2;
      circles.push({ id: n.id, x, y, r, node: n });
    }
    return circles;
  }

  /**
   * Draw the tree. `opts.legalTargets` glow as drop targets; `opts.hoverId`
   * pulses under the pointer; `opts.evalAnim`, when present, drives the merge.
   */
  drawTree(
    root: TreeNode,
    dt: number,
    opts: {
      legalTargets?: Set<NodeId>;
      hoverId?: NodeId | null;
      evalAnim?: EvaluateAnimation | null;
      time: number;
    },
  ): NodeCircle[] {
    const circles = this.computeTreeCircles(root);
    this.lastNodeCircles = circles;

    // Ease animated bubble views toward targets; spawn new ones with a pop.
    const alive = new Set<NodeId>();
    for (const c of circles) {
      alive.add(c.id);
      let bv = this.bubbles.get(c.id);
      if (!bv) {
        // Spawn at parent position if we can find one, else at target.
        bv = { x: c.x, y: c.y, r: 0, spawn: 0, born: false };
        this.bubbles.set(c.id, bv);
      }
      bv.spawn = Math.min(1, bv.spawn + dt / 0.32);
      bv.x = smooth(bv.x, c.x, 0.25, dt);
      bv.y = smooth(bv.y, c.y, 0.25, dt);
      bv.r = smooth(bv.r, c.r, 0.3, dt);
      bv.born = true;
    }
    for (const id of [...this.bubbles.keys()]) {
      if (!alive.has(id)) this.bubbles.delete(id);
    }

    // Edges first (under bubbles).
    this.ctx.lineCap = "round";
    for (const c of circles) {
      if (c.node.type !== "op") continue;
      const parent = this.bubbles.get(c.id)!;
      for (const child of [c.node.left, c.node.right]) {
        const cv = this.bubbles.get(child.id);
        if (!cv) continue;
        const grow = clamp01(cv.spawn);
        this.drawEdge(parent.x, parent.y, cv.x, cv.y, grow, opts.evalAnim, child.id);
      }
    }

    // Bubbles.
    for (const c of circles) {
      const bv = this.bubbles.get(c.id)!;
      const pop = easeOutBack(clamp01(bv.spawn));
      let r = bv.r * pop;
      let alpha = 1;
      let label = this.labelFor(c.node);
      let showValue = false;

      if (opts.evalAnim) {
        const st = opts.evalAnim.stateFor(c.id);
        // Reveal aggregate value; shrink as absorbed into parent.
        if (st.reveal > 0) {
          label = String(st.value);
          showValue = true;
        }
        const absorbScale = 1 - 0.85 * st.absorb;
        r *= absorbScale;
        alpha *= 1 - 0.75 * st.absorb;
        // A little pop when a node reveals its value.
        if (st.reveal > 0 && st.reveal < 1) {
          r *= 1 + 0.18 * Math.sin(st.reveal * Math.PI);
        }
      }

      const isTarget = opts.legalTargets?.has(c.id) ?? false;
      const isHover = opts.hoverId === c.id;
      this.drawBubble(bv.x, bv.y, r, c.node, label, {
        alpha,
        target: isTarget,
        hover: isHover,
        time: opts.time,
        forceValue: showValue,
      });
    }

    this.drawParticles();
    return circles;
  }

  get lastCircles(): NodeCircle[] {
    return this.lastNodeCircles;
  }

  private labelFor(node: TreeNode): string {
    if (node.type === "slot") return "0";
    if (node.type === "value") return String(node.value);
    if (node.type === "var") return "x";
    switch (node.op) {
      case "*":
        return "×";
      case "@":
        return "ƒ";
      default:
        return "+";
    }
  }

  private colorsFor(node: TreeNode): { a: string; b: string; glow: string } {
    if (node.type === "var") return THEME.variable;
    if (node.type === "op") {
      if (node.op === "*") return THEME.mul;
      if (node.op === "@") return THEME.apply;
      return THEME.add;
    }
    return THEME.number;
  }

  private drawEdge(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    grow: number,
    evalAnim: EvaluateAnimation | null | undefined,
    childId: NodeId,
  ): void {
    let ex = lerp(x1, x2, grow);
    let ey = lerp(y1, y2, grow);
    let alpha = 0.5;
    if (evalAnim) {
      const st = evalAnim.stateFor(childId);
      alpha *= 1 - 0.9 * st.absorb;
    }
    const ctx = this.ctx;
    ctx.strokeStyle = `rgba(180,200,255,${alpha})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    // slight curve for organic feel
    const mx = (x1 + ex) / 2;
    const my = (y1 + ey) / 2 + 6;
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();
  }

  drawBubble(
    x: number,
    y: number,
    r: number,
    node: TreeNode,
    label: string,
    opts: {
      alpha?: number;
      target?: boolean;
      hover?: boolean;
      time?: number;
      forceValue?: boolean;
    } = {},
  ): void {
    const ctx = this.ctx;
    const alpha = opts.alpha ?? 1;
    const time = opts.time ?? 0;
    if (r <= 0.5 || alpha <= 0.02) return;
    ctx.save();
    ctx.globalAlpha = alpha;

    const isSlot = node.type === "slot" && !opts.forceValue;

    // Target highlight ring (pulsing).
    if (opts.target) {
      const pulse = 1 + 0.08 * Math.sin(time * 6);
      ctx.save();
      ctx.globalAlpha = alpha * 0.9;
      ctx.strokeStyle = THEME.targetGlow;
      ctx.lineWidth = 3;
      ctx.shadowColor = THEME.targetGlow;
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.22 * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (isSlot) {
      // Ghostly dashed placeholder.
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = THEME.slotStroke;
      ctx.fillStyle = THEME.slotFill;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      const colors = this.colorsFor(node);
      const hoverBoost = opts.hover ? 1.06 : 1;
      const rr = r * hoverBoost;
      // Glow
      ctx.shadowColor = colors.glow;
      ctx.shadowBlur = opts.hover ? 26 : 14;
      const grad = ctx.createRadialGradient(
        x - rr * 0.3,
        y - rr * 0.35,
        rr * 0.2,
        x,
        y,
        rr,
      );
      grad.addColorStop(0, colors.a);
      grad.addColorStop(1, colors.b);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      // Glossy highlight
      ctx.fillStyle = "rgba(255,255,255,0.28)";
      ctx.beginPath();
      ctx.ellipse(x - rr * 0.28, y - rr * 0.38, rr * 0.42, rr * 0.26, -0.5, 0, Math.PI * 2);
      ctx.fill();
      // Rim
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Label
    ctx.globalAlpha = alpha;
    ctx.fillStyle = isSlot ? THEME.textDim : "#0b1026";
    if (!isSlot) ctx.fillStyle = "rgba(10,16,38,0.92)";
    const fontSize = Math.max(12, r * (label.length > 2 ? 0.8 : 1.05));
    ctx.font = `700 ${fontSize}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y + 1);
    ctx.restore();
  }

  // --- hand -------------------------------------------------------------------

  drawHand(
    hand: Card[],
    opts: { draggingIndex?: number | null; time: number; playableFlags?: boolean[] },
  ): HandCardRect[] {
    const ctx = this.ctx;
    const areaTop = this.height - this.handHeight;
    const cardH = Math.min(this.handHeight * 0.72, 120);
    const cardW = cardH * 0.72;
    const gap = Math.min(18, cardW * 0.22);
    const n = hand.length;
    const totalW = n * cardW + (n - 1) * gap;
    let startX = (this.width - totalW) / 2;
    const y = areaTop + (this.handHeight - cardH) / 2 + 6;

    // hand shelf
    ctx.fillStyle = "rgba(10,14,34,0.55)";
    ctx.fillRect(0, areaTop, this.width, this.handHeight);
    ctx.strokeStyle = "rgba(120,150,255,0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, areaTop + 0.5);
    ctx.lineTo(this.width, areaTop + 0.5);
    ctx.stroke();

    const rects: HandCardRect[] = [];
    for (let i = 0; i < n; i++) {
      const x = startX + i * (cardW + gap);
      rects.push({ index: i, x, y, w: cardW, h: cardH, card: hand[i] });
      if (opts.draggingIndex === i) {
        // Draw an empty ghost slot where the dragged card was.
        this.drawCardGhost(x, y, cardW, cardH);
        continue;
      }
      const bob = Math.sin(opts.time * 2 + i) * 3;
      const playable = opts.playableFlags ? opts.playableFlags[i] : true;
      this.drawCard(x, y + bob, cardW, cardH, hand[i], { dim: !playable });
    }
    return rects;
  }

  private drawCardGhost(x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = "rgba(150,170,255,0.35)";
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, w, h, 12);
    ctx.stroke();
    ctx.restore();
  }

  drawCard(
    x: number,
    y: number,
    w: number,
    h: number,
    card: Card,
    opts: { dim?: boolean; scale?: number } = {},
  ): void {
    const ctx = this.ctx;
    ctx.save();
    if (opts.scale && opts.scale !== 1) {
      ctx.translate(x + w / 2, y + h / 2);
      ctx.scale(opts.scale, opts.scale);
      ctx.translate(-(x + w / 2), -(y + h / 2));
    }
    if (opts.dim) ctx.globalAlpha = 0.4;

    // Card body
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, "#20264f");
    grad.addColorStop(1, "#161b3c");
    ctx.fillStyle = grad;
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 6;
    roundRect(ctx, x, y, w, h, 12);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // colored token in the middle
    const colors = colorsForCard(card);
    const cx = x + w / 2;
    const cy = y + h * 0.42;
    const r = Math.min(w, h) * 0.28;
    const rg = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.2, cx, cy, r);
    rg.addColorStop(0, colors.a);
    rg.addColorStop(1, colors.b);
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // glyph
    ctx.fillStyle = "rgba(10,16,38,0.92)";
    ctx.font = `800 ${r * 1.2}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(cardLabel(card), cx, cy + 1);

    // caption
    ctx.fillStyle = THEME.textDim;
    ctx.font = `600 ${Math.max(9, h * 0.1)}px ${FONT}`;
    ctx.fillText(captionForCard(card), cx, y + h - h * 0.16);

    // border
    ctx.strokeStyle = "rgba(150,170,255,0.25)";
    ctx.lineWidth = 1.5;
    roundRect(ctx, x, y, w, h, 12);
    ctx.stroke();
    ctx.restore();
  }

  // --- HUD --------------------------------------------------------------------

  drawHUD(info: {
    round: number;
    target: number;
    score: number;
    deckRemaining: number;
    deckTotal: number;
    muted: boolean;
  }): { muteRect: Rect } {
    const ctx = this.ctx;
    const h = this.hudHeight;
    ctx.fillStyle = "rgba(10,14,34,0.6)";
    ctx.fillRect(0, 0, this.width, h);

    const pad = 18;
    // Left: round
    this.drawStat(pad, h / 2, "ROUND", String(info.round), "left");
    // Center: score / target with progress
    const midX = this.width / 2;
    const reached = info.score >= info.target;
    ctx.fillStyle = reached ? THEME.accent : THEME.text;
    ctx.font = `800 ${Math.min(34, h * 0.42)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(`${info.score}`, midX, h * 0.5);
    ctx.fillStyle = THEME.textDim;
    ctx.font = `600 ${Math.min(15, h * 0.2)}px ${FONT}`;
    ctx.fillText(`/ ${info.target} to clear`, midX, h * 0.74);
    ctx.font = `600 ${Math.min(12, h * 0.16)}px ${FONT}`;
    ctx.fillText("SCORE", midX, h * 0.24);

    // progress bar under center
    const barW = Math.min(280, this.width * 0.4);
    const barX = midX - barW / 2;
    const barY = h - 8;
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    roundRect(ctx, barX, barY, barW, 4, 2);
    ctx.fill();
    const frac = clamp01(info.target ? info.score / info.target : 0);
    ctx.fillStyle = reached ? THEME.accent : THEME.number.a;
    roundRect(ctx, barX, barY, barW * frac, 4, 2);
    ctx.fill();

    // Right: deck + mute
    this.drawStat(this.width - pad - 70, h / 2, "DECK", `${info.deckRemaining}/${info.deckTotal}`, "right");
    const muteRect: Rect = { x: this.width - 46, y: h / 2 - 16, w: 32, h: 32 };
    this.drawIconButton(muteRect, info.muted ? "🔇" : "🔊");
    return { muteRect };
  }

  private drawStat(x: number, cy: number, label: string, value: string, align: CanvasTextAlign): void {
    const ctx = this.ctx;
    ctx.textAlign = align;
    ctx.fillStyle = THEME.textDim;
    ctx.font = `600 12px ${FONT}`;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(label, x, cy - 6);
    ctx.fillStyle = THEME.text;
    ctx.font = `800 22px ${FONT}`;
    ctx.fillText(value, x, cy + 16);
  }

  private drawIconButton(rect: Rect, glyph: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 8);
    ctx.fill();
    ctx.font = `18px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(glyph, rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);
  }

  // --- primitives for overlays -----------------------------------------------

  drawDimmer(alpha = 0.55): void {
    this.ctx.fillStyle = `rgba(4,6,18,${alpha})`;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  drawPanel(rect: Rect): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 30;
    ctx.fillStyle = THEME.panel;
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 18);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = THEME.panelStroke;
    ctx.lineWidth = 1.5;
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 18);
    ctx.stroke();
    ctx.restore();
  }

  drawButton(
    rect: Rect,
    label: string,
    opts: { primary?: boolean; danger?: boolean; enabled?: boolean; time?: number } = {},
  ): void {
    const ctx = this.ctx;
    const enabled = opts.enabled ?? true;
    ctx.save();
    if (!enabled) ctx.globalAlpha = 0.4;
    let fill = "rgba(255,255,255,0.10)";
    let stroke = "rgba(150,170,255,0.4)";
    let text = THEME.text;
    if (opts.primary) {
      const pulse = opts.time ? 1 + 0.02 * Math.sin(opts.time * 4) : 1;
      ctx.shadowColor = THEME.accent;
      ctx.shadowBlur = 18 * pulse;
      fill = THEME.accent;
      stroke = "rgba(255,255,255,0.5)";
      text = "#08240f";
    } else if (opts.danger) {
      fill = "rgba(255,107,138,0.18)";
      stroke = THEME.danger;
      text = THEME.danger;
    }
    ctx.fillStyle = fill;
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 12);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 12);
    ctx.stroke();
    ctx.fillStyle = text;
    ctx.font = `700 ${Math.min(20, rect.h * 0.4)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);
    ctx.restore();
  }

  text(
    str: string,
    x: number,
    y: number,
    opts: { size?: number; color?: string; align?: CanvasTextAlign; weight?: number } = {},
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = opts.color ?? THEME.text;
    ctx.font = `${opts.weight ?? 600} ${opts.size ?? 18}px ${FONT}`;
    ctx.textAlign = opts.align ?? "center";
    ctx.textBaseline = "middle";
    ctx.fillText(str, x, y);
  }

  /** Big glowing title bubble text. */
  titleText(str: string, x: number, y: number, size: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `900 ${size}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = THEME.number.glow;
    ctx.shadowBlur = 24;
    const grad = ctx.createLinearGradient(x, y - size / 2, x, y + size / 2);
    grad.addColorStop(0, "#8fe4ff");
    grad.addColorStop(1, "#2b7fff");
    ctx.fillStyle = grad;
    ctx.fillText(str, x, y);
    ctx.restore();
  }

  /** Draw a card mid-drag, centered on the pointer. */
  drawDraggedCard(card: Card, x: number, y: number, w: number, h: number): void {
    this.drawCard(x - w / 2, y - h / 2, w, h, card, { scale: 1.1 });
  }

  // --- particles --------------------------------------------------------------

  burst(x: number, y: number, color: string, count = 12, speed = 120): void {
    for (let i = 0; i < count; i++) {
      const a = (Math.PI * 2 * i) / count + Math.random() * 0.5;
      const s = speed * (0.5 + Math.random());
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: 0,
        maxLife: 0.5 + Math.random() * 0.4,
        r: 2 + Math.random() * 3,
        color,
      });
    }
  }

  private updateParticles(dt: number): void {
    for (const p of this.particles) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 260 * dt; // gravity
      p.vx *= 0.98;
    }
    this.particles = this.particles.filter((p) => p.life < p.maxLife);
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    for (const p of this.particles) {
      const t = 1 - p.life / p.maxLife;
      ctx.globalAlpha = t;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * t, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Colour associated with a card (for particle bursts). */
  static particleColor(card: Card): string {
    return colorsForCard(card).a;
  }
}

/** Colour ramp for a card by kind (numbers, x, and each operator). */
function colorsForCard(card: Card): { a: string; b: string; glow: string } {
  if (card.kind === "number") return THEME.number;
  if (card.kind === "var") return THEME.variable;
  if (card.op === "*") return THEME.mul;
  if (card.op === "@") return THEME.apply;
  return THEME.add;
}

function captionForCard(card: Card): string {
  if (card.kind === "number") return "NUMBER";
  if (card.kind === "var") return "VARIABLE";
  if (card.op === "*") return "MULTIPLY";
  if (card.op === "@") return "EVALUATE";
  return "ADD";
}

// --- helpers ------------------------------------------------------------------

const FONT =
  "'Baloo 2', 'Nunito', 'Segoe UI', system-ui, -apple-system, sans-serif";

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

export function pointInCircle(
  px: number,
  py: number,
  cx: number,
  cy: number,
  r: number,
): boolean {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

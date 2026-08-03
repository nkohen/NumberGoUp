/**
 * Canvas renderer for the interaction-net sandbox.
 *
 * Visual language matches the game: a dark blue gradient with faint stars,
 * glossy gradient shapes with a coloured glow, rounded wires.
 *
 * AGENTS ARE SHAPED LIKE THEIR PORTS. A binary agent (γ, δ) is a curved triangle
 * whose three corners sit exactly where its three wires attach: a sharp apex
 * pointing up for the principal port, two blunter corners below for the aux
 * ports. An ε has only a principal port, so it is a teardrop with its point at
 * that one wire. You can tell which wire is which from the silhouette, without
 * tracing it — which matters because "principal meets principal" is the entire
 * reduction rule.
 *
 * THE ONE RULE THAT MATTERS HERE: every rewrite is spatially local, so it is
 * animated IN PLACE. Layout runs only when the user asks for it (load a preset,
 * reset, press Tidy) — never during reduction. Re-running a global layout after
 * each rewrite is the known failure mode of interaction-net visualisers: the
 * whole net jumps every frame and nothing is legible. Instead:
 *
 *   - agents keep the position they were laid out at,
 *   - agents created by a rewrite are born at the position of the agent they
 *     came from and drift toward whatever their principal port now points at,
 *   - wires are drawn from live port positions, so they follow along for free.
 *
 * The three rule families get distinct motion:
 *
 *   ANNIHILATION  the pair collapses toward its midpoint and pops.
 *   COMMUTATION   the two agents translate *through* each other, each leaving a
 *                 duplicate behind: 2 sprites become 4 in the same region.
 *   ERASURE       the ε swallows its partner, then splits into copies that drift
 *                 outward along the wires the partner's aux ports used to hold.
 */
import { clamp01, easeInOutCubic, easeOutBack, lerp, smooth } from "../render/animation";
import { layoutForest } from "./layout";
import {
  attachPoint,
  portDirection,
  relaxStep,
  restAngle,
  restAngleFree,
  turnToward,
  type Bounds,
  type AgentPlacement,
  type FreePlacement,
  type Placements,
} from "./relax";
import { symbolDef, type Alphabet } from "./alphabet";
import {
  isFree,
  Net,
  portsOf,
  principal,
  type Agent,
  type AgentId,
  type Endpoint,
  type Sym,
} from "./net";

const THEME = {
  bgTop: "#0b1026",
  bgBottom: "#131a3a",
  text: "#eaf0ff",
  textDim: "rgba(234,240,255,0.6)",
  wire: "rgba(180,200,255,0.42)",
  wireActive: "rgba(124,242,155,0.95)",
  free: "rgba(120,190,255,0.85)",
  freeFill: "rgba(40,70,140,0.45)",
  select: "#ffe27a",
};

/**
 * Above this many agents, settling costs more than it buys — a net that big is
 * unreadable anyway, and the frame budget is better spent drawing it.
 */
const RELAX_LIMIT = 400;

/** Bubble radius the tidy layout aims for, and the floor it will not go below. */
const MAX_RADIUS = 30;
const MIN_RADIUS = 13;

/** How far the camera will zoom out before it gives up and lets things clip. */
const MIN_ZOOM = 0.08;

const FALLBACK_STYLE = { a: "#9fb4e8", b: "#5a6ea8", glow: "rgba(159,180,232,0.5)" };

/** Colours come from the alphabet, so a new symbol set brings its own palette. */
function styleFor(alphabet: Alphabet, symbol: Sym): { a: string; b: string; glow: string } {
  return symbolDef(alphabet, symbol)?.color ?? FALLBACK_STYLE;
}

export interface Point {
  x: number;
  y: number;
}

interface AgentView extends AgentPlacement {
  /** Target position, used while easing to a fresh layout. */
  tx: number;
  ty: number;
  /** True while easing to `tx,ty`; relaxation takes over once it lands. */
  easing: boolean;
  /** 0..1 birth animation. */
  spawn: number;
  /** The user is dragging this one. */
  held?: boolean;
  symbol: Sym;
  arity: number;
}

interface Ghost extends Point {
  symbol: Sym;
  arity: number;
  angle: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** When (in animation progress) this ghost stops existing. */
  until: number;
}

interface Born {
  id: AgentId;
  fromX: number;
  fromY: number;
  delay: number;
  /** Perpendicular offset that keeps sibling copies from stacking up. */
  spreadX: number;
  spreadY: number;
}

interface Particle extends Point {
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  r: number;
  color: string;
}

export type RewriteKind = "annihilate" | "commute" | "erase";

interface RewriteAnim {
  kind: RewriteKind;
  t: number;
  dur: number;
  ghosts: Ghost[];
  born: Born[];
  flashX: number;
  flashY: number;
  flashed: boolean;
}

/** A snapshot of the two agents in a redex, taken before it is rewritten. */
export interface RedexSnapshot {
  a: Agent;
  b: Agent;
  at: Point;
  bt: Point;
}

export class NetRenderer {
  readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  private dpr = 1;

  private views = new Map<AgentId, AgentView>();
  private freeViews = new Map<number, FreePlacement>();
  /** Continuously settle positions and rotations when nothing is animating. */
  settle = true;
  private particles: Particle[] = [];
  private anims: RewriteAnim[] = [];
  private radius = 22;
  private time = 0;
  /**
   * World-to-screen view. `x,y` is the world point shown at the centre of the
   * canvas; `scale` is 1 until the net outgrows the canvas, then shrinks to fit.
   * Everything else in this class works in WORLD coordinates — the camera is
   * applied once, as a canvas transform, at draw time.
   */
  private camera = { scale: 1, x: 0, y: 0 };
  /** The box the tidy layout last laid the net out into. May exceed the canvas. */
  private world: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  /** Endpoint the user has armed for wiring, drawn highlighted. */
  selected: Endpoint | null = null;
  /**
   * Free-port ids to draw as legal drop targets. The game layer sets this while
   * a card is held, so the interface the player can actually attack is obvious
   * rather than something they have to deduce from the shapes.
   */
  highlightFree = new Set<number>();
  /**
   * Of those, the ones that would actually START A REACTION — i.e. whose far end
   * is a principal port. Drawn hotter than the merely-legal ones, because
   * "which wires are live" is the single thing a player most needs to see and
   * the hardest to work out from the picture.
   */
  highlightHot = new Set<number>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.resize();
  }

  get busy(): boolean {
    return this.anims.length > 0 || this.particles.length > 0;
  }

  get bubbleRadius(): number {
    return this.radius;
  }

  /** Current view scale: 1 when everything fits, less when zoomed out. */
  get zoom(): number {
    return this.camera.scale;
  }

  /** Screen point -> world point. */
  toWorld(x: number, y: number): Point {
    return {
      x: (x - this.width / 2) / this.camera.scale + this.camera.x,
      y: (y - this.height / 2) / this.camera.scale + this.camera.y,
    };
  }

  /** World point -> screen point. */
  toScreen(x: number, y: number): Point {
    return {
      x: (x - this.camera.x) * this.camera.scale + this.width / 2,
      y: (y - this.camera.y) * this.camera.scale + this.height / 2,
    };
  }

  /** Bounding box of everything currently placed, in world coordinates. */
  private contentBounds(): Bounds | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const see = (p: Point): void => {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    };
    for (const v of this.views.values()) see(v);
    for (const f of this.freeViews.values()) see(f);
    if (minX === Infinity) return null;
    return { minX, minY, maxX, maxY };
  }

  /**
   * Zoom out (never in past 1:1) so the whole net stays on screen, and follow
   * its centre while zoomed out. Eased, so a rewrite that suddenly doubles the
   * agent count pulls the view back smoothly instead of snapping.
   */
  private updateCamera(dt: number): void {
    // Freeze the view while the user is dragging. Otherwise moving a node
    // changes the content bounds, which moves the camera, which slides the
    // world out from under the cursor — the drag stops tracking the pointer.
    if (this.userHolding()) return;
    const box = this.contentBounds();
    if (!box) return;
    const pad = this.radius * 2.6;
    const w = box.maxX - box.minX + pad * 2;
    const h = box.maxY - box.minY + pad * 2;
    const fit = Math.min(this.width / Math.max(1, w), this.height / Math.max(1, h));
    const scale = Math.max(MIN_ZOOM, Math.min(1, fit));
    // While everything fits, stay at exact identity: recentring a net that is
    // already fully visible just makes it drift as agents move.
    const engaged = scale < 0.995;
    const targetX = engaged ? (box.minX + box.maxX) / 2 : this.width / 2;
    const targetY = engaged ? (box.minY + box.maxY) / 2 : this.height / 2;
    this.camera.scale = smooth(this.camera.scale, scale, 0.12, dt);
    this.camera.x = smooth(this.camera.x, targetX, 0.12, dt);
    this.camera.y = smooth(this.camera.y, targetY, 0.12, dt);
  }

  /** Is the user holding something right now? */
  private userHolding(): boolean {
    for (const v of this.views.values()) if (v.held) return true;
    for (const f of this.freeViews.values()) if (f.pinned) return true;
    return false;
  }

  /** Where relaxation is allowed to put things: the layout box, plus room to grow. */
  private relaxBounds(): Bounds {
    const box = this.contentBounds();
    const room = this.radius * 8;
    if (!box) return this.world;
    return {
      minX: Math.min(this.world.minX, box.minX - room),
      minY: Math.min(this.world.minY, box.minY - room),
      maxX: Math.max(this.world.maxX, box.maxX + room),
      maxY: Math.max(this.world.maxY, box.maxY + room),
    };
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // --- Layout (explicit user action only) ---------------------------------------

  /**
   * Position every agent and free port from the forest decomposition. `snap`
   * places them immediately; otherwise they ease to the new positions, which
   * makes the Tidy button read as a settling rather than a jump.
   */
  relayout(net: Net, snap = false): void {
    const layout = layoutForest(net);
    const margin = 34;
    const innerW = Math.max(1, this.width - margin * 2);
    const innerH = Math.max(1, this.height - margin * 2);

    // Try to fit the canvas, but never below MIN_RADIUS: past that point the
    // agents would be too small to read, so instead we lay the net out into a
    // WORLD box bigger than the canvas and let the camera zoom out to show it.
    // Space per level is capped too, so a wide two-level net does not stretch
    // its rows down a tall canvas.
    const rowSpace = layout.depths > 1 ? innerH / (layout.depths - 1 + 0.8) : innerH;
    this.radius = Math.max(
      MIN_RADIUS,
      Math.min(MAX_RADIUS, (innerW / Math.max(1, layout.cols)) * 0.34, rowSpace * 0.34),
    );
    const colW = Math.max(innerW / Math.max(1, layout.cols), this.radius * 2.9);
    const rowH = Math.min(Math.max(rowSpace, this.radius * 4.2), this.radius * 4.2);
    const contentW = layout.cols * colW;
    const contentH = (layout.depths - 1) * rowH + this.radius * 4;
    const left = margin + Math.max(0, (innerW - contentW) / 2);
    const top = margin + Math.max(0, (innerH - contentH) / 2);

    this.world = {
      minX: 0,
      minY: 0,
      maxX: Math.max(this.width, left + contentW + margin),
      maxY: Math.max(this.height, top + contentH + margin),
    };

    const place = (col: number, depth: number, up: boolean): Point => ({
      x: left + (col + 0.5) * colW,
      y: top + this.radius * 1.6 + depth * rowH + (up ? -this.radius * 1.9 : 0),
    });

    const seen = new Set<AgentId>();
    for (const a of layout.agents) {
      seen.add(a.id);
      const p = place(a.col, a.depth, false);
      this.setTarget(a.id, a.symbol, a.arity, p, snap);
    }
    for (const id of [...this.views.keys()]) if (!seen.has(id)) this.views.delete(id);

    this.freeViews.clear();
    for (const stub of layout.stubs) {
      if (stub.freeId === null) continue;
      const p = place(stub.col, stub.depth, stub.up);
      // An aux stub sits a little below its row so the wire has length to it.
      if (!stub.up) p.y += this.radius * 1.5;
      this.freeViews.set(stub.freeId, { ...p, angle: 0 });
    }
    // Wires with no agent at either end get their own strip along the bottom.
    layout.looseWires.forEach(([a, b], i) => {
      const y = this.world.maxY - margin * 0.6;
      const span = this.world.maxX - this.world.minX - margin * 2;
      const x = margin + ((i + 0.5) * span) / Math.max(1, layout.looseWires.length);
      if (isFree(a)) this.freeViews.set(a.free, { x: x - 18, y, angle: 0 });
      if (isFree(b)) this.freeViews.set(b.free, { x: x + 18, y, angle: 0 });
    });
    // Anything still unplaced (a free port only reachable through an arc) goes
    // near its partner rather than at the origin.
    for (const f of net.freePorts()) {
      if (this.freeViews.has(f)) continue;
      const partner = net.follow({ free: f });
      const near = partner ? this.pointFor(partner) : null;
      const fallback = { x: (this.world.minX + this.world.maxX) / 2, y: this.world.maxY - margin };
      this.freeViews.set(f, { ...(near ?? fallback), angle: 0 });
    }
    this.aimFreePorts(net);
  }

  /** The renderer's position maps, viewed as something `relax.ts` can settle. */
  private placements(): Placements {
    return { agents: this.views, free: this.freeViews };
  }

  /**
   * Settle positions and rotations toward a lower-energy arrangement.
   *
   * Relaxation is deliberately NOT run while a rewrite is animating. The whole
   * point of animating in place is that motion during a rewrite means the
   * rewrite and nothing else; letting the layout breathe at the same time would
   * put us back where a re-layout-every-frame visualiser is. So it settles
   * between rewrites — which is exactly when the eye has time to follow it.
   *
   * Rotations are aimed at the wires either way, since the corners of an agent
   * are its ports and should point at what they are connected to even when the
   * user has turned settling off.
   */
  private settleFrame(net: Net, dt: number): void {
    const places = this.placements();
    for (const v of this.views.values()) v.pinned = v.easing || v.held;

    if (this.settle && this.anims.length === 0 && this.views.size <= RELAX_LIMIT) {
      // Fixed-size sweeps, count scaled by the frame time, so the settling speed
      // does not depend on the frame rate.
      const sweeps = Math.max(1, Math.min(3, Math.round(dt * 120)));
      for (let i = 0; i < sweeps; i++) {
        relaxStep(net, places, {
          radius: this.radius,
          rate: 0.18,
          turnRate: 0.16,
          bounds: this.relaxBounds(),
        });
      }
      return;
    }

    const turn = Math.min(1, dt * 5);
    for (const [id, v] of this.views) {
      const want = restAngle(net, id, places);
      if (want !== null) v.angle = turnToward(v.angle, want, turn);
    }
    for (const [id, v] of this.freeViews) {
      const want = restAngleFree(net, id, places);
      if (want !== null) v.angle = turnToward(v.angle, want, turn);
    }
  }

  private setTarget(id: AgentId, symbol: Sym, arity: number, p: Point, snap: boolean): void {
    const anchor = { x: p.x, y: p.y };
    const view = this.views.get(id);
    if (!view) {
      this.views.set(id, {
        x: p.x,
        y: p.y,
        angle: 0,
        anchor,
        tx: p.x,
        ty: p.y,
        easing: false,
        spawn: 1,
        symbol,
        arity,
      });
      return;
    }
    view.tx = p.x;
    view.ty = p.y;
    view.anchor = anchor;
    view.easing = !snap;
    if (snap) {
      view.x = p.x;
      view.y = p.y;
    }
  }

  /** Forget all positions — the next relayout will snap. */
  clear(): void {
    this.camera = { scale: 1, x: this.width / 2, y: this.height / 2 };
    this.views.clear();
    this.freeViews.clear();
    this.particles = [];
    this.anims = [];
    this.selected = null;
    this.highlightFree.clear();
    this.highlightHot.clear();
  }

  // --- Positions ------------------------------------------------------------------

  /** Where an agent is drawn right now. */
  positionOf(id: AgentId): Point | null {
    const v = this.views.get(id);
    return v ? { x: v.x, y: v.y } : null;
  }

  /** The point on the canvas where a wire attaches to an endpoint. */
  pointFor(e: Endpoint): Point | null {
    if (isFree(e)) return this.freeViews.get(e.free) ?? null;
    const v = this.views.get(e.agent);
    if (!v) return null;
    return attachPoint(v, v.arity, e.port, this.radius * this.spawnScale(v));
  }

  private spawnScale(v: AgentView): number {
    if (v.spawn <= 0) return 0; // still waiting for its cue
    return v.spawn >= 1 ? 1 : easeOutBack(clamp01(v.spawn));
  }

  /** Drop an agent's view — used when the user deletes one. */
  forget(id: AgentId): void {
    this.views.delete(id);
  }

  // --- Hit testing -----------------------------------------------------------------

  agentAt(screenX: number, screenY: number): AgentId | null {
    const { x, y } = this.toWorld(screenX, screenY);
    let best: AgentId | null = null;
    let bestD = this.radius * this.radius;
    for (const [id, v] of this.views) {
      const d = (v.x - x) ** 2 + (v.y - y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  /** The FREE port under the pointer — the only thing a card can be played on. */
  freePortAt(net: Net, screenX: number, screenY: number, slop = 20): number | null {
    const { x, y } = this.toWorld(screenX, screenY);
    const reach = slop / this.camera.scale;
    let best: number | null = null;
    let bestD = reach * reach;
    for (const f of net.freePorts()) {
      const p = this.freeViews.get(f);
      if (!p) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }

  /** The port or free port under the pointer, within `slop` pixels. */
  endpointAt(net: Net, screenX: number, screenY: number, slop = 14): Endpoint | null {
    const { x, y } = this.toWorld(screenX, screenY);
    // `slop` is a screen distance, so it covers more world as we zoom out — but
    // it must also stay well under the agent radius. A port sits one radius from
    // the centre, so a fixed 14px reach on a small agent swallows the whole body
    // and makes it impossible to grab and drag.
    const reach = Math.min(slop / this.camera.scale, Math.max(6 / this.camera.scale, this.radius * 0.55));
    let best: Endpoint | null = null;
    let bestD = reach * reach;
    const test = (e: Endpoint): void => {
      const p = this.pointFor(e);
      if (!p) return;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = e;
      }
    };
    for (const agent of net.agents()) for (const p of portsOf(agent)) test(p);
    for (const f of net.freePorts()) test({ free: f });
    return best;
  }

  // --- Rewrite animation ------------------------------------------------------------

  /**
   * Start the animation for a rewrite that has ALREADY been applied to the net.
   * `before` is the snapshot taken just before it, `newAgents` the ids the
   * rewrite created.
   */
  beginRewrite(net: Net, before: RedexSnapshot, newAgents: AgentId[]): void {
    const { a, b, at, bt } = before;
    const mid = { x: (at.x + bt.x) / 2, y: (at.y + bt.y) / 2 };
    const kind: RewriteKind =
      a.symbol === b.symbol ? "annihilate" : a.symbol === "ε" || b.symbol === "ε" ? "erase" : "commute";

    // Keep the rotations the pair had: the ghosts animate with them, and the
    // copies inherit them so nothing snaps round at the moment of the rewrite.
    const aAngle = this.views.get(a.id)?.angle ?? 0;
    const bAngle = this.views.get(b.id)?.angle ?? 0;
    this.views.delete(a.id);
    this.views.delete(b.id);

    const ghosts: Ghost[] = [];
    const born: Born[] = [];

    if (kind === "annihilate") {
      ghosts.push(this.ghost(a.symbol, a.arity, at, mid, 1, aAngle));
      ghosts.push(this.ghost(b.symbol, b.arity, bt, mid, 1, bAngle));
    } else if (kind === "erase") {
      // The eraser slides onto its partner and swallows it.
      const eraserFirst = a.symbol === "ε";
      const ep = eraserFirst ? at : bt;
      const op = eraserFirst ? bt : at;
      const eraser = eraserFirst ? a : b;
      const eaten = eraserFirst ? b : a;
      ghosts.push(this.ghost(eraser.symbol, eraser.arity, ep, op, 0.55, eraserFirst ? aAngle : bAngle));
      ghosts.push(
        this.ghost(eaten.symbol, eaten.arity, op, op, 0.55, eraserFirst ? bAngle : aAngle),
      );
      for (const id of newAgents)
        born.push({ id, fromX: op.x, fromY: op.y, delay: 0.5, spreadX: 0, spreadY: 0 });
    } else {
      // Commutation: the two agents pass through each other. Copies of α are
      // born where β was and vice versa, so the pair visibly swaps sides while
      // duplicating.
      ghosts.push(this.ghost(a.symbol, a.arity, at, bt, 0.62, aAngle));
      ghosts.push(this.ghost(b.symbol, b.arity, bt, at, 0.62, bAngle));
      for (const id of newAgents) {
        const sym = net.agent(id)?.symbol;
        const from = sym === a.symbol ? bt : at;
        born.push({ id, fromX: from.x, fromY: from.y, delay: 0.3, spreadX: 0, spreadY: 0 });
      }
    }

    this.fanOut(net, born, at, bt);

    // Give every newly created agent a view: born at its origin, easing toward
    // whatever its principal port now points at.
    for (const b0 of born) {
      const agent = net.agent(b0.id);
      if (!agent) continue;
      const target = this.birthTarget(net, b0, agent);
      target.x += b0.spreadX;
      target.y += b0.spreadY;
      this.views.set(b0.id, {
        x: b0.fromX,
        y: b0.fromY,
        // Inherit the rotation of whichever original this is a copy of.
        angle: agent.symbol === a.symbol ? aAngle : bAngle,
        // No tidy-layout anchor: a copy is free to settle wherever it fits.
        anchor: null,
        tx: target.x,
        ty: target.y,
        easing: true,
        // A negative spawn is a delay: the copy stays invisible at its birth
        // point until the ghosts have passed through / been swallowed.
        spawn: -b0.delay,
        symbol: agent.symbol,
        arity: agent.arity,
      });
    }

    this.anims.push({
      kind,
      t: 0,
      dur: kind === "annihilate" ? 0.38 : 0.46,
      ghosts,
      born,
      flashX: mid.x,
      flashY: mid.y,
      flashed: false,
    });
  }

  /**
   * Copies of the same agent are all wired into roughly the same region, so
   * left to the connectivity rule alone they land on top of each other. Fan each
   * family out along the perpendicular of the axis the pair sat on.
   */
  private fanOut(net: Net, born: Born[], at: Point, bt: Point): void {
    let ux = bt.x - at.x;
    let uy = bt.y - at.y;
    const len = Math.hypot(ux, uy);
    if (len < 1) {
      ux = 1;
      uy = 0;
    } else {
      ux /= len;
      uy /= len;
    }
    const perp = { x: -uy, y: ux };
    const families = new Map<Sym, Born[]>();
    for (const b of born) {
      const symbol = net.agent(b.id)?.symbol;
      if (!symbol) continue;
      const family = families.get(symbol) ?? [];
      family.push(b);
      families.set(symbol, family);
    }
    for (const family of families.values()) {
      if (family.length < 2) continue;
      const gap = this.radius * 2.4;
      family.forEach((b, i) => {
        const offset = (i - (family.length - 1) / 2) * gap;
        b.spreadX = perp.x * offset;
        b.spreadY = perp.y * offset;
      });
    }
  }

  private ghost(
    symbol: Sym,
    arity: number,
    from: Point,
    to: Point,
    until: number,
    angle: number,
  ): Ghost {
    return {
      symbol,
      arity,
      angle,
      x: from.x,
      y: from.y,
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      until,
    };
  }

  /**
   * Where a freshly created agent should settle: a short step from its birth
   * point toward whatever its principal port is now wired to. Purely local — it
   * never looks at the rest of the net, which is what keeps the picture stable.
   */
  private birthTarget(net: Net, born: Born, agent: Agent): Point {
    const spread = this.radius * 2.6;
    const partner = net.follow(principal(agent.id));
    const target = partner ? this.pointFor(partner) : null;
    if (!target) {
      // Connected to another newborn: fan out sideways instead.
      const i = born.id % 2 === 0 ? -1 : 1;
      return { x: born.fromX + i * spread, y: born.fromY - spread * 0.35 };
    }
    const dx = target.x - born.fromX;
    const dy = target.y - born.fromY;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return { x: born.fromX, y: born.fromY - spread };
    const step = Math.min(dist * 0.55, spread);
    return { x: born.fromX + (dx / dist) * step, y: born.fromY + (dy / dist) * step };
  }

  // --- Drawing ------------------------------------------------------------------------

  draw(net: Net, dt: number, opts: { activePairs?: Array<[AgentId, AgentId]> } = {}): void {
    this.time += dt;
    this.background(); // screen space: the starfield does not zoom
    this.advance(net, dt);
    this.updateCamera(dt);

    const active = new Set<AgentId>();
    for (const [x, y] of opts.activePairs ?? []) {
      active.add(x);
      active.add(y);
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(this.camera.scale, this.camera.scale);
    ctx.translate(-this.camera.x, -this.camera.y);

    this.drawWires(net, active);
    this.drawFreePorts(net);
    this.drawGhosts(net);
    this.drawAgents(net, active);
    this.drawParticles(dt);
    this.drawSelection();

    ctx.restore();
  }

  /**
   * Line width that survives zooming out. A hairline that scales all the way
   * down disappears; one that does not scale at all turns a zoomed-out net into
   * a mat of thick strokes. Keep the on-screen width between 40% and 100% of
   * the nominal value.
   */
  private stroke(base: number): number {
    const s = this.camera.scale;
    return Math.min(base, Math.max(base * 0.4, base * s)) / s;
  }

  private advance(net: Net, dt: number): void {
    for (const v of this.views.values()) {
      const waiting = v.spawn <= 0;
      v.spawn = Math.min(1, v.spawn + dt / 0.3);
      if (waiting) continue; // hold position until it appears
      if (v.easing) {
        v.x = smooth(v.x, v.tx, 0.22, dt);
        v.y = smooth(v.y, v.ty, 0.22, dt);
        // Once it has essentially arrived, hand it over to the relaxer.
        if (Math.abs(v.x - v.tx) < 0.6 && Math.abs(v.y - v.ty) < 0.6) v.easing = false;
      }
    }
    this.settleFrame(net, dt);
    for (const anim of this.anims) {
      anim.t = Math.min(1, anim.t + dt / anim.dur);
      for (const g of anim.ghosts) {
        const p = easeInOutCubic(clamp01(anim.t / Math.max(0.001, g.until)));
        g.x = lerp(g.fromX, g.toX, p);
        g.y = lerp(g.fromY, g.toY, p);
      }
      if (!anim.flashed && anim.t >= (anim.kind === "annihilate" ? 0.62 : 0.45)) {
        anim.flashed = true;
        this.burst(anim.flashX, anim.flashY, anim.kind);
      }
    }
    this.anims = this.anims.filter((a) => a.t < 1);
  }

  private background(): void {
    const g = this.ctx.createLinearGradient(0, 0, 0, this.height);
    g.addColorStop(0, THEME.bgTop);
    g.addColorStop(1, THEME.bgBottom);
    this.ctx.fillStyle = g;
    this.ctx.fillRect(0, 0, this.width, this.height);
    let s = 1337;
    const rnd = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    for (let i = 0; i < 60; i++) {
      const x = rnd() * this.width;
      const y = rnd() * this.height;
      const r = rnd() * 1.2 + 0.3;
      this.ctx.fillStyle = `rgba(200,215,255,${rnd() * 0.32 + 0.08})`;
      this.ctx.beginPath();
      this.ctx.arc(x, y, r, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }

  private drawWires(net: Net, active: Set<AgentId>): void {
    const ctx = this.ctx;
    ctx.lineCap = "round";
    for (const [a, b] of net.wires()) {
      const pa = this.pointFor(a);
      const pb = this.pointFor(b);
      if (!pa || !pb) continue;
      const isRedex =
        !isFree(a) && !isFree(b) && a.port === 0 && b.port === 0 && active.has(a.agent);
      const da = this.tangent(a);
      const db = this.tangent(b);
      const dist = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      // Now that ports turn to face their partners, most wires want to be
      // nearly straight. Scale each Bezier handle by how far its port is from
      // already pointing at the other end: aligned ports get a short handle (a
      // straight line), a port facing sideways gets a long one so the wire still
      // leaves the shape cleanly instead of kinking.
      const ux = (pb.x - pa.x) / (dist || 1);
      const uy = (pb.y - pa.y) / (dist || 1);
      const alignA = Math.max(0, da.x * ux + da.y * uy);
      const alignB = Math.max(0, -(db.x * ux + db.y * uy));
      const handle = (align: number): number =>
        Math.min(60, Math.max(4, dist * (0.08 + 0.34 * (1 - align))));
      const ka = handle(alignA);
      const kb = handle(alignB);

      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      if (Math.abs(pa.x - pb.x) < 0.5 && Math.abs(pa.y - pb.y) < 0.5) {
        // A wire that closes on itself: draw a small circle so it is visible.
        ctx.arc(pa.x, pa.y - 9, 9, 0, Math.PI * 2);
      } else {
        ctx.bezierCurveTo(
          pa.x + da.x * ka,
          pa.y + da.y * ka,
          pb.x + db.x * kb,
          pb.y + db.y * kb,
          pb.x,
          pb.y,
        );
      }
      if (isRedex) {
        const pulse = 0.6 + 0.4 * Math.sin(this.time * 6);
        ctx.strokeStyle = THEME.wireActive;
        ctx.globalAlpha = pulse;
        ctx.lineWidth = this.stroke(3.4);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = THEME.wire;
        ctx.lineWidth = this.stroke(2);
        ctx.stroke();
      }
    }
  }

  /** The direction a wire leaves an endpoint, used as the Bezier tangent. */
  private tangent(e: Endpoint): Point {
    if (isFree(e)) {
      const f = this.freeViews.get(e.free);
      return f ? portDirection(0, 0, f.angle) : { x: 0, y: 0 };
    }
    const v = this.views.get(e.agent);
    if (!v) return { x: 0, y: 0 };
    return portDirection(v.arity, e.port, v.angle);
  }

  /**
   * Free ports read as small HOLLOW versions of the single-port agent shape,
   * turned to face along their own wire. Same visual grammar as an ε — a point
   * marks where the wire attaches — but unfilled, so the interface of the net
   * stays obviously distinct from its agents.
   */
  private drawFreePorts(net: Net): void {
    const ctx = this.ctx;
    const r = Math.max(4.5, Math.min(8, this.radius * 0.3));
    for (const f of net.freePorts()) {
      const p = this.freeViews.get(f);
      if (!p) continue;
      const target = this.highlightFree.has(f);
      const hot = target && this.highlightHot.has(f);
      ctx.save();
      if (target) {
        // A pulse, so a playable wire reads as playable at a glance.
        const pulse = 0.55 + 0.45 * Math.sin(this.time * 5);
        ctx.shadowColor = hot ? THEME.wireActive : THEME.select;
        ctx.shadowBlur = (hot ? 24 : 14) * pulse;
      }
      this.shapePath(p.x, p.y, target ? r * (hot ? 1.5 : 1.3) : r, 0, p.angle);
      ctx.fillStyle = hot
        ? "rgba(124,242,155,0.35)"
        : target
          ? "rgba(255,226,122,0.22)"
          : THEME.freeFill;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = hot ? THEME.wireActive : target ? THEME.select : THEME.free;
      ctx.lineWidth = this.stroke(target ? 2.2 : 1.6);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawAgents(net: Net, active: Set<AgentId>): void {
    for (const agent of net.agents()) {
      const v = this.views.get(agent.id);
      if (!v) continue;
      const scale = this.spawnScale(v);
      this.bubble(
        v.x,
        v.y,
        this.radius * scale,
        agent.symbol,
        active.has(agent.id) ? 1 : 0,
        1,
        v.angle,
        agent.arity,
        styleFor(net.alphabet, agent.symbol),
      );
    }
  }

  private drawGhosts(net: Net): void {
    for (const anim of this.anims) {
      for (const g of anim.ghosts) {
        if (anim.t > g.until) continue;
        // Shrink away over the last stretch of the ghost's life.
        const local = clamp01(anim.t / Math.max(0.001, g.until));
        const shrink = 1 - clamp01((local - 0.7) / 0.3);
        this.bubble(
          g.x,
          g.y,
          this.radius * shrink,
          g.symbol,
          0,
          shrink,
          g.angle,
          g.arity,
          styleFor(net.alphabet, g.symbol),
        );
      }
    }
  }

  /**
   * Trace an agent's outline. The shape is a rounded, outward-bowed polygon
   * whose CORNERS ARE ITS PORTS: a γ or δ is a curved triangle with one corner
   * pointing up (the principal port) and two pointing down (the aux ports), so
   * the silhouette alone tells you which wire is which. An ε has a single port,
   * which has no polygon, so it is drawn as a disc pulled to a point at its
   * principal port instead.
   */
  private agentPath(x: number, y: number, r: number, arity: number, angle: number): void {
    this.shapePath(x, y, r, arity, angle);
  }

  private shapePath(x: number, y: number, r: number, arity: number, angle: number): void {
    const ctx = this.ctx;
    const dirs: Point[] = [];
    for (let port = 0; port <= arity; port++) dirs.push(portDirection(arity, port, angle));
    // Order them around the centre so the outline is a simple polygon.
    dirs.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));

    if (dirs.length < 3) {
      const apex = Math.atan2(dirs[0].y, dirs[0].x);
      const gap = 0.5; // half-width of the arc's opening, in radians
      const body = r * 0.78;
      const at = (angle: number, dist: number): Point => ({
        x: x + Math.cos(angle) * dist,
        y: y + Math.sin(angle) * dist,
      });
      const start = at(apex + gap, body);
      const tip = at(apex, r * 1.02);
      ctx.beginPath();
      ctx.arc(x, y, body, apex + gap, apex - gap);
      ctx.quadraticCurveTo(at(apex - gap * 0.45, r * 0.98).x, at(apex - gap * 0.45, r * 0.98).y, tip.x, tip.y);
      ctx.quadraticCurveTo(at(apex + gap * 0.45, r * 0.98).x, at(apex + gap * 0.45, r * 0.98).y, start.x, start.y);
      ctx.closePath();
      return;
    }

    const corners = dirs.map((d) => ({ x: x + d.x * r, y: y + d.y * r }));
    const round = r * 0.2; // how far back from each corner the rounding starts
    const starts: Point[] = [];
    const ends: Point[] = [];
    const controls: Point[] = [];
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % corners.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const back = Math.min(round, len * 0.3);
      // Bow the edge outward, but scaled to its length: the short bottom edge
      // would otherwise bulge enough to swallow the two aux corners.
      const bow = Math.min(r * 0.13, len * 0.085);
      const s = { x: a.x + ux * back, y: a.y + uy * back };
      const e = { x: b.x - ux * back, y: b.y - uy * back };
      const mx = (s.x + e.x) / 2;
      const my = (s.y + e.y) / 2;
      const nl = Math.hypot(mx - x, my - y) || 1;
      starts.push(s);
      ends.push(e);
      // A quadratic passes half-way to its control point, so bow twice as far.
      controls.push({ x: mx + ((mx - x) / nl) * bow * 2, y: my + ((my - y) / nl) * bow * 2 });
    }

    ctx.beginPath();
    ctx.moveTo(starts[0].x, starts[0].y);
    for (let i = 0; i < corners.length; i++) {
      ctx.quadraticCurveTo(controls[i].x, controls[i].y, ends[i].x, ends[i].y);
      const next = (i + 1) % corners.length;
      // Round the corner itself, with the port position as the control point so
      // the silhouette still points straight at the port.
      ctx.quadraticCurveTo(corners[next].x, corners[next].y, starts[next].x, starts[next].y);
    }
    ctx.closePath();
  }

  private bubble(
    x: number,
    y: number,
    r: number,
    symbol: Sym,
    glow: number,
    alpha: number,
    angle: number,
    arity: number,
    style: { a: string; b: string; glow: string },
  ): void {
    if (r <= 0.5 || alpha <= 0.01) return;
    const ctx = this.ctx;
    // A triangle's mass sits below its circumcentre, so nudge the fill highlight
    // and the glyph down to look centred.
    const inset = arity >= 2 ? r * 0.16 : r * 0.04;
    // The bias follows the rotation, so the glyph stays in the fat part of the
    // shape however the agent is turned.
    const bias = { x: -Math.sin(angle) * 0 + Math.cos(angle + Math.PI / 2) * inset, y: Math.sin(angle + Math.PI / 2) * inset };
    ctx.save();
    ctx.globalAlpha = alpha;
    if (glow > 0) {
      ctx.shadowColor = style.glow;
      ctx.shadowBlur = 18 * glow;
    }
    const g = ctx.createRadialGradient(
      x + bias.x - r * 0.3,
      y + bias.y - r * 0.25,
      r * 0.1,
      x + bias.x,
      y + bias.y,
      r,
    );
    g.addColorStop(0, style.a);
    g.addColorStop(1, style.b);
    ctx.fillStyle = g;
    this.agentPath(x, y, r, arity, angle);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = this.stroke(1.2);
    ctx.stroke();

    // Gloss highlight, clipped to the outline so it can't spill past a corner.
    ctx.save();
    this.agentPath(x, y, r, arity, angle);
    ctx.clip();
    ctx.beginPath();
    ctx.ellipse(x + bias.x - r * 0.22, y + bias.y - r * 0.12, r * 0.36, r * 0.2, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = "rgba(8,12,30,0.85)";
    ctx.font = `700 ${Math.max(8, r * (arity >= 2 ? 0.9 : 1.05))}px "Baloo 2", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(symbol, x + bias.x, y + bias.y + r * 0.04);
    ctx.restore();
  }

  private drawSelection(): void {
    if (!this.selected) return;
    const p = this.pointFor(this.selected);
    if (!p) return;
    const ctx = this.ctx;
    ctx.strokeStyle = THEME.select;
    ctx.lineWidth = this.stroke(2);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8 + Math.sin(this.time * 8) * 1.6, 0, Math.PI * 2);
    ctx.stroke();
  }

  // --- Particles ----------------------------------------------------------------------

  private burst(x: number, y: number, kind: RewriteKind): void {
    const colors =
      kind === "annihilate"
        ? ["#eaf0ff", "#9fc0ff"]
        : kind === "erase"
          ? ["#ff9be0", "#d24fb8"]
          : ["#FFC46B", "#7CF29B"];
    const n = kind === "commute" ? 16 : 12;
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const speed = 40 + Math.random() * 90;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.45 + Math.random() * 0.3,
        maxLife: 0.75,
        r: 1.5 + Math.random() * 2,
        color: colors[i % colors.length],
      });
    }
  }

  private drawParticles(dt: number): void {
    const ctx = this.ctx;
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.94;
      p.vy *= 0.94;
      if (p.life <= 0) continue;
      ctx.globalAlpha = clamp01(p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  /** Place a newly created agent under the pointer (sandbox authoring). */
  placeAt(agent: Agent, screenX: number, screenY: number): void {
    const { x, y } = this.toWorld(screenX, screenY);
    this.views.set(agent.id, {
      x,
      y,
      angle: 0,
      anchor: null,
      tx: x,
      ty: y,
      easing: false,
      spawn: 0,
      symbol: agent.symbol,
      arity: agent.arity,
    });
  }

  /** Give every free port without a position one, fanned around its partner. */
  placeLooseFreePorts(net: Net): void {
    for (const f of net.freePorts()) {
      if (this.freeViews.has(f)) continue;
      const partner = net.follow({ free: f });
      if (!partner || isFree(partner)) {
        this.freeViews.set(f, { x: this.camera.x, y: this.camera.y, angle: 0 });
        continue;
      }
      const v = this.views.get(partner.agent);
      if (!v) {
        this.freeViews.set(f, { x: this.camera.x, y: this.camera.y, angle: 0 });
        continue;
      }
      const d = portDirection(v.arity, partner.port, v.angle);
      this.freeViews.set(f, {
        x: v.x + d.x * this.radius * 2.4,
        y: v.y + d.y * this.radius * 2.4,
        angle: 0,
      });
    }
    // Drop positions for free ports that no longer exist.
    const live = new Set(net.freePorts());
    for (const f of [...this.freeViews.keys()]) if (!live.has(f)) this.freeViews.delete(f);
    this.aimFreePorts(net);
  }

  /** Snap every free port to face along its wire (after a placement change). */
  private aimFreePorts(net: Net): void {
    const places = this.placements();
    for (const [id, place] of this.freeViews) {
      const want = restAngleFree(net, id, places);
      if (want !== null) place.angle = want;
    }
  }

  /** Move a free port (dragging the loose end of a wire). */
  moveFreePort(id: number, screenX: number, screenY: number): void {
    const was = this.freeViews.get(id);
    const { x, y } = this.toWorld(screenX, screenY);
    this.freeViews.set(id, { x, y, angle: was?.angle ?? 0, pinned: true });
  }

  /** Move an agent (dragging it). Held agents are excluded from relaxation. */
  moveAgent(id: AgentId, screenX: number, screenY: number): void {
    const v = this.views.get(id);
    if (!v) return;
    const { x, y } = this.toWorld(screenX, screenY);
    v.x = x;
    v.y = y;
    v.tx = x;
    v.ty = y;
    v.easing = false;
    v.held = true;
    // Dragging a node re-homes it: it should stay where it was put rather than
    // being dragged back by the anchor to where the tidy layout wanted it.
    v.anchor = { x, y };
  }

  /** Release everything the user was dragging. */
  releaseAll(): void {
    for (const v of this.views.values()) v.held = false;
    for (const v of this.freeViews.values()) v.pinned = false;
  }

  /** Snapshot a redex's positions before it is rewritten. */
  snapshot(net: Net, pair: [AgentId, AgentId]): RedexSnapshot | null {
    const a = net.agent(pair[0]);
    const b = net.agent(pair[1]);
    const at = this.positionOf(pair[0]);
    const bt = this.positionOf(pair[1]);
    if (!a || !b || !at || !bt) return null;
    return { a, b, at, bt };
  }
}

/** Re-exported so the sandbox can share the palette with its HTML chrome. */
export const SANDBOX_THEME = { ...THEME };

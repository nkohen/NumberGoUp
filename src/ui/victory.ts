/**
 * The "You Win!" celebration: sprays one glossy bubble per deck card from the
 * deck, then lets them bounce around the whole screen under gravity. Pure
 * presentation — self-contained physics + drawing, driven by the App while the
 * `won` screen is shown.
 */
import { Card, cardLabel } from "../core/cards";
import { Renderer } from "../render/renderer";

interface VBubble {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  glyph: string;
  a: string;
  b: string;
  glow: string;
}

// Zero gravity + perfectly elastic wall bounces: energy is conserved, so the
// bubbles drift and ricochet around the screen forever instead of settling.

export class VictoryBubbles {
  private bubbles: VBubble[] = [];
  private queue: Card[];
  private sinceSpawn = 0;
  private readonly spawnEvery = 0.035; // stagger the spray for a "fountain" feel
  elapsed = 0;

  /**
   * @param deck  cards to launch (one bubble each; a big late deck = a big spray)
   * @param ox/oy the spray origin (the deck lives bottom-centre during play)
   */
  constructor(
    deck: readonly Card[],
    private readonly ox: number,
    private readonly oy: number,
  ) {
    // Cap for safety: launch up to 120 bubbles.
    this.queue = deck.slice(0, 120);
  }

  /** How many bubbles are live (0 briefly at the very start). */
  get count(): number {
    return this.bubbles.length;
  }

  private spawnOne(): void {
    const card = this.queue.shift();
    if (!card) return;
    const style = Renderer.bubbleStyle(card);
    // Spray out in every direction from the deck; with no gravity they keep this
    // speed forever, ricocheting off the walls.
    const angle = Math.random() * Math.PI * 2;
    const speed = 220 + Math.random() * 340;
    this.bubbles.push({
      x: this.ox + (Math.random() - 0.5) * 40,
      y: this.oy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      r: 16 + Math.random() * 14,
      glyph: cardLabel(card),
      a: style.a,
      b: style.b,
      glow: style.glow,
    });
  }

  update(dt: number, width: number, height: number, topInset = 0): void {
    // Clamp dt so a background-tab hiccup doesn't fling bubbles off-screen.
    const step = Math.min(dt, 1 / 30);
    this.elapsed += dt;
    this.sinceSpawn += dt;
    while (this.queue.length && this.sinceSpawn >= this.spawnEvery) {
      this.sinceSpawn -= this.spawnEvery;
      this.spawnOne();
    }
    for (const b of this.bubbles) {
      b.x += b.vx * step;
      b.y += b.vy * step;
      // Perfectly elastic wall bounces (top inset keeps them below the HUD).
      // No gravity or damping, so speed is preserved and they never settle.
      if (b.x < b.r) {
        b.x = b.r;
        b.vx = Math.abs(b.vx);
      } else if (b.x > width - b.r) {
        b.x = width - b.r;
        b.vx = -Math.abs(b.vx);
      }
      if (b.y < topInset + b.r) {
        b.y = topInset + b.r;
        b.vy = Math.abs(b.vy);
      } else if (b.y > height - b.r) {
        b.y = height - b.r;
        b.vy = -Math.abs(b.vy);
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const b of this.bubbles) {
      ctx.save();
      ctx.shadowColor = b.glow;
      ctx.shadowBlur = 16;
      const grad = ctx.createRadialGradient(
        b.x - b.r * 0.3,
        b.y - b.r * 0.35,
        b.r * 0.2,
        b.x,
        b.y,
        b.r,
      );
      grad.addColorStop(0, b.a);
      grad.addColorStop(1, b.b);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      // Glossy highlight.
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.arc(b.x - b.r * 0.32, b.y - b.r * 0.36, b.r * 0.28, 0, Math.PI * 2);
      ctx.fill();
      // Glyph.
      ctx.fillStyle = "#0b1026";
      ctx.font = `800 ${Math.round(b.r * 0.9)}px "Baloo 2", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(b.glyph, b.x, b.y + 1);
      ctx.restore();
    }
  }
}

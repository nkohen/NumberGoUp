/**
 * Entry point. Sets up the full-window canvas and boots the App controller.
 */
import "./style.css";
import { App } from "./ui/app";

const canvas = document.getElementById("game") as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error("Canvas #game not found");
}

// The App handles resize, input, the game loop, and all rendering.
// In dev, allow tuning/repro via URL params: ?seed=123&baseTarget=1&growth=1.7&hand=5
let opts: ConstructorParameters<typeof App>[1] = {};
if (import.meta.env.DEV) {
  const q = new URLSearchParams(location.search);
  const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
  const config: Record<string, number> = {};
  if (num("baseTarget") !== undefined) config.baseTarget = num("baseTarget")!;
  if (num("growth") !== undefined) config.targetGrowth = num("growth")!;
  if (num("hand") !== undefined) config.handSize = num("hand")!;
  opts = { config, seed: num("seed") };
}

const app = new App(canvas, opts);

// Dev-only debug hook (stripped in production by the `import.meta.env` guard).
if (import.meta.env.DEV) {
  (window as unknown as { __app: App }).__app = app;
}

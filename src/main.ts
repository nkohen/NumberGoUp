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
const app = new App(canvas);

// Dev-only debug hook (stripped in production by the `import.meta.env` guard).
if (import.meta.env.DEV) {
  (window as unknown as { __app: App }).__app = app;
}

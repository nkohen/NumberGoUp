/**
 * Battery / render-cost benchmark for Number Go Up.
 *
 * The dominant battery cost of a canvas game on a phone is how often it paints.
 * A loop that redraws the whole canvas at 60fps even when nothing is happening
 * keeps the GPU/CPU busy continuously and drains the battery. This script
 * measures *actual paints* (not just rAF ticks) across representative states:
 *
 *   - idle-title    : title screen, no input        → should be ~0 fps ideally
 *   - idle-playing  : mid-run, waiting on the player → should be ~0 fps ideally
 *   - active        : during an evaluate animation   → should run at ~60 fps
 *
 * It also samples main-thread scripting/task time via the CDP performance
 * metrics so we can see CPU cost, not just paint count.
 *
 * How the paint counter works: every rendered frame begins with a full-canvas
 * background `fillRect`. We wrap `CanvasRenderingContext2D.prototype.fillRect`
 * via an init script (installed before the app boots) and count calls whose
 * rectangle covers the whole canvas. That gives a source-independent frame
 * count, so numbers are directly comparable before and after optimization.
 *
 * Usage:  node scripts/benchmark.mjs
 *         node scripts/benchmark.mjs --json   # machine-readable output
 */
import { chromium, devices } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8814;
const BASE = `http://localhost:${PORT}`;
const VITE = path.join(ROOT, "node_modules/.bin/vite");
const JSON_OUT = process.argv.includes("--json");
const SAMPLE_MS = 3000; // how long to observe each state

// Installed in the page *before* any app code runs. Counts full-canvas paints.
function installPaintCounter() {
  const proto = CanvasRenderingContext2D.prototype;
  const orig = proto.fillRect;
  window.__paints = 0;
  proto.fillRect = function (x, y, w, h) {
    // A background paint covers the whole backing store. fillRect args are in
    // user space (CSS px); the canvas is scaled by devicePixelRatio via the
    // current transform, so multiply by the transform scale before comparing.
    const t = this.getTransform();
    if (
      x === 0 &&
      y === 0 &&
      Math.abs(w * t.a - this.canvas.width) < 2 &&
      Math.abs(h * t.d - this.canvas.height) < 2
    ) {
      window.__paints++;
    }
    return orig.call(this, x, y, w, h);
  };
}

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`Vite dev server never came up on ${BASE}`);
}

/** Observe paints and CPU over SAMPLE_MS while the page sits in a given state. */
async function measure(page, client) {
  await page.evaluate(() => (window.__paints = 0));
  const before = await cpuTime(client);
  const t0 = Date.now();
  await sleep(SAMPLE_MS);
  const elapsed = (Date.now() - t0) / 1000;
  const paints = await page.evaluate(() => window.__paints);
  const after = await cpuTime(client);
  return {
    fps: +(paints / elapsed).toFixed(1),
    paints,
    scriptMs: +((after.script - before.script) * 1000).toFixed(0),
    taskMs: +((after.task - before.task) * 1000).toFixed(0),
    seconds: +elapsed.toFixed(2),
  };
}

async function cpuTime(client) {
  const { metrics } = await client.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { script: m.ScriptDuration || 0, task: m.TaskDuration || 0 };
}

const server = spawn(VITE, ["--port", String(PORT), "--strictPort"], {
  cwd: ROOT,
  stdio: "ignore",
});

let browser;
const results = {};
try {
  await waitForServer();
  browser = await chromium.launch();
  const context = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await context.newPage();
  await page.addInitScript(installPaintCounter);
  const client = await context.newCDPSession(page);
  await client.send("Performance.enable");

  await page.goto(`${BASE}/?seed=3`, { waitUntil: "networkidle" });
  await sleep(600);

  // 1) idle on the title screen
  results["idle-title"] = await measure(page, client);

  // 2) start a run, then sit idle waiting for player input
  await page.keyboard.press("Enter");
  await sleep(600);
  results["idle-playing"] = await measure(page, client);

  // 3) active: a genuinely continuous app animation (the victory celebration,
  //    whose bubbles animate every frame). Confirms the loop still paints at
  //    full refresh rate when something is actually moving.
  await page.evaluate(() => {
    const app = window.__app;
    // `private` in TS is compile-time only, so these are reachable at runtime.
    app.startVictory?.();
    app.screen = "won";
    app.invalidate?.();
  });
  results["active"] = await measure(page, client);

  if (JSON_OUT) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`\nNumber Go Up — battery/render benchmark  (${SAMPLE_MS}ms/state, iPhone 13 viewport)\n`);
    const rows = Object.entries(results).map(([state, r]) => ({
      state,
      fps: r.fps,
      paints: r.paints,
      "script(ms)": r.scriptMs,
      "task(ms)": r.taskMs,
    }));
    console.table(rows);
    console.log(
      "Lower fps/paints/CPU in the idle states = less battery drain.\n" +
        "Ideal: idle-* near 0 fps, active near display refresh rate.\n",
    );
  }
} catch (err) {
  console.error("✗", err.message);
  if (String(err.message).includes("Executable doesn't exist")) {
    console.error("  Run the one-time browser install:  npx playwright install chromium");
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
}

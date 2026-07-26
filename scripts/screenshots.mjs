/**
 * Visual regression aid: capture every game screen at both a mobile and a
 * desktop viewport, so layout changes can be eyeballed before publishing.
 *
 * Usage:
 *   npm run screenshots            # writes PNGs to ./screenshots/
 *
 * One-time setup (installs the headless browser Playwright drives):
 *   npx playwright install chromium
 *
 * Output: screenshots/<viewport>-<screen>.png for viewport ∈ {mobile, desktop}
 * and screen ∈ {title, playing, shop, gameover}. The directory is gitignored.
 *
 * How it works: this spawns the Vite *dev* server (not the production build)
 * because dev exposes `window.__app`, which lets us jump straight to the shop
 * and game-over overlays without hand-playing a full round. The forced-win path
 * makes those panels show "scored 0" etc. — that's a capture artifact, not a
 * bug; only the *layout* is meaningful in those two shots. Any `reach` that
 * pokes app state directly must also call `app.invalidate()`: the game renders
 * on demand, so without it the canvas keeps showing the previous frame.
 *
 * See docs/visual-testing.md for what to check on each screen.
 */
import { chromium, devices } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "screenshots");
const PORT = 8813;
const BASE = `http://localhost:${PORT}`;
const VITE = path.join(ROOT, "node_modules/.bin/vite");

const VIEWPORTS = [
  { name: "mobile", context: { ...devices["iPhone 13"] } },
  { name: "desktop", context: { viewport: { width: 1280, height: 800 } } },
];

// Each screen knows how to reach itself from a fresh page load. `shop` and
// `gameover` are forced via the dev-only `window.__app` hook.
const SCREENS = [
  { name: "title", reach: async () => {} },
  {
    name: "playing",
    reach: async (page) => {
      await page.keyboard.press("Enter"); // start a run from the title
      await sleep(500);
    },
  },
  {
    name: "shop",
    reach: async (page) => {
      await page.keyboard.press("Enter");
      await sleep(300);
      await page.evaluate(() => {
        const app = window.__app;
        app.game.target = 0; // guarantee a win so the shop opens
        app.game.evaluate();
        app.screen = "shop";
        app.invalidate();
      });
      await sleep(400);
    },
  },
  {
    name: "gameover",
    reach: async (page) => {
      await page.keyboard.press("Enter");
      await sleep(300);
      await page.evaluate(() => {
        const app = window.__app;
        app.game.target = 1e9; // unreachable target so the round is lost
        app.game.evaluate();
        app.screen = "gameover";
        app.invalidate();
      });
      await sleep(400);
    },
  },
  // Precision mode: its own HUD (HP bar + Analyze button) and result wording.
  // Started by clicking the title's Precision button, since Enter starts Classic.
  {
    name: "precision-playing",
    reach: async (page) => {
      await clickPrecision(page);
      // A worn-down HP bar and a non-trivial pending cost are the interesting
      // states to eyeball; a fresh run shows a full bar and a huge distance.
      await page.evaluate(() => {
        const app = window.__app;
        app.game.hp = 43;
        app.invalidate();
      });
      await sleep(400);
    },
  },
  {
    // The deck overlay, mid-round so the "left to play" breakdown differs from
    // the full deck (a fresh round would make the two lines identical).
    name: "precision-deck",
    reach: async (page) => {
      await clickPrecision(page);
      await page.evaluate(() => {
        const app = window.__app;
        // Play a couple of cards so some are consumed for the round.
        for (let n = 0; n < 2; n++) {
          const i = app.game.hand.findIndex((c) => c.kind === "number");
          if (i >= 0) app.game.play(i, app.game.root.id);
        }
        app.showDeck = true;
        app.invalidate();
      });
      await sleep(400);
    },
  },
  {
    name: "precision-shop",
    reach: async (page) => {
      await clickPrecision(page);
      await page.evaluate(() => {
        const app = window.__app;
        app.game.target = app.game.currentScore + 7; // survive, 7 damage
        app.game.evaluate();
        app.screen = "shop";
        app.invalidate();
      });
      await sleep(400);
    },
  },
  {
    // The case the two bar colours have to survive: HP low enough that the
    // remaining-health fill is itself red, sitting directly against the pending
    // damage segment. If those ever read as one block, the colours are wrong.
    name: "precision-lowhp",
    reach: async (page) => {
      await clickPrecision(page);
      await page.evaluate(() => {
        const app = window.__app;
        app.game.hp = 40;
        app.game.target = 25; // 25 damage pending vs 15 HP that would remain
        app.invalidate();
      });
      await sleep(400);
    },
  },
  {
    // The round-20 win: its own finish line, distinct from classic's round 30.
    name: "precision-won",
    reach: async (page) => {
      await clickPrecision(page);
      await page.evaluate(() => {
        const app = window.__app;
        app.game.round = 20; // PRECISION_WIN_ROUND
        app.game.hp = 38;
        app.game.target = app.game.currentScore;
        app.game.evaluate();
        app.startVictory();
        app.screen = "won";
        app.invalidate();
      });
      await sleep(700);
    },
  },
  {
    name: "precision-gameover",
    reach: async (page) => {
      await clickPrecision(page);
      await page.evaluate(() => {
        const app = window.__app;
        app.game.hp = 3;
        app.game.target = app.game.currentScore + 400; // fatal distance
        app.game.evaluate();
        app.screen = "gameover";
        app.invalidate();
      });
      await sleep(400);
    },
  },
];

/** Click the title screen's Precision button (its rect lives in `app.ui`). */
async function clickPrecision(page) {
  const rect = await page.evaluate(() => {
    const b = window.__app.ui.precisionBtn;
    return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
  });
  if (!rect) throw new Error("Precision button not found on the title screen");
  await page.mouse.click(rect.x, rect.y);
  await sleep(500);
}

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      /* server not up yet */
    }
    await sleep(300);
  }
  throw new Error(`Vite dev server never came up on ${BASE}`);
}

mkdirSync(OUT, { recursive: true });

const server = spawn(VITE, ["--port", String(PORT), "--strictPort"], {
  cwd: ROOT,
  stdio: "ignore",
});

let browser;
try {
  await waitForServer();
  browser = await chromium.launch();
  for (const vp of VIEWPORTS) {
    for (const screen of SCREENS) {
      const context = await browser.newContext(vp.context);
      const page = await context.newPage();
      // Fixed seed → deterministic offers/hand across runs.
      await page.goto(`${BASE}/?seed=3`, { waitUntil: "networkidle" });
      await sleep(500);
      await screen.reach(page);
      const file = path.join(OUT, `${vp.name}-${screen.name}.png`);
      await page.screenshot({ path: file });
      console.log("✔", path.relative(ROOT, file));
      await context.close();
    }
  }
  console.log(`\nDone — ${VIEWPORTS.length * SCREENS.length} screenshots in ./screenshots/`);
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

/**
 * Generate the app icons: "NGU" in the title font (Baloo 2, heavy) inside a
 * game-style number bubble. Rendered with the real web font via headless
 * Chromium so it matches the in-game look exactly.
 *
 * Usage:
 *   node scripts/make-icons.mjs      (also runnable as part of icon regen)
 *
 * Writes PNGs into public/ (copied verbatim into the build by Vite):
 *   icon-192.png, icon-512.png       — standard "any" PWA icons
 *   icon-512-maskable.png            — extra safe-zone padding for Android masks
 *   apple-touch-icon.png (180)       — iOS home-screen icon
 *
 * Re-run this whenever the icon design changes.
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public");
mkdirSync(OUT, { recursive: true });

// size, filename, bubbleFrac (bubble radius as a fraction of icon size — smaller
// = more padding, for maskable safe zones).
const ICONS = [
  { size: 512, file: "icon-512.png", bubbleFrac: 0.4 },
  { size: 192, file: "icon-192.png", bubbleFrac: 0.4 },
  { size: 512, file: "icon-512-maskable.png", bubbleFrac: 0.33 },
  { size: 180, file: "apple-touch-icon.png", bubbleFrac: 0.42 },
];

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@700;800&display=swap" rel="stylesheet">
<style>html,body{margin:0}</style></head>
<body><canvas id="c"></canvas></body></html>`;

// Drawn in the page so it can use the loaded Baloo 2 font. Mirrors the game's
// drawBubble (radial gradient + glow + top-left sheen) and titleText styling.
function renderIcon(S, bubbleFrac) {
  const canvas = document.getElementById("c");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");

  // Full-bleed dark background (same palette as the game bg).
  const bg = ctx.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, "#0b1026");
  bg.addColorStop(1, "#131a3a");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, S, S);

  const cx = S / 2;
  const cy = S / 2;
  const r = S * bubbleFrac;

  // Bubble body: radial gradient with a top-left highlight, plus outer glow.
  ctx.save();
  ctx.shadowColor = "rgba(90,209,255,0.55)";
  ctx.shadowBlur = S * 0.05;
  const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.2, cx, cy, r);
  grad.addColorStop(0, "#5ad1ff");
  grad.addColorStop(1, "#2b7fff");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Glossy sheen near the top-left.
  ctx.save();
  const hl = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.42, 1, cx - r * 0.35, cy - r * 0.42, r * 0.8);
  hl.addColorStop(0, "rgba(255,255,255,0.55)");
  hl.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = hl;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Subtle rim.
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = Math.max(1, S * 0.007);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // "NGU" in the title font, light gradient with a soft dark shadow so it reads
  // on the blue bubble.
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const fontSize = r * 0.62;
  ctx.font = `800 ${fontSize}px 'Baloo 2', system-ui, sans-serif`;
  ctx.shadowColor = "rgba(6,12,30,0.5)";
  ctx.shadowBlur = S * 0.02;
  ctx.shadowOffsetY = S * 0.006;
  const tg = ctx.createLinearGradient(0, cy - fontSize / 2, 0, cy + fontSize / 2);
  tg.addColorStop(0, "#ffffff");
  tg.addColorStop(1, "#d3ecff");
  ctx.fillStyle = tg;
  ctx.fillText("NGU", cx, cy + S * 0.015);
  ctx.restore();

  return canvas.toDataURL("image/png");
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle" });
  // Inject the draw function into the page so it can use the loaded font.
  await page.addScriptTag({ content: `window.__renderIcon = ${renderIcon.toString()}` });
  await page.evaluate(async () => {
    await document.fonts.load("800 100px 'Baloo 2'");
    await document.fonts.ready;
  });
  for (const { size, file, bubbleFrac } of ICONS) {
    const dataUrl = await page.evaluate(
      ([s, f]) => window.__renderIcon(s, f),
      [size, bubbleFrac],
    );
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    writeFileSync(path.join(OUT, file), Buffer.from(base64, "base64"));
    console.log("✔ public/" + file + `  (${size}px)`);
  }
} finally {
  await browser.close();
}

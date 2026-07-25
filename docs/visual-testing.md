# Visual testing (desktop + mobile)

Number Go Up renders its entire UI onto a `<canvas>`, so normal DOM/unit tests
can't catch layout problems (overlapping HUD text, cards running off-screen,
overflowing panels). Instead we screenshot every screen at a mobile and a
desktop viewport and eyeball them. **Do this before publishing any change that
touches rendering or layout.**

## One-time setup

```bash
npm install                      # installs Playwright (a devDependency)
npx playwright install chromium  # downloads the headless browser it drives (~120 MB)
```

## Capture

```bash
npm run screenshots
```

This spawns the Vite dev server, drives a headless Chromium through every
screen, and writes eight PNGs to `screenshots/` (gitignored):

|              | mobile (iPhone 13, 390×664 @3×) | desktop (1280×800) |
| ------------ | ------------------------------- | ------------------ |
| **title**    | `mobile-title.png`              | `desktop-title.png`    |
| **playing**  | `mobile-playing.png`            | `desktop-playing.png`  |
| **shop**     | `mobile-shop.png`               | `desktop-shop.png`     |
| **gameover** | `mobile-gameover.png`           | `desktop-gameover.png` |

Open them and compare mobile vs. desktop. The run is seeded (`?seed=3`) so the
hand and shop offers are identical every time.

> The `shop` and `gameover` shots are reached by forcing a win/loss through the
> dev-only `window.__app` hook, so they show placeholder numbers ("scored 0",
> "needed 1000000000"). That's a capture artifact — only judge the **layout** in
> those two, not the values.

## What to check on each screen

- **HUD (top bar, all in-game screens):** `ROUND · DEPTH · SCORE · FOCUS · DECK ·
  🔊` must not overlap, and a large centered score must not slide under the left
  or right clusters.
- **playing:** the whole hand of cards fits within the width (nothing clipped at
  either edge) and sits above the bottom of the screen.
- **shop:** each upgrade card fully contains its description (no text spilling
  out the bottom or colliding with the helper line), and the **Grow / Re-roll /
  Skip** button row fits inside the panel.
- **gameover / shop panels:** the whole panel fits on screen with its buttons.

The responsive layout logic these guard lives in:
- `src/render/renderer.ts` — `resize()` (viewport sizing), `drawHand()`
  (scale-to-fit), `drawHUD()` / `drawStat()` (measured right cluster).
- `src/ui/app.ts` — `drawShop()` / `drawShopOption()` (content-sized cards and
  fitted buttons).

## The one thing headless can't catch

Headless Chromium uses a fixed viewport, so it **cannot reproduce iOS Safari's
dynamic address bar** (the bar that shows/hides as you scroll and changes the
visible height). That's exactly the case `resize()` handles via `visualViewport`
and the `100dvh` CSS fallback. After any change to canvas sizing, do a quick
manual check on a real phone — load the [live
build](https://nkohen.github.io/number-go-up/) and confirm the bottom row of
cards sits above the browser bar, not hidden behind it.

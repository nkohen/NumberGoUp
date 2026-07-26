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
screen, and writes fourteen PNGs to `screenshots/` (gitignored):

|                       | mobile (iPhone 13, 390×664 @3×) | desktop (1280×800)              |
| --------------------- | ------------------------------- | ------------------------------- |
| **title**             | `mobile-title.png`              | `desktop-title.png`             |
| **playing**           | `mobile-playing.png`            | `desktop-playing.png`           |
| **shop**              | `mobile-shop.png`               | `desktop-shop.png`              |
| **gameover**          | `mobile-gameover.png`           | `desktop-gameover.png`          |
| **precision-playing**  | `mobile-precision-playing.png`   | `desktop-precision-playing.png`  |
| **precision-shop**     | `mobile-precision-shop.png`      | `desktop-precision-shop.png`     |
| **precision-gameover** | `mobile-precision-gameover.png`  | `desktop-precision-gameover.png` |

Open them and compare mobile vs. desktop. The run is seeded (`?seed=3`) so the
hand and shop offers are identical every time.

> The `shop` and `gameover` shots (both modes) are reached by forcing a
> win/loss through the dev-only `window.__app` hook, so they show placeholder
> numbers ("scored 0", "needed 1000000000", "survived 0 rounds"). That's a
> capture artifact — only judge the **layout** in those, not the values.

> **Adding a screen?** Any `reach` step that pokes `window.__app` state directly
> must end with `app.invalidate()`. The game renders on demand, so a state change
> alone leaves the previous frame on the canvas and you'll capture a stale shot
> that looks like a bug in the feature you just added.

## What to check on each screen

- **HUD (top bar, all in-game screens):** `ROUND · DEPTH · SCORE · FOCUS · DECK ·
  🔊` must not overlap, and a large centered score must not slide under the left
  or right clusters. In precision the second left slot is `HP` instead of `DEPTH`,
  and the bottom bar is a full-width health bar rather than the narrow centred
  progress bar.
- **precision-playing:** the **Analyze** button (top right, left of 🏠) shows its
  HP cost and must not collide with 🏠 or with the Redraw button when that's
  visible. Analyze is the only way to end a precision round, so it must *always*
  be present — Redraw is the one that yields space on a narrow screen.
- **playing:** the whole hand of cards fits within the width (nothing clipped at
  either edge) and sits above the bottom of the screen.
- **shop:** each upgrade card fully contains its description (no text spilling
  out the bottom or colliding with the helper line), and the **Grow / Re-roll /
  Skip** button row fits inside the panel.
- **gameover / shop panels:** the whole panel fits on screen with its buttons.
  The precision shop header carries an extra clause (`· −N HP (M left)`), so check
  it doesn't wrap awkwardly or overflow the panel on mobile.

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

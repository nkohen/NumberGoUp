# Architecture

How the code is organized and how a frame/interaction flows through it. Pair
this with [`DESIGN.md`](DESIGN.md) (why) and [`GAME_DESIGN.md`](GAME_DESIGN.md)
(what it plays like).

## Layered design

```
        ┌─────────────────────────────────────────────┐
        │  ui/app.ts   game loop · input · screen flow  │
        └───────────────┬───────────────┬───────────────┘
                        │ reads/updates │ draws with
                        ▼               ▼
        ┌───────────────────┐   ┌────────────────────────┐
        │ core/  (pure)     │   │ render/ + audio/        │
        │ rules & state     │   │ presentation only       │
        └───────────────────┘   └────────────────────────┘
```

The dependency arrow only points one way: **`core/` knows nothing about
rendering, audio, the DOM, or the app.** It's plain data and pure functions,
which is why it's the part with unit tests. Everything with side effects
(canvas, Web Audio, pointer events, `requestAnimationFrame`, `localStorage`)
lives in `render/`, `audio/`, and `ui/`.

## Modules

### `core/` — the game, as pure logic
| File | Responsibility |
|------|----------------|
| `rng.ts` | Seeded deterministic RNG (`mulberry32`): `next/int/pick/shuffle`. Immutable shuffle. |
| `cards.ts` | `Card` tagged union (`number` \| `op`), labels, keys, and the `starterDeck()`. |
| `tree.ts` | The syntax tree: `TreeNode` union, `evaluate`, `legalTargets`, and immutable `place()` returning a `PlaceResult` (with animation hints). Structural sharing; stable node ids. |
| `upgrades.ts` | `Upgrade` data + pure `applyUpgrade(deck, upgrade)` + `generateOffers(...)`. |
| `game.ts` | `Game` state machine: run/round lifecycle, hand draw, `play/redraw/evaluate/chooseUpgrade`, target curve, stats. Holds the only mutable game state; all randomness via one `Rng`. |

### `audio/`
| File | Responsibility |
|------|----------------|
| `sound.ts` | `SoundEngine` — lazily-unlocked Web Audio context and a library of synthesized SFX (`pickup/place/sprout/merge/win/lose/upgrade/…`). A shared `sound` singleton. |

### `render/` — pixels, no rules
| File | Responsibility |
|------|----------------|
| `layout.ts` | `layoutTree` → `(col, depth)` per node; plus `nodeHeights` and `parentMap` for the merge animation. Resolution-independent. |
| `animation.ts` | Easing functions, frame-rate-independent `smooth`, and `EvaluateAnimation` — the bottom-up merge sequencer that exposes per-node `{reveal, absorb, value}`. |
| `renderer.ts` | `Renderer` — all canvas drawing: background, bubbles (glossy gradients + glow), sprouting edges, particles, the hand, the HUD, and overlay primitives (`drawPanel/drawButton/text`). Owns *visual* state only: animated bubble positions that ease toward layout targets, and the particle system. Returns the geometry it drew (node circles, hand-card rects) so input can hit-test the exact same thing. |

### `ui/`
| File | Responsibility |
|------|----------------|
| `app.ts` | `App` — the conductor. Owns `Game`, `Renderer`, and `sound`; runs the `requestAnimationFrame` loop; translates pointer events into `Game` calls; and owns the screen state machine (`title/playing/evaluating/shop/gameover`) and its overlays. |

### `main.ts`
Boots the canvas and `App`. In dev only, exposes `window.__app` and reads URL
params (`?seed=&baseTarget=&growth=&hand=`) for tuning/repro. Both are stripped
from production by an `import.meta.env.DEV` guard.

## Data flow of one frame

`App.loop(ts)`:
1. Compute `dt`, advance `time`.
2. `renderer.beginFrame(dt)` — clear, background, advance particles.
3. Dispatch on `screen` to a `draw*` method, which:
   - reads current `Game` state,
   - calls `renderer.drawTree/drawHand/drawHUD/…`,
   - **stashes the returned geometry** (node circles, hand rects, button rects)
     into `this.ui` for the input handlers.
4. `requestAnimationFrame(loop)`.

## Data flow of a card placement

1. `pointerdown` on a hand card → `App` starts a `DragState`, computes
   `legalTargets(tree, card)` and highlights them; plays `pickup`.
2. `pointermove` → update drag position; find the nearest legal node under the
   pointer (generous radius) for the hover glow; chirp on new hover.
3. `pointerup` → if over a legal node, call `game.play(handIndex, nodeId)`.
   - `Game` validates via `tree.place()`, updates the tree, consumes the card,
     returns the rest of the hand to the deck, and draws a new hand.
   - `App` uses the returned `PlaceResult.kind` to pick sound
     (`sprout` vs `place`) and fire a particle burst.
   - The renderer, next frame, sees a new node id and **pops it in**; the model
     was already updated synchronously, so the HUD score reflects it immediately.

## The evaluate animation

`App.beginEvaluate()` constructs an `EvaluateAnimation` from the *current* tree
(the tree isn't mutated by scoring), then calls `game.evaluate()` (which sets
`game.phase` and prepares shop offers or ends the run). The app stays on the
`evaluating` screen, feeding `dt` to the animation each frame; the renderer asks
it for per-node `{reveal, absorb, value}` to reveal aggregates and shrink
children into parents, playing a climbing merge tone per level. When it reports
`done`, the app routes to `shop` or `gameover` based on the stored result.

## Testing

`tests/` covers the pure core with Vitest: RNG determinism, tree
placement/evaluation/legality, upgrade application and offer-generation
invariants (e.g. never removing the last number), and full game-flow transitions
(play → evaluate → shop → next round; loss → game over). Rendering/audio are
verified manually and via headless-Chrome smoke checks during development.

Run with `npm test`.

## Extending it

- **New operator** (e.g. subtract): add to `Op`/`OPS` and `evaluate` in
  `tree.ts`, a glyph in `cards.ts`, a colour in `renderer.ts`, and (optionally)
  to the shop pool in `upgrades.ts`.
- **New upgrade type**: add a variant to `Upgrade`, a case to `applyUpgrade`, and
  a generator + card visual. It's pure data, so add a test.
- **Balance**: edit `DEFAULT_CONFIG` in `game.ts` (or pass `?baseTarget=…` in
  dev). Nothing else depends on the constants directly.

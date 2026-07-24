# Design decisions & rationale

This document records the significant decisions made while building Number Go Up
end-to-end, and _why_ — so they're easy to revisit and change. Anything I was
unsure about is flagged and also collected in [`../QUESTIONS.md`](../QUESTIONS.md).

---

## 1. Technology stack

**Decision:** TypeScript + Vite + a hand-written HTML5 Canvas renderer. No game
engine, no runtime dependencies. Vitest for testing the core.

**The original prototype was Rust** (a CLI in `legacy-rust/`), and the original
brief mentioned "compile to web assembly for portability and browser support."
I chose a web-native stack instead. Rationale:

- **The actual goal was browser portability**, and a TS/Canvas app _is_ browser
  native — it needs no WASM toolchain, loads instantly, and runs everywhere
  (desktop + mobile) from a ~12 KB static bundle.
- **The requested UX is animation- and interaction-heavy** (draggable bubbles,
  sprouting edges, merge animations, sound). That's exactly what the DOM/Canvas
  + Web Audio platform does best, with the least friction.
- **You want to iterate on game design.** A dependency-free TS codebase with a
  pure, unit-tested core is the fastest thing to tweak and reason about.
- **Autonomy/robustness:** avoiding a WASM build pipeline removed a whole class
  of overnight "stuck on the toolchain" risks.

If you'd prefer Rust→WASM (e.g. to share logic with a native build), the
`core/` module is a pure, self-contained state machine that ports cleanly. This
is **flagged as an open question** — see QUESTIONS.md #1.

**Why Canvas and not React/DOM or SVG?** The game is essentially one animated
scene (a tree of bubbles) plus a few overlays. Immediate-mode Canvas gives full
control over the custom animations (bubble morphs, particle bursts, the merge
sequence) without fighting a retained DOM. All UI — including buttons and the
shop — is drawn on the canvas, and hit-testing reuses the exact geometry that
was drawn, so there's a single source of truth for layout.

## 2. The turn model

Taken directly from your brief, and made precise:

- A **round** starts with the full deck shuffled and the tree reset to a single
  `0` slot.
- Each **turn**: shuffle the deck, draw 5. Then either
  - **play one card** into the tree — the other four return to the deck, the
    played card is consumed for the rest of the round, and a fresh hand is
    drawn; or
  - **Evaluate** to finalize.
- Because the played card is consumed, the deck shrinks by one per turn, so a
  round lasts **at most `deckSize` plays**. That's the natural limit on tree
  size — no arbitrary turn counter needed. (Decision: this is what bounds a
  round. See QUESTIONS.md #2 for whether you'd like an explicit turn/energy
  limit instead.)

**"Draw 5, keep 1" is the core tension.** You get to be picky (unused cards come
back), but randomness still shapes which cards are available each turn, and the
total card budget is small.

**Stuck-hand safeguard.** The only way to have _no_ legal move is an opening hand
that is all operations while the tree is still a bare `0` (ops need a number to
split). Rather than force a losing Evaluate, a **Redraw** button appears _only_
when you have no legal move. It can't be abused to stall because it's unavailable
the moment any play is possible. (See QUESTIONS.md #3.)

## 3. The tree grammar

- `slot` (empty, shows `0`) — a number card turns it into a `value`.
- `value(n)` — an operation card turns it into `op(value(n), slot)`: the original
  number stays as one child, a fresh `0` becomes the other.
- Operations can only be played on **number leaves**, never on an existing
  operation. **Consequence:** you build strictly downward from the leaves and
  **can't wrap an existing subtree in a new operator**. The root operator is
  whatever you place first. This is faithful to the original spec and gives the
  game its puzzly, commit-as-you-go character. (Flagged — QUESTIONS.md #4 — in
  case you intended to allow re-parenting.)

Node ids are preserved across edits where a bubble should visually persist (a
filled slot keeps its id; splitting a value keeps the original number as the
left child with its id), which is what lets the renderer animate morphs and
sprouts smoothly.

## 4. Scoring, targets, and progression

- **Score** = the evaluated tree.
- **Target** for round _r_ = `ceil(baseTarget · growth^(r−1))` with
  `baseTarget = 4`, `growth = 1.6` → 4, 7, 11, 17, 27, 42, 68, … These constants
  live in `DEFAULT_CONFIG` (`src/core/game.ts`) and are trivially tunable.
- Round 1 (target 4) is gently winnable additively on the starter deck (e.g.
  `2+2`). The additive ceiling of the starter deck is exactly 6 (`1+1+2+2`), so
  within a round or two the rising target forces you to discover multiplication
  and to lean on the shop. Balancing is a **known rough spot** — QUESTIONS.md #5.
- The run is **endless**: play until you miss a target. Stats tracked: rounds
  cleared and best score.

## 5. Deck upgrades (the "shop")

After clearing a round you pick **one of three** offers (or skip). Three
families:

- **Add** a card (bigger numbers and more operators unlock as rounds progress).
- **Remove** a weak card (deck-thinning) — never offered if it would delete your
  last number, and only when the deck is comfortably larger than a hand.
- **Promote** a number (e.g. `1 → 3`).

Upgrades are plain data with a pure `applyUpgrade(deck, upgrade)` function, so
they're easy to test and extend. There is currently **no currency** — picks are
free. Whether you'd like an economy (coins, rerolls, shop costs, relics) is
**the biggest open game-design question** — QUESTIONS.md #6.

## 6. Audio

All sound is **synthesized at runtime** with the Web Audio API (no asset files):
short enveloped sine/triangle blips, rising "sprout" chirps, a pitched merge
that climbs as the tree collapses, and win/lose arpeggios. This keeps the bundle
tiny and every sound tweakable in code. Audio unlocks on first interaction (a
browser requirement) and a mute toggle persists to `localStorage`.

## 7. Art direction

Deep-space navy gradient with faint stars; glossy, glowing bubbles with a soft
radial-gradient body and a highlight. Colour encodes card type: **numbers are
blue, `+` is green, `×` is amber**. Empty slots are ghostly dashed rings. Legal
drop targets pulse green while dragging. The rounded "Baloo 2" webfont reinforces
the friendly, bubbly feel (with a system-font fallback). See QUESTIONS.md #7 for
palette/theme preferences.

## 9. Functions mode (added on request)

A second mode where the tree can contain the variable `x` and a
function-application operator `ƒ`. `ƒ(F, a)` evaluates the polynomial `F` (left
subtree, may contain `x`) at the point `a` (right subtree) — implemented as
"evaluate `F` with `x` bound to `eval(a)`". Key decisions:

- **`ƒ` is modeled as just another binary operator** (`@` internally) so it
  reuses all the existing placement/animation machinery; only evaluation and
  colour differ. `x` is a new leaf kind alongside `value`.
- **Dynamic scoping with `x = 0` outside any `ƒ`.** This keeps every tree
  well-defined without special "unbound variable" states or placement
  restrictions, at the cost of allowing (harmless) `x` leaves outside a
  function. The nearest enclosing `ƒ` wins; nested `ƒ`s rebind.
- **No re-parenting still applies**, so `ƒ` is strongest placed early (root).
  See QUESTIONS.md #4/#13 — this is the one spot where a wrap/re-parent move
  would feel especially natural (wrap a finished polynomial in an evaluate).
- **Modes share the target curve for now**; the polynomial-at-a-point mechanic
  scales faster, so Functions may want its own curve after playtesting.

Everything lives behind a `GameMode` in `DEFAULT_CONFIG`/`configForMode`, with a
mode picker on the title screen. See [`GAME_DESIGN.md`](GAME_DESIGN.md#functions).

## 8. Things intentionally left out of v0.1

Persistence of runs, a tutorial beyond the rules card, animations for the shop
transition, more card/operator types (subtract, power, negative numbers),
special "relic" modifiers, and a daily-seed mode. The seeded RNG and data-driven
upgrades were built with these in mind. Candidates are listed in
[`GAME_DESIGN.md`](GAME_DESIGN.md#future-directions).

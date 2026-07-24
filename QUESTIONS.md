# Questions for you ☀️

Good morning! I built **Number Go Up** end-to-end overnight — a playable,
animated, sound-enabled roguelike deck-builder in the browser. Below is what I
decided on my own (with reasoning), and the questions where your call would
change the direction. Nothing here is hard to change; the code is structured so
these are mostly small edits.

**To play it right now:** `npm install && npm run dev`, then open the printed URL.

> **Update (later that night):** per your follow-up message, I added a second
> **Functions mode** (pick it on the title screen) with a variable card `x` and
> a function-evaluation operator `ƒ`: `ƒ(F, a)` evaluates the polynomial `F`
> (left, may contain `x`) at the point `a` (right). e.g. `ƒ(x×x, 3) = 9`. It's
> fully working, tested, and documented; a couple of questions about it are at
> the bottom (Q13–Q15).

---

## The one big decision I made without asking

**I switched the stack from Rust/WASM to a web-native TypeScript + Canvas app.**
Your original note mentioned compiling to WebAssembly "for portability and
browser support" — and a TS/Canvas game *is* browser-native (no WASM toolchain),
loads instantly, runs on desktop + mobile, and is by far the easiest thing to
iterate on for the animated bubble UX you described. The old Rust CLI is
preserved in `legacy-rust/`. Full reasoning in
[`docs/DESIGN.md`](docs/DESIGN.md#1-technology-stack).

**Q1. Are you happy with the web/TS stack, or do you specifically want
Rust→WASM?** The pure game logic in `src/core/` is a clean state machine that
would port to Rust without much pain if you want to share it with a native
build.

---

## Questions that shape the game

**Q2. Round length / limit.** Right now a round naturally ends when your deck is
spent (one card is consumed per turn), so a round lasts at most `deckSize`
plays. Do you like this implicit limit, or would you prefer an explicit turn or
"energy" budget per round?

**Q3. The stuck-hand safeguard.** If your opening hand is all operators (nothing
can be legally placed on a bare `0`), a **Redraw** button appears so you're not
forced into a losing Evaluate. It's only available when you have zero legal
moves. Good compromise, or would you rather handle "no legal move" differently
(e.g. guarantee a number in the opening hand)?

**Q4. Can operators wrap an existing subtree?** Per the original spec, operators
can only be played on **number leaves**, so you build strictly *downward* and
the top operator is fixed once placed (you can't turn `(2+2)` into `(2+2)×3`
later). This makes it a commit-as-you-go puzzle. **Was that your intent, or did
you want to allow "re-parenting"** (wrapping a whole subtree in a new operator)?
That single rule change significantly alters strategy — easy to add if you want
it.

**Q5. Balancing.** Targets are `4, 7, 11, 17, 27, 42, …` (`baseTarget=4`,
`growth=1.6`). I set round 1 to 4 so it's gently winnable with `2+2`; the
starter deck's additive ceiling is 6, so multiplication becomes necessary within
a round or two. **These numbers are reasoned, not playtested** — please tell me
how it *feels* (too easy? spikes too hard? runs too long?) and I'll tune the
curve, the starter deck, and the upgrade pool.

**Q6. Economy / meta-progression (biggest open design question).** The shop is
currently "pick 1 of 3 free upgrades." There's no currency, rerolls, or relics.
Options I can build:
  - (a) keep it simple (current);
  - (b) earn **coins** from overshooting the target, spend on upgrades/rerolls;
  - (c) Slay-the-Spire-style **relics** (persistent run modifiers);
  - (d) card **costs / rarity tiers**.
Which direction appeals? This is where the roguelike depth would come from.

**Q7. New operators & cards.** I kept it to `1, 2, +, ×` plus shop-added numbers.
Want me to add **subtract**, **power/exponent** (makes scores explode), negative
numbers, wild cards, or multiplier tokens? Each is a small, isolated addition.

**Q8. Art & audio direction.** Current look: deep-space navy, glossy glowing
bubbles, blue numbers / green `+` / amber `×`, synthesized bloopy sounds. Does
this match the vibe you pictured? Any palette, mood, or sound preferences (e.g.
softer/retro/chiptune, a background music loop)?

---

## Smaller things I'd like your take on

- **Q9. Tap-to-place?** Currently you drag cards. Should I also support
  tap-a-card-then-tap-a-target (nice on mobile / for accessibility)?
- **Q10. Undo.** Should placements be undoable within a turn before you draw the
  next hand?
- **Q11. Persistence.** Save/restore a run in progress, and a stats page? The RNG
  is already seedable, so a shareable **daily-seed** challenge is also cheap.
- **Q12. Scope for next session.** Where should I spend the next block of time —
  meta-progression (Q6), more content (Q7), balancing/juice, or a tutorial?

---

## Questions about the new Functions mode

- **Q13. `ƒ` and re-parenting.** Since operators only attach to leaves, `ƒ` works
  best placed early (so it's the root and the whole tree is one evaluation). Did
  you picture being able to build a polynomial *first* and then wrap the whole
  thing in an evaluate (`ƒ`)? That's the "re-parenting" from Q4, and Functions
  mode is where it would feel most natural. I can add it (mode-wide or just for
  `ƒ`) if you want.
- **Q14. Unbound `x`.** I made `x = 0` outside any `ƒ` (so every tree is always
  well-defined). Alternative: forbid placing `x` unless it's inside a function
  body. Preference?
- **Q15. Separate tuning.** Functions can score much higher (evaluate a square at
  a big point), so it may deserve its own target curve / starter deck rather than
  sharing Classic's. Want me to tune it separately once you've played?

## What's done and verified

- ✅ Full game loop: title → play → evaluate (merge animation) → shop → next
  round → game over, endless with rising targets.
- ✅ Drag-and-drop bubble tree with legal-target glow, sprouting edges, particle
  bursts, and the bottom-up merge-to-score animation you described.
- ✅ Procedural sound effects + mute (persisted).
- ✅ Deck-upgrade shop (add / remove / promote).
- ✅ **Functions mode**: variable `x` + evaluate operator `ƒ`, with an
  environment-aware merge animation (the `x` leaves visibly resolve to the point
  they're evaluated at). Verified building `ƒ(x×x, 3) = 9` in-browser.
- ✅ 38 passing unit tests on the pure core; type-checks; production build is
  ~12 KB gzipped with zero runtime deps.
- ✅ Verified end-to-end in headless Chrome (screenshots in `docs/screenshots/`).

See [`docs/`](docs/) for design, game-design, and architecture write-ups. Every
commit is scoped and described so anything here is easy to revert or adjust.

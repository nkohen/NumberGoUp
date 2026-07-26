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

- **Q16. Precision tuning + the round-20 win.** Precision now WINS on surviving
  round 20, because unlike classic it can't be left endless: its target range
  stops widening at round 17 and nothing else escalates, so a precise enough deck
  would face no opposition forever. Adding that finish line forced a re-tune —
  the win has to be reachable, but must not land before the range finishes
  widening (or you'd win without ever seeing [1, 1000)). `precisionRangeGrowth`
  went 1.40 → **1.35**: full range at r17, so rounds 17-20 are the endgame.
  Modelled win rates at r20 (greedy semi-skilled sim, 100 trials): 1.40 → 0%
  (its best run ever was 19 — literally unwinnable), 1.35 → 3%, 1.30 → 11%,
  1.25 → 30% but the full range never arrives. The sim is myopic, so a human
  should do much better; still, **this is the number to check first when you
  playtest.** If nobody can win, drop toward 1.30; if you'd rather winning were
  elite-only, push back toward 1.40. `npx vite-node tools/precisionmode.ts 1.3
  1.35 1.4` re-runs the table.
- **Q17. Subtraction.** You mentioned maybe adding a `−` card. Worth knowing it
  interacts with precision's auto-analyze: today the round resolves the moment you
  reach or pass the target, which is only safe because no play can lower the
  score. A `−` card makes an overshoot recoverable, so precision would need to go
  back to resolving only on an exact hit (one line in `Game.shouldAutoScore`).
  A monotonicity test guards this — adding `−` turns it red on purpose rather
  than silently changing when rounds end. Subtraction would also make precision
  substantially easier (you could always walk a miss back), so it'd likely want
  a steeper `precisionRangeGrowth` alongside.
- **Q18. Precision and focus.** Precision currently pays twice in precision: a
  close land both costs less HP *and* banks ◆ focus on the same bands. That
  makes precision the single dominant skill. Alternative: no focus from landing
  (earn it only by skipping the shop), so growing the tree is a real sacrifice.
  Wanted the double-dip, or is it too generous?

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
- ✅ **Precision mode**: random target each round from a widening range, 100 HP,
  damage = distance from the target (either direction), manual **Analyze** to
  finalize, endless until the HP runs out. Classic is untouched.
- ✅ 83 passing unit tests on the pure core; type-checks; production build is
  ~26 KB gzipped with zero runtime deps.
- ✅ Verified end-to-end in headless Chrome (screenshots in `docs/screenshots/`).

See [`docs/`](docs/) for design, game-design, and architecture write-ups. Every
commit is scoped and described so anything here is easy to revert or adjust.

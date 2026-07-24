# Game design — Number Go Up

The complete ruleset as implemented in v0.1, plus balancing notes and a backlog
of ideas. This is the document to mark up when you want to change how the game
_plays_ (as opposed to how it's built — see `ARCHITECTURE.md`).

## Core loop

```
Title ──▶ Round ──▶ Evaluate ──▶ (cleared?) ──▶ Shop ──▶ Round+1 ──▶ …
                                     │
                                     └──(missed)──▶ Game Over ──▶ Title
```

A **run** is an endless sequence of rounds with rising targets. A **round** is a
puzzle: build the best tree you can from the cards you draw.

## Rules

### The tree
- Starts as a single empty **slot** displaying `0`.
- **Number card → slot:** fills the slot with that number.
- **Operation card (`+`/`×`) → number leaf:** replaces the number `n` with
  `n ○ 0`, keeping `n` as one child and sprouting a fresh `0` as the other.
- Operations may only be played on **number leaves**, so the tree grows
  downward from its leaves; the top operator is fixed once placed.

### Evaluation
- `slot = 0`, `value(n) = n`, `+`/`×` combine their children.
- **Multiplying by an unfilled `0` zeroes that whole branch** — the central
  strategic hazard.

### The turn
1. Shuffle deck, draw 5.
2. Either **play one** card (rest return to deck, played card consumed, redraw)
   or **Evaluate**.
3. A round lasts at most `deckSize` plays (the deck is spent one card per turn).

### Winning / losing
- Evaluate ≥ target → **round cleared** → shop.
- Evaluate < target → **run over**.

## Numbers (current tuning)

Defined in `DEFAULT_CONFIG` (`src/core/game.ts`):

| Parameter        | Value | Meaning                                   |
|------------------|-------|-------------------------------------------|
| `handSize`       | 5     | Cards drawn per turn                      |
| `baseTarget`     | 4     | Round-1 target                            |
| `targetGrowth`   | 1.6   | Target multiplier per round               |
| `upgradeChoices` | 3     | Offers shown in the shop                  |

Target by round: **4, 7, 11, 17, 27, 42, 68, 109, …**

**Starter deck (8 cards):** `1 1 2 2 + + × ×`.

### Reachability sanity check
The starter deck's purely-additive maximum is `1+1+2+2 = 6`, and its best overall
build is around `(2+1)×(2+1) = 9`. So:
- **Round 1 (4)** is gently winnable without even discovering multiplication
  (e.g. `2+2`) — a forgiving first impression.
- **Round 2 (7)** already exceeds the additive ceiling, so you must either play a
  strong multiply line or spend your first upgrade well.
- Beyond that, every cleared round raises both the target and (via one upgrade)
  your ceiling, so the run becomes a race between your deck and the curve.

(An earlier build used `baseTarget = 6`, which sat exactly on the additive
ceiling and made round 1 punishingly tight — hence the drop to 4.)

> ⚠️ **Balancing is under-tuned.** The curve, starter deck, and upgrade pool were
> set by reasoning, not playtesting. Expect to tune `baseTarget`/`targetGrowth`
> and the upgrade weights. See QUESTIONS.md #5.

## Upgrades (the shop)

One of three offers per clear (or skip). Families:

- **Add** — `add a 3 / 4 / 5 …`, `add a + / ×`. The candidate pool widens by
  round (bigger numbers appear later; `×` is weighted higher as the "power
  tool").
- **Remove** — thin a `1` or `2` out of the deck. Guarded so it never removes
  your last number and only appears when the deck is larger than a hand.
- **Promote** — upgrade the smallest number in your deck by `+2` (e.g. `1 → 3`).

Design intent: give the classic deck-builder choice between **going wide**
(more cards, more options per draw) and **going tall/lean** (fewer, stronger
cards that show up more reliably). Multiplication is deliberately scarce-then-
buyable because it's how scores actually explode.

## Feel / juice

- Bubbles **pop in** with an overshoot ease and ease toward their layout slots.
- Placing a number **pops**; placing an operator **sprouts** an edge with a
  rising chirp and a particle burst.
- On Evaluate the tree **merges bottom-up**: each level reveals its aggregate
  value and shrinks into its parent with a climbing merge tone, ending on the
  root = your score.
- Win/lose arpeggios; everything is mutable via `M`.

## Future directions (backlog)

Roughly ordered by bang-for-buck:

1. **Economy / meta choices** — coins from overshooting the target, shop rerolls,
   card costs, or Slay-the-Spire-style relics. (Biggest lever on depth.)
2. **More operators** — subtract, power/exponent (huge scores), maybe unary
   negate or "double". Each is a few lines in `cards.ts` + `tree.ts`.
3. **Bigger/dynamic number cards** — wilds, `×2` multiplier tokens, random
   ranges.
4. **Board modifiers per round** — "×3 target but +1 hand size", forbidden
   operators, starting partial trees.
5. **Re-parenting move** — allow wrapping a subtree in a new operator (changes
   the whole strategic character; see QUESTIONS.md #4).
6. **Persistence & daily seed** — the RNG is already seedable; add a shareable
   daily challenge and save/restore.
7. **Tutorial round** — a scripted first round that teaches the `×0` hazard.
8. **Undo within a turn** before committing a placement.

All of these were kept in mind in the data model (seeded RNG, tagged-union cards,
data-driven upgrades), so they should slot in without structural upheaval.

/**
 * Deck-upgrade ("shop") mechanic.
 *
 * After clearing a round the player is offered a small set of upgrades and
 * picks one (or skips). Upgrades are plain data so they are easy to test,
 * serialize, and display. Each upgrade is applied by `applyUpgrade`, a pure
 * function over the deck.
 *
 * Three upgrade families:
 *   - add     : add a new card to the deck (more/bigger numbers, more ops)
 *   - remove  : thin the deck by removing one weak card (classic deck-builder move)
 *   - promote : upgrade one number card to a larger value
 */
import {
  Card,
  cardKey,
  numberCard,
  opCard,
  varCard,
  Op,
} from "./cards";
import type { Rng } from "./rng";
import type { GameMode } from "./game";

export type Upgrade =
  | { readonly type: "add"; readonly card: Card; readonly title: string; readonly desc: string }
  | { readonly type: "remove"; readonly card: Card; readonly title: string; readonly desc: string }
  | {
      readonly type: "promote";
      readonly from: number;
      readonly to: number;
      readonly title: string;
      readonly desc: string;
    };

/** Count how many copies of each card key are in the deck. */
function tally(deck: readonly Card[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of deck) m.set(cardKey(c), (m.get(cardKey(c)) ?? 0) + 1);
  return m;
}

function numberValuesInDeck(deck: readonly Card[]): number[] {
  return deck
    .filter((c): c is Extract<Card, { kind: "number" }> => c.kind === "number")
    .map((c) => c.value);
}

/** Apply an upgrade to a deck, returning a NEW deck (never mutates input). */
export function applyUpgrade(deck: readonly Card[], up: Upgrade): Card[] {
  const out = deck.slice();
  switch (up.type) {
    case "add":
      out.push(up.card);
      return out;
    case "remove": {
      const idx = out.findIndex((c) => cardKey(c) === cardKey(up.card));
      if (idx >= 0) out.splice(idx, 1);
      return out;
    }
    case "promote": {
      const idx = out.findIndex(
        (c) => c.kind === "number" && c.value === up.from,
      );
      if (idx >= 0) out[idx] = numberCard(up.to);
      return out;
    }
  }
}

/**
 * Generate up to `count` distinct upgrade offers appropriate to the current
 * deck and round. Deterministic given `rng`.
 */
export function generateOffers(
  deck: readonly Card[],
  rng: Rng,
  round: number,
  count = 3,
  mode: GameMode = "classic",
): Upgrade[] {
  const offers: Upgrade[] = [];
  const seen = new Set<string>();
  const push = (u: Upgrade, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    offers.push(u);
  };

  // Candidate "add number" values scale up as the run progresses.
  const numberPool: number[] = [3, 3, 4];
  if (round >= 2) numberPool.push(5);
  if (round >= 3) numberPool.push(6, 7);
  if (round >= 5) numberPool.push(8, 10);

  const opPool: Op[] = ["+", "*", "*"]; // multiply is the power tool, weight it

  // Build a weighted candidate list, then draw distinct offers from it.
  const candidates: Array<{ up: Upgrade; key: string }> = [];

  for (const v of numberPool) {
    candidates.push({
      up: {
        type: "add",
        card: numberCard(v),
        title: `Add a ${v}`,
        desc: `Shuffle a ${v} card into your deck.`,
      },
      key: `add-n${v}`,
    });
  }
  for (const op of opPool) {
    const label = op === "*" ? "×" : "+";
    candidates.push({
      up: {
        type: "add",
        card: opCard(op),
        title: `Add a ${label}`,
        desc:
          op === "*"
            ? "Shuffle a multiply card into your deck."
            : "Shuffle an add card into your deck.",
      },
      key: `add-op${op}`,
    });
  }

  // Functions mode: also offer the variable `x` and the evaluate operator `ƒ`.
  if (mode === "functions") {
    candidates.push({
      up: {
        type: "add",
        card: varCard(),
        title: "Add an x",
        desc: "Shuffle a variable card into your deck.",
      },
      key: "add-x",
    });
    candidates.push({
      up: {
        type: "add",
        card: opCard("@"),
        title: "Add a ƒ",
        desc: "Shuffle an evaluate card into your deck.",
      },
      key: "add-op@",
    });
  }

  // Promote the smallest number present (e.g. 1 -> 3) — strong thinning-adjacent play.
  const values = numberValuesInDeck(deck).sort((a, b) => a - b);
  if (values.length > 0) {
    const from = values[0];
    const to = from + 2;
    candidates.push({
      up: {
        type: "promote",
        from,
        to,
        title: `Upgrade a ${from} → ${to}`,
        desc: `Permanently turn one of your ${from} cards into a ${to}.`,
      },
      key: `promote-${from}`,
    });
  }

  // Remove a weak card, but never the last number (keeps every deck buildable)
  // and only when the deck is comfortably larger than the hand.
  const t = tally(deck);
  const numberCount = numberValuesInDeck(deck).length;
  if (deck.length > 6) {
    for (const value of [1, 2]) {
      const has = (t.get(`n${value}`) ?? 0) > 0;
      const wouldStripLastNumber = numberCount <= 1;
      if (has && !wouldStripLastNumber) {
        candidates.push({
          up: {
            type: "remove",
            card: numberCard(value),
            title: `Remove a ${value}`,
            desc: `Thin your deck by removing one ${value} card.`,
          },
          key: `remove-n${value}`,
        });
      }
    }
  }

  // Draw `count` distinct candidates at random.
  const shuffled = rng.shuffle(candidates);
  for (const c of shuffled) {
    if (offers.length >= count) break;
    push(c.up, c.key);
  }
  return offers;
}

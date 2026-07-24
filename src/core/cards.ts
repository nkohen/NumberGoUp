/**
 * Card model.
 *
 * The starter deck contains number cards (1, 2) and operation cards (+, *).
 * The model is intentionally open for extension: new operations (subtract,
 * power, etc.) and new number values only require touching this file and the
 * evaluator in `tree.ts`.
 */

/** The operations currently supported by the game. */
export type Op = "+" | "*";

export const OPS: readonly Op[] = ["+", "*"];

/** A card is either a number card or an operation card. */
export type Card =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "op"; readonly op: Op };

export function numberCard(value: number): Card {
  return { kind: "number", value };
}

export function opCard(op: Op): Card {
  return { kind: "op", op };
}

/** Short glyph used on the card bubble ("1", "2", "+", "×"). */
export function cardLabel(card: Card): string {
  if (card.kind === "number") return String(card.value);
  return card.op === "*" ? "×" : card.op;
}

/** Stable string key for a card, handy for tallies and shop logic. */
export function cardKey(card: Card): string {
  return card.kind === "number" ? `n${card.value}` : `op${card.op}`;
}

/** Human readable name used in tooltips / shop descriptions. */
export function cardName(card: Card): string {
  if (card.kind === "number") return `Number ${card.value}`;
  return card.op === "*" ? "Multiply" : "Add";
}

/**
 * The default starting deck, per the original game spec: cards 1, 2, +, *.
 * Two of each number and two of each operation gives a small, readable deck
 * (8 cards) that still has meaningful shuffle variance.
 */
export function starterDeck(): Card[] {
  return [
    numberCard(1),
    numberCard(1),
    numberCard(2),
    numberCard(2),
    opCard("+"),
    opCard("+"),
    opCard("*"),
    opCard("*"),
  ];
}

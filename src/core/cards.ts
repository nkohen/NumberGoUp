/**
 * Card model.
 *
 * Classic mode uses number cards (1, 2, …) and operation cards (+, ×).
 * Functions mode additionally uses:
 *   - the variable card `x` (a symbolic leaf), and
 *   - the evaluate/apply operator `ƒ` (internally `@`): `apply(F, a)` evaluates
 *     the polynomial function `F` (its left subtree, which may contain `x`
 *     leaves) at the point `a` (its right subtree).
 *
 * The model is intentionally open for extension: new operations and new number
 * values only require touching this file and the evaluator in `tree.ts`.
 */

/** Binary operators. `@` is function application (evaluate left at right). */
export type Op = "+" | "*" | "@";

export const OPS: readonly Op[] = ["+", "*", "@"];

/** A card is a number, the variable `x`, or an operation. */
export type Card =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "var" }
  | { readonly kind: "op"; readonly op: Op };

export function numberCard(value: number): Card {
  return { kind: "number", value };
}

export function opCard(op: Op): Card {
  return { kind: "op", op };
}

/** The variable `x` (used in Functions mode). */
export function varCard(): Card {
  return { kind: "var" };
}

/** Short glyph used on the card bubble ("1", "x", "+", "×", "ƒ"). */
export function cardLabel(card: Card): string {
  if (card.kind === "number") return String(card.value);
  if (card.kind === "var") return "x";
  switch (card.op) {
    case "*":
      return "×";
    case "@":
      return "ƒ";
    default:
      return "+";
  }
}

/** Stable string key for a card, handy for tallies and shop logic. */
export function cardKey(card: Card): string {
  if (card.kind === "number") return `n${card.value}`;
  if (card.kind === "var") return "x";
  return `op${card.op}`;
}

/** Human readable name used in tooltips / shop descriptions. */
export function cardName(card: Card): string {
  if (card.kind === "number") return `Number ${card.value}`;
  if (card.kind === "var") return "Variable x";
  switch (card.op) {
    case "*":
      return "Multiply";
    case "@":
      return "Evaluate";
    default:
      return "Add";
  }
}

/**
 * The Classic starting deck, per the original game spec: cards 1, 2, +, ×.
 * Two of each gives a small, readable 8-card deck with meaningful variance.
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

/**
 * The Functions starting deck. Adds the variable `x` and the evaluate operator
 * `ƒ`, plus a 3 so there are meaningful points to evaluate at. Round 1 is still
 * winnable additively (e.g. 1+3), while `ƒ` unlocks polynomial builds like
 * `apply(x×x, 2) = 4`.
 */
export function functionsStarterDeck(): Card[] {
  return [
    numberCard(1),
    numberCard(2),
    numberCard(3),
    varCard(),
    varCard(),
    opCard("+"),
    opCard("*"),
    opCard("*"),
    opCard("@"),
  ];
}

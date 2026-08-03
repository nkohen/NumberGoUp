/**
 * Alphabets: symbols, arities, and the rewrite rules between them.
 *
 * The base combinators γ/δ/ε have exactly three verbs — annihilate, commute,
 * erase — and commuting is nearly always a mistake, so any game built on them
 * collapses to "match the symbol or burn it". This module makes the rule set
 * data instead of code, so alternative alphabets can be designed and measured.
 *
 * WHAT A RULE IS. An interaction rule for α (arity m) against β (arity n)
 * replaces the redex with any net whose interface is the m + n auxiliary ports
 * left dangling. So a rule is: a list of agents to create, plus a wiring over
 *
 *   - the INTERFACE slots  — α.aux[0..m-1] and β.aux[0..n-1], and
 *   - every port of every created agent.
 *
 * Each of those must be used exactly once; `validateRule` checks it.
 *
 * TWO CONSTRAINTS ARE NOT NEGOTIABLE.
 *
 * 1. At most ONE rule per unordered pair of symbols. That is what makes an
 *    interaction system strongly confluent, and confluence is what makes "did
 *    you clear the net" and "how many interactions" well-defined rather than
 *    artifacts of the evaluator. Rules are stored keyed by sorted pair, so a
 *    second rule for the same pair is a structural impossibility rather than a
 *    thing to remember not to do.
 *
 * 2. PARITY. The ports to pair up number m + n + Σ(arity + 1) over created
 *    agents, and that has to be even. This is quietly restrictive: for two
 *    arity-2 agents, every arity-2 and arity-0 agent contributes an odd count,
 *    so a rule must create an EVEN number of them. You cannot write "these two
 *    fuse into a single new node" with binary symbols alone. Arity-1 and
 *    arity-3 symbols contribute an even count and lift the restriction — which
 *    is the main reason the alphabets in `alphabets.ts` use them.
 *
 * A pair with no rule DEADLOCKS: the redex is stuck, not an error. That is a
 * legitimate design tool — an armoured symbol nothing can react with.
 */

export type Sym = string;

export interface SymbolDef {
  readonly symbol: Sym;
  readonly arity: number;
  readonly name: string;
  /** Renderer fill/glow. */
  readonly color: { readonly a: string; readonly b: string; readonly glow: string };
}

/** One end of a wire on a rule's right-hand side. */
export type Slot =
  /** An auxiliary port of one of the two vanishing agents. */
  | { readonly kind: "interface"; readonly side: "a" | "b"; readonly index: number }
  /** A port of an agent this rule creates (`agent` indexes into `creates`). */
  | { readonly kind: "agent"; readonly agent: number; readonly port: number };

export function ifaceSlot(side: "a" | "b", index: number): Slot {
  return { kind: "interface", side, index };
}

export function agentSlot(agent: number, port: number): Slot {
  return { kind: "agent", agent, port };
}

export interface Rule {
  /**
   * A short name for what this rewrite DOES, e.g. "annihilate", "fuse",
   * "erase". Purely descriptive, but the analysis harness reports which verbs a
   * solution actually uses — which is how you find out whether an alphabet has
   * more mechanics than it has rules.
   */
  readonly verb: string;
  /** Symbols of the agents created, in order. */
  readonly creates: readonly Sym[];
  /** The right-hand side's wiring. */
  readonly links: ReadonlyArray<readonly [Slot, Slot]>;
}

export interface Alphabet {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly symbols: readonly SymbolDef[];
  /** Keyed by `sortedPairKey`; written from the perspective of the FIRST symbol. */
  readonly rules: ReadonlyMap<string, Rule>;
}

/**
 * Rule-table key for an unordered pair. The separator is a NUL because symbols
 * are arbitrary strings and a printable separator could appear inside one —
 * `splitPairKey` is the only thing that should ever take a key apart.
 */
export function pairKey(x: Sym, y: Sym): string {
  return x <= y ? `${x}\u0000${y}` : `${y}\u0000${x}`;
}

/** The two symbols of a pair key, in the order the rule is written for. */
export function splitPairKey(key: string): [Sym, Sym] {
  const [a, b] = key.split("\u0000");
  return [a, b];
}

export function arityOf(alphabet: Alphabet, symbol: Sym): number {
  const def = alphabet.symbols.find((s) => s.symbol === symbol);
  if (!def) throw new Error(`alphabet ${alphabet.id} has no symbol ${symbol}`);
  return def.arity;
}

export function symbolDef(alphabet: Alphabet, symbol: Sym): SymbolDef | undefined {
  return alphabet.symbols.find((s) => s.symbol === symbol);
}

/**
 * The rule for a pair, with `swap` telling the caller which of its two agents
 * plays the "a" role — rules are stored once per unordered pair, so half the
 * lookups come back reversed.
 */
export function lookupRule(
  alphabet: Alphabet,
  x: Sym,
  y: Sym,
): { rule: Rule; swap: boolean } | null {
  const rule = alphabet.rules.get(pairKey(x, y));
  if (!rule) return null;
  // `swap` when x is not the symbol the rule was written for as side "a".
  return { rule, swap: x > y };
}

// --- Validation ------------------------------------------------------------------

export interface RuleProblem {
  pair: string;
  message: string;
}

/**
 * Check that a rule is a well-formed net: every interface slot and every port of
 * every created agent used exactly once, no dangling references, parity intact.
 */
export function validateRule(
  alphabet: Alphabet,
  symA: Sym,
  symB: Sym,
  rule: Rule,
): string[] {
  const problems: string[] = [];
  const arityA = arityOf(alphabet, symA);
  const arityB = arityOf(alphabet, symB);

  const need = new Map<string, number>();
  const bump = (key: string): void => {
    need.set(key, (need.get(key) ?? 0) + 1);
  };
  for (let i = 0; i < arityA; i++) need.set(`a:${i}`, 0);
  for (let i = 0; i < arityB; i++) need.set(`b:${i}`, 0);
  rule.creates.forEach((symbol, index) => {
    const arity = arityOf(alphabet, symbol);
    for (let port = 0; port <= arity; port++) need.set(`n${index}:${port}`, 0);
  });

  for (const [x, y] of rule.links) {
    for (const slot of [x, y]) {
      if (slot.kind === "interface") {
        const arity = slot.side === "a" ? arityA : arityB;
        if (slot.index < 0 || slot.index >= arity) {
          problems.push(`link references ${slot.side}.aux[${slot.index}] but arity is ${arity}`);
          continue;
        }
        bump(`${slot.side}:${slot.index}`);
      } else {
        const created = rule.creates[slot.agent];
        if (created === undefined) {
          problems.push(`link references created agent ${slot.agent}, which does not exist`);
          continue;
        }
        const arity = arityOf(alphabet, created);
        if (slot.port < 0 || slot.port > arity) {
          problems.push(`link references ${created}[${slot.agent}].port ${slot.port}, arity ${arity}`);
          continue;
        }
        bump(`n${slot.agent}:${slot.port}`);
      }
    }
  }

  for (const [key, count] of need) {
    if (count !== 1) problems.push(`port ${key} is wired ${count} times, must be exactly 1`);
  }

  // Parity is implied by the above, but check it separately so a failure says
  // WHY the rule could not have been written rather than listing every port.
  const ports = arityA + arityB + rule.creates.reduce((n, s) => n + arityOf(alphabet, s) + 1, 0);
  if (ports % 2 !== 0) {
    problems.push(
      `parity: ${ports} ports cannot be paired up — a rule for ${symA}(${arityA}) ⋈ ${symB}(${arityB}) ` +
        `must create agents whose (arity + 1) sums to an even number`,
    );
  }
  return problems;
}

/** Validate a whole alphabet. Returns an empty array when it is sound. */
export function validateAlphabet(alphabet: Alphabet): RuleProblem[] {
  const problems: RuleProblem[] = [];
  const seen = new Set<string>();
  for (const def of alphabet.symbols) {
    if (seen.has(def.symbol)) problems.push({ pair: def.symbol, message: "duplicate symbol" });
    seen.add(def.symbol);
    if (def.arity < 0) problems.push({ pair: def.symbol, message: "negative arity" });
  }
  for (const [key, rule] of alphabet.rules) {
    const [symA, symB] = key.split(" ");
    if (!seen.has(symA) || !seen.has(symB)) {
      problems.push({ pair: `${symA} ⋈ ${symB}`, message: "rule references an unknown symbol" });
      continue;
    }
    for (const created of rule.creates) {
      if (!seen.has(created)) {
        problems.push({ pair: `${symA} ⋈ ${symB}`, message: `creates unknown symbol ${created}` });
      }
    }
    for (const message of validateRule(alphabet, symA, symB, rule)) {
      problems.push({ pair: `${symA} ⋈ ${symB}`, message });
    }
  }
  return problems;
}

// --- The base combinators, as data -------------------------------------------------

/**
 * The uniform rule, written out as a rule table: same symbol annihilates,
 * different symbols commute, and erasure falls out at arity 0. Generating it
 * rather than hand-writing six rules keeps it identical to the formulation the
 * confluence tests were written against.
 */
export function uniformRule(symA: Sym, arityA: number, symB: Sym, arityB: number): Rule {
  if (symA === symB) {
    return {
      verb: "annihilate",
      creates: [],
      links: Array.from({ length: arityA }, (_, j) => [ifaceSlot("a", j), ifaceSlot("b", j)] as const),
    };
  }
  // n copies of α take over β's aux wires, m copies of β take over α's.
  const creates: Sym[] = [
    ...Array.from({ length: arityB }, () => symA),
    ...Array.from({ length: arityA }, () => symB),
  ];
  const links: Array<readonly [Slot, Slot]> = [];
  for (let k = 0; k < arityB; k++) links.push([ifaceSlot("b", k), agentSlot(k, 0)]);
  for (let j = 0; j < arityA; j++) links.push([ifaceSlot("a", j), agentSlot(arityB + j, 0)]);
  for (let k = 0; k < arityB; k++) {
    for (let j = 0; j < arityA; j++) {
      links.push([agentSlot(k, j + 1), agentSlot(arityB + j, k + 1)]);
    }
  }
  const verb = arityA === 0 || arityB === 0 ? "erase" : "commute";
  return { verb, creates, links };
}

/** Build the full uniform rule table over a set of symbols. */
export function uniformRules(symbols: readonly SymbolDef[]): Map<string, Rule> {
  const rules = new Map<string, Rule>();
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i; j < symbols.length; j++) {
      const [a, b] = [symbols[i], symbols[j]];
      rules.set(pairKey(a.symbol, b.symbol), uniformRule(a.symbol, a.arity, b.symbol, b.arity));
    }
  }
  return rules;
}

const BASE_SYMBOLS: readonly SymbolDef[] = [
  {
    symbol: "γ",
    arity: 2,
    name: "constructor",
    color: { a: "#7CF29B", b: "#27B36B", glow: "rgba(124,242,155,0.55)" },
  },
  {
    symbol: "δ",
    arity: 2,
    name: "duplicator",
    color: { a: "#FFC46B", b: "#F0862B", glow: "rgba(255,196,107,0.55)" },
  },
  {
    symbol: "ε",
    arity: 0,
    name: "eraser",
    color: { a: "#ff9be0", b: "#d24fb8", glow: "rgba(255,155,224,0.55)" },
  },
];

/** Lafont's interaction combinators — the control to measure others against. */
export const BASE: Alphabet = {
  id: "base",
  name: "Interaction combinators",
  blurb: "γ δ ε with the uniform rule: same annihilates, different commutes.",
  symbols: BASE_SYMBOLS,
  rules: uniformRules(BASE_SYMBOLS),
};

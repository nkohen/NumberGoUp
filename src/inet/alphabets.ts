/**
 * Candidate alphabets — the search for a more interesting rule set.
 *
 * THE PROBLEM WITH γ δ ε. It has exactly three verbs: annihilate, commute,
 * erase. Commuting makes the net bigger and is nearly always a mistake, so a
 * "clear the net" game on the base combinators is only ever "match the symbol,
 * or burn it". Two mechanics.
 *
 * The deeper cause is structural: **no base rule turns two agents into one**.
 * Every rule either removes both or multiplies them, so a net can shrink by two
 * or grow, and there is no middle gear — no grinding an enemy down.
 *
 * That gap is a PARITY problem, not a failure of imagination. The ports a rule
 * must pair up number m + n + Σ(arity + 1) over created agents. For two binary
 * agents that is 4 + Σ, and every arity-2 or arity-0 agent contributes an ODD
 * number, so a legal rule creates an even count of them. "These two fuse into
 * one node" is arithmetically impossible with binary and nullary symbols alone.
 *
 * Arity 1 and arity 3 contribute an EVEN number and lift the restriction. So
 * every alphabet below carries at least one odd-arity symbol, and that is what
 * buys the verbs the base system cannot express.
 */
import {
  agentSlot,
  BASE,
  ifaceSlot,
  pairKey,
  uniformRule,
  type Alphabet,
  type Rule,
  type Slot,
  type Sym,
  type SymbolDef,
} from "./alphabet";

export { BASE };

// --- A small DSL, because raw Slot arrays are unreadable ---------------------------

/**
 * Slot shorthand:
 *   "a0" / "b1"   the vanishing agents' auxiliary ports
 *   "n0"          the principal port of the 0th created agent
 *   "n0.1"        auxiliary port 1 of the 0th created agent
 */
function parseSlot(text: string): Slot {
  if (text[0] === "a" || text[0] === "b") {
    return ifaceSlot(text[0] as "a" | "b", Number(text.slice(1)));
  }
  const [head, auxIndex] = text.split(".");
  const agent = Number(head.slice(1));
  return agentSlot(agent, auxIndex === undefined ? 0 : Number(auxIndex) + 1);
}

function flipSide(slot: Slot): Slot {
  if (slot.kind !== "interface") return slot;
  return ifaceSlot(slot.side === "a" ? "b" : "a", slot.index);
}

interface Draft {
  symA: Sym;
  symB: Sym;
  rule: Rule;
}

/**
 * Declare a rule for a pair, written with `symA` as side "a". Rules are stored
 * once per unordered pair, so if the symbols are not in sorted order this
 * rewrites the sides — which means rules can always be written in whichever
 * direction reads naturally.
 */
function rule(
  symA: Sym,
  symB: Sym,
  verb: string,
  creates: Sym[],
  links: Array<[string, string]>,
): Draft {
  const parsed = links.map(([x, y]) => [parseSlot(x), parseSlot(y)] as const);
  if (symA <= symB) return { symA, symB, rule: { verb, creates, links: parsed } };
  return {
    symA: symB,
    symB: symA,
    rule: { verb, creates, links: parsed.map(([x, y]) => [flipSide(x), flipSide(y)] as const) },
  };
}

/** Annihilation: both vanish, aux wires threaded through pairwise. */
function annihilate(symA: Sym, symB: Sym, arity: number): Draft {
  return rule(
    symA,
    symB,
    "annihilate",
    [],
    Array.from({ length: arity }, (_, i) => [`a${i}`, `b${i}`] as [string, string]),
  );
}

function build(
  id: string,
  name: string,
  blurb: string,
  symbols: SymbolDef[],
  drafts: Draft[],
  options: { uniformRest?: boolean } = {},
): Alphabet {
  const rules = new Map<string, Rule>();
  for (const draft of drafts) rules.set(pairKey(draft.symA, draft.symB), draft.rule);
  if (options.uniformRest) {
    // Anything not given an explicit rule falls back to the uniform one, so an
    // alphabet only has to spell out the pairs it wants to be interesting.
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i; j < symbols.length; j++) {
        const [x, y] = [symbols[i], symbols[j]];
        const key = pairKey(x.symbol, y.symbol);
        if (rules.has(key)) continue;
        const [first, second] = x.symbol <= y.symbol ? [x, y] : [y, x];
        rules.set(key, uniformRule(first.symbol, first.arity, second.symbol, second.arity));
      }
    }
  }
  return { id, name, blurb, symbols, rules };
}

const C = {
  green: { a: "#7CF29B", b: "#27B36B", glow: "rgba(124,242,155,0.55)" },
  amber: { a: "#FFC46B", b: "#F0862B", glow: "rgba(255,196,107,0.55)" },
  pink: { a: "#ff9be0", b: "#d24fb8", glow: "rgba(255,155,224,0.55)" },
  cyan: { a: "#7ee6ff", b: "#2b9fd6", glow: "rgba(126,230,255,0.55)" },
  violet: { a: "#b79bff", b: "#7a4fe0", glow: "rgba(183,155,255,0.55)" },
  red: { a: "#ff8a8a", b: "#d63b4f", glow: "rgba(255,138,138,0.55)" },
};

// --- Forge: fuse, convert, cut ---------------------------------------------------------

const FORGE_SYMBOLS: SymbolDef[] = [
  { symbol: "▲", arity: 2, name: "prism", color: C.cyan },
  { symbol: "■", arity: 2, name: "block", color: C.amber },
  { symbol: "✦", arity: 1, name: "spark", color: C.violet },
  { symbol: "✕", arity: 0, name: "void", color: C.pink },
];

/**
 * The main candidate. Its point is the FUSE rule: two binary agents collapse
 * into a single unary one, and their spare wires are joined to each other. That
 * is the middle gear the base system cannot express — the net gets smaller
 * without the eraser's fan-out, and the interface closes by one wire at the same
 * time.
 *
 * The three non-obvious rules form a small economy:
 *
 *   ▲ ⋈ ■   fuse     two binaries collapse into one ✦, spare wires joined
 *   ✦ ⋈ ■   convert  the spark rewrites a block into a prism and is spent
 *   ✦ ⋈ ▲   cut      the spark guts a prism, leaving a ✕ to burn onward
 *
 * so a stuck position has outs other than "burn it": soften a block into a prism
 * and mirror it, or fuse a pair down and annihilate the spark. Matching a symbol
 * is still the cheapest kill when it is available, which is what keeps the
 * annihilation lesson intact.
 */
export const FORGE: Alphabet = build(
  "forge",
  "Forge",
  "Binary agents fuse into a unary spark; sparks convert and cut. Five verbs.",
  FORGE_SYMBOLS,
  [
    annihilate("▲", "▲", 2),
    annihilate("■", "■", 2),
    annihilate("✦", "✦", 1),
    annihilate("✕", "✕", 0),
    // Two binaries collapse into one unary, and the spare wires join up.
    rule("▲", "■", "fuse", ["✦"], [
      ["a0", "n0"],
      ["b0", "n0.0"],
      ["a1", "b1"],
    ]),
    // A spark rewrites a block into a prism, spending itself.
    rule("✦", "■", "convert", ["▲"], [
      ["a0", "n0"],
      ["b0", "n0.0"],
      ["b1", "n0.1"],
    ]),
    // A spark guts a prism: one branch is voided, the other threads through.
    rule("✦", "▲", "cut", ["✕"], [
      ["b0", "n0"],
      ["a0", "b1"],
    ]),
  ],
  { uniformRest: true }, // ✕ against everything is the usual erasure
);

// --- Cascade: every rule leaves something reacting ------------------------------------

const CASCADE_SYMBOLS: SymbolDef[] = [
  { symbol: "◆", arity: 2, name: "cell", color: C.green },
  { symbol: "◇", arity: 2, name: "shell", color: C.cyan },
  { symbol: "↯", arity: 1, name: "jolt", color: C.amber },
  { symbol: "✕", arity: 0, name: "void", color: C.pink },
];

/**
 * Tuned for chain reactions rather than economy: the ◆ ⋈ ◇ rule emits a ↯ whose
 * PRINCIPAL port takes over an interface wire, so it immediately faces whatever
 * was there and often reacts again without another card. The question this
 * alphabet is meant to answer is whether cascades alone make a level satisfying,
 * or whether they just make the outcome hard to predict.
 */
export const CASCADE: Alphabet = build(
  "cascade",
  "Cascade",
  "Rules emit live agents that keep reacting — one card can set off a chain.",
  CASCADE_SYMBOLS,
  [
    annihilate("◆", "◆", 2),
    annihilate("◇", "◇", 2),
    annihilate("↯", "↯", 1),
    annihilate("✕", "✕", 0),
    // A jolt is left facing one of the shell's old wires, ready to go again.
    rule("◆", "◇", "spark", ["↯"], [
      ["b0", "n0"],
      ["a0", "n0.0"],
      ["a1", "b1"],
    ]),
    // The jolt tears a cell open into a fresh jolt plus a void.
    rule("↯", "◆", "tear", ["↯", "✕"], [
      ["b0", "n0"],
      ["a0", "n0.0"],
      ["b1", "n1"],
    ]),
    // Against a shell it simply passes through, rewiring it.
    rule("↯", "◇", "pierce", ["✕"], [
      ["b0", "n0"],
      ["a0", "b1"],
    ]),
  ],
  { uniformRest: true },
);

// --- Warded: armour, via pairs with no rule at all ---------------------------------------

const WARDED_SYMBOLS: SymbolDef[] = [
  { symbol: "○", arity: 2, name: "node", color: C.green },
  { symbol: "▣", arity: 2, name: "ward", color: C.red },
  { symbol: "⚷", arity: 1, name: "key", color: C.violet },
  { symbol: "✕", arity: 0, name: "void", color: C.pink },
];

/**
 * Uses DEADLOCK as a design tool: ▣ has no rule against ✕ or ○, so it cannot be
 * burned or matched — only a ⚷ opens it. That should force real target
 * selection, at the risk of making levels unsolvable when the key is missing,
 * which is exactly what the measurements are for.
 */
export const WARDED: Alphabet = build(
  "warded",
  "Warded",
  "The ward is immune to fire and to its own kind. Only the key opens it.",
  WARDED_SYMBOLS,
  [
    annihilate("○", "○", 2),
    annihilate("⚷", "⚷", 1),
    annihilate("✕", "✕", 0),
    // The key opens a ward: both vanish, and the ward's wires thread through.
    rule("⚷", "▣", "unlock", ["✕"], [
      ["b0", "n0"],
      ["a0", "b1"],
    ]),
    // A key against a plain node just slips past, rewiring it.
    rule("⚷", "○", "slip", ["○"], [
      ["a0", "n0"],
      ["b0", "n0.0"],
      ["b1", "n0.1"],
    ]),
    rule("○", "▣", "chip", ["⚷"], [
      ["a0", "n0"],
      ["b0", "n0.0"],
      ["a1", "b1"],
    ]),
    // ▣ ⋈ ▣ and ▣ ⋈ ✕ are deliberately ABSENT: a ward cannot be burned, and two
    // wards facing each other are a permanent deadlock.
  ],
  { uniformRest: false },
);

// Fill in only the pairs Warded does not deliberately leave open.
const wardedRules = WARDED.rules as Map<string, Rule>;
for (const [x, y] of [
  ["○", "✕"],
  ["⚷", "✕"],
] as Array<[Sym, Sym]>) {
  const ax = WARDED_SYMBOLS.find((s) => s.symbol === x)!;
  const ay = WARDED_SYMBOLS.find((s) => s.symbol === y)!;
  const [first, second] = ax.symbol <= ay.symbol ? [ax, ay] : [ay, ax];
  wardedRules.set(
    pairKey(x, y),
    uniformRule(first.symbol, first.arity, second.symbol, second.arity),
  );
}

// --- Inverted: take away the two answers the base game leans on -------------------

const INVERTED_SYMBOLS: SymbolDef[] = [
  { symbol: "○", arity: 2, name: "node", color: C.green },
  { symbol: "□", arity: 2, name: "shell", color: C.cyan },
  { symbol: "†", arity: 1, name: "spike", color: C.violet },
  { symbol: "✕", arity: 0, name: "void", color: C.pink },
];

/**
 * Distilled from the random rule-table search, which beat every hand-design
 * here. The generated winner did two things no designer starting from the base
 * combinators would try, and between them they are the whole idea:
 *
 *   1. THE BINARY SYMBOLS CANNOT ANNIHILATE WITH THEMSELVES. ○ ⋈ ○ and □ ⋈ □
 *      have no rule at all. "Match the symbol" — the base game's one reliable
 *      move — simply does not exist against the enemy's building blocks.
 *   2. THE VOID DOES NOT ERASE EVERYTHING. Against a node it TEMPERS: the node
 *      hardens into a shell and the void survives. So "burn it" is not a
 *      universal answer either.
 *
 * What is left is a route rather than a move. A node must be whittled by a
 * spike, or sheared against a shell into two spikes which then annihilate each
 * other; a shell is immune to spikes and has to be burned. Every kill is at
 * least two steps and the first step is rarely the one that looks productive,
 * which is why a greedy "remove the most agents now" policy does so badly here.
 */
export const INVERTED: Alphabet = build(
  "inverted",
  "Inverted",
  "Binaries cannot match, and fire hardens instead of killing. Every kill is a route.",
  INVERTED_SYMBOLS,
  [
    // Only the odd-arity symbols may annihilate.
    annihilate("†", "†", 1),
    annihilate("✕", "✕", 0),
    // Two binaries shear each other into a pair of spikes.
    rule("○", "□", "shear", ["†", "†"], [
      ["a0", "n0"],
      ["b0", "n0.0"],
      ["a1", "n1"],
      ["b1", "n1.0"],
    ]),
    // A spike whittles a node down: a fresh spike takes one branch, the other
    // is capped by a void that keeps burning.
    rule("†", "○", "whittle", ["†", "✕"], [
      ["b0", "n0"],
      ["a0", "n0.0"],
      ["b1", "n1"],
    ]),
    // Fire does not kill a node — it hardens it into a shell.
    rule("○", "✕", "temper", ["□", "✕"], [
      ["a0", "n0"],
      ["a1", "n0.0"],
      ["n0.1", "n1"],
    ]),
    // Shells burn normally, and spikes snuff out.
    rule("□", "✕", "burn", ["✕", "✕"], [
      ["a0", "n0"],
      ["a1", "n1"],
    ]),
    rule("†", "✕", "snuff", ["✕"], [["a0", "n0"]]),
    // ○ ⋈ ○, □ ⋈ □ and □ ⋈ † are deliberately ABSENT.
  ],
  { uniformRest: false },
);

export const ALPHABETS: readonly Alphabet[] = [BASE, FORGE, CASCADE, WARDED, INVERTED];

export function alphabetById(id: string): Alphabet | undefined {
  return ALPHABETS.find((a) => a.id === id);
}

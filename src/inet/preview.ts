/**
 * "What happens if I play this here?"
 *
 * The arithmetic game previews a placement by showing the number the tree would
 * evaluate to. The equivalent here has two halves, because a net move has two
 * questions attached to it:
 *
 *   WHICH RULE fires — the pair, its verb, and what it leaves behind. Reading
 *   this off the rule table by hand is possible but tedious, and it is the thing
 *   a player is actually reasoning about.
 *
 *   WHAT THE NET BECOMES once the dust settles — how many interactions run, how
 *   many agents are left, whether that clears the board. Found by simply doing
 *   it on a clone, which is exact rather than an estimate, and cheap because the
 *   nets are small.
 *
 * Pure and DOM-free.
 */
import { lookupRule } from "./alphabet";
import { applyMove, type Move } from "./level";
import { isFree, Net, type Sym } from "./net";
import { reduce } from "./reduce";

export type PreviewKind =
  /** A rule fires. */
  | "reaction"
  /** Legal, but nothing reacts — the card just builds structure. */
  | "inert"
  /** The two would face each other with no rule between them, forever. */
  | "deadlock"
  /** The wire has no agent at the far end at all. */
  | "loose";

export interface RulePreview {
  kind: PreviewKind;
  /** e.g. "† ⋈ ○", or "†  ○.aux" for an inert placement. */
  pair: string;
  verb: string | null;
  /** e.g. "→ † + ✕", or "→ nothing". */
  result: string | null;
  /** One sentence a player can act on. */
  detail: string;
}

export interface MoveOutcome {
  interactions: number;
  agentsBefore: number;
  agentsAfter: number;
  cleared: boolean;
  /** The move sets off something that does not settle — almost never wanted. */
  diverged: boolean;
}

export interface Preview {
  rule: RulePreview;
  outcome: MoveOutcome;
}

function describe(creates: readonly Sym[]): string {
  if (creates.length === 0) return "Both agents vanish; their loose wires thread through to each other.";
  if (creates.length === 1) return `Both agents are replaced by a single ${creates[0]}.`;
  return `Both agents are replaced by ${creates.join(" + ")}.`;
}

/** The rule that would fire when a new `symbol` is plugged into a free wire. */
export function previewPlug(net: Net, freeId: number, symbol: Sym): RulePreview {
  const far = net.follow({ free: freeId });
  if (!far || isFree(far)) {
    return {
      kind: "loose",
      pair: symbol,
      verb: null,
      result: null,
      detail: "This wire has no agent at the far end, so the card would just sit on it.",
    };
  }
  const other = net.agent(far.agent);
  if (!other) {
    return { kind: "loose", pair: symbol, verb: null, result: null, detail: "Nothing at the far end." };
  }
  if (far.port !== 0) {
    return {
      kind: "inert",
      pair: `${symbol} → ${other.symbol} aux${far.port - 1}`,
      verb: null,
      result: null,
      detail:
        "This wire leads to an auxiliary port, so nothing reacts — the card only builds structure.",
    };
  }
  const found = lookupRule(net.alphabet, symbol, other.symbol);
  if (!found) {
    return {
      kind: "deadlock",
      pair: `${symbol} ⋈ ${other.symbol}`,
      verb: null,
      result: null,
      detail: "No rule for this pair: the two would face each other forever, stuck.",
    };
  }
  return {
    kind: "reaction",
    pair: `${symbol} ⋈ ${other.symbol}`,
    verb: found.rule.verb,
    result: found.rule.creates.length ? `→ ${found.rule.creates.join(" + ")}` : "→ nothing",
    detail: describe(found.rule.creates),
  };
}

/** The rule that would fire when two loose ends are spliced together. */
export function previewSplice(net: Net, a: number, b: number): RulePreview {
  const fa = net.follow({ free: a });
  const fb = net.follow({ free: b });
  if (!fa || !fb || isFree(fa) || isFree(fb)) {
    return {
      kind: "loose",
      pair: "wire",
      verb: null,
      result: null,
      detail: "Joins the two wires. At least one has no agent on it, so nothing reacts.",
    };
  }
  if (fa.port !== 0 || fb.port !== 0) {
    return {
      kind: "inert",
      pair: "wire",
      verb: null,
      result: null,
      detail:
        "Joins the two wires. A reaction needs BOTH ends to be principal ports, and at least one is not.",
    };
  }
  const symA = net.agent(fa.agent)!.symbol;
  const symB = net.agent(fb.agent)!.symbol;
  const found = lookupRule(net.alphabet, symA, symB);
  if (!found) {
    return {
      kind: "deadlock",
      pair: `${symA} ⋈ ${symB}`,
      verb: null,
      result: null,
      detail: "Would put these two face to face with no rule between them — stuck forever.",
    };
  }
  return {
    kind: "reaction",
    pair: `${symA} ⋈ ${symB}`,
    verb: found.rule.verb,
    result: found.rule.creates.length ? `→ ${found.rule.creates.join(" + ")}` : "→ nothing",
    detail: describe(found.rule.creates),
  };
}

/** Play the move on a clone and run it out, to report exactly what it leads to. */
export function outcomeOf(net: Net, move: Move, fuel = 2000): MoveOutcome {
  const copy = net.clone();
  const agentsBefore = copy.agentCount;
  if (!applyMove(copy, move)) {
    return { interactions: 0, agentsBefore, agentsAfter: agentsBefore, cleared: false, diverged: false };
  }
  const result = reduce(copy, { fuel });
  return {
    interactions: result.interactions,
    agentsBefore,
    agentsAfter: copy.agentCount,
    cleared: copy.agentCount === 0,
    diverged: result.fuelExhausted,
  };
}

/** Both halves of the preview for a move. */
export function previewMove(net: Net, move: Move): Preview {
  const rule =
    move.kind === "plug"
      ? previewPlug(net, move.free, move.symbol)
      : previewSplice(net, move.a, move.b);
  return { rule, outcome: outcomeOf(net, move) };
}

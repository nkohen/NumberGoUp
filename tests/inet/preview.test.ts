import { describe, it, expect } from "vitest";
import { INVERTED, WARDED } from "../../src/inet/alphabets";
import { aux, Net, principal, type Endpoint } from "../../src/inet/net";
import { outcomeOf, previewMove, previewPlug, previewSplice } from "../../src/inet/preview";

/** The free port on `port`, which addAgentWired guarantees exists. */
function freeOn(net: Net, e: Endpoint): number {
  const q = net.follow(e)!;
  if (!("free" in q)) throw new Error("expected a free port");
  return q.free;
}

describe("move preview", () => {
  it("names the rule that would fire, and what it leaves behind", () => {
    const net = new Net();
    const g = net.addAgentWired("γ");
    const preview = previewPlug(net, freeOn(net, principal(g.id)), "γ");
    expect(preview.kind).toBe("reaction");
    expect(preview.pair).toBe("γ ⋈ γ");
    expect(preview.verb).toBe("annihilate");
    expect(preview.result).toBe("→ nothing");
  });

  it("reports a placement onto an aux wire as inert rather than as a reaction", () => {
    const net = new Net();
    const g = net.addAgentWired("γ");
    const preview = previewPlug(net, freeOn(net, aux(g.id, 0)), "γ");
    expect(preview.kind).toBe("inert");
    expect(preview.detail).toContain("auxiliary port");
  });

  it("warns about a pair the alphabet has no rule for", () => {
    // Warded's ward is immune to fire: ▣ ⋈ ✕ has no rule.
    const net = new Net(WARDED);
    const ward = net.addAgentWired("▣");
    const preview = previewPlug(net, freeOn(net, principal(ward.id)), "✕");
    expect(preview.kind).toBe("deadlock");
    expect(preview.detail).toContain("stuck");
  });

  it("flags Inverted's trap: fire hardens a node instead of killing it", () => {
    const net = new Net(INVERTED);
    const node = net.addAgentWired("○");
    const free = freeOn(net, principal(node.id));
    const preview = previewPlug(net, free, "✕");
    expect(preview.kind).toBe("reaction");
    expect(preview.verb).toBe("temper");
    expect(preview.result).toBe("→ □ + ✕");

    // And the outcome makes the trap concrete: the agent count does not drop.
    const outcome = outcomeOf(net, { kind: "plug", free, symbol: "✕" });
    expect(outcome.agentsBefore).toBe(1);
    expect(outcome.agentsAfter).toBe(2);
    expect(outcome.cleared).toBe(false);
  });

  it("computes the outcome by actually doing it, not estimating", () => {
    const net = new Net();
    const g = net.addAgentWired("γ");
    const free = freeOn(net, principal(g.id));
    const { rule, outcome } = previewMove(net, { kind: "plug", free, symbol: "γ" });
    expect(rule.verb).toBe("annihilate");
    expect(outcome.interactions).toBe(1);
    expect(outcome.agentsAfter).toBe(0);
    expect(outcome.cleared).toBe(true);
    // Previewing must not disturb the real net.
    expect(net.agentCount).toBe(1);
  });

  it("previews a splice only as a reaction when BOTH ends are principal", () => {
    const net = new Net();
    const a = net.addAgentWired("γ");
    const b = net.addAgentWired("γ");
    const both = previewSplice(net, freeOn(net, principal(a.id)), freeOn(net, principal(b.id)));
    expect(both.kind).toBe("reaction");
    expect(both.verb).toBe("annihilate");

    const oneAux = previewSplice(net, freeOn(net, principal(a.id)), freeOn(net, aux(b.id, 0)));
    expect(oneAux.kind).toBe("inert");
    expect(oneAux.detail).toContain("BOTH ends");
  });

  it("describes a wire with nothing on the far end", () => {
    const net = new Net();
    const f1 = net.addFree();
    const f2 = net.addFree();
    net.link(f1, f2);
    expect(previewPlug(net, f1.free, "γ").kind).toBe("loose");
  });

  it("reports a move that sets off a chain, with the interaction count", () => {
    // An eraser on the root of a small tree: one card, several interactions.
    const net = new Net();
    const root = net.addAgentWired("γ");
    const kid = net.addAgentWired("γ");
    net.link(aux(root.id, 0), principal(kid.id));
    const free = freeOn(net, principal(root.id));
    const { outcome } = previewMove(net, { kind: "plug", free, symbol: "ε" });
    expect(outcome.interactions).toBeGreaterThan(1);
    expect(outcome.diverged).toBe(false);
  });
});

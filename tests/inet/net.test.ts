import { describe, it, expect } from "vitest";
import {
  Net,
  NetError,
  aux,
  endpointKey,
  isFree,
  principal,
  portsOf,
} from "../../src/inet/net";

describe("net data model", () => {
  it("wires every port of a fresh agent to a free port", () => {
    const net = new Net();
    const g = net.addAgentWired("γ");
    expect(g.arity).toBe(2);
    expect(net.freePorts().length).toBe(3);
    net.assertWellFormed();
    for (const p of portsOf(g)) expect(isFree(net.follow(p)!)).toBe(true);
  });

  it("an eraser has only a principal port", () => {
    const net = new Net();
    const e = net.addAgentWired("ε");
    expect(e.arity).toBe(0);
    expect(portsOf(e)).toHaveLength(1);
    net.assertWellFormed();
  });

  it("linking two agent ports consumes the free ports that held them", () => {
    const net = new Net();
    const a = net.addAgentWired("γ");
    const b = net.addAgentWired("δ");
    expect(net.freePorts().length).toBe(6);
    net.link(principal(a.id), principal(b.id));
    expect(net.freePorts().length).toBe(4);
    expect(net.follow(principal(a.id))).toEqual(principal(b.id));
    expect(net.follow(principal(b.id))).toEqual(principal(a.id));
    net.assertWellFormed();
  });

  it("unlinking gives both agent ports a fresh free port again", () => {
    const net = new Net();
    const a = net.addAgentWired("γ");
    const b = net.addAgentWired("δ");
    net.link(principal(a.id), principal(b.id));
    net.unlink(principal(a.id));
    expect(net.freePorts().length).toBe(6);
    expect(isFree(net.follow(principal(a.id))!)).toBe(true);
    expect(isFree(net.follow(principal(b.id))!)).toBe(true);
    net.assertWellFormed();
  });

  it("relinking an agent port re-frees the port it abandoned", () => {
    const net = new Net();
    const a = net.addAgentWired("γ");
    const b = net.addAgentWired("γ");
    const c = net.addAgentWired("γ");
    net.link(principal(a.id), principal(b.id));
    net.link(principal(a.id), principal(c.id));
    expect(net.follow(principal(a.id))).toEqual(principal(c.id));
    expect(isFree(net.follow(principal(b.id))!)).toBe(true);
    net.assertWellFormed();
  });

  it("supports agent-free wires between two free ports", () => {
    const net = new Net();
    const f1 = net.addFree();
    const f2 = net.addFree();
    net.link(f1, f2);
    net.assertWellFormed();
    expect(net.agentCount).toBe(0);
    expect(net.follow(f1)).toEqual(f2);
    expect(net.wires()).toHaveLength(1);
  });

  it("tolerates a wire that closes on itself", () => {
    const net = new Net();
    const f1 = net.addFree();
    const f2 = net.addFree();
    net.link(f1, f2);
    net.link(f1, f1); // f2 goes with the wire it was the other end of
    expect(net.freePorts()).toEqual([f1.free]);
    expect(net.follow(f1)).toEqual(f1);
    expect(net.wires()).toHaveLength(1);
    net.assertWellFormed();
  });

  it("assertWellFormed catches a dangling port", () => {
    const net = new Net();
    net.addAgent("γ"); // bare: ports intentionally left dangling
    expect(() => net.assertWellFormed()).toThrow(NetError);
    expect(net.danglingPorts()).toHaveLength(3);
  });

  it("deleteAgent leaves free ports where the agent was attached", () => {
    const net = new Net();
    const a = net.addAgentWired("γ");
    const b = net.addAgentWired("γ");
    net.link(principal(a.id), aux(b.id, 0));
    net.deleteAgent(a.id);
    expect(net.agentCount).toBe(1);
    expect(isFree(net.follow(aux(b.id, 0))!)).toBe(true);
    net.assertWellFormed();
  });

  it("clone is independent of the original", () => {
    const net = new Net();
    const a = net.addAgentWired("γ");
    const copy = net.clone();
    expect(copy.signature()).toBe(net.signature());
    net.link(aux(a.id, 0), aux(a.id, 1));
    expect(copy.signature()).not.toBe(net.signature());
    copy.assertWellFormed();
    net.assertWellFormed();
  });

  it("signature distinguishes structure and ignores nothing that matters", () => {
    const build = (crossed: boolean): Net => {
      const net = new Net();
      const a = net.addAgentWired("γ");
      const b = net.addAgentWired("γ");
      net.link(principal(a.id), principal(b.id));
      if (crossed) net.link(aux(a.id, 0), aux(b.id, 1));
      return net;
    };
    expect(build(false).signature()).toBe(build(false).signature());
    expect(build(true).signature()).not.toBe(build(false).signature());
  });

  it("splicing two loose ends joins the wires instead of stranding them", () => {
    // The sandbox's wiring gesture: a free port is the loose END of a wire, so
    // clicking two of them must connect what is at the far end of each. Linking
    // the free ports directly would cut both agents loose and leave a stranded
    // free-to-free wire behind — the bug this pins.
    const net = new Net();
    const a = net.addAgentWired("γ");
    const b = net.addAgentWired("δ");
    const looseA = net.follow(aux(a.id, 0))!;
    const looseB = net.follow(aux(b.id, 1))!;
    expect(isFree(looseA)).toBe(true);
    expect(isFree(looseB)).toBe(true);
    const freeBefore = net.freePorts().length;

    // Splice: link what each loose end is attached to.
    net.link(net.follow(looseA)!, net.follow(looseB)!);
    net.assertWellFormed("after splice");

    expect(net.follow(aux(a.id, 0))).toEqual(aux(b.id, 1));
    // Both free ports went with the wire halves they belonged to; no new ones.
    expect(net.freePorts().length).toBe(freeBefore - 2);
    expect(net.wires().every(([x, y]) => !(isFree(x) && isFree(y)))).toBe(true);
  });

  it("endpointKey round-trips", () => {
    expect(endpointKey({ agent: 3, port: 2 })).toBe("3:2");
    expect(endpointKey({ free: 7 })).toBe("f7");
  });
});

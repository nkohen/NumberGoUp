/**
 * Port geometry and layout relaxation.
 *
 * This module owns the canonical answer to "where is port *p* of this agent,
 * on screen" — both the renderer and the relaxer need it, and they must not be
 * allowed to disagree, or wires would attach somewhere other than the corner
 * they appear to attach to.
 *
 * Agents and free ports can ROTATE. Each has an `angle`, and its ports rotate
 * with it. A
 * γ or δ is drawn as a triangle whose corners are its ports, so rotating it to
 * aim each corner at whatever that port is wired to removes most of the visual
 * tangle for free: children hang off the corner that points at them, and the two
 * halves of a redex end up nose to nose.
 *
 * The rest angle has a closed form. We want the rotation θ that best aligns
 * every port with the direction of its partner, i.e. that maximises
 *
 *     Σ_p w_p · cos( (want_p − base_p) − θ )
 *
 * which is just the weighted circular mean of the per-port corrections:
 *
 *     θ = atan2( Σ w_p sin(want_p − base_p), Σ w_p cos(want_p − base_p) )
 *
 * No iteration, no local minima. The principal port is weighted more heavily
 * than the auxiliary ones because "principal meets principal" is the entire
 * reduction rule, so that is the wire the eye should be able to follow.
 *
 * POSITIONS are then settled by a small energy minimisation: wires act as
 * springs, agents and free ports push each other apart, and tree edges get a
 * "child below parent" bias so a net keeps reading top-down.
 *
 * The important term is the ANCHOR. An agent that came from the tidy tree
 * layout is held to that position by a strong spring, because the tidy layout is
 * better than anything relaxation would discover — so relaxation only nudges it.
 * An agent created by a rewrite has no anchor and settles freely. That split is
 * the whole design: the structural layout is preserved where it exists, and
 * energy minimisation cleans up exactly the part that would otherwise be a
 * jumble.
 *
 * Pure and DOM-free; see `tests/inet/relax.test.ts`.
 */
import { isFree, portsOf, type AgentId, type Endpoint, type Net } from "./net";

export interface Point {
  x: number;
  y: number;
}

export interface AgentPlacement extends Point {
  /** Rotation in radians. 0 puts the principal port straight up. */
  angle: number;
  /** Held in place (the user is dragging it). */
  pinned?: boolean;
  /** Tidy-layout position this agent is weakly held to, if it has one. */
  anchor?: Point | null;
}

export interface FreePlacement extends Point {
  /**
   * Rotation, same convention as an agent: 0 points the terminus straight up.
   * A free port is the loose end of a wire, so it has exactly one "port" and it
   * should face whatever is on the other end.
   */
  angle: number;
  pinned?: boolean;
}

export interface Placements {
  agents: Map<AgentId, AgentPlacement>;
  free: Map<number, FreePlacement>;
}

/** How much more the principal port counts than an aux port when aiming. */
const PRINCIPAL_WEIGHT = 2.6;

/** The direction port `port` faces in an unrotated agent, in radians. */
export function portBaseAngle(arity: number, port: number): number {
  if (port === 0) return -Math.PI / 2; // principal: straight up
  if (arity <= 1) return Math.PI / 2;
  return Math.PI * (0.75 - (0.5 * (port - 1)) / (arity - 1));
}

/** Unit vector port `port` faces, for an agent rotated by `angle`. */
export function portDirection(arity: number, port: number, angle = 0): Point {
  const a = portBaseAngle(arity, port) + angle;
  return { x: Math.cos(a), y: Math.sin(a) };
}

/** Where a wire attaches to a port: the corresponding corner of the shape. */
export function attachPoint(
  place: Point & { angle: number },
  arity: number,
  port: number,
  radius: number,
): Point {
  const d = portDirection(arity, port, place.angle);
  return { x: place.x + d.x * radius, y: place.y + d.y * radius };
}

/** Screen point of any endpoint, or null if it has no placement yet. */
export function endpointPoint(
  net: Net,
  places: Placements,
  e: Endpoint,
  radius: number,
): Point | null {
  if (isFree(e)) return places.free.get(e.free) ?? null;
  const place = places.agents.get(e.agent);
  const agent = net.agent(e.agent);
  if (!place || !agent) return null;
  return attachPoint(place, agent.arity, e.port, radius);
}

/**
 * The rotation that best aims every port at whatever it is wired to, or null if
 * the agent has nothing to aim at. See the closed form in the module comment.
 */
export function restAngle(net: Net, id: AgentId, places: Placements): number | null {
  const agent = net.agent(id);
  const self = places.agents.get(id);
  if (!agent || !self) return null;

  let sx = 0;
  let sy = 0;
  for (const port of portsOf(agent)) {
    const partner = net.follow(port);
    if (!partner) continue;
    // Aim at the partner's CENTRE, not its attachment point: an attachment
    // point depends on the partner's own angle, which would make the result
    // depend on the order agents are visited.
    const target = isFree(partner)
      ? places.free.get(partner.free)
      : places.agents.get(partner.agent);
    if (!target) continue;
    const dx = target.x - self.x;
    const dy = target.y - self.y;
    if (Math.hypot(dx, dy) < 1e-6) continue;
    const correction = Math.atan2(dy, dx) - portBaseAngle(agent.arity, port.port);
    const w = port.port === 0 ? PRINCIPAL_WEIGHT : 1;
    sx += w * Math.cos(correction);
    sy += w * Math.sin(correction);
  }
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return null;
  return Math.atan2(sy, sx);
}

/**
 * The rotation that faces a free port along its own wire, or null if it has
 * nowhere to look.
 */
export function restAngleFree(net: Net, id: number, places: Placements): number | null {
  const self = places.free.get(id);
  const partner = net.follow({ free: id });
  if (!self || !partner) return null;
  const target = isFree(partner)
    ? places.free.get(partner.free)
    : places.agents.get(partner.agent);
  if (!target) return null;
  const dx = target.x - self.x;
  const dy = target.y - self.y;
  if (Math.hypot(dx, dy) < 1e-6) return null;
  return Math.atan2(dy, dx) - portBaseAngle(0, 0);
}

/** Shortest-way angular interpolation. */
export function turnToward(from: number, to: number, t: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * t;
}

export interface RelaxOptions {
  /** Agent radius. Every length scale below is derived from it. */
  radius: number;
  /** Fraction of the computed displacement applied per sweep. */
  rate?: number;
  /** Fraction of the way to the rest angle turned per sweep. */
  turnRate?: number;
  wire?: number;
  repel?: number;
  anchor?: number;
  hierarchy?: number;
  /** Preferred distance between the two ends of a wire. */
  wireRest?: number;
  /** Multiple of the summed radii two bodies keep between their centres. */
  separation?: number;
  /** How far, in radii, an anchored agent may stray from its anchor. */
  leash?: number;
  /** Keep everything inside this world-space box. */
  bounds?: Bounds;
}

/** A world-space rectangle. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Resolved {
  radius: number;
  rate: number;
  turnRate: number;
  wire: number;
  repel: number;
  anchor: number;
  hierarchy: number;
  wireRest: number;
  separation: number;
  leash: number;
  bounds?: Bounds;
}

function resolve(options: RelaxOptions): Resolved {
  const radius = options.radius;
  return {
    radius,
    rate: options.rate ?? 0.28,
    turnRate: options.turnRate ?? 0.3,
    wire: options.wire ?? 0.55,
    repel: options.repel ?? 1,
    // Strong on purpose. An agent that has a tidy-layout position should KEEP
    // it — the tree layout is better than anything relaxation would find, so
    // relaxation is only allowed to nudge it (fix overlaps, aim rotations).
    // Agents created by a rewrite have no anchor and settle freely, which is
    // the case that was a jumble.
    anchor: options.anchor ?? 0.5,
    hierarchy: options.hierarchy ?? 0.3,
    // Wires want visible length: too short and the net balls up into a clump
    // where you cannot follow any individual wire.
    wireRest: options.wireRest ?? radius * 2,
    // 1.0 would let two agents touch exactly, so keep a real gap between them.
    separation: options.separation ?? 1.45,
    // A hard limit, not just a spring: a single long wire generates enough force
    // to drag an anchored agent a long way, and the tidy layout is worth more
    // than the wire length it would save.
    leash: options.leash ?? 0.75,
    bounds: options.bounds,
  };
}

/** A thing that occupies space and pushes its neighbours away. */
interface Body {
  free: boolean;
  id: number;
  p: Point;
  r: number;
}

function bodies(net: Net, places: Placements, radius: number): Body[] {
  const out: Body[] = [];
  for (const [id, place] of places.agents) {
    if (!net.hasAgent(id)) continue;
    out.push({ free: false, id, p: place, r: radius });
  }
  for (const [id, place] of places.free) out.push({ free: true, id, p: place, r: radius * 0.3 });
  return out;
}

/** Cap a displacement so one bad wire can't fling a node across the canvas. */
function clampStep(v: number, limit: number): number {
  return v > limit ? limit : v < -limit ? -limit : v;
}

/**
 * Run one relaxation sweep, mutating `places`. Cheap enough to call every frame
 * (repulsion uses a uniform grid, so it is linear in practice).
 */
export function relaxStep(net: Net, places: Placements, options: RelaxOptions): void {
  const o = resolve(options);
  const r = o.radius;
  const minGap = r * 2 * o.separation;

  const dAgents = new Map<AgentId, Point>();
  const dFree = new Map<number, Point>();
  for (const id of places.agents.keys()) dAgents.set(id, { x: 0, y: 0 });
  for (const id of places.free.keys()) dFree.set(id, { x: 0, y: 0 });

  const push = (e: Endpoint, fx: number, fy: number): void => {
    const acc = isFree(e) ? dFree.get(e.free) : dAgents.get(e.agent);
    if (!acc) return;
    acc.x += fx;
    acc.y += fy;
  };

  // --- Wires pull their two ends together ---------------------------------------
  for (const [a, b] of net.wires()) {
    const pa = endpointPoint(net, places, a, r);
    const pb = endpointPoint(net, places, b, r);
    if (!pa || !pb) continue;
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) continue;
    const stretch = clampStep(dist - o.wireRest, r * 6);
    const f = (o.wire * stretch) / dist / 2;
    push(a, dx * f, dy * f);
    push(b, -dx * f, -dy * f);

    // A wire from an aux port to a principal port is a parent/child edge; keep
    // the child below the parent so the net still reads as a tree.
    if (o.hierarchy > 0 && !isFree(a) && !isFree(b)) {
      const parent = a.port > 0 && b.port === 0 ? a : b.port > 0 && a.port === 0 ? b : null;
      if (parent) {
        const child = parent === a ? b : a;
        const pp = places.agents.get(parent.agent);
        const cp = places.agents.get(child.agent);
        if (pp && cp) {
          // Consistent with wireRest: the two centres end up about
          // 2r (the two attachment offsets) + wireRest apart.
          const want = r * 2 + o.wireRest;
          const correction = clampStep(o.hierarchy * (want - (cp.y - pp.y)), r) / 2;
          dAgents.get(child.agent)!.y += correction;
          dAgents.get(parent.agent)!.y -= correction;
        }
      }
    }
  }

  // --- Bodies push each other apart ------------------------------------------------
  const all = bodies(net, places, r);
  const cell = Math.max(1, minGap);
  const grid = new Map<string, Body[]>();
  for (const body of all) {
    const key = `${Math.floor(body.p.x / cell)},${Math.floor(body.p.y / cell)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(body);
    else grid.set(key, [body]);
  }
  const pushBody = (body: Body, fx: number, fy: number): void => {
    const acc = body.free ? dFree.get(body.id) : dAgents.get(body.id);
    if (!acc) return;
    acc.x += fx;
    acc.y += fy;
  };
  for (const body of all) {
    const cx = Math.floor(body.p.x / cell);
    const cy = Math.floor(body.p.y / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const other of grid.get(`${gx},${gy}`) ?? []) {
          if (other === body) continue;
          if (other.free === body.free && other.id <= body.id) continue; // once per pair
          const want = (body.r + other.r) * o.separation;
          let dx = other.p.x - body.p.x;
          let dy = other.p.y - body.p.y;
          let dist = Math.hypot(dx, dy);
          if (dist > want) continue;
          if (dist < 1e-6) {
            // Exactly coincident: shove them apart along a fixed axis rather
            // than dividing by zero.
            dx = 1;
            dy = 0;
            dist = 1;
          }
          const f = (o.repel * (want - dist)) / dist / 2;
          pushBody(body, -dx * f, -dy * f);
          pushBody(other, dx * f, dy * f);
        }
      }
    }
  }

  // --- Weak spring back to the tidy layout ------------------------------------------
  if (o.anchor > 0) {
    for (const [id, place] of places.agents) {
      if (!place.anchor) continue;
      const acc = dAgents.get(id)!;
      acc.x += (place.anchor.x - place.x) * o.anchor;
      acc.y += (place.anchor.y - place.y) * o.anchor;
    }
  }

  // --- Apply -------------------------------------------------------------------------
  const limit = r * 0.9;
  const box = o.bounds;
  const clampTo = (p: Point): void => {
    if (!box) return;
    p.x = Math.min(Math.max(p.x, box.minX), Math.max(box.minX, box.maxX));
    p.y = Math.min(Math.max(p.y, box.minY), Math.max(box.minY, box.maxY));
  };
  for (const [id, place] of places.agents) {
    if (place.pinned) continue;
    const acc = dAgents.get(id)!;
    place.x += clampStep(acc.x * o.rate, limit);
    place.y += clampStep(acc.y * o.rate, limit);
    if (place.anchor) {
      // Stay on the leash: enough give to dodge an overlap, not enough to
      // restructure the tidy layout.
      const maxDrift = r * o.leash;
      const dx = place.x - place.anchor.x;
      const dy = place.y - place.anchor.y;
      const drift = Math.hypot(dx, dy);
      if (drift > maxDrift) {
        place.x = place.anchor.x + (dx / drift) * maxDrift;
        place.y = place.anchor.y + (dy / drift) * maxDrift;
      }
    }
    clampTo(place);
  }
  for (const [id, place] of places.free) {
    if (place.pinned) continue;
    const acc = dFree.get(id)!;
    place.x += clampStep(acc.x * o.rate, limit);
    place.y += clampStep(acc.y * o.rate, limit);
    clampTo(place);
  }

  // --- Aim everything at its wires ------------------------------------------------------
  for (const [id, place] of places.agents) {
    const want = restAngle(net, id, places);
    if (want === null) continue;
    place.angle = turnToward(place.angle, want, o.turnRate);
  }
  for (const [id, place] of places.free) {
    const want = restAngleFree(net, id, places);
    if (want === null) continue;
    place.angle = turnToward(place.angle, want, o.turnRate);
  }
}

/**
 * The energy the relaxation is trying to reduce: wire stretch plus body
 * overlap. Exported so tests can assert that relaxing actually minimises
 * something rather than just moving things around.
 */
export function energy(net: Net, places: Placements, options: RelaxOptions): number {
  const o = resolve(options);
  const r = o.radius;
  let total = 0;
  for (const [a, b] of net.wires()) {
    const pa = endpointPoint(net, places, a, r);
    const pb = endpointPoint(net, places, b, r);
    if (!pa || !pb) continue;
    total += o.wire * (Math.hypot(pb.x - pa.x, pb.y - pa.y) - o.wireRest) ** 2;
  }
  const all = bodies(net, places, r);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const want = (all[i].r + all[j].r) * o.separation;
      const dist = Math.hypot(all[j].p.x - all[i].p.x, all[j].p.y - all[i].p.y);
      if (dist < want) total += o.repel * (want - dist) ** 2;
    }
  }
  return total;
}

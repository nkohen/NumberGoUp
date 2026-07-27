/**
 * The interaction-combinator sandbox — a dev-only toy for answering one
 * question: is this fun to watch, and is there a skill gradient?
 *
 * Not a game mode. Nothing here touches `src/core/`.
 *
 * Interaction model:
 *   - click a port, then another port, to wire them (the only way to create a
 *     redex, which is what the eventual "wire card" would do);
 *   - drag a bubble or a free port to move it;
 *   - pick γ/δ/ε from the palette and click empty space to place one;
 *   - ✕ deletes an agent.
 *
 * Reduction metrics are accumulated here rather than by calling `reduce()`,
 * because the sandbox fires redexes one at a time (or one round at a time) with
 * an animation between them. The numbers are the same ones `ReduceResult`
 * reports.
 */
import { Rng, randomSeed } from "../core/rng";
import { Net, SYMBOL_NAMES, type Endpoint, type Sym } from "./net";
import { activePairs, step, type ActivePair } from "./reduce";
import { NetRenderer } from "./render";
import { PRESETS } from "./presets";

type Tool = "wire" | "erase" | Sym;

const canvas = document.getElementById("net") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const desc = document.getElementById("desc") as HTMLDivElement;
const hint = document.getElementById("hint") as HTMLDivElement;
const presetSelect = document.getElementById("preset") as HTMLSelectElement;
const speedInput = document.getElementById("speed") as HTMLInputElement;
const speedLabel = document.getElementById("speedLabel") as HTMLSpanElement;
const runButton = document.getElementById("run") as HTMLButtonElement;
const pauseButton = document.getElementById("pause") as HTMLButtonElement;
const stepButton = document.getElementById("step") as HTMLButtonElement;
const orderButton = document.getElementById("order") as HTMLButtonElement;
const eraseButton = document.getElementById("erase") as HTMLButtonElement;
const settleButton = document.getElementById("settle") as HTMLButtonElement;
const capSelect = document.getElementById("cap") as HTMLSelectElement;
const symbolButtons = [...document.querySelectorAll<HTMLButtonElement>("button.sym")];

const renderer = new NetRenderer(canvas);
const rng = new Rng(randomSeed());

let net = new Net();
let tool: Tool = "wire";
let parallel = false;
let running = false;
let sinceStep = 0;
let dragging: { kind: "agent"; id: number } | { kind: "free"; id: number } | null = null;
/** Set when a run stopped because the net hit the agent cap. */
let cappedAt = 0;

/** Agents at which an automatic run stops. 0 means no limit. */
function agentCap(): number {
  return Number(capSelect.value);
}

const stats = {
  interactions: 0,
  rounds: 0,
  peakParallelism: 0,
  peakAgents: 0,
  loops: 0,
};

function resetStats(): void {
  stats.interactions = 0;
  stats.rounds = 0;
  stats.peakParallelism = activePairs(net).length;
  stats.peakAgents = net.agentCount;
  stats.loops = net.loops;
}

/** Steps per second from the slider, on an exponential curve. */
function stepsPerSecond(): number {
  const t = Number(speedInput.value) / 100;
  return 0.5 * Math.pow(60, t);
}

// --- Loading -------------------------------------------------------------------

function load(build: () => Net, description: string): void {
  net = build();
  renderer.clear();
  renderer.relayout(net, true);
  renderer.placeLooseFreePorts(net);
  resetStats();
  cappedAt = 0;
  desc.textContent = description;
  running = false;
  syncButtons();
}

function loadPreset(id: string): void {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return;
  load(() => preset.build(), preset.description);
}

for (const preset of PRESETS) {
  const option = document.createElement("option");
  option.value = preset.id;
  option.textContent = preset.name;
  presetSelect.append(option);
}

// --- Reduction ------------------------------------------------------------------

function fire(pair: ActivePair): void {
  const before = renderer.snapshot(net, pair);
  const known = new Set(net.agents().map((a) => a.id));
  step(net, pair);
  stats.interactions++;
  stats.peakAgents = Math.max(stats.peakAgents, net.agentCount);
  stats.loops = net.loops;
  const created = net.agents().filter((a) => !known.has(a.id)).map((a) => a.id);
  if (before) renderer.beginRewrite(net, before, created);
  renderer.placeLooseFreePorts(net);
}

/**
 * One scheduling round: a single redex, or every current redex at once.
 *
 * `respectCap` guards automatic running only. Interaction combinators are
 * Turing complete and a two-agent net can double every round, so an unattended
 * Run on a diverging net will happily allocate until the tab dies — hence the
 * cap. A deliberate Step is always allowed through: one round at a time is
 * never the thing that wrecks your machine, and being unable to inspect the net
 * past the cap would be worse than useless.
 */
function advance(respectCap = false): boolean {
  const cap = agentCap();
  if (respectCap && cap > 0 && net.agentCount >= cap) {
    cappedAt = net.agentCount;
    return false;
  }
  const pairs = activePairs(net);
  stats.peakParallelism = Math.max(stats.peakParallelism, pairs.length);
  if (pairs.length === 0) return false;
  stats.rounds++;
  if (parallel) {
    for (const pair of pairs) {
      // A single parallel round can more than double the net, so re-check
      // inside the round rather than only at its start.
      if (respectCap && cap > 0 && net.agentCount >= cap) {
        cappedAt = net.agentCount;
        break;
      }
      fire(pair);
    }
  } else {
    fire(pairs[rng.int(0, pairs.length - 1)]);
  }
  return true;
}

// --- HUD -------------------------------------------------------------------------

function row(label: string, value: string | number): string {
  return `<div><span class="k">${label}</span><b>${value}</b></div>`;
}

function drawHud(pairs: ActivePair[]): void {
  const state = cappedAt
    ? '<span class="state diverged">paused · agent cap</span>'
    : pairs.length === 0
      ? '<span class="state">normal form</span>'
      : `<span class="k">reducible</span>`;
  const zoom = renderer.zoom;
  hud.innerHTML =
    row("interactions", stats.interactions) +
    row("rounds", stats.rounds) +
    row("active pairs", pairs.length) +
    row("peak parallelism", stats.peakParallelism) +
    "<hr>" +
    row("agents", net.agentCount) +
    row("peak agents", stats.peakAgents) +
    row("free ports", net.freePorts().length) +
    row("closed loops", stats.loops) +
    row("view", zoom >= 0.995 ? "1:1" : `${Math.round(zoom * 100)}%`) +
    "<hr>" +
    `<div style="text-align:center">${state}</div>`;
}

// --- Input ------------------------------------------------------------------------

function canvasPoint(event: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

canvas.addEventListener("pointerdown", (event) => {
  const { x, y } = canvasPoint(event);
  canvas.setPointerCapture(event.pointerId);

  if (tool === "γ" || tool === "δ" || tool === "ε") {
    const agent = net.addAgentWired(tool);
    renderer.placeAt(agent, x, y);
    renderer.placeLooseFreePorts(net);
    return;
  }

  const endpoint = renderer.endpointAt(net, x, y);
  if (tool === "erase") {
    const id = renderer.agentAt(x, y);
    if (id !== null) {
      net.deleteAgent(id);
      renderer.forget(id);
      renderer.placeLooseFreePorts(net);
    }
    return;
  }

  if (endpoint) {
    if (renderer.selected && !sameEnd(renderer.selected, endpoint)) {
      const from = wireEnd(renderer.selected);
      const to = wireEnd(endpoint);
      // Splicing a wire into itself would just make a closed loop; ignore it.
      if (!sameEnd(from, to)) {
        net.link(from, to);
        renderer.placeLooseFreePorts(net);
      }
      renderer.selected = null;
    } else {
      renderer.selected = endpoint;
      // Dragging a free port moves it; dragging an agent port does not.
      if ("free" in endpoint) dragging = { kind: "free", id: endpoint.free };
    }
    return;
  }

  const id = renderer.agentAt(x, y);
  if (id !== null) {
    dragging = { kind: "agent", id };
    renderer.selected = null;
    return;
  }
  renderer.selected = null;
});

/**
 * What the user means when they click an endpoint.
 *
 * A free port is not a thing in its own right — it is the loose END of some
 * wire. So joining two loose ends means SPLICING the two wires into one: connect
 * what is at the far end of each, and let both free ports disappear with the
 * wire halves they belonged to. Linking the free ports themselves instead would
 * cut both wires loose from their agents and leave a stranded free-to-free wire
 * behind, plus two brand new free ports where the agents used to be attached.
 */
function wireEnd(e: Endpoint): Endpoint {
  if (!("free" in e)) return e;
  return net.follow(e) ?? e;
}

function sameEnd(a: Endpoint, b: Endpoint): boolean {
  if ("free" in a || "free" in b) return "free" in a && "free" in b && a.free === b.free;
  return a.agent === b.agent && a.port === b.port;
}

canvas.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  const { x, y } = canvasPoint(event);
  if (dragging.kind === "agent") renderer.moveAgent(dragging.id, x, y);
  else renderer.moveFreePort(dragging.id, x, y);
});

for (const type of ["pointerup", "pointercancel"]) {
  canvas.addEventListener(type, () => {
    dragging = null;
    renderer.releaseAll();
  });
}

// --- Controls ----------------------------------------------------------------------

function setTool(next: Tool): void {
  tool = next;
  renderer.selected = null;
  syncButtons();
}

function syncButtons(): void {
  for (const button of symbolButtons) button.classList.toggle("on", tool === button.dataset.sym);
  eraseButton.classList.toggle("on", tool === "erase");
  orderButton.textContent = parallel ? "parallel" : "sequential";
  orderButton.classList.toggle("on", parallel);
  settleButton.classList.toggle("on", renderer.settle);
  runButton.disabled = running;
  pauseButton.disabled = !running;
  speedLabel.textContent = `${stepsPerSecond().toFixed(1)}/s`;
  hint.textContent =
    tool === "wire"
      ? "click a port, then another port, to wire them · drag to move · corners are ports: apex up = principal"
      : tool === "erase"
        ? "click an agent to delete it"
        : `click to place ${tool} — ${SYMBOL_NAMES[tool]}`;
}

for (const button of symbolButtons) {
  button.addEventListener("click", () => {
    const sym = button.dataset.sym as Sym;
    setTool(tool === sym ? "wire" : sym);
  });
}
eraseButton.addEventListener("click", () => setTool(tool === "erase" ? "wire" : "erase"));
orderButton.addEventListener("click", () => {
  parallel = !parallel;
  syncButtons();
});
settleButton.addEventListener("click", () => {
  renderer.settle = !renderer.settle;
  syncButtons();
});
speedInput.addEventListener("input", syncButtons);
stepButton.addEventListener("click", () => {
  running = false;
  cappedAt = 0; // a deliberate step always goes through
  advance();
  syncButtons();
});
runButton.addEventListener("click", () => {
  running = true;
  cappedAt = 0;
  sinceStep = Infinity;
  syncButtons();
});
pauseButton.addEventListener("click", () => {
  running = false;
  syncButtons();
});
document.getElementById("reset")!.addEventListener("click", () => loadPreset(presetSelect.value));
document.getElementById("tidy")!.addEventListener("click", () => {
  renderer.relayout(net);
  renderer.placeLooseFreePorts(net);
});
document.getElementById("clear")!.addEventListener("click", () => {
  load(() => new Net(), "Empty canvas. Place agents from the palette and wire them up.");
});
presetSelect.addEventListener("change", () => loadPreset(presetSelect.value));

window.addEventListener("resize", () => {
  renderer.resize();
  renderer.relayout(net, true);
  renderer.placeLooseFreePorts(net);
});

window.addEventListener("keydown", (event) => {
  if (event.key === " ") {
    event.preventDefault();
    running = !running;
    syncButtons();
  } else if (event.key === "s") {
    advance();
  } else if (event.key === "t") {
    renderer.relayout(net);
  } else if (["γ", "δ", "ε", "g", "d", "e"].includes(event.key)) {
    const map: Record<string, Sym> = { g: "γ", d: "δ", e: "ε", γ: "γ", δ: "δ", ε: "ε" };
    setTool(map[event.key]);
  } else if (event.key === "Escape") {
    setTool("wire");
  }
});

// --- Frame loop ---------------------------------------------------------------------

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (running) {
    sinceStep += dt;
    const interval = 1 / stepsPerSecond();
    // Never start a new rewrite while one is still animating, or the motion
    // stops reading as "this thing turned into those things".
    if (sinceStep >= interval && !renderer.busy) {
      sinceStep = 0;
      if (!advance(true)) {
        running = false;
        syncButtons();
      }
    }
  }

  const pairs = activePairs(net);
  renderer.draw(net, dt, { activePairs: pairs });
  drawHud(pairs);
  requestAnimationFrame(frame);
}

// --- Boot ------------------------------------------------------------------------------

renderer.resize();
loadPreset(new URLSearchParams(location.search).get("preset") ?? PRESETS[0].id);
presetSelect.value = new URLSearchParams(location.search).get("preset") ?? PRESETS[0].id;
syncButtons();
requestAnimationFrame(frame);

// A dev hook mirroring the game's `window.__app`, so the screenshot script (and
// the console) can drive the sandbox without clicking.
(window as unknown as { __inet: unknown }).__inet = {
  get net() {
    return net;
  },
  renderer,
  stats,
  loadPreset,
  advance,
  setParallel: (on: boolean) => {
    parallel = on;
    syncButtons();
  },
  reduceAll: (limit = 200) => {
    for (let i = 0; i < limit && advance(); i++);
  },
  setCap: (n: number) => {
    capSelect.value = String(n);
  },
};

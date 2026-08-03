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
import { lookupRule, splitPairKey, symbolDef, type Alphabet } from "./alphabet";
import { ALPHABETS, alphabetById } from "./alphabets";
import { makeEnemy } from "./generate-levels";
import { Net, type Endpoint, type Sym } from "./net";
import { activePairs, step, type ActivePair } from "./reduce";
import { previewPlug, previewSplice, outcomeOf, type RulePreview } from "./preview";
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
const alphabetSelect = document.getElementById("alphabet") as HTMLSelectElement;
const paletteEl = document.getElementById("palette") as HTMLSpanElement;
const rulePanel = document.getElementById("rulePanel") as HTMLDivElement;
const ruleBody = document.getElementById("ruleBody") as HTMLDivElement;
const tip = document.getElementById("tip") as HTMLDivElement;
let symbolButtons: HTMLButtonElement[] = [];

const renderer = new NetRenderer(canvas);
const rng = new Rng(randomSeed());

let alphabet: Alphabet = ALPHABETS[0];
let net = new Net(alphabet);
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

for (const a of ALPHABETS) {
  const option = document.createElement("option");
  option.value = a.id;
  option.textContent = a.name;
  alphabetSelect.append(option);
}

/**
 * Rebuild the palette and rule reference for the current alphabet. The presets
 * are hand-built γδε nets, so they are only offered for the base alphabet;
 * everything else gets a Random net instead.
 */
function syncAlphabet(): void {
  paletteEl.innerHTML = "";
  for (const def of alphabet.symbols) {
    const button = document.createElement("button");
    button.className = "sym";
    button.dataset.sym = def.symbol;
    button.textContent = def.symbol;
    button.title = `${def.name} (arity ${def.arity})`;
    button.style.color = def.color.a;
    button.addEventListener("click", () => {
      setTool(tool === def.symbol ? "wire" : def.symbol);
    });
    paletteEl.append(button);
  }
  symbolButtons = [...paletteEl.querySelectorAll<HTMLButtonElement>("button.sym")];

  const isBase = alphabet.id === ALPHABETS[0].id;
  presetSelect.disabled = !isBase;
  presetSelect.title = isBase
    ? "Load a canned net"
    : "The presets are hand-built γδε nets — use Random for other alphabets";

  const rows: string[] = [];
  for (let i = 0; i < alphabet.symbols.length; i++) {
    for (let j = i; j < alphabet.symbols.length; j++) {
      const x = alphabet.symbols[i];
      const y = alphabet.symbols[j];
      const found = lookupRule(alphabet, x.symbol, y.symbol);
      const [first, second] = x.symbol <= y.symbol ? [x.symbol, y.symbol] : [y.symbol, x.symbol];
      void splitPairKey;
      const result = !found
        ? '<span class="dead">deadlock</span>'
        : found.rule.creates.length === 0
          ? "&rarr; nothing"
          : `&rarr; ${found.rule.creates.join(" + ")}`;
      const verb = found ? `<span class="verb">${found.rule.verb}</span>` : "";
      rows.push(`<tr><td>${first} &#8904; ${second}</td><td>${verb}</td><td>${result}</td></tr>`);
    }
  }
  ruleBody.innerHTML =
    `<h3>${alphabet.name}</h3><table>${rows.join("")}</table>` +
    `<div class="note">${alphabet.blurb}</div>` +
    `<div class="note">A pair with no rule is stuck forever — that is a design tool, not a bug.</div>`;
}

function setAlphabet(id: string): void {
  alphabet = alphabetById(id) ?? ALPHABETS[0];
  alphabetSelect.value = alphabet.id;
  syncAlphabet();
  if (alphabet.id === ALPHABETS[0].id) loadPreset(presetSelect.value);
  else loadRandom();
}

/** A random net in the current alphabet — the stand-in for presets. */
function loadRandom(): void {
  for (let attempt = 0; attempt < 400; attempt++) {
    const candidate = makeEnemy(alphabet, Math.floor(Math.random() * 1e9), 4);
    if (candidate) {
      load(() => candidate, `Random ${alphabet.name} net. ${alphabet.blurb}`);
      return;
    }
  }
  load(() => new Net(alphabet), `Empty ${alphabet.name} canvas.`);
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

/**
 * Hover preview. In the sandbox the "card" is whichever palette symbol is armed,
 * or — with the wire tool and one end already picked — the splice you are about
 * to make. Same idea as the demo's: say which rule would fire before it fires.
 */
function previewFor(free: number): RulePreview | null {
  if (tool === "erase") return null;
  if (tool === "wire") {
    const first = renderer.selected;
    if (!first || !("free" in first) || first.free === free) return null;
    return previewSplice(net, first.free, free);
  }
  return previewPlug(net, free, tool);
}

function showTip(x: number, y: number): void {
  const free = renderer.freePortAt(net, x, y);
  const preview = free === null ? null : previewFor(free);
  if (!preview || free === null) {
    tip.classList.remove("show");
    return;
  }
  const klass = preview.kind === "deadlock" ? "bad" : preview.kind === "reaction" ? "verb" : "warn";
  const head =
    preview.kind === "reaction"
      ? `<span class="head">${preview.pair}</span> <span class="${klass}">${preview.verb}</span> ${preview.result}`
      : `<span class="head ${klass}">${preview.kind === "deadlock" ? "deadlock" : "no reaction"}</span>`;
  const move =
    tool === "wire" && renderer.selected && "free" in renderer.selected
      ? ({ kind: "splice", a: renderer.selected.free, b: free } as const)
      : ({ kind: "plug", free, symbol: tool } as const);
  const outcome = outcomeOf(net, move);
  const line = outcome.diverged
    ? '<span class="bad">never settles</span>'
    : `${outcome.agentsBefore} → ${outcome.agentsAfter} agents · ` +
      `${outcome.interactions} interaction${outcome.interactions === 1 ? "" : "s"}`;
  tip.innerHTML =
    `${head}<div class="detail">${preview.detail}</div><div class="outcome">${line}</div>`;
  tip.classList.add("show");
  const box = tip.getBoundingClientRect();
  const main = canvas.getBoundingClientRect();
  tip.style.left = `${Math.max(4, x + 16 + box.width > main.width ? x - box.width - 16 : x + 16)}px`;
  tip.style.top = `${Math.max(4, y + 14 + box.height > main.height ? y - box.height - 14 : y + 14)}px`;
}

canvas.addEventListener("pointermove", (event) => {
  const { x, y } = canvasPoint(event);
  if (!dragging) {
    showTip(x, y);
    return;
  }
  tip.classList.remove("show");
  if (dragging.kind === "agent") renderer.moveAgent(dragging.id, x, y);
  else renderer.moveFreePort(dragging.id, x, y);
});

canvas.addEventListener("pointerleave", () => tip.classList.remove("show"));

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
        : `click to place ${tool} — ${symbolDef(alphabet, tool)?.name ?? ""}`;
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
  load(() => new Net(alphabet), "Empty canvas. Place agents from the palette and wire them up.");
});
document.getElementById("random")!.addEventListener("click", loadRandom);
document.getElementById("rules")!.addEventListener("click", () => {
  rulePanel.classList.toggle("show");
  desc.style.display = rulePanel.classList.contains("show") ? "none" : "";
});
alphabetSelect.addEventListener("change", () => setAlphabet(alphabetSelect.value));
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
  } else if (/^[1-9]$/.test(event.key)) {
    // Number keys pick from the palette, whatever the alphabet's symbols are.
    const def = alphabet.symbols[Number(event.key) - 1];
    if (def) setTool(tool === def.symbol ? "wire" : def.symbol);
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
const params = new URLSearchParams(location.search);
presetSelect.value = params.get("preset") ?? PRESETS[0].id;
setAlphabet(params.get("alphabet") ?? ALPHABETS[0].id);
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
  setAlphabet,
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

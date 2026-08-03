/**
 * "Clear the Net" — a playable demo of the enemy-net concept.
 *
 * Each level is an enemy net with free wires. Play cards into those wires, step
 * the computation, and win by reducing the net to zero agents.
 *
 * Dev-only, like the sandbox: shares the whole engine (`net`, `reduce`,
 * `layout`, `render`, `relax`) and adds only the game layer in `level.ts`,
 * `levels.ts` and `solver.ts`. Nothing here touches `src/core/`.
 */
import { lookupRule, type Alphabet } from "./alphabet";
import { ALPHABETS, alphabetById } from "./alphabets";
import { generateLevels } from "./generate-levels";
import { cardLabel, cardName, LevelRun, legalMoves, type Card, type LevelDef, type Move } from "./level";
import { LEVELS } from "./levels";
import { isFree, type AgentId } from "./net";
import { activePairs, type ActivePair } from "./reduce";
import { NetRenderer } from "./render";

const canvas = document.getElementById("net") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const teaches = document.getElementById("teaches") as HTMLDivElement;
const handEl = document.getElementById("hand") as HTMLDivElement;
const levelSelect = document.getElementById("level") as HTMLSelectElement;
const alphabetSelect = document.getElementById("alphabet") as HTMLSelectElement;
const rulePanel = document.getElementById("rulePanel") as HTMLDivElement;
const ruleBody = document.getElementById("ruleBody") as HTMLDivElement;
const stepButton = document.getElementById("step") as HTMLButtonElement;
const runButton = document.getElementById("run") as HTMLButtonElement;
const undoButton = document.getElementById("undo") as HTMLButtonElement;
const resultEl = document.getElementById("result") as HTMLDivElement;
const resultTitle = document.getElementById("resultTitle") as HTMLHeadingElement;
const resultBody = document.getElementById("resultBody") as HTMLParagraphElement;
const resultNext = document.getElementById("resultNext") as HTMLButtonElement;
const resultAgain = document.getElementById("resultAgain") as HTMLButtonElement;

const renderer = new NetRenderer(canvas);

/**
 * The base alphabet keeps its hand-authored teaching set; every other alphabet
 * gets levels generated and verified at load (see generate-levels.ts). Authoring
 * five sets by hand while the rule sets are still moving would be wasted work,
 * and a generated set is a fairer sample of what a typical puzzle feels like.
 */
let alphabet: Alphabet = ALPHABETS[0];
let levels: readonly LevelDef[] = LEVELS;
let run = new LevelRun(LEVELS[0]);
/** Index into `run.hand` of the card being held, if any. */
let held: number | null = null;
/** First wire picked for a splice, waiting for its partner. */
let spliceFrom: number | null = null;
let running = false;
let sinceStep = 0;
let resolved = false;

// --- Level lifecycle ----------------------------------------------------------------

function load(id: string): void {
  const def = levels.find((l) => l.id === id) ?? levels[0];
  if (!def) return;
  run = new LevelRun(def);
  held = null;
  spliceFrom = null;
  running = false;
  resolved = false;
  renderer.clear();
  renderer.relayout(run.net, true);
  renderer.placeLooseFreePorts(run.net);
  levelSelect.value = def.id;
  teaches.innerHTML = `<b>${def.name}</b>${def.teaches}`;
  resultEl.classList.remove("show");
  syncHand();
}

for (const a of ALPHABETS) {
  const option = document.createElement("option");
  option.value = a.id;
  option.textContent = a.name;
  alphabetSelect.append(option);
}

function syncLevelList(): void {
  levelSelect.innerHTML = "";
  for (const level of levels) {
    const option = document.createElement("option");
    option.value = level.id;
    option.textContent = `${level.name} · par ${level.par}`;
    levelSelect.append(option);
  }
}

function syncRulePanel(): void {
  const rows: string[] = [];
  for (let i = 0; i < alphabet.symbols.length; i++) {
    for (let j = i; j < alphabet.symbols.length; j++) {
      const x = alphabet.symbols[i];
      const y = alphabet.symbols[j];
      const found = lookupRule(alphabet, x.symbol, y.symbol);
      const [first, second] = x.symbol <= y.symbol ? [x.symbol, y.symbol] : [y.symbol, x.symbol];
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
    `<div class="note">Press <b>rules</b> again to hide this and see the net behind it.</div>`;
}

/**
 * Generating a level set solves every candidate net, which takes a few seconds
 * and blocks the main thread. Paint a notice first — a frozen tab with no
 * explanation reads as a crash — then generate on the next frame.
 */
function setAlphabet(id: string): void {
  alphabet = alphabetById(id) ?? ALPHABETS[0];
  alphabetSelect.value = alphabet.id;
  syncRulePanel();

  if (alphabet.id === ALPHABETS[0].id) {
    levels = LEVELS;
    syncLevelList();
    load(levels[0].id);
    return;
  }

  levelSelect.innerHTML = "<option>generating…</option>";
  levelSelect.disabled = true;
  teaches.innerHTML = `<b>${alphabet.name}</b>Solving candidate nets to find levels that can actually be cleared…`;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      levels = generateLevels(alphabet, 6, 3);
      levelSelect.disabled = false;
      syncLevelList();
      if (levels.length > 0) load(levels[0].id);
      else teaches.innerHTML = `<b>${alphabet.name}</b>No solvable levels found for this alphabet.`;
    });
  });
}

// --- Playing cards --------------------------------------------------------------------

/** Free wires the held card could legally be played into. */
function targetsForHeldCard(): Set<number> {
  if (held === null) return new Set();
  const card = run.hand[held];
  const moves = legalMoves(run.net, [card]);
  const out = new Set<number>();
  for (const move of moves) {
    if (move.kind === "plug") out.add(move.free);
    else {
      out.add(move.a);
      out.add(move.b);
    }
  }
  // Mid-splice, the wire already chosen is not a target for itself.
  if (spliceFrom !== null) out.delete(spliceFrom);
  return out;
}

/**
 * The subset of playable wires that would actually start a reaction. Plugging an
 * agent in only makes a redex if the wire leads to a PRINCIPAL port; a wire that
 * leads to an aux port just builds structure. For a wire card the equivalent is
 * a pair of ends that are both principal, so nothing is marked until the first
 * end is chosen.
 */
function liveTargets(): Set<number> {
  const out = new Set<number>();
  if (held === null) return out;
  const card = run.hand[held];
  const facesPrincipal = (free: number): boolean => {
    const q = run.net.follow({ free });
    return !!q && !isFree(q) && q.port === 0;
  };
  if (card.kind === "agent") {
    for (const f of run.net.freePorts()) if (facesPrincipal(f)) out.add(f);
  } else if (spliceFrom !== null && facesPrincipal(spliceFrom)) {
    for (const f of run.net.freePorts()) if (f !== spliceFrom && facesPrincipal(f)) out.add(f);
  }
  return out;
}

function playMove(move: Move): void {
  // Remember where the wire was so a plugged agent can be born there rather
  // than appearing at the origin and flying in.
  const at =
    move.kind === "plug" ? renderer.pointFor({ free: move.free }) : null;
  const before = new Set(run.net.agents().map((a) => a.id));

  if (!run.play(move)) return;

  if (at) {
    for (const agent of run.net.agents()) {
      if (before.has(agent.id)) continue;
      renderer.placeAt(agent, ...toScreenPair(at));
    }
  }
  renderer.placeLooseFreePorts(run.net);
  held = null;
  spliceFrom = null;
  syncHand();
  checkResolution();
}

/** `placeAt` takes screen coordinates; the wire position is in world space. */
function toScreenPair(p: { x: number; y: number }): [number, number] {
  const s = renderer.toScreen(p.x, p.y);
  return [s.x, s.y];
}

// --- Reduction --------------------------------------------------------------------------

function fire(pair: ActivePair): void {
  const before = renderer.snapshot(run.net, pair);
  const known = new Set(run.net.agents().map((a) => a.id));
  run.stepOnce(pair);
  const created = run.net
    .agents()
    .filter((a) => !known.has(a.id))
    .map((a) => a.id);
  if (before) renderer.beginRewrite(run.net, before, created);
  renderer.placeLooseFreePorts(run.net);
}

/** Fire one redex, animated. Returns false when the net is in normal form. */
function stepOnce(): boolean {
  const pairs = activePairs(run.net);
  if (pairs.length === 0) return false;
  fire(pairs[0]);
  checkResolution();
  return true;
}

function checkResolution(): void {
  if (resolved) return;
  if (run.cleared) {
    resolved = true;
    running = false;
    const par = run.level.par;
    const verdict =
      run.cardsPlayed < par ? "Under par!" : run.cardsPlayed === par ? "Par." : "Cleared.";
    show(
      "Net cleared",
      `${verdict} ${run.cardsPlayed} card${run.cardsPlayed === 1 ? "" : "s"} (par ${par}) · ` +
        `${run.interactions} interaction${run.interactions === 1 ? "" : "s"}.`,
      true,
    );
  } else if (run.stuck) {
    resolved = true;
    running = false;
    show("Stuck", `${run.net.agentCount} agents left and nothing legal to play.`, false);
  }
}

function show(title: string, body: string, won: boolean): void {
  resultTitle.textContent = title;
  resultTitle.className = won ? "win" : "lose";
  resultBody.textContent = body;
  resultNext.style.display = won && nextLevelId() ? "" : "none";
  resultEl.classList.add("show");
}

function nextLevelId(): string | null {
  const i = levels.findIndex((l) => l.id === run.level.id);
  return i >= 0 && i + 1 < levels.length ? levels[i + 1].id : null;
}

// --- Hand UI -----------------------------------------------------------------------------

function syncHand(): void {
  handEl.innerHTML = "";
  run.hand.forEach((card: Card, index: number) => {
    const el = document.createElement("div");
    el.className = `card sym-${card.kind === "wire" ? "wire" : card.symbol}`;
    if (held === index) el.classList.add("on");
    el.textContent = cardLabel(card);
    el.title = cardName(card, run.net.alphabet);
    el.addEventListener("click", () => {
      held = held === index ? null : index;
      spliceFrom = null;
      syncHand();
    });
    handEl.append(el);
  });
  if (run.hand.length === 0) {
    const note = document.createElement("span");
    note.id = "handHint";
    note.textContent = "no cards left — step the computation out";
    handEl.append(note);
  } else {
    const note = document.createElement("span");
    note.id = "handHint";
    note.textContent =
      held === null
        ? "pick a card"
        : run.hand[held].kind === "wire"
          ? spliceFrom === null
            ? "click one loose end…"
            : "…now click the other"
          : "click a glowing loose end to play it";
    handEl.append(note);
  }
  undoButton.disabled = !run.canUndo;
  renderer.highlightFree = targetsForHeldCard();
  renderer.highlightHot = liveTargets();
}

// --- Input -------------------------------------------------------------------------------

canvas.addEventListener("pointerdown", (event) => {
  if (resolved) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const free = renderer.freePortAt(run.net, x, y);
  if (free === null || held === null) return;
  const card = run.hand[held];
  if (card.kind === "agent") {
    playMove({ kind: "plug", free, symbol: card.symbol });
    return;
  }
  if (spliceFrom === null) {
    spliceFrom = free;
    syncHand(); // re-highlights: live ends depend on which one was picked first
    return;
  }
  if (spliceFrom === free) {
    spliceFrom = null;
    syncHand();
    return;
  }
  playMove({ kind: "splice", a: spliceFrom, b: free });
});

// --- Controls ------------------------------------------------------------------------------

stepButton.addEventListener("click", () => {
  running = false;
  stepOnce();
});
runButton.addEventListener("click", () => {
  running = !running;
  sinceStep = Infinity;
});
undoButton.addEventListener("click", () => {
  if (!run.undo()) return;
  resolved = false;
  running = false;
  resultEl.classList.remove("show");
  renderer.clear();
  renderer.relayout(run.net, true);
  renderer.placeLooseFreePorts(run.net);
  held = null;
  spliceFrom = null;
  syncHand();
});
document.getElementById("reset")!.addEventListener("click", () => load(run.level.id));
levelSelect.addEventListener("change", () => load(levelSelect.value));
alphabetSelect.addEventListener("change", () => setAlphabet(alphabetSelect.value));
document.getElementById("rules")!.addEventListener("click", () => {
  rulePanel.classList.toggle("show");
  teaches.style.display = rulePanel.classList.contains("show") ? "none" : "";
});
resultAgain.addEventListener("click", () => load(run.level.id));
resultNext.addEventListener("click", () => {
  const next = nextLevelId();
  if (next) load(next);
});

window.addEventListener("keydown", (event) => {
  if (event.key === " ") {
    event.preventDefault();
    running = !running;
  } else if (event.key === "s") stepOnce();
  else if (event.key === "u") undoButton.click();
  else if (event.key === "r") load(run.level.id);
  else if (event.key === "Escape") {
    held = null;
    spliceFrom = null;
    syncHand();
  } else if (/^[1-9]$/.test(event.key)) {
    const index = Number(event.key) - 1;
    if (index < run.hand.length) {
      held = held === index ? null : index;
      spliceFrom = null;
      syncHand();
    }
  }
});

window.addEventListener("resize", () => {
  renderer.resize();
  renderer.relayout(run.net, true);
  renderer.placeLooseFreePorts(run.net);
});

// --- Frame loop -------------------------------------------------------------------------------

function row(label: string, value: string | number): string {
  return `<div><span class="k">${label}</span><b>${value}</b></div>`;
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const pairs = activePairs(run.net);
  if (running) {
    sinceStep += dt;
    if (sinceStep >= 0.3 && !renderer.busy) {
      sinceStep = 0;
      if (!stepOnce()) running = false;
    }
  }

  renderer.draw(run.net, dt, { activePairs: pairs });
  hud.innerHTML =
    row("agents left", run.net.agentCount) +
    row("cards used", `${run.cardsPlayed} / par ${run.level.par}`) +
    row("interactions", run.interactions) +
    row("reactions ready", pairs.length);
  stepButton.disabled = pairs.length === 0 || resolved;
  runButton.textContent = running ? "Pause" : "Run";
  runButton.disabled = pairs.length === 0 || resolved;
  requestAnimationFrame(frame);
}

// --- Boot ----------------------------------------------------------------------------------------

renderer.resize();
const params = new URLSearchParams(location.search);
setAlphabet(params.get("alphabet") ?? ALPHABETS[0].id);
if (params.get("level")) load(params.get("level")!);
requestAnimationFrame(frame);

// Dev hook, mirroring the sandbox's `window.__inet`, so the screenshot script
// can drive the demo without clicking.
(window as unknown as { __play: unknown }).__play = {
  get run() {
    return run;
  },
  renderer,
  load,
  setAlphabet,
  get levels() {
    return levels;
  },
  play: (move: Move) => playMove(move),
  stepOnce,
  runOut: (limit = 200) => {
    for (let i = 0; i < limit && stepOnce(); i++);
  },
  freePorts: () => run.net.freePorts(),
  farEnd: (free: number) => {
    const q = run.net.follow({ free });
    return q && !isFree(q) ? { agent: q.agent as AgentId, port: q.port } : null;
  },
};

# Interaction combinators — sandbox findings

Exploratory notes on `src/inet/`, the standalone interaction-combinator sandbox.
Nothing here ships; it exists to answer one question — *is this fun to watch, and
is there a skill gradient?*

Run it with `npm run dev` and open [/sandbox.html](http://localhost:5173/sandbox.html).
Numbers below come from `npm run inet:stats` (1000 random nets per size, fuel
5000, parallel reduction order, symbol weights γ 1.0 / δ 1.0 / ε 0.4, ports
paired uniformly at random).

---

## The implementation, in one paragraph

`net.ts` models wires as first-class symmetric links between *endpoints* (an
agent port or a free port), not as edges of an agent graph — which is what makes
agent-free wires fall out for free. Rewriting collapses wire chains **eagerly**:
`step` traces each dangling end *through* the vanishing agents, alternating
between the wire an endpoint sits on and the substitution the rule prescribes,
until it lands on something that survives. There are no indirection nodes in the
net at any point and no compaction pass, and `assertWellFormed` therefore holds
after every single rewrite, not just at normal form. A trace that returns to its
start is a closed agent-free loop: counted, not crashed on.

The rule is the uniform one — same symbol annihilates, different symbols commute,
with erasure falling out because `ε` has arity 0. `tests/inet/rules.test.ts`
pins that against a separately hand-transcribed statement of the classical six
rules, for all nine ordered symbol pairs.

**Strong confluence holds and is tested.** Every preset and 100 random nets
across four sizes reduce identically under `first`, `parallel` and 20 different
random orders — same `interactions`, same `finalAgents`, same closed-loop count,
same canonical signature. That test is the reason to trust everything below.

---

## 1. Does commutation read as legible motion, or as noise?

**Legible, but only because it is animated in place — and only up to about 4
simultaneous rewrites.**

Agents are drawn as curved triangles whose **corners are their ports** — sharp
apex for the principal port, two corners for the aux ports (ε, having only a
principal port, is a teardrop pointing at it). That was worth doing: with plain
circles you had to trace a wire to see whether it landed on a principal port, and
"principal meets principal" is the entire rule, so the silhouette should say it.

Agents also **rotate**, which turned out to be the single biggest legibility win.
The rest angle has a closed form — it is the weighted circular mean of the
per-port corrections (see `src/inet/relax.ts`), with the principal port weighted
2.6× because that is the wire the eye needs to follow — so there is no iteration
and no local minimum. Children hang off the corner that points at them, and the
two halves of a redex end up nose to nose. Free ports rotate the same way — a
free port is just the loose end of a wire, so it is drawn as a small *hollow*
version of the one-port shape facing back along its own wire.

Rotation also pays for itself in the wires: each Bezier handle is scaled by how
far its port already points at the other end, so once ports face each other the
wires collapse to near-straight lines and only bow where a port genuinely faces
sideways.

The motion I settled on: the two agents translate *through* each other and each
leaves a duplicate behind, so two sprites become four occupying roughly the
region the pair did, with a particle burst at the crossing point. Watching it
frame by frame, the read is unambiguous: "the green one went that way and became
two." Annihilation (collapse to the midpoint and pop) and erasure (the `ε`
swallows its partner, then splits and drifts outward along the wires the
partner's aux ports used to hold) are even clearer, because they change the agent
count in the direction your eye expects.

Two caveats, both honest:

- **The single most important decision was refusing to re-run layout.** Agents
  keep the position they were laid out at; a newly created agent is born where
  the agent it came from was and drifts a short step toward whatever its
  principal port now points at. That's it — no global layout during reduction.
  An early version that re-laid-out per rewrite was completely unreadable: the
  whole net jumped every frame, and you could not tell motion caused by the rule
  from motion caused by the layout. This is the known failure mode and it is
  worth stating loudly.
- **It degrades into noise above ~4 concurrent rewrites.** In parallel mode the
  `wide` preset fires 8 commutations at once and it reads as "something happened
  everywhere", not as eight legible events. Sequential mode at 2–5 steps/second
  is where the model is actually comprehensible. If parallelism ever became a
  scoring axis, it would need a different visual idiom — a pulse or a wavefront,
  not eight simultaneous bloom animations.

The local-drift heuristic accumulates mess on its own — after ~20 rewrites the
picture stays *correct* but the wires cross badly — so positions are also settled
by a small energy minimisation (`relaxStep`): wires are springs, bodies push each
other apart, and parent/child edges get a downward bias so the net keeps reading
top-down.

The load-bearing detail is what relaxation is *allowed to touch*. An agent that
came from the tidy tree layout is **leashed** to that position (a hard cap of
0.75 radii, not just a spring — a single long wire generates more than enough
force to drag it across the canvas otherwise), because the tidy layout is better
than anything relaxation would find. An agent created by a rewrite has no anchor
and settles freely. So the structural layout is preserved wherever it exists and
energy minimisation cleans up exactly the part that used to be a jumble. It also
never runs while a rewrite is animating, for the reason above: during a rewrite,
motion has to mean the rewrite and nothing else. It settles *between* rewrites,
which is when the eye has time to follow it anyway. There is a `settle` toggle in
the sandbox if you want to see the difference.

## 2. What is the spread of `interactions` across random nets of a fixed size?

**Fat in absolute terms, and it gets *relatively* tighter as nets grow.**

| agents | median | mean | p90 | p99 | max | CV | p99/median |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 4 | 1 | 1.3 | 4 | 7 | 8 | 1.32 | 7.0× |
| 8 | 2 | 3.7 | 9 | 17 | 21 | 1.00 | 8.5× |
| 16 | 10 | 11.6 | 22 | 42 | 66 | 0.74 | 4.2× |
| 32 | 33 | 34.8 | 59 | 101 | 184 | 0.62 | 3.1× |
| 64 | 83 | 89.0 | 140 | 238 | 281 | 0.46 | 2.9× |

At 16 agents a lucky/skilled wiring scores 4× the median and 6× the 10th
percentile; at 64 agents the same ratio is under 3×. So the *headroom shrinks
with size* — big nets regress toward the mean because they average over many
independent local interactions. That is the opposite of the arithmetic game,
where score is a product and the ceiling explodes with size.

Design read: this is a **healthy but not runaway** skill gradient, and the
interesting sizes are small — 8 to 32 agents. That is also, conveniently, the
range that is legible on screen (see 5). A mode built on this would want a hand
of ~6–12 agents, not 60.

The distribution is also strongly bimodal-ish at the low end: a *lot* of random
nets score 0 or 1 because the wiring never puts two principal ports together.
Median 2 at 8 agents means half of all random wirings barely compute at all. In
a game the player is exactly the thing that fixes this — which is encouraging,
because it means unskilled play has an obvious floor to climb off.

## 3. Is `peakParallelism` uncorrelated enough to be its own scoring mode?

**No. It is mostly the same axis wearing a hat.**

| agents | corr(interactions, peakParallelism) | corr(interactions, avg width) | corr(interactions, rounds) |
|---:|---:|---:|---:|
| 4 | 0.93 | — | 0.95 |
| 8 | 0.86 | 0.74 | 0.90 |
| 16 | 0.80 | 0.74 | 0.83 |
| 32 | 0.78 | — | 0.72 |
| 64 | 0.74 | 0.71 | 0.59 |

I checked the obvious escape hatch too: *average width* (`interactions / rounds`)
divides the raw size of the computation out, and it is still 0.71–0.74
correlated. Everything scales together with "how much work happened", which is
not surprising in hindsight — a net that does more work has more of everything.

The one metric with real independence is `finalAgents`, which is **negatively**
correlated with interactions (−0.83 at 4 agents, −0.41 at 64): annihilation both
counts as work *and* destroys agents, so "leave the biggest net standing" and "do
the most work" genuinely pull against each other. If you want a second scoring
mode, that's the one — *build the largest normal form* is a different game from
*compute the longest*, and the tension is real rather than cosmetic.

`rounds` under parallel order (the depth of the computation) also decorrelates as
nets grow, down to 0.59 at 64 agents. A "shallowest computation that still does N
work" objective would have some daylight in it, but not much at playable sizes.

## 4. What fraction of random nets diverge?

**14% at 4 agents, rising monotonically to 40% at 64.**

| agents | 4 | 8 | 16 | 32 | 64 |
|---|---:|---:|---:|---:|---:|
| diverged | 14.2% | 21.0% | 30.0% | 37.2% | 40.1% |

(Divergence = did not normalize within 5000 interactions. That cap is ~18× the
largest observed *normalizing* run at 64 agents, so the verdict is safe even
though it isn't a proof.)

This was the biggest surprise of the exercise, and I think it is the most
interesting thing here. **Non-termination is not an exotic edge case in this
system — it's a coin flip.** Wire agents together carelessly and there is a very
good chance the thing you built runs forever.

The `diverge` preset makes the point at minimum scale: **two agents**, one γ and
one δ, principal-to-principal with both aux pairs cross-wired. Under parallel
reduction it doubles every round — 4096 simultaneous active pairs by round 13,
10,002 agents at the 5000-interaction cap. Two bubbles and four wires.

## 5. What net size stays readable on a phone?

Measured against the actual screenshots (`npm run screenshots` writes
`*-sandbox-*.png` at iPhone 13 and 1280×800).

| viewport | comfortable | ceiling | unreadable |
|---|---|---|---|
| desktop 1280×800 | ~16 agents | ~32 | 64+ |
| phone 390×844 | ~6–8 agents | ~16 | 24+ |

These are the sizes that stay *comfortably readable*. Nothing gets clipped any
more at any size: past a floor radius the tidy layout stops shrinking agents and
lays the net out into a world box larger than the canvas, and the camera zooms
out to fit (never in past 1:1). A 256-agent net renders whole at about 68%. But
zoomed out is not the same as legible, and the numbers above are the legibility
limit, not the fitting limit.

The binding constraint is **columns, not agents** — and free ports eat columns
exactly like agents do. The 7-agent `dup-tree` preset already needs 18 leaf
columns (8 agents × their unconnected aux ports), which on a phone puts the
bubble radius at about 11px: legible, but the glyphs are at their limit. A
15-agent tree has 16 free ports and is past it.

Practical implication for a game: the *interface* has to be small. A puzzle whose
agents are mostly wired to each other (few free ports) shows perhaps twice as
many agents in the same space as one with a wide interface.

## 6. What surprised me, and what would be fun

**Surprises.**

1. The divergence rate (above). I expected non-termination to require
   construction; it requires carelessness.
2. `finalAgents` anticorrelating with `interactions`. Doing more work leaves you
   with less. That's a genuine mechanical tension I did not anticipate and did
   not have to design.
3. How little of the rule system there is. There is no rule table in `reduce.ts`
   at all — equal annihilates, different commutes, and erasure is just
   commutation at arity zero. The whole computational model is about fifteen
   lines. Compare `src/core/tree.ts`.
4. Strong confluence is not just a nice property, it is a *design gift*: the
   score cannot be farmed by evaluating cleverly. Whatever the player wires up
   has one score, full stop. Every ordering question a normal game has to
   adjudicate simply does not arise.

**What I think would be fun.**

Because reduction order is worth nothing, **all the skill has to live in the
wiring** — which is good, since wiring is the one action that creates a redex and
therefore the natural card. The loop writes itself: you are dealt a pile of γ/δ/ε
and a limited number of wires, and you decide what connects to what; then you
press go and watch it compute.

The mechanic I'd actually build is the one the numbers hand you for free:
**divergence as bust.** More interactions is more score, but 30–40% of
aggressive wirings never terminate, and a net that doesn't terminate scores
nothing. Interaction-combinator nets are Turing complete, so the player can't be
given a reliable "will this halt?" oracle — the tension is not simulated, it's
load-bearing. That is a blackjack risk/reward curve derived from a theorem rather
than from a tuning pass, and it is a much better reason for a bust mechanic than
"we needed one."

Two things I'd want to prototype next, in order:

- **A cost on wires, not on agents.** Agents are the resource you're given; wires
  are the resource you spend. That makes "which two ports" the whole decision.
- **A visible fuel gauge as the clock.** Watching a net you built race a fuel bar
  is where the watching becomes tense rather than decorative — and it makes the
  bust legible in the moment instead of at the end.

The thing I'd be most careful about: this is beautiful at 8 agents and
incomprehensible at 64, while the *skill headroom* also shrinks as nets grow. So
the interesting game and the legible game are the same small game. That's lucky,
but it means there's no obvious growth axis — a roguelike built on this cannot
scale by making the net bigger, and would need to escalate some other way
(new symbols with their own rules, constraints on wiring, or a target normal
form to hit rather than a raw score).

---

## The "clear the net" demo

`/play.html` (dev only, `npm run dev`) is a playable slice of the game concept:
**a level is an enemy net with free wires, and you win by reducing it to zero
agents.** Two card types — an agent card (γ/δ/ε) plugs into a free wire
principal-port-first, and a wire card splices two loose ends together.

I probed the concept against the real reducer before building any of it
(`tools/inet-clear.ts`), because it lives or dies on one question:

**Is ε-spam dominant?** No — and that is the whole reason this works. Plugging ε
into every free wire clears only **44–60%** of random enemies, and when it fails
it strands about three agents. The reason is structural: erasing a γ spawns *two*
erasers on its aux wires, so if those lead to free ports the erasers just sit
there. **Erasure does not clean up after itself.** Reaching zero means making two
erasure waves meet head-on, which is what wire cards are for.

Three consequences fall straight out of the rewrite rules, and between them they
are the game:

| | |
|---|---|
| **Match the symbol** | γ meets γ → annihilate. Cheap, surgical, no fallout. On the smallest possible level (one γ) this clears in **1 card** where ε-spam takes 3. |
| **Only principal ports are live** | A card plugged into a wire that leads to an *aux* port builds structure and starts nothing. The enemy's interface is its attack surface — and that is a real level-design knob. |
| **The interface is a resource** | γ and δ each bring two new free wires; ε brings none. You open and close the interface as you go. |

δ earns its place too, which surprised me — duplication makes strictly *more*
work, so I expected it to be a trap card. It shows up throughout optimal lines
anyway, because commuting **restructures** a net so things line up to annihilate
later. "Makes it worse before it gets better" is a good card to have.

### You cannot tell by looking whether a net is clearable

This is the real engineering constraint. A δ in the wrong place duplicates
whatever you throw at it and the level is simply unwinnable; other nets need one
specific three-card line. So `solver.ts` does an iterative-deepening search with
the hand as the branching constraint, and **every shipped level is verified by
it** — `tests/inet/solver.test.ts` re-derives every par and fails if a level
drifts off it or stops being solvable. Authoring these by eye does not work: of
the eight levels I hand-wrote, the solver caught two that were mis-stated and one
whose declared lesson was not what its cheapest line actually did.

Two things follow that matter for any larger version:

- **Search is exponential**, so levels are bounded to roughly ≤6 agents and ≤4
  cards. Comfortably enough for hand-authored puzzles, and it happens to coincide
  with the sizes that are legible anyway — but it means a generator could not
  scale levels arbitrarily without a smarter solver.
- **`par` is an upper bound, not a proven floor.** The solver searches the policy
  "reduce to normal form between moves"; a player can also stop reduction
  part-way and play into a half-reduced net. Reduction never creates or destroys
  free wires, so the same wires are always available, but what sits at the far
  end of one can change as an erasure wave travels along it. The demo reports
  beating par as *under par* rather than treating it as impossible.

---

## Notes on the code

- `src/inet/{net,reduce,layout,generate,presets}.ts` are pure and DOM-free.
  `render.ts` is canvas-only. `sandbox.ts` is the only file that touches the DOM
  beyond the canvas.
- **The sandbox chrome (buttons, HUD) is HTML, not canvas.** The net itself is
  canvas-only and matches the game's visual language; the controls are DOM
  because this is a dev tool where a legible metric readout beats matching the
  game's hand-drawn widgets.
- **`sandbox.html` is not in the game bundle.** `vite dev` serves any HTML file
  in the project root, so it is at `/sandbox.html` with no configuration at all;
  `vite.config.ts` only adds it as a second Rollup input when `INET_SANDBOX=1`,
  which keeps it out of `npm run build` and off the PWA precache.
- **The sandbox caps automatic runs at an agent count** (default 1000, settable
  in the toolbar). A diverging net doubles every parallel round, so an unattended
  Run will allocate until the tab dies — `diverge` reaches 10,002 agents in 5000
  interactions from a two-agent start. A deliberate Step is always allowed
  through the cap; only automatic running is stopped, and the HUD says why.
- `reduce` maintains its redex worklist incrementally (`step` returns the agents
  it touched) rather than rescanning. Rescanning made diverging nets quadratic —
  the test suite went from 100s to 15s.
- The per-pair rule override table (the stretch goal) is **not** implemented. The
  shape is open for it: `ruleFor(a, b)` is the single place the decision is made,
  and `ReduceResult` would grow a `deadlocked` flag. The "wire card" interaction
  *is* implemented — clicking two ports is the only way to create a redex in the
  sandbox, exactly as it would be in a game.

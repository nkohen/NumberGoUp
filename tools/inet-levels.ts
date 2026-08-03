/**
 * Level analyser for the "clear the net" demo.
 * Run: `npx vite-node tools/inet-levels.ts`.
 *
 * Prints, for every level: whether it is solvable at all, the cheapest line the
 * solver found, and whether that line matches the lesson the level claims to
 * teach. Use it to tune a hand until `par` is the number you want — authoring
 * these by eye does not work, because whether a net can be cleared is not
 * visible from its shape.
 */
import { LEVELS } from "../src/inet/levels";
import { allReachable, cardLabel, moveLabel, type Card } from "../src/inet/level";
import { solve } from "../src/inet/solver";
import { activePairs } from "../src/inet/reduce";

function handOf(hand: readonly Card[]): string {
  return hand.map(cardLabel).join(" ");
}

console.log("Level analysis — par is whatever the solver finds, not what we hoped\n");

let bad = 0;
for (const level of LEVELS) {
  const net = level.build();
  const reachable = allReachable(net);
  const redexes = activePairs(net).length;
  const result = solve(net.clone(), level.hand, { maxCards: 5 });
  const par = result.solution?.cards ?? null;
  const ok = par === level.par;
  if (!ok || !reachable) bad++;

  console.log(`${ok && reachable ? "  " : "!!"} ${level.id.padEnd(14)} ${String(net.agentCount).padStart(2)} agents · ` +
    `${String(net.freePorts().length).padStart(2)} free wires · ${redexes} redex · hand [${handOf(level.hand)}]`);
  console.log(`     declared par ${level.par}   solver par ${par ?? "UNSOLVABLE"}` +
    `${result.exhaustive ? "" : "  (search budget hit — result not proven minimal)"}` +
    `${reachable ? "" : "   UNREACHABLE AGENTS — unwinnable"}`);
  if (result.solution) {
    console.log(`     line: ${result.solution.line.map(moveLabel).join("   →   ")}`);
  }
  console.log(`     nodes ${result.nodes}`);
  console.log();
}

console.log(bad === 0 ? "All levels check out." : `${bad} level(s) need attention.`);

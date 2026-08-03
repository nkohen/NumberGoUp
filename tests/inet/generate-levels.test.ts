import { describe, it, expect } from "vitest";
import { ALPHABETS } from "../../src/inet/alphabets";
import { defaultHand, generateLevels, makeEnemy } from "../../src/inet/generate-levels";
import { allReachable, applyMove, cardFor, isCleared, spend, type Card } from "../../src/inet/level";
import { activePairs, reduce } from "../../src/inet/reduce";
import { solve } from "../../src/inet/solver";

describe("level generation", () => {
  for (const alphabet of ALPHABETS) {
    // One generation pass per alphabet, checked for everything: generating is
    // the expensive part (it solves every candidate), so doing it twice would
    // double the suite's runtime for no extra coverage.
    it(`${alphabet.id}: produces playable levels, clearable at their stated par`, () => {
      const levels = generateLevels(alphabet, 3, 7);
      expect(levels.length, `${alphabet.id} produced no levels`).toBeGreaterThan(0);

      for (const level of levels) {
        const net = level.build();
        net.assertWellFormed(level.id);
        // The player opens the action: a level must not start mid-reaction.
        expect(activePairs(net), `${level.id} starts with a redex`).toHaveLength(0);
        // Nothing unreachable, or the level would be unwinnable by construction.
        expect(allReachable(net), `${level.id} has unreachable agents`).toBe(true);
        expect(level.par).toBeGreaterThan(0);
        expect(level.hand.length).toBeGreaterThanOrEqual(level.par);

        // `build` replays a seed, so it must be reproducible.
        expect(level.build().signature()).toBe(net.signature());

        // The stated par is real: re-solve, then replay the line and confirm it
        // actually clears the net.
        const result = solve(level.build(), level.hand, { maxCards: level.par });
        expect(result.solution?.cards, `${level.id} par drifted`).toBe(level.par);

        const replay = level.build();
        let hand: readonly Card[] = level.hand;
        reduce(replay, { fuel: 2000 });
        for (const move of result.solution!.line) {
          const rest = spend(hand, cardFor(move));
          expect(rest, `${level.id}: plays a card not in hand`).not.toBeNull();
          hand = rest!;
          expect(applyMove(replay, move)).toBe(true);
          reduce(replay, { fuel: 2000 });
          replay.assertWellFormed(`${level.id} mid-line`);
        }
        expect(isCleared(replay), `${level.id}: line did not clear`).toBe(true);
      }
    });
  }

  it("rejects enemies that start reacting or have unreachable agents", () => {
    // Sample a stretch of seeds and confirm the filter never lets a bad one out.
    let accepted = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const net = makeEnemy(ALPHABETS[0], seed * 31, 3);
      if (!net) continue;
      accepted++;
      expect(activePairs(net)).toHaveLength(0);
      expect(allReachable(net)).toBe(true);
      expect(net.freePorts().length).toBeGreaterThanOrEqual(2);
      expect(net.freePorts().length).toBeLessThanOrEqual(7);
    }
    expect(accepted).toBeGreaterThan(0);
  });

  it("offers two of every symbol plus wires", () => {
    for (const alphabet of ALPHABETS) {
      const hand = defaultHand(alphabet);
      expect(hand.filter((c) => c.kind === "wire")).toHaveLength(2);
      for (const def of alphabet.symbols) {
        expect(hand.filter((c) => c.kind === "agent" && c.symbol === def.symbol)).toHaveLength(2);
      }
    }
  });
});

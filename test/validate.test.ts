import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLadder, fromCumulative, validateLadder } from "../src/ladder.js";
import { syntheticLevels } from "./fixtures.js";

test("a real ladder passes", () => {
  assert.deepEqual(validateLadder(syntheticLevels), []);
  assert.doesNotThrow(() => assertLadder(syntheticLevels));
});

test("cumulative figures passed as incremental are caught", () => {
  // The quiet failure: nothing throws, every number looks plausible, and the
  // book appears several times deeper than it is.
  const cumulative = [
    { bps: 5, usd: 612_000 },
    { bps: 10, usd: 1_160_000 },
    { bps: 25, usd: 1_631_000 },
    { bps: 50, usd: 2_033_000 },
  ];

  const problems = validateLadder(cumulative);
  assert.ok(problems.length > 0);
  assert.match(problems[0]!.message, /cumulative/);

  // And the fix it points at actually clears the warning.
  assert.deepEqual(
    validateLadder(fromCumulative(cumulative.map((l) => ({ bps: l.bps, cumulativeUsd: l.usd })))),
    [],
  );
});

test("three rising bands are not enough to accuse — a real book could do that", () => {
  const problems = validateLadder([
    { bps: 5, usd: 100 },
    { bps: 10, usd: 200 },
    { bps: 25, usd: 300 },
  ]);
  assert.equal(problems.filter((p) => /cumulative/.test(p.message)).length, 0);
});

test("bps must increase away from mid", () => {
  const problems = validateLadder([
    { bps: 25, usd: 500 },
    { bps: 10, usd: 400 },
  ]);
  assert.match(problems[0]!.message, /must increase away from mid/);
  assert.equal(problems[0]!.level, 1);
});

test("negative or non-finite numbers are caught with the level that carries them", () => {
  const problems = validateLadder([
    { bps: 5, usd: 100 },
    { bps: 10, usd: -1 },
    { bps: Number.NaN, usd: 50 },
  ]);
  assert.ok(problems.some((p) => p.level === 1 && /usd/.test(p.message)));
  assert.ok(problems.some((p) => p.level === 2 && /bps/.test(p.message)));
});

test("an empty ladder is reported once, not per-level", () => {
  const problems = validateLadder([]);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.message, /no levels/);
});

test("assertLadder throws with every problem in the message", () => {
  assert.throws(
    () => assertLadder([{ bps: -1, usd: -1 }]),
    (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /bps/);
      assert.match(error.message, /usd/);
      return true;
    },
  );
});

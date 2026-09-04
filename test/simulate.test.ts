import assert from "node:assert/strict";
import { test } from "node:test";
import { bookDepth, simulateOrders, walkLadder } from "../src/ladder.js";
import { BOOK_TOTAL, ORACLE, syntheticLevels } from "./fixtures.js";

test("later orders clear worse — each one pays for the ones before it", () => {
  const { fills } = simulateOrders(syntheticLevels, ORACLE, [400_000, 400_000, 400_000]);

  assert.equal(fills.length, 3);
  assert.ok(fills[1]!.exitGapPct < fills[0]!.exitGapPct);
  assert.ok(fills[2]!.exitGapPct < fills[1]!.exitGapPct);
});

test("quoting each leg independently is the flattering version", () => {
  // The mistake this function exists to prevent: pricing every order as if it
  // were first, then being surprised by the fill.
  const legs = [500_000, 500_000, 500_000];
  const independent = legs.map((s) => walkLadder(syntheticLevels, ORACLE, s).exitGapPct);
  const { fills } = simulateOrders(syntheticLevels, ORACLE, legs);

  assert.equal(independent[0], fills[0]!.exitGapPct, "the first leg is identical either way");
  assert.ok(fills[2]!.exitGapPct < independent[2]!, "the third leg is materially worse in reality");
});

test("the book drains across the sequence", () => {
  const { fills } = simulateOrders(syntheticLevels, ORACLE, [600_000, 600_000]);
  assert.equal(fills[0]!.depthBeforeUsd, BOOK_TOTAL);
  assert.ok(Math.abs(fills[1]!.depthBeforeUsd - (BOOK_TOTAL - 600_000)) < 1e-6);
});

test("an order that outruns what is left is flagged, not extrapolated", () => {
  const { fills } = simulateOrders(syntheticLevels, ORACLE, [3_000_000, 500_000]);
  assert.equal(fills[0]!.exceedsBook, false);
  assert.equal(fills[1]!.exceedsBook, true, "only 120k was left for a 500k order");
  assert.ok(fills[1]!.filledUsd < 500_000);
});

test("the blended gap is size-weighted, not a mean of the legs", () => {
  const { fills, blendedGapPct, totalUsd } = simulateOrders(
    syntheticLevels,
    ORACLE,
    [100_000, 900_000],
  );

  assert.equal(totalUsd, 1_000_000);
  const weighted = (fills[0]!.exitGapPct * 100_000 + fills[1]!.exitGapPct * 900_000) / 1_000_000;
  assert.ok(Math.abs(blendedGapPct - weighted) < 1e-9);

  const mean = (fills[0]!.exitGapPct + fills[1]!.exitGapPct) / 2;
  assert.notEqual(Math.round(blendedGapPct * 1e6), Math.round(mean * 1e6));
});

test("one order matches a plain walk exactly", () => {
  const { fills, blendedGapPct } = simulateOrders(syntheticLevels, ORACLE, [750_000]);
  const direct = walkLadder(syntheticLevels, ORACLE, 750_000);
  assert.equal(fills[0]!.exitGapPct, direct.exitGapPct);
  // The blend is a weighted average, so it goes through a multiply and a
  // divide even for one leg — compared with tolerance, not bit-for-bit.
  assert.ok(Math.abs(blendedGapPct - direct.exitGapPct) < 1e-9);
});

test("the caller's ladder is not consumed", () => {
  const before = bookDepth(syntheticLevels);
  simulateOrders(syntheticLevels, ORACLE, [1_000_000, 1_000_000]);
  assert.equal(bookDepth(syntheticLevels), before);
});

test("an empty sequence is answerable, not an error", () => {
  const result = simulateOrders(syntheticLevels, ORACLE, []);
  assert.deepEqual(result.fills, []);
  assert.equal(result.totalUsd, 0);
  assert.equal(result.blendedGapPct, 0);
});

test("a zero-sized leg is refused", () => {
  assert.throws(() => simulateOrders(syntheticLevels, ORACLE, [100_000, 0]), RangeError);
});

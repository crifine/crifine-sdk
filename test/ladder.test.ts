import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TAIL_PENALTY_BPS,
  bookDepth,
  fromCumulative,
  slippageCurve,
  walkLadder,
} from "../src/ladder.js";
import { BOOK_TOTAL, ORACLE, syntheticLevels } from "./fixtures.js";

test("a size inside the first band pays that band's slippage exactly", () => {
  const result = walkLadder(syntheticLevels, ORACLE, 100_000);
  assert.equal(result.slippageBps, 5);
  assert.equal(result.exceedsBook, false);
  assert.equal(result.filledUsd, 100_000);
  assert.equal(result.realizedPriceEst, ORACLE * (1 - 5 / 10_000));
});

test("a size spanning two bands is volume-weighted, not averaged", () => {
  // 612k at 5bp, then 88k at 10bp.
  const result = walkLadder(syntheticLevels, ORACLE, 700_000);
  const expected = (612_000 * 5 + 88_000 * 10) / 700_000;
  assert.ok(Math.abs(result.slippageBps - expected) < 1e-9);
  // The naive mean of the two band rates would be 7.5 — materially different.
  assert.notEqual(Math.round(result.slippageBps * 100), 750);
});

test("bigger sizes never clear better", () => {
  const sizes = [50_000, 250_000, 1_000_000, 2_500_000];
  const curve = slippageCurve(syntheticLevels, ORACLE, sizes);
  for (let i = 1; i < curve.length; i++) {
    assert.ok(
      curve[i]!.result.realizedPriceEst <= curve[i - 1]!.result.realizedPriceEst,
      `size ${sizes[i]} cleared better than ${sizes[i - 1]}`,
    );
  }
});

test("a size past the whole book is flagged, not extrapolated", () => {
  const result = walkLadder(syntheticLevels, ORACLE, 5_000_000);
  assert.equal(result.exceedsBook, true);
  assert.equal(result.filledUsd, BOOK_TOTAL);

  // The unfilled remainder is charged at the penalty, so the number is far
  // worse than any observed band — which is the signal to stop trusting it.
  assert.ok(result.slippageBps > 400);
  assert.ok(result.slippageBps < TAIL_PENALTY_BPS);
});

test("exactly the book total does not trip the flag", () => {
  const result = walkLadder(syntheticLevels, ORACLE, BOOK_TOTAL);
  assert.equal(result.exceedsBook, false);
  assert.equal(Math.round(result.filledUsd), BOOK_TOTAL);
});

test("a closed underlying market makes the same book clear worse", () => {
  const open = walkLadder(syntheticLevels, ORACLE, 1_000_000, { marketOpen: true });
  const shut = walkLadder(syntheticLevels, ORACLE, 1_000_000, { marketOpen: false });
  assert.ok(shut.realizedPriceEst < open.realizedPriceEst);
  assert.ok(Math.abs(shut.slippageBps / open.slippageBps - 1.45) < 1e-9);
});

test("a size of zero or less is refused rather than answered", () => {
  assert.throws(() => walkLadder(syntheticLevels, ORACLE, 0), RangeError);
  assert.throws(() => walkLadder(syntheticLevels, ORACLE, -1), RangeError);
});

test("cumulative ladders convert without double-counting", () => {
  const cumulative = [
    { bps: 5, cumulativeUsd: 612_000 },
    { bps: 10, cumulativeUsd: 1_160_000 },
    { bps: 25, cumulativeUsd: 1_631_000 },
  ];
  const levels = fromCumulative(cumulative);
  assert.deepEqual(
    levels.map((level) => level.usd),
    [612_000, 548_000, 471_000],
  );
  assert.equal(bookDepth(levels), 1_631_000);
});

test("feeding cumulative figures in raw would overstate the book — the reason fromCumulative exists", () => {
  const raw = [
    { bps: 5, usd: 612_000 },
    { bps: 10, usd: 1_160_000 },
    { bps: 25, usd: 1_631_000 },
  ];
  assert.ok(bookDepth(raw) > bookDepth(fromCumulative(
    raw.map((l) => ({ bps: l.bps, cumulativeUsd: l.usd })),
  )));
});

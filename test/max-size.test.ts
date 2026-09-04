import assert from "node:assert/strict";
import { test } from "node:test";
import { bookDepth, maxSizeFor, walkLadder } from "../src/ladder.js";
import { BOOK_TOTAL, ORACLE, syntheticLevels } from "./fixtures.js";

test("the answer actually clears within the limit", () => {
  for (const limit of [-0.1, -0.5, -1, -2, -5]) {
    const size = maxSizeFor(syntheticLevels, ORACLE, limit);
    if (size === 0) continue;
    const actual = walkLadder(syntheticLevels, ORACLE, size).exitGapPct;
    assert.ok(actual >= limit, `at ${limit}%, ${size} actually clears at ${actual}%`);
  }
});

test("one step larger would breach — the answer is the largest that fits", () => {
  const limit = -1;
  const size = maxSizeFor(syntheticLevels, ORACLE, limit, { step: 1000 });
  const bigger = walkLadder(syntheticLevels, ORACLE, size + 2000).exitGapPct;
  assert.ok(bigger < limit, "a materially larger size should breach the limit");
});

test("a generous limit returns the whole book, never more", () => {
  const size = maxSizeFor(syntheticLevels, ORACLE, -50);
  assert.equal(size, BOOK_TOTAL);
  assert.equal(size, bookDepth(syntheticLevels));
});

test("it never returns a size past the observed book", () => {
  // Even an absurd allowance must not reach into unmeasured depth, where the
  // tail penalty applies and there is no data to stand on.
  const size = maxSizeFor(syntheticLevels, ORACLE, -99);
  assert.ok(size <= BOOK_TOTAL);
  assert.equal(walkLadder(syntheticLevels, ORACLE, size).exceedsBook, false);
});

test("an impossible limit returns zero rather than a misleading small number", () => {
  // The first band already costs 5bp; nothing clears inside 0.01%.
  assert.equal(maxSizeFor(syntheticLevels, ORACLE, -0.01), 0);
});

test("a tighter limit never allows more size than a looser one", () => {
  const limits = [-0.1, -0.25, -0.5, -1, -2, -4];
  const sizes = limits.map((limit) => maxSizeFor(syntheticLevels, ORACLE, limit));
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i]! >= sizes[i - 1]!, `${limits[i]} allowed less than ${limits[i - 1]}`);
  }
});

test("a closed market allows less size for the same limit", () => {
  const open = maxSizeFor(syntheticLevels, ORACLE, -1, { marketOpen: true });
  const shut = maxSizeFor(syntheticLevels, ORACLE, -1, { marketOpen: false });
  assert.ok(shut < open, "the session penalty must shrink the affordable size");
});

test("a positive limit is refused — every size clears at some cost", () => {
  assert.throws(() => maxSizeFor(syntheticLevels, ORACLE, 0), RangeError);
  assert.throws(() => maxSizeFor(syntheticLevels, ORACLE, 1), RangeError);
});

test("an empty ladder answers zero rather than dividing by nothing", () => {
  assert.equal(maxSizeFor([], ORACLE, -1), 0);
});

test("step controls the granularity of the answer", () => {
  const coarse = maxSizeFor(syntheticLevels, ORACLE, -1, { step: 100_000 });
  assert.equal(coarse % 100_000, 0);
});

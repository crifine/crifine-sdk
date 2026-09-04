import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOCKING, blocks, decide, isUnmeasured } from "../src/policy.js";
import type { ExitEstimate } from "../src/types.js";

const estimate = (overrides: Partial<ExitEstimate> = {}): ExitEstimate => ({
  pool: "aave-v3 / WETH",
  as_of: "2026-08-29",
  oracle_price: 4820,
  exit_size_usd: 1_000_000,
  realized_price_est: 4815,
  exit_gap_pct: -0.1,
  slippage_bps: 10,
  exceeds_book: false,
  filled_usd: 1_000_000,
  days_observed: 7,
  market_open: true,
  method_version: "v1",
  evidence_url: "https://crifine.app/api/v1/exit/aave-v3-weth",
  ...overrides,
});

test("a policy that accepts any gap is refused at construction", () => {
  assert.throws(() => decide(estimate(), { maxGapPct: 0 }), RangeError);
  assert.throws(() => decide(estimate(), { maxGapPct: 2 }), RangeError);
});

test("a healthy book inside the limit proceeds", () => {
  const decision = decide(estimate(), { maxGapPct: -2 });
  assert.equal(decision.action, "proceed");
  assert.equal(blocks(decision), false);
  assert.match(decision.reason, /within the -2% limit/);
});

/* ── The ordering, which is the whole point ─────────────────────────────── */

test("past the book refuses — even when the gap alone would only mean resize", () => {
  const decision = decide(
    estimate({ exceeds_book: true, filled_usd: 300_000, exit_gap_pct: -9 }),
    { maxGapPct: -2 },
  );
  assert.equal(decision.action, "refuse");
  assert.notEqual(decision.action, "resize");
  assert.match(decision.reason, /no price/);
});

test("past the book outranks a closed market too", () => {
  const decision = decide(
    estimate({ exceeds_book: true, filled_usd: 100_000, market_open: false }),
    { maxGapPct: -2 },
  );
  assert.equal(decision.action, "refuse");
});

test("a short record refuses before the gap is even considered", () => {
  // A gap well inside the limit must not rescue an estimate with no history.
  const decision = decide(estimate({ days_observed: 2, exit_gap_pct: -0.05 }), {
    maxGapPct: -2,
    minDaysObserved: 30,
  });
  assert.equal(decision.action, "refuse");
  assert.match(decision.reason, /only 2 days of record/);
});

test("a closed market defers, not holds — it is a time problem", () => {
  const decision = decide(estimate({ market_open: false, exit_gap_pct: -0.01 }), {
    maxGapPct: -2,
  });
  assert.equal(decision.action, "defer");
  assert.match(decision.reason, /time risk, not a price one/);
});

test("a closed market can be opted into deliberately", () => {
  const decision = decide(estimate({ market_open: false }), {
    maxGapPct: -2,
    allowClosedMarket: true,
  });
  assert.equal(decision.action, "proceed");
});

/* ── Resize vs hold ─────────────────────────────────────────────────────── */

test("a thin book with headroom suggests a smaller size", () => {
  const decision = decide(
    estimate({ exit_gap_pct: -5, exit_size_usd: 1_000_000, filled_usd: 400_000 }),
    { maxGapPct: -2 },
  );
  assert.equal(decision.action, "resize");
  assert.equal(decision.suggestedSizeUsd, 400_000);
});

test("a thin book with no headroom holds — a smaller order does not fix it", () => {
  const decision = decide(
    estimate({ exit_gap_pct: -5, exit_size_usd: 1_000_000, filled_usd: 1_000_000 }),
    { maxGapPct: -2 },
  );
  assert.equal(decision.action, "hold");
  assert.equal(decision.suggestedSizeUsd, undefined);
  assert.match(decision.reason, /does not fix a thin book/);
});

test("a resize below minResizeUsd becomes a hold rather than a pointless order", () => {
  const decision = decide(
    estimate({ exit_gap_pct: -5, exit_size_usd: 1_000_000, filled_usd: 5_000 }),
    { maxGapPct: -2, minResizeUsd: 50_000 },
  );
  assert.equal(decision.action, "hold");
});

/* ── Helpers ────────────────────────────────────────────────────────────── */

test("every blocking action actually blocks, and proceed does not", () => {
  for (const action of BLOCKING) {
    assert.ok(["refuse", "hold", "defer"].includes(action));
  }
  assert.equal(blocks({ action: "proceed", reason: "", estimate: estimate() }), false);
  assert.equal(blocks({ action: "refuse", reason: "", estimate: estimate() }), true);
});

test("isUnmeasured is exactly the past-the-book condition", () => {
  assert.equal(isUnmeasured(estimate()), false);
  assert.equal(isUnmeasured(estimate({ exceeds_book: true })), true);
});

test("the decision carries its estimate, so a log line stands alone", () => {
  const decision = decide(estimate(), { maxGapPct: -2 });
  assert.equal(decision.estimate.evidence_url, estimate().evidence_url);
});

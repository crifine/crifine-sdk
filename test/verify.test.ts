import assert from "node:assert/strict";
import { test } from "node:test";
import { walkLadder } from "../src/ladder.js";
import { verify, verifyUrl } from "../src/verify.js";
import type { Evidence } from "../src/types.js";
import { ORACLE, syntheticEvidence, syntheticLevels } from "./fixtures.js";

/** An evidence payload whose published result is genuinely correct. */
function honest(size = 1_000_000, marketOpen = true): Evidence {
  const evidence = syntheticEvidence({ assumed_size_usd: size });
  const truth = walkLadder(syntheticLevels, ORACLE, size, { marketOpen });
  evidence.result = {
    realized_price_est: truth.realizedPriceEst,
    exit_gap_pct: truth.exitGapPct,
    market_open: marketOpen,
  };
  return evidence;
}

test("an honest payload verifies", () => {
  const verdict = verify(honest());
  assert.equal(verdict.matches, true);
  assert.deepEqual(verdict.problems, []);
  assert.ok(Math.abs(verdict.deltaBps) < 1e-6);
});

/* ── The half that matters: it must be able to say no ─────────────────────
   A verifier that only ever confirms proves nothing. Each test below breaks
   the payload in a different, realistic way. */

test("a flattering price is rejected", () => {
  const evidence = honest();
  // Claim 20 bps better than the ladder supports — small enough to look like
  // rounding, large enough to matter on a $5M order.
  evidence.result.realized_price_est *= 1 + 20 / 10_000;

  const verdict = verify(evidence);
  assert.equal(verdict.matches, false);
  assert.ok(verdict.deltaBps > 15, `expected a positive delta, got ${verdict.deltaBps}`);
  assert.match(verdict.problems[0]!, /above the recomputation/);
});

test("a pessimistic price is rejected too — verification is not one-sided", () => {
  const evidence = honest();
  evidence.result.realized_price_est *= 1 - 20 / 10_000;

  const verdict = verify(evidence);
  assert.equal(verdict.matches, false);
  assert.ok(verdict.deltaBps < -15);
  assert.match(verdict.problems[0]!, /below the recomputation/);
});

test("padding the ladder to make a thin book look deep is caught", () => {
  const evidence = honest(2_500_000);
  // The publisher inflates the deepest band; the claimed result no longer
  // follows from the ladder shipped alongside it.
  evidence.ladder.levels = evidence.ladder.levels.map((level, index) =>
    index === 0 ? { ...level, usd: level.usd * 4 } : level,
  );

  assert.equal(verify(evidence).matches, false);
});

test("a size the payload did not actually use is caught", () => {
  const evidence = honest(1_000_000);
  evidence.assumed_size_usd = 250_000; // result was computed for 1M

  assert.equal(verify(evidence).matches, false);
});

test("hiding a closed market is caught", () => {
  // Result computed with the session penalty, then relabelled as open.
  const evidence = honest(1_000_000, false);
  evidence.result.market_open = true;

  assert.equal(verify(evidence).matches, false);
});

test("tolerance admits floating-point noise but not a real difference", () => {
  const evidence = honest();
  evidence.result.realized_price_est += 1e-9;
  assert.equal(verify(evidence).matches, true);

  // 2 bps on a $4,820 oracle is about $0.96 — inside no sane tolerance.
  const drifted = honest();
  drifted.result.realized_price_est *= 1 + 2 / 10_000;
  assert.equal(verify(drifted).matches, false);
  assert.equal(verify(drifted, { toleranceBps: 5 }).matches, true);
});

/* ── Uncheckable is not the same as wrong ──────────────────────────────── */

test("a payload with no ladder is refused rather than assumed correct", () => {
  const evidence = honest();
  evidence.ladder.levels = [];

  const verdict = verify(evidence);
  assert.equal(verdict.matches, false);
  assert.match(verdict.problems.join(" "), /no ladder levels/);
});

test("a payload with no method version is refused", () => {
  const evidence = honest();
  evidence.method_version = "";

  assert.match(verify(evidence).problems.join(" "), /method_version/);
});

test("a payload with no assumed size is refused", () => {
  const evidence = honest();
  evidence.assumed_size_usd = 0;

  assert.match(verify(evidence).problems.join(" "), /assumed_size_usd/);
});

test("structural problems are reported together, not one at a time", () => {
  const evidence = honest();
  evidence.ladder.levels = [];
  evidence.method_version = "";
  evidence.assumed_size_usd = 0;

  assert.ok(verify(evidence).problems.length >= 3);
});

/* ── Fetching ─────────────────────────────────────────────────────────── */

test("verifyUrl reports a failed request instead of throwing", async () => {
  const verdict = await verifyUrl("https://example.invalid/evidence", {
    fetch: async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" }),
  });

  assert.equal(verdict.matches, false);
  assert.match(verdict.problems[0]!, /503/);
});

test("verifyUrl verifies a fetched payload", async () => {
  const verdict = await verifyUrl("https://example.invalid/evidence", {
    fetch: async () => Response.json(honest()),
  });

  assert.equal(verdict.matches, true);
});

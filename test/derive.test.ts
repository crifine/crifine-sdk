import assert from "node:assert/strict";
import { test } from "node:test";
import { depthDecay, gapSeries, rankRoutes, severity, stressWindow } from "../src/derive.js";
import type { DepthPoint, ExitEstimate } from "../src/types.js";
import { ORACLE, syntheticLevels } from "./fixtures.js";

const series: DepthPoint[] = [
  { date: "2026-08-22", depth_usd: 5_000_000, oracle_price: 4300, gap_pct: -1.0 },
  { date: "2026-08-23", depth_usd: 4_600_000, oracle_price: 4400, gap_pct: -1.4 },
  // The big move, and the drain that followed it.
  { date: "2026-08-24", depth_usd: 4_200_000, oracle_price: 4900, gap_pct: -2.2 },
  { date: "2026-08-25", depth_usd: 2_400_000, oracle_price: 4850, gap_pct: -6.1 },
  { date: "2026-08-26", depth_usd: 3_100_000, oracle_price: 4820, gap_pct: -4.4 },
];

test("severity bands match the documented thresholds", () => {
  assert.equal(severity(-0.4), "ok");
  assert.equal(severity(-1), "watch");
  assert.equal(severity(-3.9), "watch");
  assert.equal(severity(-4), "bad");
  // Direction must not change the band — magnitude is what matters.
  assert.equal(severity(4), "bad");
});

test("a stress window reports the worst point, not the average", () => {
  const window = stressWindow(series, 4);
  assert.equal(window.worstGapPct, -6.1);
  assert.equal(window.worstOn, "2026-08-25");
  assert.equal(window.lowestDepthUsd, 2_400_000);

  // The mean gap is about -3.0; reporting that would understate the risk by
  // half, which is the whole reason this function exists.
  const mean = series.reduce((sum, p) => sum + p.gap_pct, 0) / series.length;
  assert.ok(window.worstGapPct < mean);
});

test("a shorter window can only be worse-or-equal than a longer one, never better", () => {
  const short = stressWindow(series, 1);
  const long = stressWindow(series, 4);
  assert.ok(long.worstGapPct <= short.worstGapPct);
  assert.ok(long.lowestDepthUsd <= short.lowestDepthUsd);
});

test("a window longer than the record reports what it actually covered", () => {
  const window = stressWindow(series, 400);
  assert.equal(window.days, series.length - 1);
});

test("an empty series is refused rather than answered", () => {
  assert.throws(() => stressWindow([], 7), RangeError);
});

test("decay finds the largest move and what depth did after it", () => {
  const decay = depthDecay(series);
  assert.ok(decay);
  assert.equal(decay.moveOn, "2026-08-24");
  assert.ok(decay.movePct > 11, `expected the ~11.4% move, got ${decay.movePct}`);
  // Depth fell from 4.2M to 2.4M in the step that followed.
  assert.ok(decay.depthChangeAfterPct < -40);
  assert.equal(decay.recovered, false);
});

test("decay needs a real series before it will say anything", () => {
  assert.equal(depthDecay(series.slice(0, 2)), null);
  assert.equal(depthDecay([]), null);
});

const estimate = (pool: string, realized: number, size = 1_000_000): ExitEstimate => ({
  pool,
  as_of: "2026-08-29",
  oracle_price: 4820,
  exit_size_usd: size,
  realized_price_est: realized,
  exit_gap_pct: (realized / 4820 - 1) * 100,
  slippage_bps: 0,
  exceeds_book: false,
  filled_usd: size,
  days_observed: 7,
  market_open: true,
  method_version: "v1",
  evidence_url: `https://crifine.app/api/v1/exit/${pool}`,
});

test("routes rank by what they clear at, best first", () => {
  const routes = rankRoutes([
    estimate("camelot-weth", 4696),
    estimate("uniswap-v3-weth", 4817),
    estimate("aave-v3-weth", 4810),
  ]);

  assert.equal(routes[0]!.estimate.pool, "uniswap-v3-weth");
  assert.equal(routes[0]!.bpsBehindBest, 0);
  assert.ok(routes[2]!.bpsBehindBest > 200);
});

test("routes measured at different sizes are refused, not silently compared", () => {
  assert.throws(
    () => rankRoutes([estimate("a", 4810, 1_000_000), estimate("b", 4800, 5_000_000)]),
    RangeError,
  );
});

test("gapSeries recomputes the record at a size of your choosing", () => {
  const ladder = {
    pool: "aave-v3-weth",
    as_of: "2026-08-29",
    oracle_price: ORACLE,
    levels: syntheticLevels,
  };

  const small = gapSeries(series, ladder, 100_000);
  const large = gapSeries(series, ladder, 2_000_000);

  assert.equal(small.length, series.length);
  // Same days, bigger size, worse every time.
  for (let i = 0; i < small.length; i++) {
    assert.ok(large[i]!.gapPct <= small[i]!.gapPct);
  }
});

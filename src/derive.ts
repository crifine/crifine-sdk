/**
 * Derivations over a recorded series.
 *
 * These are documented behaviours of the API — stress windows, depth decay,
 * route ranking — implemented here so a caller can reproduce them from a
 * history payload instead of taking the server's word for it. Same reason
 * `walkLadder` is public: a derivation only the publisher can perform is not
 * checkable.
 *
 * All pure. No network, no clock.
 */

import { walkLadder, type WalkOptions } from "./ladder.js";
import type { DepthPoint, ExitEstimate, Ladder } from "./types.js";

/* ── Severity ───────────────────────────────────────────────────────────── */

export type Severity = "ok" | "watch" | "bad";

/**
 * Blunt on purpose: a reader should be able to act on the band without parsing
 * the number, and the number is always shown beside it anyway. These are the
 * same thresholds the docs describe — they are a reading aid, not a rule. Pick
 * your own for anything that gates money.
 */
export function severity(gapPct: number): Severity {
  const magnitude = Math.abs(gapPct);
  if (magnitude < 1) return "ok";
  if (magnitude < 4) return "watch";
  return "bad";
}

/* ── Stress windows ─────────────────────────────────────────────────────── */

export type StressWindow = {
  /** Days actually covered — may be shorter than requested. */
  days: number;
  lowestDepthUsd: number;
  medianDepthUsd: number;
  worstGapPct: number;
  /** The date the worst gap fell on. */
  worstOn: string;
};

/**
 * The worst condition inside a slice of the record, not the average across it.
 *
 * An average describes the days you did not need the measurement. A parameter
 * tuned to it is tuned to conditions under which it was never going to matter.
 */
export function stressWindow(series: readonly DepthPoint[], days: number): StressWindow {
  if (series.length === 0) {
    throw new RangeError("stressWindow needs at least one recorded point");
  }

  const slice = series.slice(-Math.max(1, days + 1));
  const worst = slice.reduce((a, b) => (b.gap_pct < a.gap_pct ? b : a));
  const depths = slice.map((point) => point.depth_usd).sort((a, b) => a - b);

  return {
    days: slice.length - 1,
    lowestDepthUsd: depths[0]!,
    medianDepthUsd: depths[Math.floor(depths.length / 2)]!,
    worstGapPct: worst.gap_pct,
    worstOn: worst.date,
  };
}

/* ── Depth decay ────────────────────────────────────────────────────────── */

export type Decay = {
  /** Date of the largest single-step oracle move in the series. */
  moveOn: string;
  movePct: number;
  /** Depth change over the step that followed that move. */
  depthChangeAfterPct: number;
  /** Depth change across the whole series. */
  depthChangeWindowPct: number;
  /** Whether depth had returned to its pre-move level by the end. */
  recovered: boolean;
};

/**
 * How fast a book thinned after a price move.
 *
 * Reported as an observation, never a forecast. Crifine measures the cost of
 * acting on a price; it does not predict what depth will do next, and a
 * function that implied otherwise would be the most dangerous thing in this
 * package.
 */
export function depthDecay(series: readonly DepthPoint[]): Decay | null {
  if (series.length < 3) return null;

  let index = 1;
  let largest = 0;
  for (let i = 1; i < series.length; i++) {
    const move = Math.abs(series[i]!.oracle_price / series[i - 1]!.oracle_price - 1);
    if (move > largest) {
      largest = move;
      index = i;
    }
  }

  const at = series[index]!;
  const after = series[Math.min(index + 1, series.length - 1)]!;
  const first = series[0]!;
  const last = series[series.length - 1]!;

  return {
    moveOn: at.date,
    movePct: (at.oracle_price / series[index - 1]!.oracle_price - 1) * 100,
    depthChangeAfterPct: (after.depth_usd / at.depth_usd - 1) * 100,
    depthChangeWindowPct: (last.depth_usd / first.depth_usd - 1) * 100,
    recovered: last.depth_usd >= at.depth_usd,
  };
}

/* ── Route ranking ──────────────────────────────────────────────────────── */

export type Route = {
  estimate: ExitEstimate;
  /** Basis points behind the best route at this size. 0 for the winner. */
  bpsBehindBest: number;
};

/**
 * Rank estimates for one asset by what they actually clear at.
 *
 * The ranking can invert between sizes: books differ in shape, not just level,
 * so a venue that wins at $50k can lose badly at $25M. Estimates computed at
 * different sizes are refused rather than silently compared.
 */
export function rankRoutes(estimates: readonly ExitEstimate[]): Route[] {
  if (estimates.length === 0) return [];

  const size = estimates[0]!.exit_size_usd;
  if (estimates.some((estimate) => estimate.exit_size_usd !== size)) {
    throw new RangeError(
      "rankRoutes compares estimates at one size — mixing sizes would rank books that were never measured against each other",
    );
  }

  const sorted = [...estimates].sort((a, b) => b.realized_price_est - a.realized_price_est);
  const best = sorted[0]!.realized_price_est;

  return sorted.map((estimate) => ({
    estimate,
    bpsBehindBest: best > 0 ? (1 - estimate.realized_price_est / best) * 10_000 : 0,
  }));
}

/* ── Reproducing a series locally ───────────────────────────────────────── */

/**
 * Recompute the gap at every point of a history, from a ladder shape.
 *
 * Useful for asking "what would this series look like at *my* size" rather
 * than the reference size the publisher chose.
 */
export function gapSeries(
  series: readonly DepthPoint[],
  ladder: Ladder,
  sizeUsd: number,
  options: WalkOptions = {},
): { date: string; gapPct: number }[] {
  const shape = ladder.levels;
  const total = shape.reduce((sum, level) => sum + level.usd, 0);
  if (total <= 0) throw new RangeError("ladder has no depth to scale");

  return series.map((point) => {
    // Scale the observed ladder shape to that day's total depth. The shape is
    // the publisher's; the level is the day's.
    const scale = point.depth_usd / total;
    const scaled = shape.map((level) => ({ ...level, usd: level.usd * scale }));

    return {
      date: point.date,
      gapPct: walkLadder(scaled, point.oracle_price, sizeUsd, options).exitGapPct,
    };
  });
}

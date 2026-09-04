/**
 * The measurement method, in the open.
 *
 * This is the whole calculation Crifine performs: walk the recorded depth
 * ladder for a stated size and report the volume-weighted price that size
 * clears at. It is a pure function — no network, no clock, no configuration
 * beyond what is passed in — so anyone can run it against a published evidence
 * payload and get the same number, or find that they do not.
 *
 * That reproducibility is the point. A measurement only the measurer can
 * perform is not a measurement.
 */

import type { Ladder, LadderLevel } from "./types.js";

/**
 * Past the last observed band the book is not merely thin, it is *unmeasured*.
 * The remainder is charged at a punitive rate and the result is flagged rather
 * than extrapolated: an estimate past the edge of the data is a guess, and it
 * should say so instead of dressing itself as a price.
 */
export const TAIL_PENALTY_BPS = 1500;

/**
 * When the underlying market is closed the observed book is not the book that
 * would absorb the trade — the participants who would have quoted against it
 * have gone home. Applied to RWA only, and always reported alongside
 * `market_open` so a caller can strip it back out.
 */
export const CLOSED_MARKET_MULTIPLIER = 1.45;

export type WalkResult = {
  realizedPriceEst: number;
  exitGapPct: number;
  slippageBps: number;
  /** True when the size is larger than the whole observed book. */
  exceedsBook: boolean;
  /** How much of the size the observed book absorbs. */
  filledUsd: number;
};

export type WalkOptions = {
  /** Defaults to true. Pass the pool's `market_open` for RWA. */
  marketOpen?: boolean;
  /** Override the penalty. Changing it changes the method — record it. */
  tailPenaltyBps?: number;
  closedMarketMultiplier?: number;
};

/**
 * Walk a ladder for a size.
 *
 * Levels are consumed in the order given; they are expected to run from the
 * band nearest the oracle price outward. Levels are *incremental*, not
 * cumulative — passing cumulative figures will silently overstate the book,
 * which is why `normaliseLadder` exists below.
 */
export function walkLadder(
  levels: readonly LadderLevel[],
  oraclePrice: number,
  sizeUsd: number,
  options: WalkOptions = {},
): WalkResult {
  if (!(sizeUsd > 0)) {
    throw new RangeError("sizeUsd must be greater than zero — an estimate without a size is meaningless");
  }
  if (!(oraclePrice > 0)) {
    throw new RangeError("oraclePrice must be greater than zero");
  }

  const tailPenalty = options.tailPenaltyBps ?? TAIL_PENALTY_BPS;
  const sessionPenalty =
    options.marketOpen === false
      ? (options.closedMarketMultiplier ?? CLOSED_MARKET_MULTIPLIER)
      : 1;

  let remaining = sizeUsd;
  let weightedBps = 0;
  let filledUsd = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.usd);
    weightedBps += take * level.bps;
    filledUsd += take;
    remaining -= take;
  }

  const exceedsBook = remaining > 1e-9;
  if (exceedsBook) weightedBps += remaining * tailPenalty;

  const slippageBps = (weightedBps / sizeUsd) * sessionPenalty;
  const realizedPriceEst = oraclePrice * (1 - slippageBps / 10_000);

  return {
    realizedPriceEst,
    exitGapPct: (realizedPriceEst / oraclePrice - 1) * 100,
    slippageBps,
    exceedsBook,
    filledUsd,
  };
}

/** Convenience: walk a whole `Ladder` payload. */
export function walk(
  ladder: Ladder,
  sizeUsd: number,
  options: WalkOptions = {},
): WalkResult {
  return walkLadder(ladder.levels, ladder.oracle_price, sizeUsd, options);
}

/**
 * Turn a cumulative ladder into an incremental one.
 *
 * Some sources publish `cumulative_usd` per level. Feeding those straight into
 * `walkLadder` double-counts every band below the deepest, which makes a thin
 * book look deep — the exact direction of error this product exists to prevent.
 */
export function fromCumulative(
  levels: readonly { bps: number; cumulativeUsd: number; price?: number }[],
): LadderLevel[] {
  let previous = 0;
  return levels.map((level) => {
    const usd = level.cumulativeUsd - previous;
    previous = level.cumulativeUsd;
    return level.price === undefined
      ? { bps: level.bps, usd }
      : { bps: level.bps, usd, price: level.price };
  });
}

/** Total liquidity across a ladder. */
export function bookDepth(levels: readonly LadderLevel[]): number {
  return levels.reduce((total, level) => total + level.usd, 0);
}

/**
 * Slippage across a range of sizes.
 *
 * Books are not linear and frequently not smooth — the size where a curve turns
 * vertical is usually the only number that matters for sizing.
 */
export function slippageCurve(
  levels: readonly LadderLevel[],
  oraclePrice: number,
  sizes: readonly number[],
  options: WalkOptions = {},
): { sizeUsd: number; result: WalkResult }[] {
  return sizes.map((sizeUsd) => ({
    sizeUsd,
    result: walkLadder(levels, oraclePrice, sizeUsd, options),
  }));
}

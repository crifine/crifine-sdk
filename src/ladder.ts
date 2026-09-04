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

/**
 * The inverse question: how much can I move before it costs me more than X?
 *
 * `walkLadder` answers "what does this size cost". This answers the question
 * people actually ask first — and the one that decides whether an order gets
 * sent at all. Binary search over the ladder rather than a closed form, because
 * the session penalty and the tail penalty make the curve piecewise and
 * non-invertible.
 *
 * Returns `0` when even the smallest meaningful size breaches the limit, and
 * never returns a size past the observed book: an answer that requires
 * unmeasured depth is not an answer.
 */
export function maxSizeFor(
  levels: readonly LadderLevel[],
  oraclePrice: number,
  maxGapPct: number,
  options: WalkOptions & { /** Rounding granularity in USD. Default 1000. */ step?: number } = {},
): number {
  if (!(maxGapPct < 0)) {
    throw new RangeError("maxGapPct must be negative — every size clears at some cost");
  }

  const ceiling = bookDepth(levels);
  if (ceiling <= 0) return 0;

  const step = Math.max(1, options.step ?? 1000);

  // The whole book is affordable, so there is nothing to search for.
  if (walkLadder(levels, oraclePrice, ceiling, options).exitGapPct >= maxGapPct) {
    return ceiling;
  }

  let low = 0;
  let high = ceiling;

  // 40 iterations resolves any book to well under a dollar; the step rounding
  // below is what actually decides the precision.
  for (let i = 0; i < 40 && high - low > step; i++) {
    const mid = (low + high) / 2;
    if (walkLadder(levels, oraclePrice, mid, options).exitGapPct >= maxGapPct) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const rounded = Math.floor(low / step) * step;

  // Rounding must never round *up* into a breach.
  return rounded > 0 && walkLadder(levels, oraclePrice, rounded, options).exitGapPct >= maxGapPct
    ? rounded
    : 0;
}

/** A problem that makes a ladder unusable, or usable but misleading. */
export type LadderProblem = {
  level?: number;
  message: string;
};

/**
 * Check a ladder before trusting it.
 *
 * The failure this exists to catch is the quiet one: a cumulative ladder fed in
 * as if it were incremental. Nothing throws, every number looks plausible, and
 * the book appears several times deeper than it is — an error in the exact
 * direction that gets someone hurt. Cumulative data is detectable because its
 * levels never decrease across a long run, which a real book essentially never
 * does as it moves away from mid.
 */
export function validateLadder(levels: readonly LadderLevel[]): LadderProblem[] {
  const problems: LadderProblem[] = [];

  if (levels.length === 0) {
    return [{ message: "ladder has no levels" }];
  }

  levels.forEach((level, index) => {
    if (!Number.isFinite(level.bps) || level.bps <= 0) {
      problems.push({ level: index, message: `bps must be a positive number, got ${level.bps}` });
    }
    if (!Number.isFinite(level.usd) || level.usd < 0) {
      problems.push({ level: index, message: `usd must be zero or more, got ${level.usd}` });
    }
    if (index > 0 && level.bps <= levels[index - 1]!.bps) {
      problems.push({
        level: index,
        message: `bps must increase away from mid; ${level.bps} follows ${levels[index - 1]!.bps}`,
      });
    }
  });

  // Monotonically non-decreasing depth across four or more bands is the
  // signature of cumulative figures. Two or three could be a real book.
  if (levels.length >= 4) {
    const nonDecreasing = levels.every(
      (level, index) => index === 0 || level.usd >= levels[index - 1]!.usd,
    );
    if (nonDecreasing) {
      problems.push({
        message:
          "depth never decreases across the whole ladder, which usually means cumulative figures were passed as incremental — run them through fromCumulative first, or the book will look several times deeper than it is",
      });
    }
  }

  return problems;
}

/** Convenience for callers that would rather fail than proceed on a bad ladder. */
export function assertLadder(levels: readonly LadderLevel[]): void {
  const problems = validateLadder(levels);
  if (problems.length > 0) {
    throw new RangeError(
      `unusable depth ladder: ${problems.map((problem) => problem.message).join("; ")}`,
    );
  }
}

/** One fill in a sequence, and what the book looked like by the time it ran. */
export type SimulatedFill = {
  sizeUsd: number;
  realizedPriceEst: number;
  exitGapPct: number;
  exceedsBook: boolean;
  /** Depth still resting when this order started. */
  depthBeforeUsd: number;
  /** How much of this order the remaining book could absorb. */
  filledUsd: number;
};

/**
 * Several orders against one book, in sequence.
 *
 * Every estimate elsewhere in this package answers for a single order against
 * an untouched book. Real execution is rarely that: a rebalance sends three
 * orders, a liquidation cascade sends many, and each one pays for the ones
 * before it.
 *
 * Quoting each leg independently is the flattering version — it prices every
 * order as if it were first. This walks them in order and consumes the book as
 * it goes, which is why the last leg usually looks nothing like the first.
 *
 * It assumes no refill between orders, which is the honest assumption over a
 * short window: depth that has not been observed returning cannot be counted on.
 */
export function simulateOrders(
  levels: readonly LadderLevel[],
  oraclePrice: number,
  sizes: readonly number[],
  options: WalkOptions = {},
): { fills: SimulatedFill[]; totalUsd: number; blendedGapPct: number } {
  // A working copy: the caller's ladder is not consumed.
  const remaining = levels.map((level) => ({ ...level }));
  const fills: SimulatedFill[] = [];

  let weightedGap = 0;
  let totalUsd = 0;

  for (const sizeUsd of sizes) {
    if (!(sizeUsd > 0)) {
      throw new RangeError("every simulated order needs a size greater than zero");
    }

    const depthBeforeUsd = remaining.reduce((sum, level) => sum + level.usd, 0);
    const result = walkLadder(remaining, oraclePrice, sizeUsd, options);

    // Consume what this order took, nearest bands first.
    let toConsume = Math.min(sizeUsd, depthBeforeUsd);
    for (const level of remaining) {
      if (toConsume <= 0) break;
      const taken = Math.min(toConsume, level.usd);
      level.usd -= taken;
      toConsume -= taken;
    }

    fills.push({
      sizeUsd,
      realizedPriceEst: result.realizedPriceEst,
      exitGapPct: result.exitGapPct,
      exceedsBook: result.exceedsBook,
      depthBeforeUsd,
      filledUsd: result.filledUsd,
    });

    weightedGap += result.exitGapPct * sizeUsd;
    totalUsd += sizeUsd;
  }

  return {
    fills,
    totalUsd,
    blendedGapPct: totalUsd > 0 ? weightedGap / totalUsd : 0,
  };
}

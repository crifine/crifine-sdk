/**
 * Turning a measurement into a decision.
 *
 * Every agent that consumes this data ends up writing the same branch: is the
 * gap acceptable, is the size past the book, is the market shut. Writing it
 * once here means the ordering is decided once — and the ordering is the part
 * people get wrong.
 *
 * **`unmeasured` outranks `expensive`.** A size past the edge of the recorded
 * book is not a bad price, it is the absence of one. An agent that folds the
 * two together will proceed on a number nobody measured, which is the failure
 * this whole product exists to prevent. `decide` will not let you conflate them.
 */

import type { ExitEstimate } from "./types.js";

export type Action =
  /** The book supports this size at this price. */
  | "proceed"
  /** Measured, but worse than the policy allows. A smaller size may clear. */
  | "resize"
  /** Measured and too expensive; waiting is the move, not resizing. */
  | "hold"
  /** The underlying market is shut. This is a time problem, not a price one. */
  | "defer"
  /** Past the edge of the data. There is no price to act on. */
  | "refuse";

export type Policy = {
  /**
   * Worst acceptable gap, in percent, negative. Required — a policy without
   * one accepts everything, which is not a policy.
   */
  maxGapPct: number;
  /**
   * Refuse when the record backing the estimate is shorter than this many
   * days. Confidence is a disclosed field; ignoring it is a choice, so make it
   * an explicit one.
   */
  minDaysObserved?: number;
  /** Allow acting while the underlying market is closed. Default false. */
  allowClosedMarket?: boolean;
  /**
   * Smallest size worth retrying at, in USD. Below this, `resize` becomes
   * `hold` — there is no point suggesting an order too small to bother with.
   */
  minResizeUsd?: number;
};

export type Decision = {
  action: Action;
  /** One sentence, safe to log or show a human. */
  reason: string;
  /** Set on `resize`: the largest size the observed book can absorb. */
  suggestedSizeUsd?: number;
  /** The estimate the decision was made from, so a log line is self-contained. */
  estimate: ExitEstimate;
};

/** True when acting on this estimate would mean acting on an unmeasured number. */
export function isUnmeasured(estimate: ExitEstimate): boolean {
  return estimate.exceeds_book;
}

/**
 * Decide what to do with an estimate.
 *
 * Checks run in a fixed order, and the order is the point:
 *
 * 1. `refuse` — past the book. Nothing else can rescue an unmeasured size.
 * 2. `refuse` — record too short. A number with no history behind it is a
 *    weaker claim than one with a long series, and the caller said how weak
 *    is too weak.
 * 3. `defer` — market shut. A threshold written for an open market does not
 *    apply to a closed one.
 * 4. `resize` / `hold` — only now does the gap matter.
 */
export function decide(estimate: ExitEstimate, policy: Policy): Decision {
  if (!(policy.maxGapPct < 0)) {
    throw new RangeError(
      "maxGapPct must be negative — a policy that accepts any gap is not a policy",
    );
  }

  const base = { estimate };

  if (estimate.exceeds_book) {
    const suggested = estimate.filled_usd;
    const worthRetrying = suggested >= (policy.minResizeUsd ?? 0) && suggested > 0;

    return {
      ...base,
      action: "refuse",
      reason: `${fmt(estimate.exit_size_usd)} is larger than the whole observed book; only ${fmt(suggested)} clears against recorded depth. Past that edge there is no price, only a penalty rate.`,
      ...(worthRetrying ? { suggestedSizeUsd: suggested } : {}),
    };
  }

  const minDays = policy.minDaysObserved;
  if (minDays !== undefined && estimate.days_observed < minDays) {
    return {
      ...base,
      action: "refuse",
      reason: `only ${estimate.days_observed} days of record back this estimate, and the policy requires ${minDays}.`,
    };
  }

  if (estimate.market_open === false && policy.allowClosedMarket !== true) {
    return {
      ...base,
      action: "defer",
      reason:
        "the underlying market is closed; the book that would absorb this trade has gone home. This is a time risk, not a price one.",
    };
  }

  if (estimate.exit_gap_pct < policy.maxGapPct) {
    // Measured but too expensive. Whether a smaller order helps depends on
    // how much headroom the book has, so only suggest one when it plausibly does.
    const headroom = estimate.filled_usd;
    const canResize =
      headroom > 0 &&
      headroom < estimate.exit_size_usd &&
      headroom >= (policy.minResizeUsd ?? 0);

    return canResize
      ? {
          ...base,
          action: "resize",
          reason: `gap of ${estimate.exit_gap_pct.toFixed(2)}% is past the ${policy.maxGapPct}% limit; the book absorbs ${fmt(headroom)}.`,
          suggestedSizeUsd: headroom,
        }
      : {
          ...base,
          action: "hold",
          reason: `gap of ${estimate.exit_gap_pct.toFixed(2)}% is past the ${policy.maxGapPct}% limit, and a smaller order does not fix a thin book.`,
        };
  }

  return {
    ...base,
    action: "proceed",
    reason: `gap of ${estimate.exit_gap_pct.toFixed(2)}% is within the ${policy.maxGapPct}% limit, across ${estimate.days_observed} days of record.`,
  };
}

/** Actions that mean "do not send the order". */
export const BLOCKING: readonly Action[] = ["refuse", "hold", "defer"];

export function blocks(decision: Decision): boolean {
  return BLOCKING.includes(decision.action);
}

function fmt(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `$${Math.round(value / 1000)}k`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

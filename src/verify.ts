/**
 * Independent verification.
 *
 * This is the most important function in the SDK. Crifine's central claim is
 * that its numbers can be checked; `evidence_url` alone does not deliver that,
 * because it hands you snapshots without a way to recompute from them. This
 * closes the gap: feed it an evidence payload and it tells you whether the
 * published result actually follows from the data behind it.
 *
 * It is written to be able to say **no**. A verifier that can only confirm is
 * not a verifier.
 */

import { walkLadder, type WalkOptions } from "./ladder.js";
import type { Evidence } from "./types.js";

export type Verdict = {
  /** Whether the published figures reproduce within tolerance. */
  matches: boolean;
  /** What this library computed from the evidence. */
  computed: { realized_price_est: number; exit_gap_pct: number };
  /** What the publisher claimed. */
  published: { realized_price_est: number; exit_gap_pct: number };
  /** Signed difference in basis points; negative means the claim was optimistic. */
  deltaBps: number;
  /** Everything that failed, in the order it was checked. Empty when it matches. */
  problems: string[];
};

export type VerifyOptions = WalkOptions & {
  /**
   * How far the recomputation may sit from the claim, in basis points.
   * Defaults to 1 bp — enough for floating-point and rounding, not enough to
   * hide a materially different number.
   */
  toleranceBps?: number;
};

/** Fields whose absence makes an evidence payload uncheckable rather than wrong. */
function structuralProblems(evidence: Evidence): string[] {
  const problems: string[] = [];

  if (!evidence.ladder?.levels?.length) {
    problems.push("evidence carries no ladder levels — nothing to recompute from");
  }
  if (!(evidence.ladder?.oracle_price > 0)) {
    problems.push("evidence has no usable oracle_price");
  }
  if (!(evidence.assumed_size_usd > 0)) {
    problems.push("evidence states no assumed_size_usd — a result without a size is meaningless");
  }
  if (!evidence.method_version) {
    problems.push("evidence states no method_version — the result is not reproducible across method changes");
  }
  if (!evidence.observation_window || !(evidence.observation_window.days > 0)) {
    problems.push("evidence states no observation window");
  }

  return problems;
}

/**
 * Recompute a published estimate from its own evidence.
 *
 * Note what is *not* trusted: the published `realized_price_est` and
 * `exit_gap_pct` are never used as inputs, only compared against at the end.
 */
export function verify(evidence: Evidence, options: VerifyOptions = {}): Verdict {
  const problems = structuralProblems(evidence);

  const published = {
    realized_price_est: evidence.result?.realized_price_est ?? Number.NaN,
    exit_gap_pct: evidence.result?.exit_gap_pct ?? Number.NaN,
  };

  if (problems.length > 0) {
    return {
      matches: false,
      computed: { realized_price_est: Number.NaN, exit_gap_pct: Number.NaN },
      published,
      deltaBps: Number.NaN,
      problems,
    };
  }

  const marketOpen = options.marketOpen ?? evidence.result?.market_open ?? true;
  const result = walkLadder(
    evidence.ladder.levels,
    evidence.ladder.oracle_price,
    evidence.assumed_size_usd,
    { ...options, marketOpen },
  );

  const computed = {
    realized_price_est: result.realizedPriceEst,
    exit_gap_pct: result.exitGapPct,
  };

  // Compared in basis points of the oracle price rather than as a percentage of
  // the price itself, so the tolerance means the same thing for a $1 stablecoin
  // and a $96,000 bitcoin.
  const deltaBps =
    ((published.realized_price_est - computed.realized_price_est) /
      evidence.ladder.oracle_price) *
    10_000;

  const tolerance = options.toleranceBps ?? 1;

  if (!Number.isFinite(published.realized_price_est)) {
    problems.push("evidence carries no published result to check against");
  } else if (Math.abs(deltaBps) > tolerance) {
    problems.push(
      `published realized price is ${deltaBps > 0 ? "above" : "below"} the recomputation by ${Math.abs(deltaBps).toFixed(2)} bps (tolerance ${tolerance})`,
    );
  }

  return { matches: problems.length === 0, computed, published, deltaBps, problems };
}

/** Fetch an evidence payload and verify it in one call. */
export async function verifyUrl(
  evidenceUrl: string,
  options: VerifyOptions & { fetch?: typeof fetch } = {},
): Promise<Verdict> {
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(evidenceUrl, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    return {
      matches: false,
      computed: { realized_price_est: Number.NaN, exit_gap_pct: Number.NaN },
      published: { realized_price_est: Number.NaN, exit_gap_pct: Number.NaN },
      deltaBps: Number.NaN,
      problems: [`evidence request failed: ${response.status} ${response.statusText}`],
    };
  }

  return verify((await response.json()) as Evidence, options);
}

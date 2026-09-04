/**
 * The published field contract.
 *
 * These names are the ones the API returns and the docs describe. They live
 * here so the SDK, the CLI, the MCP server and anything else built on Crifine
 * share one definition instead of four that drift.
 */

export type Chain = string;
export type PoolKind = "crypto" | "rwa";

/** One rung of a depth ladder: liquidity resting inside a band, not cumulative. */
export type LadderLevel = {
  /** Distance from the oracle price, in basis points. */
  bps: number;
  /** Liquidity resting inside this band, in USD. */
  usd: number;
  /** Price at the far edge of the band. */
  price?: number;
};

export type Ladder = {
  pool: string;
  as_of: string;
  oracle_price: number;
  levels: LadderLevel[];
  method_version?: string;
};

/**
 * The result of a pre-trade check.
 *
 * `exit_gap_pct` is the number to act on; `evidence_url` is the reason to
 * believe it. Everything else is context for those two.
 */
export type ExitEstimate = {
  pool: string;
  chain?: Chain;
  as_of: string;
  oracle_price: number;
  exit_size_usd: number;
  realized_price_est: number;
  exit_gap_pct: number;
  slippage_bps: number;
  /** True when the requested size is larger than the whole observed book. */
  exceeds_book: boolean;
  /** How much of the size observed depth can actually absorb. */
  filled_usd: number;
  lowest_depth_7d_usd?: number;
  /** Length of the continuous record backing this estimate. */
  days_observed: number;
  /** Underlying market session. Only meaningful for RWA. */
  market_open: boolean;
  method_version: string;
  evidence_url: string;
};

export type Pool = {
  pool: string;
  label: string;
  venue: string;
  asset: string;
  chain: Chain;
  kind: PoolKind;
  recording_since: string;
  days_observed: number;
  snapshot_cadence_minutes?: number;
};

export type DepthPoint = {
  date: string;
  depth_usd: number;
  oracle_price: number;
  gap_pct: number;
};

export type DepthHistory = {
  pool: string;
  window: { from: string; to: string };
  size_usd: number;
  resolution: string;
  depth_change_pct: number;
  oracle_change_pct: number;
  lowest_depth_usd: number;
  method_version: string;
  series: DepthPoint[];
};

export type FragilityRow = {
  pool: string;
  size_usd: number;
  exit_gap_pct: number;
  depth_usd: number;
  depth_change_7d_pct: number;
  market_open: boolean;
};

/**
 * What `evidence_url` returns: everything needed to recompute the result
 * without trusting the party that published it.
 */
export type Evidence = {
  pool: string;
  as_of: string;
  method_version: string;
  assumed_size_usd: number;
  observation_window: { from: string; to: string; days: number };
  depth_source: {
    venue: string;
    chain: Chain;
    cadence_minutes: number;
    snapshots_in_window: number;
  };
  /** The ladder the published result was walked against. */
  ladder: Ladder;
  /** What was published, to be checked against a local recomputation. */
  result: {
    realized_price_est: number;
    exit_gap_pct: number;
    market_open?: boolean;
  };
};

/**
 * Synthetic fixtures.
 *
 * Deliberately named so nobody can mistake them for recorded data. The real
 * depth series is the product's one unbackfillable asset and is never published
 * — the method is open, the record is not.
 */

import type { Evidence, LadderLevel } from "../src/types.js";

export const syntheticLevels: LadderLevel[] = [
  { bps: 5, usd: 612_000, price: 4817.59 },
  { bps: 10, usd: 548_000, price: 4815.18 },
  { bps: 25, usd: 471_000, price: 4807.95 },
  { bps: 50, usd: 402_000, price: 4795.9 },
  { bps: 100, usd: 318_000, price: 4771.8 },
  { bps: 200, usd: 268_000, price: 4723.6 },
  { bps: 400, usd: 279_000, price: 4627.2 },
  { bps: 800, usd: 222_000, price: 4434.4 },
];

export const ORACLE = 4820;

/** Total book across `syntheticLevels`: 3,120,000. */
export const BOOK_TOTAL = 3_120_000;

export function syntheticEvidence(overrides: Partial<Evidence> = {}): Evidence {
  const size = 1_000_000;
  // Computed once, here, so the fixture stays consistent with the method.
  const base: Evidence = {
    pool: "aave-v3-weth",
    as_of: "2026-08-29",
    method_version: "v1",
    assumed_size_usd: size,
    observation_window: { from: "2026-08-22", to: "2026-08-29", days: 7 },
    depth_source: {
      venue: "aave-v3",
      chain: "ethereum",
      cadence_minutes: 5,
      snapshots_in_window: 2016,
    },
    ladder: {
      pool: "aave-v3-weth",
      as_of: "2026-08-29",
      oracle_price: ORACLE,
      levels: syntheticLevels,
      method_version: "v1",
    },
    result: { realized_price_est: 0, exit_gap_pct: 0, market_open: true },
  };

  return { ...base, ...overrides };
}

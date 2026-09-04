/**
 * Formatting shared by anything that displays these numbers.
 *
 * Exported so the CLI, the app and third parties render the same quantity the
 * same way. A gap shown as `-5.58%` in one place and `5.6%` in another is two
 * numbers to a reader, not one.
 */

/** Compact for glancing: $5.0M, $850k, $12,400. */
export function formatSize(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `$${Math.round(value / 1000)}k`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

export function formatPrice(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 10 ? 4 : 2,
  })}`;
}

/** Always signed. An unsigned execution gap has lost the part that matters. */
export function formatPct(value: number, digits = 2): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

/**
 * Sub-basis-point differences read as a tie when rounded to zero, so they are
 * shown as such instead.
 */
export function formatBps(value: number): string {
  if (value > 0 && value < 1) return "<1 bps";
  return `${Math.round(value)} bps`;
}

/**
 * Pay-as-you-go spend past the subscription allowance.
 *
 * Upstream's limits pipeline reports windows and reset credits but not the
 * `extra_usage` balance Claude returns for credit-based accounts, so an account
 * spending on credits shows no balance anywhere. Formatting lives here until
 * upstream reports it too.
 *
 * @module extraUsage
 */
import type { ServerProviderExtraUsage } from "@t3tools/contracts";

/**
 * Amounts arrive as minor units scaled by `decimalPlaces`; a missing currency
 * means the provider counts credits rather than money.
 */
export function formatCreditAmount(
  value: number | null,
  currency: string | null,
  decimalPlaces: number,
): string {
  if (value === null) return "—";
  const places = Math.max(0, Math.min(20, Math.trunc(decimalPlaces)));
  const amount = value / 10 ** places;
  if (!currency) return `${amount.toFixed(places)} credits`;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    }).format(amount);
  } catch {
    return `${amount.toFixed(places)} ${currency}`;
  }
}

/** `$12.34 of $50.00`: what the account has spent against its cap. */
export function extraUsageSummary(usage: ServerProviderExtraUsage): string {
  const amount = (value: number | null) =>
    formatCreditAmount(value, usage.currency, usage.decimalPlaces);
  return `${amount(usage.usedCredits)} of ${amount(usage.monthlyLimit)}`;
}

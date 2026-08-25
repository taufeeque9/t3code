export function formatCreditAmount(
  value: number | null,
  currency: string | null,
  decimalPlaces: number,
  locale?: string,
): string {
  if (value === null) return "—";
  const places = Math.max(0, Math.min(20, Math.trunc(decimalPlaces)));
  const amount = value / 10 ** places;
  if (!currency) return `${amount.toFixed(places)} credits`;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    }).format(amount);
  } catch {
    return `${amount.toFixed(places)} ${currency}`;
  }
}

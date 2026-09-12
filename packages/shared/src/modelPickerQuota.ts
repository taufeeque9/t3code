import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";

type QuotaProvider = Pick<ServerProvider, "driver" | "usageLimits">;

export interface PickerQuota {
  readonly label: string;
  /** A passed reset or failed probe needs a new reading before showing a balance. */
  readonly remainingPercent: number | null;
}

function quotaForWindow(
  provider: QuotaProvider,
  window: ServerProviderUsageWindow | undefined,
  now: number,
): PickerQuota | null {
  if (!window || provider.usageLimits?.unavailable?.reason === "unsupported") return null;
  const unknown =
    provider.usageLimits?.unavailable !== undefined ||
    (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now);
  return {
    label: window.label,
    remainingPercent: unknown ? null : Math.max(0, Math.min(100, 100 - window.usedPercent)),
  };
}

/** Model rows show the weekly bucket; account-wide session quota is shown separately. */
export function resolveModelPickerQuota(
  provider: QuotaProvider,
  model: string,
  now: number,
): PickerQuota | null {
  const windows = provider.usageLimits?.windows ?? [];
  if (provider.driver === "claudeAgent") {
    const isFable = /(?:^|[^a-z0-9])fable(?:$|[^a-z0-9])/i.test(model);
    return quotaForWindow(
      provider,
      windows.find((window) => window.id === (isFable ? "seven_day_fable" : "seven_day")),
      now,
    );
  }
  if (provider.driver === "codex") {
    return quotaForWindow(
      provider,
      windows.find((window) => window.kind === "weekly"),
      now,
    );
  }
  return null;
}

/** Only Claude accounts show session quota in the account selector. */
export function resolveAccountPickerQuota(
  provider: QuotaProvider,
  now: number,
): PickerQuota | null {
  if (provider.driver !== "claudeAgent") return null;
  return quotaForWindow(
    provider,
    provider.usageLimits?.windows.find((window) => window.id === "five_hour"),
    now,
  );
}

export function formatPickerQuota(quota: PickerQuota): string {
  const remaining = quota.remainingPercent;
  if (remaining === null) return "—";
  if (remaining > 0 && remaining < 1) return "<1% left";
  return `${Math.floor(remaining)}% left`;
}

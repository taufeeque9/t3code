/** Model-aware warnings for the account selected in the composer. */
import type { ServerProviderUsageWindow, UsageLimitsReport } from "@t3tools/contracts";

export const LIMIT_WARNING_PERCENT = 95;

type LimitAccount = UsageLimitsReport["accounts"][number];

export interface LimitWarning {
  readonly accountLabel: string;
  readonly windowLabel: string;
  readonly usedPercent: number;
  readonly availability: string;
  /** Dismissals expire on reset or escalation from nearly spent to exhausted. */
  readonly key: string;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Claude's parser identifies model buckets as seven_day_<display_name>. */
function modelScope(window: ServerProviderUsageWindow, driver: LimitAccount["driver"]) {
  return driver === "claudeAgent" && window.id.startsWith("seven_day_")
    ? window.id.slice("seven_day_".length)
    : null;
}

function appliesToModel(window: ServerProviderUsageWindow, account: LimitAccount, model: string) {
  const scope = modelScope(window, account.driver);
  return scope === null || `_${normalize(model)}_`.includes(`_${scope}_`);
}

function hasReset(window: ServerProviderUsageWindow, now: number) {
  return window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now;
}

function accountLabel(account: LimitAccount) {
  return account.displayName?.trim() || account.label;
}

function accountKey(account: LimitAccount) {
  return account.email?.trim().toLowerCase() || account.id;
}

/** Shared windows still apply when a model has its own additional allowance. */
export function resolveLimitWarning(
  report: UsageLimitsReport | null,
  instanceId: string | null,
  model: string,
  hasUnreportedAccounts = false,
): LimitWarning | null {
  if (!report || instanceId === null) return null;
  const account = report.accounts.find((candidate) => candidate.instanceId === instanceId);
  if (!account || account.limits.unavailable) return null;
  const now = Date.parse(report.createdAt);
  const relevantWindows = account.limits.windows.filter((window) =>
    appliesToModel(window, account, model),
  );
  const warningWindow = relevantWindows
    .filter((window) => window.usedPercent >= LIMIT_WARNING_PERCENT && !hasReset(window, now))
    .toSorted((a, b) => b.usedPercent - a.usedPercent)[0];
  if (!warningWindow) return null;

  const scopedWindow = report.accounts
    .filter((candidate) => candidate.driver === account.driver)
    .flatMap((candidate) => candidate.limits.windows)
    .find((window) => modelScope(window, account.driver) && appliesToModel(window, account, model));
  const scopeLabel = scopedWindow?.label.split("·").at(-1)?.trim();
  const allowance = scopeLabel || "quota";
  const requiredIds = new Set(relevantWindows.map((window) => window.id));
  if (scopedWindow) requiredIds.add(scopedWindow.id);
  let unknown = hasUnreportedAccounts || report.notices.length > 0;
  const selectedExhausted = relevantWindows.some(
    (window) => window.usedPercent >= 100 && !hasReset(window, now),
  );
  const alternatives: Array<{ label: string; remaining: number }> = [];
  const seen = new Set([accountKey(account)]);
  const nativeLabels = new Map(
    report.accounts
      .filter((candidate) => candidate.instanceId)
      .map((candidate) => [accountKey(candidate), accountLabel(candidate)]),
  );
  // Duplicate native/hub readings share quota. Prefer usable reads, then freshness.
  const candidates = report.accounts.toSorted((a, b) => {
    const aUsable = !a.limits.unavailable && a.limits.windows.length > 0;
    const bUsable = !b.limits.unavailable && b.limits.windows.length > 0;
    return (
      Number(bUsable) - Number(aUsable) ||
      Date.parse(b.limits.checkedAt) - Date.parse(a.limits.checkedAt)
    );
  });
  for (const candidate of candidates) {
    const key = accountKey(candidate);
    if (candidate.driver !== account.driver || seen.has(key)) continue;
    seen.add(key);
    const windows = candidate.limits.windows.filter((window) =>
      appliesToModel(window, candidate, model),
    );
    if (candidate.limits.unavailable || windows.length === 0) {
      unknown = true;
      continue;
    }
    if (windows.some((window) => window.usedPercent >= 100 && !hasReset(window, now))) continue;
    // A passed reset needs a fresh probe; it is not evidence of a full allowance.
    if (
      windows.some((window) => hasReset(window, now)) ||
      [...requiredIds].some((id) => !windows.some((window) => window.id === id))
    ) {
      unknown = true;
      continue;
    }
    alternatives.push({
      label: nativeLabels.get(key) ?? accountLabel(candidate),
      remaining:
        Math.floor((100 - Math.max(...windows.map((window) => window.usedPercent))) * 10) / 10,
    });
  }
  alternatives.sort((a, b) => b.remaining - a.remaining || a.label.localeCompare(b.label));
  let availability: string;
  if (alternatives.length > 0) {
    const names = alternatives
      .slice(0, 3)
      .map(
        (candidate) =>
          `${candidate.label} (${candidate.remaining < 1 ? "<1" : candidate.remaining}% left)`,
      )
      .join(", ");
    const more = alternatives.length > 3 ? ` +${alternatives.length - 3} more` : "";
    availability = `${scopeLabel ? `${scopeLabel} available` : "Quota available"}: ${names}${more}`;
  } else if (unknown) {
    availability = `${scopeLabel ? `${scopeLabel} availability` : "Availability"} on other accounts is unknown`;
  } else if (selectedExhausted) {
    availability = `No ${allowance} left on any account`;
  } else {
    availability = `No ${allowance} left on other accounts`;
  }
  return {
    accountLabel: accountLabel(account),
    windowLabel: warningWindow.label,
    usedPercent: warningWindow.usedPercent,
    availability,
    key: `${account.id}:${warningWindow.id}:${warningWindow.resetsAt ?? ""}:${warningWindow.usedPercent >= 100 ? "exhausted" : "near"}`,
  };
}

const dismissedKeys = new Set<string>();

export function dismissLimitWarning(key: string): void {
  dismissedKeys.add(key);
}

export function isLimitWarningDismissed(key: string | null): boolean {
  return key !== null && dismissedKeys.has(key);
}

/**
 * Deciding when a thread should be warned that its account is nearly spent.
 *
 * The warning is about the account this thread actually sends through: a pool
 * with room elsewhere does not help a turn that is about to be refused, and
 * switching account is the action the warning exists to prompt.
 *
 * @module limitWarning
 */
import type { UsageLimitsReport } from "@t3tools/contracts";

/** Warn only once a window is close enough that the next turn may not fit. */
export const LIMIT_WARNING_PERCENT = 95;

export interface LimitWarning {
  /** The account label to name in the warning. */
  readonly accountLabel: string;
  /** The window that crossed, e.g. "Session" or "Weekly". */
  readonly windowLabel: string;
  readonly usedPercent: number;
  /** Identifies this warning so a dismissal survives re-renders but not a reset. */
  readonly key: string;
}

/**
 * The most-spent window at or past the threshold for the thread's own account,
 * or null when it still has room. Ties go to the window with less left, so the
 * warning names the one that will bite first.
 */
export function resolveLimitWarning(
  report: UsageLimitsReport | null,
  instanceId: string | null,
): LimitWarning | null {
  if (!report || instanceId === null) return null;
  const account = report.accounts.find((candidate) => candidate.instanceId === instanceId);
  if (!account) return null;
  let worst: LimitWarning | null = null;
  for (const window of account.limits.windows) {
    if (window.usedPercent < LIMIT_WARNING_PERCENT) continue;
    if (worst && worst.usedPercent >= window.usedPercent) continue;
    worst = {
      accountLabel: account.displayName ?? account.label,
      windowLabel: window.label,
      usedPercent: window.usedPercent,
      // The reset time is part of the key so a dismissal lapses when the
      // window rolls over and the warning is newly true again.
      key: `${account.id}:${window.id}:${window.resetsAt ?? ""}`,
    };
  }
  return worst;
}

/**
 * Warnings dismissed in this session, keyed so the same window stays quiet but
 * a reset — which changes the key — is allowed to warn again.
 */
const dismissedKeys = new Set<string>();

export function dismissLimitWarning(key: string): void {
  dismissedKeys.add(key);
}

export function isLimitWarningDismissed(key: string | null): boolean {
  return key !== null && dismissedKeys.has(key);
}

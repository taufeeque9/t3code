import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

/** A window at or above this share is treated as nearly spent. */
export const LIMIT_WARNING_PERCENT = 95;

const HOUR_MS = 60 * 60 * 1000;

function normalizeModel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Claude's parser identifies model buckets as seven_day_<display_name>. */
export function usageWindowModelScope(
  window: ServerProviderUsageWindow,
  driver: ProviderDriverKind,
): string | null {
  return driver === "claudeAgent" && window.id.startsWith("seven_day_")
    ? window.id.slice("seven_day_".length)
    : null;
}

/** Antigravity buckets are per family: Gemini has its own, Claude and GPT share `3p`. */
export function usageWindowAppliesToModel(
  window: ServerProviderUsageWindow,
  driver: ProviderDriverKind,
  model: string,
): boolean {
  const normalized = `_${normalizeModel(model)}_`;
  if (driver === "antigravity") {
    const family = window.id.split("-")[0];
    if (family === "gemini") return normalized.includes("_gemini_");
    if (family === "3p") return !normalized.includes("_gemini_");
    if (family === "claude" || family === "gpt") return normalized.includes(`_${family}_`);
  }
  const scope = usageWindowModelScope(window, driver);
  return scope === null || normalized.includes(`_${scope}_`);
}

type AccountCandidate = Pick<ServerProvider, "instanceId" | "driver" | "usageLimits">;

interface RankedAccount {
  readonly instanceId: ProviderInstanceId;
  readonly weeklyResetMs: number | null;
  readonly weeklyRemainingPercent: number;
  readonly openSessionResetMs: number | null;
}

function futureResetMs(window: ServerProviderUsageWindow, now: number): number | null {
  const resetMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  return Number.isFinite(resetMs) && resetMs > now ? resetMs : null;
}

function rankAccount(
  candidate: AccountCandidate,
  model: string,
  now: number,
): RankedAccount | null {
  const limits = candidate.usageLimits;
  if (!limits || limits.unavailable) return null;
  const windows = limits.windows
    .filter(
      (window) =>
        (window.kind === "session" || window.kind === "weekly") &&
        usageWindowAppliesToModel(window, candidate.driver, model),
    )
    .map((window) => {
      const resetMs = futureResetMs(window, now);
      const passed = window.resetsAt !== undefined && resetMs === null;
      return { kind: window.kind, resetMs, usedPercent: passed ? 0 : window.usedPercent };
    });
  if (windows.length === 0) return null;
  if (windows.some((window) => window.usedPercent >= LIMIT_WARNING_PERCENT)) return null;

  const binding = windows
    .filter((window) => window.kind === "weekly")
    .sort(
      (a, b) =>
        (a.resetMs ?? Number.POSITIVE_INFINITY) - (b.resetMs ?? Number.POSITIVE_INFINITY) ||
        b.usedPercent - a.usedPercent,
    )[0];
  const openSessionResets = windows.flatMap((window) =>
    window.kind === "session" && window.resetMs !== null && window.usedPercent > 0
      ? [window.resetMs]
      : [],
  );
  const openSessionResetMs = openSessionResets.length > 0 ? Math.min(...openSessionResets) : null;
  return {
    instanceId: candidate.instanceId,
    weeklyResetMs: binding?.resetMs ?? null,
    weeklyRemainingPercent: binding ? 100 - binding.usedPercent : 0,
    openSessionResetMs,
  };
}

/**
 * Heuristic account choice for a new thread: skip nearly spent accounts, spend the weekly
 * allowance that resets soonest (resets within an hour tie), then prefer an account whose
 * session window is already running and resets sooner, then the most weekly quota left.
 * Returns null when no candidate has a usable reading.
 */
export function pickProviderAccountByLimits(
  candidates: ReadonlyArray<AccountCandidate>,
  model: string,
  now: number,
): ProviderInstanceId | null {
  const ranked = candidates.flatMap((candidate) => {
    const account = rankAccount(candidate, model, now);
    return account ? [account] : [];
  });
  const knownResets = ranked.flatMap((account) =>
    account.weeklyResetMs === null ? [] : [account.weeklyResetMs],
  );
  const soonestReset = knownResets.length > 0 ? Math.min(...knownResets) : null;
  const soonest =
    soonestReset === null
      ? ranked
      : ranked.filter(
          (account) =>
            account.weeklyResetMs !== null && account.weeklyResetMs - soonestReset <= HOUR_MS,
        );
  return (
    [...soonest].sort(
      (a, b) =>
        (a.openSessionResetMs ?? Number.POSITIVE_INFINITY) -
          (b.openSessionResetMs ?? Number.POSITIVE_INFINITY) ||
        b.weeklyRemainingPercent - a.weeklyRemainingPercent,
    )[0]?.instanceId ?? null
  );
}

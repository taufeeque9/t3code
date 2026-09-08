/**
 * Claude accounts the Limits view can offer a sign-in for.
 *
 * Upstream reports a broken account as a notice string, which is enough to
 * explain a missing bar but not to repair it. Claude is the one driver whose
 * CLI T3 Code can drive through a sign-in, so those accounts are collected
 * separately with the identity a sign-in needs.
 *
 * @module claudeSignIn
 */
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { isProviderAvailable } from "@t3tools/contracts";
import { limitsNotice } from "@t3tools/shared/usageLimits";

export interface ClaudeSignInCandidate {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  /** Why the account needs attention, in the same words the notices list uses. */
  readonly notice: string;
  /** Whether upstream's notices already print this one, so it is not said twice. */
  readonly listedInNotices: boolean;
}

/** Everything upstream's notices need, so both read the same presentations. */
type Presentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: { readonly target: { readonly label: string } };
    readonly serverConfig: {
      readonly providers?: readonly ServerProvider[] | undefined;
    } | null;
  }
>;

/**
 * A probe that fails outright leaves `usageLimits` unset, which is exactly how
 * an unusable credential looks and is why an absent report counts here even
 * though upstream's notices skip it. An account that can never report windows
 * is working as configured and is left alone.
 */
export function collectClaudeSignIns(
  presentations: Presentations,
): readonly ClaudeSignInCandidate[] {
  const candidates: ClaudeSignInCandidate[] = [];
  for (const [environmentId, presentation] of presentations) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      if (provider.driver !== "claudeAgent") continue;
      if (!provider.enabled || !provider.installed || !isProviderAvailable(provider)) continue;
      if (provider.usageLimits?.unavailable?.reason === "unsupported") continue;
      const notice = provider.usageLimits
        ? limitsNotice(provider.usageLimits)
        : "Could not read this account's limits.";
      if (notice === null) continue;
      candidates.push({
        key: `${environmentId}:${provider.instanceId}`,
        environmentId,
        instanceId: provider.instanceId,
        displayName: provider.displayName?.trim() || String(provider.driver),
        notice,
        listedInNotices: provider.usageLimits !== undefined,
      });
    }
  }
  return candidates;
}

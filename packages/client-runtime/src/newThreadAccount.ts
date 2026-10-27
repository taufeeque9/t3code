import {
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { pickProviderAccountByLimits } from "@t3tools/shared/providerAccountPick";

/**
 * Moves a new thread's default selection to the same-driver account with the best usable
 * limits, keeping its model and options. Returns null when the selection should stay as is.
 */
export function resolveNewThreadAccountSelection(input: {
  readonly settings: Pick<
    ServerSettings,
    "autoPickProviderAccount" | "providerInstances" | "projectSettingsOverrides"
  >;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId: ProjectId | null;
  readonly selection: ModelSelection | null;
  readonly now: number;
}): ModelSelection | null {
  const { selection } = input;
  if (!input.settings.autoPickProviderAccount || !selection) return null;
  const driver = input.providers.find(
    (provider) => provider.instanceId === selection.instanceId,
  )?.driver;
  if (driver === undefined) return null;
  const candidates = input.providers.filter(
    (provider) =>
      provider.driver === driver &&
      resolveProjectProviderInstanceEnabled(input.settings, input.projectId, provider.instanceId) &&
      isProviderAvailable(provider) &&
      provider.installed &&
      provider.auth.status !== "unauthenticated" &&
      (provider.instanceId === selection.instanceId ||
        provider.models.some((model) => model.slug === selection.model)),
  );
  const instanceId = pickProviderAccountByLimits(candidates, selection.model, input.now);
  return instanceId === null || instanceId === selection.instanceId
    ? null
    : { ...selection, instanceId };
}

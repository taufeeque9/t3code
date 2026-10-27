import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { collectProviderUsageLimits } from "@t3tools/shared/usageLimits";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import {
  type ComposerThreadTarget,
  deriveEffectiveComposerModelState,
  useComposerDraftModelState,
} from "../../composerDraftStore";
import { NO_PROVIDER_MODEL_SELECTION } from "../../providerInstances";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { dismissLimitWarning, isLimitWarningDismissed, resolveLimitWarning } from "./limitWarning";

/**
 * A composer banner when the composer's account is nearly spent. Unlike the
 * on-demand usage panel it is not gated on the user asking: a thread about to
 * be refused should say so before the turn is spent. It reads the live provider
 * statuses, so it costs no extra request.
 */
export function useLimitWarningBanner(input: {
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selectedProvider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId | null;
  readonly threadModelSelection: ModelSelection | null | undefined;
  readonly projectModelSelection: ModelSelection | null | undefined;
  readonly settings: UnifiedSettings;
  readonly usageLimitSources: UsageLimitSourceSnapshots;
  readonly nowMinute: string;
}): ComposerBannerStackItem | null {
  const draftModelState = useComposerDraftModelState(input.composerDraftTarget);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const { selectedModel } = deriveEffectiveComposerModelState({
    draft: draftModelState,
    providers: input.providers,
    selectedProvider: input.selectedProvider,
    selectedInstanceId: input.instanceId ?? NO_PROVIDER_MODEL_SELECTION.instanceId,
    threadModelSelection: input.threadModelSelection,
    projectModelSelection: input.projectModelSelection,
    settings: input.settings,
  });
  const warning = resolveLimitWarning(
    input.instanceId === null
      ? null
      : collectProviderUsageLimits(
          input.instanceId,
          input.providers,
          input.usageLimitSources,
          Date.parse(`${input.nowMinute}:00.000Z`),
        ),
    input.instanceId,
    selectedModel,
    input.providers.some(
      (provider) =>
        provider.driver === input.selectedProvider &&
        provider.enabled &&
        provider.installed &&
        provider.usageLimits === undefined,
    ),
  );
  if (!warning || warning.key === dismissedKey || isLimitWarningDismissed(warning.key)) {
    return null;
  }
  return {
    id: `limit-warning:${warning.key}`,
    variant: "warning",
    icon: <TriangleAlertIcon />,
    title: `${warning.accountLabel}: ${warning.usedPercent}% of ${warning.windowLabel} used`,
    children: <p className="text-xs text-muted-foreground">{warning.availability}</p>,
    dismissLabel: "Dismiss limit warning",
    onDismiss: () => {
      dismissLimitWarning(warning.key);
      setDismissedKey(warning.key);
    },
  };
}

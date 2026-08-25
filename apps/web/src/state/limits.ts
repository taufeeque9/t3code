import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderLimitsAccount } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentProviderLimits {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly waiting: boolean;
  readonly detail: string | null;
  readonly accounts: readonly ProviderLimitsAccount[];
}

const providerLimitsAtom = Atom.make((get): readonly EnvironmentProviderLimits[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  return [...presentations].map(([environmentId, presentation]) => {
    const result = get(serverEnvironment.providerLimits({ environmentId, input: {} }));
    const snapshot = Option.getOrNull(AsyncResult.value(result));
    return {
      environmentId,
      environmentLabel: presentation.entry.target.label,
      waiting: result.waiting,
      detail:
        result._tag === "Failure"
          ? "Could not read limits from this environment."
          : (snapshot?.detail ?? null),
      accounts: snapshot?.accounts ?? [],
    };
  });
}).pipe(Atom.withLabel("web-limits:all-environments"));

export function useProviderLimits() {
  const environments = useAtomValue(providerLimitsAtom);
  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.providerLimits({ environmentId: environment.environmentId, input: {} }),
      );
    }
  }, [environments]);
  return { environments, refresh };
}

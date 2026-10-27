import { resolveNewThreadAccountSelection } from "@t3tools/client-runtime/new-thread-account";
import type { ScopedProjectRef } from "@t3tools/contracts";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { hasExplicitComposerModelSelection } from "./chatThreadActions";

/** Not explicit, so the composer's sticky selection keeps only the user's own picks. */
export function applyNewThreadAccountPick(draftId: DraftId, projectRef: ScopedProjectRef): void {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(projectRef.environmentId);
  const { getComposerDraft, setModelSelection } = useComposerDraftStore.getState();
  const draft = getComposerDraft(draftId);
  if (!config || !draft?.activeProvider || hasExplicitComposerModelSelection(draft)) return;
  const selection = resolveNewThreadAccountSelection({
    settings: config.settings,
    providers: config.providers,
    projectId: projectRef.projectId,
    selection: draft.modelSelectionByProvider[draft.activeProvider] ?? null,
    now: Date.now(),
  });
  if (selection) setModelSelection(draftId, selection, { replaceOptions: true });
}

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { waitForServerThread } from "../components/ChatView.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { serverEnvironment } from "../state/server";
import { buildThreadRouteParams } from "../threadRoutes";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useAtomCommand } from "../state/use-atom-command";

export function useForkThread() {
  const forkThreadMutation = useAtomCommand(serverEnvironment.forkThread, {
    reportFailure: false,
  });
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const router = useRouter();

  return useCallback(
    async (source: ScopedThreadRef, beforeMessageId?: MessageId) => {
      const result = await forkThreadMutation({
        environmentId: source.environmentId,
        input: {
          sourceThreadId: source.threadId,
          ...(beforeMessageId ? { beforeMessageId } : {}),
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not fork thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      const target = scopeThreadRef(source.environmentId, result.value.threadId);
      if (result.value.draftText !== null) {
        setPrompt(target, result.value.draftText);
      }
      // The thread route treats an unknown thread as missing and bounces to
      // the home screen, so wait for the read model to carry the fork first.
      if (!(await waitForServerThread(target))) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Thread forked, but it has not loaded yet",
            description: "Open it from the sidebar.",
          }),
        );
        return;
      }
      try {
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(target),
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Thread forked, but navigation failed",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [forkThreadMutation, router, setPrompt],
  );
}

import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, MessageId, type ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { createQueuedMessageDispatcher } from "../queuedMessageDispatch";
import { useQueuedMessageStore } from "../queuedMessageStore";
import { useThreadDetail, useThreadShell } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { environmentShell } from "../state/shell";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveThreadMetadataUpdateForNextTurn } from "./ChatView.logic";

const dispatch = createQueuedMessageDispatcher();

function QueuedThread({ threadKey, threadRef }: { threadKey: string; threadRef: ScopedThreadRef }) {
  const message = useQueuedMessageStore((state) => state.byThreadKey[threadKey]);
  const thread = useThreadShell(threadRef);
  const detail = useThreadDetail(message?.sentAt ? threadRef : null);
  const acknowledged = detail?.messages.some((entry) => entry.id === message?.id) ?? false;
  const environment = useEnvironment(threadRef.environmentId);
  const shell = useAtomValue(environmentShell.stateValueAtom(threadRef.environmentId));
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const setRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, { reportFailure: false });
  const setInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const live = environment?.connection.phase === "connected" && shell.status === "live";

  useEffect(() => {
    if (!message) return;
    void dispatch({
      threadKey,
      acknowledged,
      thread,
      live,
      send: async (queued) => {
        if (!thread) return;
        const settings = queued.settings ?? thread;
        const commandTarget = { environmentId: threadRef.environmentId };
        const modeInput = { threadId: threadRef.threadId, createdAt: queued.sentAt };
        const metadata = resolveThreadMetadataUpdateForNextTurn({
          currentModelSelection: thread.modelSelection,
          nextModelSelection: settings.modelSelection,
          currentBranch: thread.branch,
        });
        if (metadata) {
          const result = await updateMetadata({
            ...commandTarget,
            input: { threadId: threadRef.threadId, ...metadata },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        }
        if (settings.runtimeMode !== thread.runtimeMode) {
          const result = await setRuntimeMode({
            ...commandTarget,
            input: { ...modeInput, runtimeMode: settings.runtimeMode },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        }
        if (settings.interactionMode !== thread.interactionMode) {
          const result = await setInteractionMode({
            ...commandTarget,
            input: { ...modeInput, interactionMode: settings.interactionMode },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        }
        const result = await startTurn({
          environmentId: threadRef.environmentId,
          input: {
            commandId: CommandId.make(queued.id),
            threadId: threadRef.threadId,
            message: {
              messageId: MessageId.make(queued.id),
              role: "user",
              text: queued.settings?.text ?? queued.prompt,
              attachments: [],
            },
            modelSelection: settings.modelSelection,
            runtimeMode: settings.runtimeMode,
            interactionMode: settings.interactionMode,
            createdAt: queued.sentAt,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      },
    });
  }, [
    acknowledged,
    live,
    message,
    setInteractionMode,
    setRuntimeMode,
    startTurn,
    thread,
    threadKey,
    threadRef,
    updateMetadata,
  ]);
  return null;
}

export function QueuedMessageCoordinator() {
  const messages = useQueuedMessageStore((state) => state.byThreadKey);
  return Object.keys(messages).map((threadKey) => {
    const threadRef = parseScopedThreadKey(threadKey);
    return threadRef ? (
      <QueuedThread key={threadKey} threadKey={threadKey} threadRef={threadRef} />
    ) : null;
  });
}

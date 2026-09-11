import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { hasQueuedTurnStart } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { useQueuedMessageStore, type QueuedMessage } from "./queuedMessageStore";

export type QueuedMessageThread = Pick<
  EnvironmentThreadShell,
  | "session"
  | "latestTurn"
  | "latestUserMessageAt"
  | "archivedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
>;

const isDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

/** Only definite pre-commit rejections allow a new command identity on retry. */
function isRejectedCommand(error: unknown): boolean {
  if (!isDispatchCommandError(error)) return false;
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null) return false;
  let name: unknown;
  if ("_tag" in cause) name = cause._tag;
  else if ("name" in cause) name = cause.name;
  return (
    name === "OrchestrationCommandInvariantError" ||
    name === "OrchestrationCommandPreviouslyRejectedError"
  );
}

/** Dispatches from live shell updates, independent of the selected route or composer. */
export function createQueuedMessageDispatcher() {
  const pending = new Set<string>();

  return async function dispatch(input: {
    threadKey: string;
    thread: QueuedMessageThread | null;
    live: boolean;
    acknowledged?: boolean;
    send: (message: QueuedMessage & { sentAt: string }) => Promise<void>;
  }): Promise<void> {
    const { threadKey, thread, live, send } = input;
    const queue = useQueuedMessageStore.getState();
    const message = queue.byThreadKey[threadKey];
    if (!message || !thread || !live) return;

    // Require the exact message and the shell update before clearing pending work.
    if (
      input.acknowledged &&
      message.sentAt &&
      thread.latestUserMessageAt &&
      thread.latestUserMessageAt >= message.sentAt
    ) {
      pending.delete(message.id);
      queue.completeSend(threadKey, message.id);
      return;
    }
    if (
      pending.has(message.id) ||
      message.error ||
      thread.archivedAt ||
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      thread.session?.status === "starting" ||
      thread.session?.status === "running" ||
      thread.session?.status === "error" ||
      thread.latestTurn?.state === "running" ||
      hasQueuedTurnStart(thread, { now: new Date().toISOString() })
    )
      return;

    pending.add(message.id);
    const claimed = queue.beginSend(threadKey, new Date().toISOString());
    if (!claimed?.sentAt) {
      pending.delete(message.id);
      return;
    }
    try {
      await send({ ...claimed, sentAt: claimed.sentAt });
    } catch (error) {
      pending.delete(message.id);
      useQueuedMessageStore
        .getState()
        .failSend(
          threadKey,
          message.id,
          error instanceof Error ? error.message : "Failed to send queued message.",
          isRejectedCommand(error),
        );
    }
  };
}

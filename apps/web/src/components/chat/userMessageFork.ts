import type { MessageId, OrchestrationV2Run, RunId, ThreadId } from "@t3tools/contracts";

export interface UserMessageForkSource {
  readonly sourceThreadId: ThreadId;
  readonly runId: RunId;
}

export type UserMessageForkSources = ReadonlyMap<MessageId, UserMessageForkSource>;

/** Run statuses the server accepts as a fork point. */
const FORKABLE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "waiting",
  "failed",
  "interrupted",
  "cancelled",
]);

/**
 * Forking from a user message forks after the run before it, so the new thread
 * can resend that message (or an edit of it). Keyed by the message that started
 * each run; a thread's first message and runs after a busy one have no entry.
 */
export function resolveUserMessageForkSources(
  runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "threadId" | "ordinal" | "userMessageId" | "status">
  >,
): UserMessageForkSources {
  const ordered = runs
    .filter((run) => run.status !== "rolled_back")
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const sources = new Map<MessageId, UserMessageForkSource>();
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    if (!FORKABLE_RUN_STATUSES.has(previous.status)) continue;
    sources.set(ordered[index]!.userMessageId, {
      sourceThreadId: previous.threadId,
      runId: previous.id,
    });
  }
  return sources;
}

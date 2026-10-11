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
 * A completed `/compact` run leaves no assistant reply to fork at, so the
 * message after it forks where the `/compact` message does.
 */
export function resolveUserMessageForkSources(
  runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "threadId" | "ordinal" | "userMessageId" | "status">
  >,
  compactCommandMessageIds: ReadonlySet<string> = new Set(),
): UserMessageForkSources {
  const ordered = runs
    .filter((run) => run.status !== "rolled_back")
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const sources = new Map<MessageId, UserMessageForkSource>();
  let previous: (typeof ordered)[number] | undefined;
  for (const run of ordered) {
    if (previous !== undefined && FORKABLE_RUN_STATUSES.has(previous.status)) {
      sources.set(run.userMessageId, { sourceThreadId: previous.threadId, runId: previous.id });
    }
    if (run.status !== "completed" || !compactCommandMessageIds.has(run.userMessageId)) {
      previous = run;
    }
  }
  return sources;
}

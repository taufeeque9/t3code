import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadForkError,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { resolveThreadForkPlan } from "./threadFork.ts";

const isThreadForkError = Schema.is(ThreadForkError);

const user = (id: string, text: string) => ({
  id: MessageId.make(id),
  role: "user" as const,
  text,
  turnId: null,
  streaming: false,
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
});
const assistant = (id: string, text: string, turnId: string) => ({
  ...user(id, text),
  role: "assistant" as const,
  turnId: TurnId.make(turnId),
});

function thread(running: boolean): OrchestrationThread {
  return {
    id: ThreadId.make("source"),
    projectId: ProjectId.make("project"),
    title: "Source",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: running
      ? {
          turnId: TurnId.make("turn-2"),
          state: "running",
          requestedAt: "2026-08-26T00:02:00.000Z",
          startedAt: "2026-08-26T00:02:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        }
      : null,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [
      user("user-1", "first"),
      assistant("assistant-1", "answer", "turn-1"),
      {
        ...user("user-2", "pending"),
        createdAt: "2026-08-26T00:02:00.000Z",
        updatedAt: "2026-08-26T00:02:00.000Z",
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: running
      ? {
          threadId: ThreadId.make("source"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-2"),
          lastError: null,
          updatedAt: "2026-08-26T00:01:00.000Z",
        }
      : null,
  };
}

describe("resolveThreadForkPlan", () => {
  it("seeds an explicit user-message fork and excludes that message", () => {
    const result = resolveThreadForkPlan(thread(false), MessageId.make("user-2"));
    expect(isThreadForkError(result)).toBe(false);
    if (isThreadForkError(result)) return;
    expect(result.copiedMessages.map((message) => message.text)).toEqual(["first", "answer"]);
    expect(result.draftText).toBe("pending");
    expect(result.forkPoint).toEqual({
      type: "before-user-message",
      userMessageOrdinal: 2,
      userMessageText: "pending",
      precedingTurnId: TurnId.make("turn-1"),
    });
  });

  it("forks a running thread only through its last stable completed turn", () => {
    const result = resolveThreadForkPlan(thread(true));
    expect(isThreadForkError(result)).toBe(false);
    if (isThreadForkError(result)) return;
    expect(result.copiedMessages.map((message) => message.text)).toEqual(["first", "answer"]);
    expect(result.draftText).toBeNull();
    expect(result.cutoffMessageId).toBe(MessageId.make("user-2"));
  });

  it("does not mistake a queued follow-up for the active turn boundary", () => {
    const source = thread(true);
    const result = resolveThreadForkPlan({
      ...source,
      messages: [
        ...source.messages,
        {
          ...user("user-3", "queued follow-up"),
          createdAt: "2026-08-26T00:03:00.000Z",
          updatedAt: "2026-08-26T00:03:00.000Z",
        },
      ],
    });
    expect(isThreadForkError(result)).toBe(false);
    if (isThreadForkError(result)) return;
    expect(result.cutoffMessageId).toBe(MessageId.make("user-2"));
    expect(result.copiedMessages.map((message) => message.text)).toEqual(["first", "answer"]);
  });

  it("excludes an incomplete trailing user turn from a full idle fork", () => {
    const result = resolveThreadForkPlan(thread(false));
    expect(isThreadForkError(result)).toBe(false);
    if (isThreadForkError(result)) return;
    expect(result.copiedMessages).toHaveLength(2);
    expect(result.forkPoint).toEqual({
      type: "before-user-message",
      userMessageOrdinal: 2,
      userMessageText: "pending",
      precedingTurnId: TurnId.make("turn-1"),
    });
    expect(result.draftText).toBeNull();
  });

  it("copies the complete idle thread when its last turn is finished", () => {
    const source = thread(false);
    const result = resolveThreadForkPlan({
      ...source,
      messages: [...source.messages, assistant("assistant-2", "done", "turn-2")],
    });
    expect(isThreadForkError(result)).toBe(false);
    if (isThreadForkError(result)) return;
    expect(result.copiedMessages).toHaveLength(4);
    expect(result.forkPoint).toEqual({
      type: "full",
      precedingTurnId: TurnId.make("turn-2"),
    });
  });
});

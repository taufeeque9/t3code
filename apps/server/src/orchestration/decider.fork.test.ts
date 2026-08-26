import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-08-26T00:00:00.000Z";
const sourceThreadId = ThreadId.make("source-thread");
const targetThreadId = ThreadId.make("target-thread");
const selectedMessageId = MessageId.make("selected-user-message");

function sourceReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: sourceThreadId,
        projectId: ProjectId.make("project-1"),
        title: "Original",
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [
          {
            id: MessageId.make("user-1"),
            role: "user",
            text: "first",
            turnId: null,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
          {
            id: MessageId.make("assistant-1"),
            role: "assistant",
            text: "answer",
            turnId: null,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
          {
            id: selectedMessageId,
            role: "user",
            text: "edit me",
            turnId: null,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("thread fork decider", (it) => {
  it.effect("copies history exclusively before the selected user message", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.fork",
          commandId: CommandId.make("fork-command"),
          threadId: targetThreadId,
          sourceThreadId,
          beforeMessageId: selectedMessageId,
          createdAt: NOW,
        },
        readModel: sourceReadModel(),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.message-sent",
        "thread.activity-appended",
      ]);
      const copiedText = events.flatMap((event) =>
        event.type === "thread.message-sent" ? [event.payload.text] : [],
      );
      expect(copiedText).toEqual(["first", "answer"]);
      const created = events[0];
      expect(created?.type === "thread.created" ? created.payload.title : null).toBe(
        "Original (fork)",
      );
    }),
  );

  it.effect("adds fork context only to the first new turn", () =>
    Effect.gen(function* () {
      const forkResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.fork",
          commandId: CommandId.make("fork-command"),
          threadId: targetThreadId,
          sourceThreadId,
          beforeMessageId: selectedMessageId,
          createdAt: NOW,
        },
        readModel: sourceReadModel(),
      });
      let readModel = sourceReadModel();
      let sequence = 0;
      for (const event of Array.isArray(forkResult) ? forkResult : [forkResult]) {
        sequence += 1;
        readModel = yield* projectEvent(readModel, { ...event, sequence });
      }

      const firstResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("first-turn"),
          threadId: targetThreadId,
          message: {
            messageId: MessageId.make("new-user-1"),
            role: "user",
            text: "changed prompt",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "2026-08-26T00:01:00.000Z",
        },
        readModel,
      });
      const firstEvents = Array.isArray(firstResult) ? firstResult : [firstResult];
      const firstTurn = firstEvents.find((event) => event.type === "thread.turn-start-requested");
      expect(
        firstTurn?.type === "thread.turn-start-requested" ? firstTurn.payload.forkContext : null,
      ).toEqual({ sourceThreadId, beforeMessageId: selectedMessageId });

      for (const event of firstEvents) {
        sequence += 1;
        readModel = yield* projectEvent(readModel, { ...event, sequence });
      }
      const secondResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("second-turn"),
          threadId: targetThreadId,
          message: {
            messageId: MessageId.make("new-user-2"),
            role: "user",
            text: "second prompt",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "2026-08-26T00:02:00.000Z",
        },
        readModel,
      });
      const secondTurn = (Array.isArray(secondResult) ? secondResult : [secondResult]).find(
        (event) => event.type === "thread.turn-start-requested",
      );
      expect(
        secondTurn?.type === "thread.turn-start-requested"
          ? secondTurn.payload.forkContext
          : undefined,
      ).toBeUndefined();
    }),
  );
});

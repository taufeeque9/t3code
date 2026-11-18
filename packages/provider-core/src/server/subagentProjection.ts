import type {
  EventId,
  MessageId,
  ModelSelection,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2Actor,
  OrchestrationV2ConversationMessage,
  OrchestrationV2CreationSource,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderRef,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { isOrchestrationV2WorkActive, latestProviderTurnForAttempt } from "@t3tools/contracts";

function trimmed(value: string | null | undefined): string | undefined {
  const result = value?.trim();
  return result && result.length > 0 ? result : undefined;
}

export function subagentThreadTitle(input: {
  readonly parentTitle: string;
  readonly title?: string | null;
  readonly prompt: string;
  readonly ordinal: number;
}): string {
  const detail = trimmed(input.title) ?? trimmed(input.prompt);
  if (detail === undefined) {
    return `${input.parentTitle} subagent ${input.ordinal}`;
  }
  if (detail.length <= 72) return detail;
  let end = 69;
  const previous = detail.charCodeAt(end - 1);
  const next = detail.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end -= 1;
  }
  return `${detail.slice(0, end)}...`;
}

export function makeSubagentChildThread(input: {
  readonly parentThread: OrchestrationV2AppThread;
  readonly childThreadId: ThreadId;
  readonly parentNodeId: NodeId;
  readonly activeProviderThreadId: ProviderThreadId | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection;
  readonly title: string;
  readonly now: DateTime.Utc;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}): OrchestrationV2AppThread {
  // The remote parent delegated the parent thread, not its subagents.
  const { delegatedFrom: _delegatedFrom, ...inherited } = input.parentThread;
  return {
    ...inherited,
    createdBy: input.createdBy,
    creationSource: input.creationSource,
    id: input.childThreadId,
    title: input.title,
    titleRegeneration: null,
    linkedPullRequest: null,
    pullRequests: [],
    historyOrigin: undefined,
    providerInstanceId: input.providerInstanceId,
    modelSelection: input.modelSelection,
    activeProviderThreadId: input.activeProviderThreadId,
    lineage: {
      parentThreadId: input.parentThread.id,
      relationshipToParent: "subagent",
      rootThreadId: input.parentThread.lineage.rootThreadId,
    },
    forkedFrom: {
      type: "node",
      nodeId: input.parentNodeId,
    },
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    autoSettleDisabledAt: null,
    // A guest link belongs to the thread it was made for.
    guestShare: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

export function makeSubagentConversationArtifacts(input: {
  readonly messageId: MessageId;
  readonly senderThreadId?: ThreadId;
  readonly turnItemId: TurnItemId;
  readonly threadId: ThreadId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId | null;
  readonly providerTurnId: ProviderTurnId | null;
  readonly nativeItemRef: OrchestrationV2ProviderRef | null;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly workflowScript?: boolean;
  readonly ordinal: number;
  readonly now: DateTime.Utc;
}): {
  readonly message: OrchestrationV2ConversationMessage;
  readonly turnItem: OrchestrationV2TurnItem;
} {
  const message: OrchestrationV2ConversationMessage = {
    createdBy: "agent",
    creationSource: "provider",
    id: input.messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: input.rootNodeId,
    role: input.role,
    ...(input.role === "user" && input.senderThreadId !== undefined
      ? { senderThreadId: input.senderThreadId }
      : {}),
    ...(input.role === "user" && input.workflowScript !== undefined
      ? { workflowScript: input.workflowScript }
      : {}),
    text: input.text,
    attachments: [],
    streaming: false,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const base = {
    id: input.turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: input.rootNodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: input.nativeItemRef,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: input.now,
    completedAt: input.now,
    updatedAt: input.now,
    messageId: input.messageId,
    text: input.text,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.role === "user"
      ? {
          ...base,
          createdBy: "agent",
          creationSource: "provider",
          type: "user_message",
          ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
          ...(input.workflowScript === undefined ? {} : { workflowScript: input.workflowScript }),
          inputIntent: "turn_start",
          attachments: [],
        }
      : {
          ...base,
          type: "assistant_message",
          streaming: false,
        };
  return { message, turnItem };
}

/** A delegated result, led by a note when the provider reported running another model than requested. */
export function withExecutedModelNote(
  result: string,
  requestedModel: string,
  executedModel: string | null | undefined,
): string {
  return executedModel == null || executedModel === requestedModel
    ? result
    : `Requested model ${requestedModel}; the provider reported running ${executedModel}.\n\n${result}`;
}

export const STOP_HOOK_FEEDBACK_NOTICE = "Stop hook feedback";
export const SUBAGENT_RESULT_ITEM_TYPES = [
  "assistant_message",
  "error",
  "system_notice",
  "user_message",
] as const;
const STOP_HOOK_FOLLOW_UP_SEPARATOR = "\n\n## Stop hook follow-up\n\n";
const STOP_HOOK_FOLLOW_UP_BYTES = 4_096;
const OMITTED_HOOK_TEXT = "[More Stop hook follow-up in the child thread.]";

type AssistantTurnItem = Extract<OrchestrationV2TurnItem, { type: "assistant_message" }>;

export function utf8Prefix(text: string, bytes: number): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    Buffer.from(text.slice(0, bytes + 1)).subarray(0, bytes),
    { stream: true },
  );
}

export function stopHookQuestion(text: string): string | undefined {
  const question = text.trim().replace(/\s+/gu, " ");
  if (question.length === 0) return undefined;
  return Buffer.byteLength(question) <= 240 ? question : `${utf8Prefix(question, 237)}…`;
}

export function formatStopHookResult(
  report: string,
  followUp: string,
  status: OrchestrationV2Run["status"],
  failure?: string,
) {
  const text =
    status === "completed"
      ? report
      : `${failure ?? `Child task ended with status ${status}.`}\n\nPartial report before the Stop hook:\n\n${report}`;
  return {
    text: followUp ? `${text}${STOP_HOOK_FOLLOW_UP_SEPARATOR}${followUp}` : text,
    reportLength: text.length,
  };
}

function continuationOf(item: OrchestrationV2TurnItem) {
  if (item.type !== "system_notice") return undefined;
  if (item.continuation !== undefined) return item.continuation;
  // Untyped Stop hook notices can still have a pending result after an upgrade.
  return item.title === STOP_HOOK_FEEDBACK_NOTICE && item.message === STOP_HOOK_FEEDBACK_NOTICE
    ? { kind: "stop_hook" as const }
    : undefined;
}

type ResultRun = Pick<OrchestrationV2Run, "id" | "status"> &
  Partial<Pick<OrchestrationV2Run, "activeAttemptId">>;
type ResultProviderTurn = Pick<OrchestrationV2ProviderTurn, "id" | "ordinal" | "runAttemptId">;

function lastAssistantItem(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  run: ResultRun,
  providerTurns: ReadonlyArray<ResultProviderTurn>,
) {
  const candidates = items.filter(
    (item): item is AssistantTurnItem =>
      item.runId === run.id && item.type === "assistant_message" && item.text.trim().length > 0,
  );
  const turnIds = new Set(candidates.map((item) => item.providerTurnId));
  const latestTurn = latestProviderTurnForAttempt(
    providerTurns.filter((turn) => turnIds.has(turn.id)),
    run.activeAttemptId,
  );
  return candidates.reduce<AssistantTurnItem | undefined>((latest, item) => {
    if (latestTurn !== undefined && item.providerTurnId !== latestTurn.id) return latest;
    return latest === undefined || item.ordinal > latest.ordinal ? item : latest;
  }, undefined);
}

export function stopHookResultForRun(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  run: ResultRun,
  providerTurns: ReadonlyArray<ResultProviderTurn> = [],
) {
  if (
    run.status !== "completed" &&
    run.status !== "failed" &&
    run.status !== "interrupted" &&
    run.status !== "cancelled"
  )
    return undefined;
  if (!items.some((item) => item.runId === run.id && continuationOf(item)?.kind === "stop_hook"))
    return undefined;
  const lastAssistant = lastAssistantItem(items, run, providerTurns);
  if (lastAssistant === undefined) return undefined;
  const turnItems = items
    .filter((item) => item.runId === run.id && item.providerTurnId === lastAssistant.providerTurnId)
    .sort((a, b) => a.ordinal - b.ordinal);
  const occurredAt = (item: OrchestrationV2TurnItem) =>
    DateTime.toEpochMillis(item.startedAt ?? item.updatedAt);
  // Server steering ordinals and provider ordinals have independent counters.
  let lastSteerAt = -Infinity;
  for (const item of turnItems) {
    if (
      item.type === "user_message" &&
      item.status === "completed" &&
      (item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer")
    ) {
      lastSteerAt = Math.max(lastSteerAt, occurredAt(item));
    }
  }
  let report: AssistantTurnItem[] = [];
  let reply: AssistantTurnItem[] = [];
  let round:
    | {
        readonly itemId: TurnItemId;
        readonly question?: string | undefined;
        readonly lastToolOrdinal?: number | undefined;
      }
    | undefined;
  let sawHook = false;
  const answers: Array<{
    readonly itemId: TurnItemId;
    readonly question?: string | undefined;
    readonly reply: AssistantTurnItem[];
  }> = [];
  for (const item of turnItems) {
    if (occurredAt(item) < lastSteerAt) continue;
    const boundary = continuationOf(item);
    if (boundary !== undefined) {
      if (round !== undefined && reply.length > 0) answers.push({ ...round, reply });
      reply = [];
      round =
        boundary.kind === "stop_hook" && report.length > 0
          ? { itemId: item.id, ...boundary }
          : undefined;
      sawHook ||= round !== undefined;
    } else if (
      item.type === "assistant_message" &&
      item.phase !== "commentary" &&
      item.status === "completed" &&
      item.text.trim() &&
      (!sawHook || (round !== undefined && item.ordinal > (round.lastToolOrdinal ?? -1)))
    ) {
      const current = sawHook ? reply : report;
      if (
        item.nativeResponseId !== undefined &&
        current[0]?.nativeResponseId === item.nativeResponseId
      ) {
        const existing = current.findIndex((part) => part.id === item.id);
        if (existing < 0) current.push(item);
        else current[existing] = item;
      } else if (sawHook) {
        reply = [item];
      } else {
        report = [item];
      }
    }
  }
  if (round !== undefined && reply.length > 0) answers.push({ ...round, reply });
  if (!sawHook || report.length === 0) return undefined;

  let remaining =
    STOP_HOOK_FOLLOW_UP_BYTES -
    Buffer.byteLength(STOP_HOOK_FOLLOW_UP_SEPARATOR + OMITTED_HOOK_TEXT + "\n\n");
  const sections: string[] = [];
  const answerItemIds: TurnItemId[] = [];
  for (const { itemId, question, reply } of answers.toReversed()) {
    const sourceIds = question === undefined ? [] : [itemId];
    const answerIds = [...sourceIds, ...reply.map((item) => item.id)];
    const text = `${question === undefined ? "" : `Hook asked: ${question}\n`}${reply
      .map((item) => item.text)
      .join("\n\n")
      .trim()}`;
    const bytes = Buffer.byteLength(text);
    if (bytes > remaining) {
      if (sections.length === 0) {
        sections.push(utf8Prefix(text, remaining).trimEnd());
        answerItemIds.push(...answerIds);
      }
      sections.push(OMITTED_HOOK_TEXT);
      break;
    }
    sections.push(text);
    answerItemIds.push(...answerIds);
    remaining -= bytes + 2;
  }
  const failure =
    run.status === "failed"
      ? items.reduce<Extract<OrchestrationV2TurnItem, { type: "error" }> | undefined>(
          (last, item) =>
            item.runId === run.id &&
            item.type === "error" &&
            (last === undefined || DateTime.isGreaterThanOrEqualTo(item.updatedAt, last.updatedAt))
              ? item
              : last,
          undefined,
        )
      : undefined;
  return {
    report: report[0]!,
    reportItems: report,
    followUp: sections.join("\n\n"),
    answerItemIds,
    failure,
  };
}

export function subagentResultForRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems" | "providerTurns">,
  run: OrchestrationV2Run,
): {
  readonly text: string;
  readonly messageId: OrchestrationV2ConversationMessage["id"] | null;
  readonly turnItemId: OrchestrationV2TurnItem["id"] | null;
  readonly resultItemIds?: ReadonlyArray<TurnItemId>;
  readonly reportLength?: number;
} {
  const stopHook = stopHookResultForRun(projection.turnItems, run, projection.providerTurns);
  const executedModel = latestProviderTurnForAttempt(
    projection.providerTurns,
    run.activeAttemptId,
  )?.model;
  const withModel = (text: string) =>
    executedModel === undefined
      ? text
      : withExecutedModelNote(text, run.modelSelection.model, executedModel);
  if (stopHook !== undefined) {
    return {
      ...formatStopHookResult(
        withModel(stopHook.reportItems.map((item) => item.text).join("\n\n")),
        stopHook.followUp,
        run.status,
        stopHook.failure?.failure.message,
      ),
      messageId: stopHook.report.messageId,
      turnItemId: stopHook.report.id,
      resultItemIds: [
        ...stopHook.reportItems.map((item) => item.id),
        ...stopHook.answerItemIds,
        ...(stopHook.failure === undefined ? [] : [stopHook.failure.id]),
      ],
    };
  }
  const turnItem = lastAssistantItem(projection.turnItems, run, projection.providerTurns) ?? null;
  const messages = projection.messages.filter(
    (candidate) =>
      candidate.runId === run.id &&
      candidate.role === "assistant" &&
      candidate.text.trim().length > 0,
  );
  // Prefer turn item order; providers can finalize messages with identical timestamps.
  const message =
    messages.find((candidate) => candidate.id === turnItem?.messageId) ??
    messages.toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
        DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
    )[0] ??
    null;
  const failure =
    run.status === "failed"
      ? projection.turnItems
          .filter((item) => item.runId === run.id && item.type === "error")
          .toSorted((left, right) => right.ordinal - left.ordinal)[0]
      : undefined;
  const reportBeforeFailure =
    failure !== undefined && turnItem !== null && turnItem.ordinal < failure.ordinal
      ? (message?.text ?? turnItem.text)
      : undefined;
  const text =
    (failure?.type === "error"
      ? reportBeforeFailure === undefined
        ? failure.failure.message
        : `${failure.failure.message}\n\nLast assistant message before the run failed:\n\n${reportBeforeFailure}`
      : undefined) ??
    message?.text ??
    turnItem?.text ??
    (run.status === "completed"
      ? "Child task completed without an assistant result."
      : `Child task ended with status ${run.status}.`);
  return {
    text: withModel(text),
    messageId: failure === undefined ? (message?.id ?? turnItem?.messageId ?? null) : null,
    turnItemId: failure?.id ?? turnItem?.id ?? null,
  };
}

export function subagentHoldsCompletion(
  task: Pick<OrchestrationV2ThreadProjection["subagents"][number], "status" | "completionDelivery">,
): boolean {
  return (
    isOrchestrationV2WorkActive(task.status) ||
    // Publishing a child's result precedes scheduling its parent's wake.
    // The parent still owes that follow-up even between those transactions.
    (task.status !== "idle" &&
      (task.completionDelivery?.state === "pending" ||
        task.completionDelivery?.state === "claimed"))
  );
}

export function delegatedTaskProgress(projection: {
  readonly runs: OrchestrationV2ThreadProjection["runs"];
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "runId" | "notification">
  >;
  readonly subagents: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["subagents"][number], "status" | "completionDelivery">
  >;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["providerThreads"][number], "pendingBackgroundTasks">
  >;
}) {
  const terminal = (status: string) =>
    ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
  const monitorRuns = new Set(
    projection.messages
      .filter((message) => message.notification?.source.kind === "monitor")
      .map((message) => message.runId),
  );
  const workRuns = projection.runs.filter(
    (run) => !monitorRuns.has(run.id) && run.status !== "rolled_back",
  );
  const active = workRuns.some(
    (run) => !terminal(run.status) && !(run.status === "queued" && run.queueHeld === true),
  );
  const children =
    projection.subagents.some(subagentHoldsCompletion) ||
    projection.providerThreads.some((thread) =>
      backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []),
    );
  const resultRun = workRuns
    .filter((run) => terminal(run.status) && (run.startedAt !== null || run.ordinal === 1))
    .toSorted((a, b) => (runRanAfter(a, b) ? -1 : runRanAfter(b, a) ? 1 : 0))[0];
  return {
    state:
      active || resultRun === undefined
        ? ("working" as const)
        : children
          ? ("waiting_for_children" as const)
          : ("result_available" as const),
    resultRun,
  };
}

function writtenIds(
  emitted: ReadonlyArray<OrchestrationV2DomainEvent>,
  type: "subagent.updated" | "node.updated" | "turn-item.updated" | "provider-turn.updated",
): ReadonlySet<string> {
  return new Set(emitted.flatMap((event) => (event.type === type ? [event.payload.id] : [])));
}

export const endOrphanedNativeSubagent = Effect.fn("subagentProjection.endOrphanedNativeSubagent")(
  function* <E>(input: {
    readonly projection: Pick<OrchestrationV2ThreadProjection, "nodes" | "subagents" | "turnItems">;
    readonly subagentId: NodeId;
    readonly status: "completed" | "failed" | "interrupted" | "cancelled";
    readonly completedAt?: DateTime.Utc;
    readonly result?: string | null;
    readonly now: DateTime.Utc;
    readonly emitted: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly allocateEventId: () => Effect.Effect<EventId, E>;
  }) {
    const { now, status, subagentId, completedAt = now } = input;
    const subagent = input.projection.subagents.find((entry) => entry.id === subagentId);
    if (subagent?.origin !== "provider_native") return [];
    const node = input.projection.nodes.find((entry) => entry.id === subagentId);
    const item = input.projection.turnItems.find(
      (entry) => entry.type === "subagent" && entry.subagentId === subagentId,
    );
    const scope = {
      threadId: subagent.threadId,
      ...(subagent.runId === null ? {} : { runId: subagent.runId }),
      nodeId: subagentId,
      providerInstanceId: subagent.providerInstanceId,
      occurredAt: now,
    };
    const events: Array<OrchestrationV2DomainEvent> = [];
    if (
      isOrchestrationV2WorkActive(subagent.status) &&
      !writtenIds(input.emitted, "subagent.updated").has(subagentId)
    ) {
      events.push({
        ...scope,
        id: yield* input.allocateEventId(),
        type: "subagent.updated",
        driver: subagent.driver,
        payload: {
          ...subagent,
          status,
          completedAt,
          updatedAt: now,
          ...(input.result === undefined ? {} : { result: input.result }),
        },
      });
    }
    if (
      node !== undefined &&
      isOrchestrationV2WorkActive(node.status) &&
      !writtenIds(input.emitted, "node.updated").has(subagentId)
    ) {
      events.push({
        ...scope,
        id: yield* input.allocateEventId(),
        type: "node.updated",
        payload: { ...node, status, completedAt },
      });
    }
    if (
      item !== undefined &&
      isOrchestrationV2WorkActive(item.status) &&
      !writtenIds(input.emitted, "turn-item.updated").has(item.id)
    ) {
      events.push({
        ...scope,
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        payload: {
          ...item,
          status,
          completedAt,
          updatedAt: now,
          ...(input.result === undefined ? {} : { result: input.result }),
        },
      });
    }
    return events;
  },
);

export const endRunlessRootTurns = Effect.fn("subagentProjection.endRunlessRootTurns")(function* <
  E,
>(input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "nodes" | "providerTurns" | "turnItems"
  >;
  readonly status: "completed" | "failed" | "interrupted" | "cancelled";
  readonly completedAt?: DateTime.Utc;
  readonly now: DateTime.Utc;
  readonly emitted: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly allocateEventId: () => Effect.Effect<EventId, E>;
}) {
  const { now, status, completedAt = now } = input;
  const endedNodeIds = writtenIds(input.emitted, "node.updated");
  const endedItemIds = writtenIds(input.emitted, "turn-item.updated");
  const endedProviderTurnIds = writtenIds(input.emitted, "provider-turn.updated");
  const scope = {
    threadId: input.threadId,
    providerInstanceId: input.providerInstanceId,
    occurredAt: now,
  };
  const events: Array<OrchestrationV2DomainEvent> = [];
  for (const node of input.projection.nodes) {
    if (
      node.kind !== "root_turn" ||
      node.runId !== null ||
      !isOrchestrationV2WorkActive(node.status)
    ) {
      continue;
    }
    if (!endedNodeIds.has(node.id)) {
      events.push({
        ...scope,
        id: yield* input.allocateEventId(),
        type: "node.updated",
        nodeId: node.id,
        payload: { ...node, status, completedAt },
      });
    }
    for (const item of input.projection.turnItems) {
      if (
        item.nodeId !== node.id ||
        item.runId !== null ||
        !isOrchestrationV2WorkActive(item.status) ||
        endedItemIds.has(item.id)
      ) {
        continue;
      }
      events.push({
        ...scope,
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        nodeId: node.id,
        payload: {
          ...item,
          status:
            status === "completed" &&
            (item.type === "command_execution" || item.type === "dynamic_tool")
              ? "failed"
              : status,
          completedAt,
          updatedAt: now,
          ...(item.type === "reasoning" || item.type === "assistant_message"
            ? { streaming: false }
            : {}),
        },
      });
    }
    for (const providerTurn of input.projection.providerTurns) {
      if (
        providerTurn.nodeId !== node.id ||
        providerTurn.runAttemptId !== null ||
        !isOrchestrationV2WorkActive(providerTurn.status) ||
        endedProviderTurnIds.has(providerTurn.id)
      ) {
        continue;
      }
      events.push({
        ...scope,
        id: yield* input.allocateEventId(),
        type: "provider-turn.updated",
        nodeId: node.id,
        payload: { ...providerTurn, status, completedAt },
      });
    }
  }
  return events;
});

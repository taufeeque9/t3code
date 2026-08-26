import type {
  MessageId,
  OrchestrationMessage,
  OrchestrationThread,
  ProviderSessionForkPoint,
} from "@t3tools/contracts";
import { ThreadForkError } from "@t3tools/contracts";

export interface ThreadForkPlan {
  readonly copiedMessages: ReadonlyArray<OrchestrationMessage>;
  readonly cutoffMessageId?: MessageId;
  readonly forkPoint: ProviderSessionForkPoint;
  readonly draftText: string | null;
}

export function resolveThreadForkPlan(
  source: OrchestrationThread,
  requestedBeforeMessageId?: MessageId,
): ThreadForkPlan | ThreadForkError {
  const requestedMessage =
    requestedBeforeMessageId === undefined
      ? undefined
      : source.messages.find((message) => message.id === requestedBeforeMessageId);
  if (requestedBeforeMessageId !== undefined && requestedMessage?.role !== "user") {
    return new ThreadForkError({
      reason: "message-not-found",
      message: "The selected user message is no longer available in this thread.",
    });
  }
  const sessionIsActive =
    source.session?.status === "starting" || source.session?.status === "running";
  const activeTurnUserMessage =
    source.latestTurn?.state === "running"
      ? source.messages.findLast(
          (message) =>
            message.role === "user" && message.createdAt === source.latestTurn?.requestedAt,
        )
      : undefined;
  const runningCutoff =
    requestedBeforeMessageId === undefined && sessionIsActive
      ? (activeTurnUserMessage ?? source.messages.findLast((message) => message.role === "user"))
      : undefined;
  const incompleteTailCutoff =
    requestedBeforeMessageId === undefined && source.messages.at(-1)?.role === "user"
      ? source.messages.at(-1)
      : undefined;
  const cutoffMessage = requestedMessage ?? runningCutoff ?? incompleteTailCutoff;
  const cutoffIndex = cutoffMessage
    ? source.messages.findIndex((message) => message.id === cutoffMessage.id)
    : source.messages.length;
  const copiedMessages = source.messages.slice(0, cutoffIndex);
  const precedingTurnId =
    copiedMessages.findLast((message) => message.role === "assistant" && message.turnId !== null)
      ?.turnId ?? null;
  const forkPoint: ProviderSessionForkPoint = cutoffMessage
    ? {
        type: "before-user-message",
        userMessageOrdinal: source.messages
          .slice(0, cutoffIndex + 1)
          .filter((message) => message.role === "user").length,
        userMessageText: cutoffMessage.text,
        precedingTurnId,
      }
    : { type: "full", precedingTurnId };

  return {
    copiedMessages,
    ...(cutoffMessage ? { cutoffMessageId: cutoffMessage.id } : {}),
    forkPoint,
    draftText: requestedMessage?.text ?? null,
  };
}

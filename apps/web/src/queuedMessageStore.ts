import type {
  ModelSelection,
  PreviewAnnotationPayload,
  ProviderDriverKind,
  ProviderInteractionMode,
  RuntimeMode,
  ServerProvider,
} from "@t3tools/contracts";
import { create } from "zustand";

import type { ComposerSubmissionIntent } from "./composer-logic";
import type { ComposerFileAttachment, ComposerImageAttachment } from "./composerDraftStore";
import type { TerminalContextDraft } from "./lib/terminalContext";
import { randomUUID } from "./lib/utils";
import type { ReviewCommentContext } from "./reviewCommentContext";

/**
 * A composer submission held back while the thread's turn is running. It
 * carries the full draft snapshot so the send path can dispatch it later with
 * the same text, attachments, and contexts the user pressed Enter on.
 */
export interface QueuedComposerMessage {
  id: string;
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  terminalContexts: TerminalContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  reviewComments: ReviewCommentContext[];
  submissionIntent: ComposerSubmissionIntent;
  sendSettings?: {
    selectedProvider: ProviderDriverKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
    selectedPromptEffort: string | null;
    selectedModelSelection: ModelSelection;
    interactionMode: ProviderInteractionMode;
    interactionModeEnabled: boolean;
    runtimeMode: RuntimeMode;
  };
  /**
   * The newest completed tool activity at queue time. Remaining messages are
   * re-anchored when an earlier message leaves the queue.
   */
  queuedAfterToolActivityId: string | null;
  /**
   * Set when the message was created by Stop or a failed restore, not by the
   * user pressing send. It waits for Send now instead of leaving on its own.
   */
  holdUntilUserAction?: boolean;
  createdAt: string;
}

interface QueuedMessageStoreState {
  queuesByThreadKey: Record<string, QueuedComposerMessage[]>;
  /**
   * Bumped by `drain`. A send that took a message before a drain and finishes
   * its upload after it compares this to the value it captured and gives up,
   * so Stop cannot be followed by a queued message starting a new turn.
   */
  drainGeneration: number;
  enqueue: (threadKey: string, message: Omit<QueuedComposerMessage, "id">) => QueuedComposerMessage;
  /**
   * Removes one message and returns it, or null when another caller already
   * took it. The remaining messages are re-anchored to `toolActivityId`.
   */
  take: (
    threadKey: string,
    id: string,
    toolActivityId: string | null,
  ) => QueuedComposerMessage | null;
  /** Removes one message without touching the others' anchors. Null when already gone. */
  remove: (threadKey: string, id: string) => QueuedComposerMessage | null;
  /**
   * Puts a message back at the head, held for user action. Used when its
   * send failed: the queue keeps its order and nothing behind it overtakes.
   */
  holdAtFront: (threadKey: string, message: QueuedComposerMessage) => void;
  /** Removes and returns every queued message for the thread, oldest first. */
  drain: (threadKey: string) => QueuedComposerMessage[];
}

const EMPTY_QUEUE: QueuedComposerMessage[] = [];

/** In-memory only: a queued message is a live intent, not a draft worth persisting. */
export const useQueuedMessageStore = create<QueuedMessageStoreState>()((set, get) => ({
  queuesByThreadKey: {},
  drainGeneration: 0,
  enqueue: (threadKey, message) => {
    const entry: QueuedComposerMessage = { ...message, id: randomUUID() };
    set((state) => ({
      queuesByThreadKey: {
        ...state.queuesByThreadKey,
        [threadKey]: [...(state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE), entry],
      },
    }));
    return entry;
  },
  take: (threadKey, id, toolActivityId) => {
    const queue = get().queuesByThreadKey[threadKey];
    const entry = queue?.find((message) => message.id === id);
    if (!queue || !entry) {
      return null;
    }
    set((state) => {
      const remaining = (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE)
        .filter((message) => message.id !== id)
        .map((message) =>
          message.queuedAfterToolActivityId === toolActivityId
            ? message
            : { ...message, queuedAfterToolActivityId: toolActivityId },
        );
      const queuesByThreadKey = { ...state.queuesByThreadKey };
      if (remaining.length === 0) {
        delete queuesByThreadKey[threadKey];
      } else {
        queuesByThreadKey[threadKey] = remaining;
      }
      return { queuesByThreadKey };
    });
    return entry;
  },
  remove: (threadKey, id) => {
    const queue = get().queuesByThreadKey[threadKey];
    const entry = queue?.find((message) => message.id === id);
    if (!queue || !entry) {
      return null;
    }
    set((state) => {
      const remaining = (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
        (message) => message.id !== id,
      );
      const queuesByThreadKey = { ...state.queuesByThreadKey };
      if (remaining.length === 0) {
        delete queuesByThreadKey[threadKey];
      } else {
        queuesByThreadKey[threadKey] = remaining;
      }
      return { queuesByThreadKey };
    });
    return entry;
  },
  holdAtFront: (threadKey, message) => {
    set((state) => {
      const rest = (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
        (entry) => entry.id !== message.id,
      );
      return {
        queuesByThreadKey: {
          ...state.queuesByThreadKey,
          [threadKey]: [{ ...message, holdUntilUserAction: true }, ...rest],
        },
      };
    });
  },
  drain: (threadKey) => {
    const queue = get().queuesByThreadKey[threadKey];
    if (!queue || queue.length === 0) {
      return EMPTY_QUEUE;
    }
    set((state) => {
      const queuesByThreadKey = { ...state.queuesByThreadKey };
      delete queuesByThreadKey[threadKey];
      return { queuesByThreadKey, drainGeneration: state.drainGeneration + 1 };
    });
    return queue;
  },
}));

/**
 * The newest finished tool call used to anchor queued messages. Live arrays
 * are sorted, but a snapshot loaded from the database is not, so pick by
 * sequence rather than position.
 */
export function latestCompletedToolActivityId(
  activities: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly sequence?: number | undefined;
    readonly createdAt: string;
  }>,
): string | null {
  let latest: (typeof activities)[number] | null = null;
  for (const activity of activities) {
    if (activity.kind !== "tool.completed") continue;
    if (
      latest === null ||
      (activity.sequence ?? -1) > (latest.sequence ?? -1) ||
      ((activity.sequence ?? -1) === (latest.sequence ?? -1) &&
        activity.createdAt > latest.createdAt)
    ) {
      latest = activity;
    }
  }
  return latest?.id ?? null;
}

/**
 * A queued message leaves automatically only after the current turn finishes.
 * Sending during a tool boundary steers the active turn instead; that remains
 * available through the queued row's explicit Send now action.
 */
export function isQueuedMessageDue(input: {
  message: Pick<QueuedComposerMessage, "holdUntilUserAction">;
  phase: "connecting" | "running" | "ready" | "disconnected";
}): boolean {
  if (input.message.holdUntilUserAction) return false;
  return input.phase === "ready" || input.phase === "disconnected";
}

export function useQueuedMessages(threadKey: string): QueuedComposerMessage[] {
  return useQueuedMessageStore((state) => state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE);
}

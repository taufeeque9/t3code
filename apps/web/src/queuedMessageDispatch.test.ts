import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MessageId, TurnId, OrchestrationDispatchCommandError } from "@t3tools/contracts";

import { createQueuedMessageDispatcher, type QueuedMessageThread } from "./queuedMessageDispatch";
import { useQueuedMessageStore, type QueuedMessage } from "./queuedMessageStore";

const THREAD = "environment:thread-1";
const OTHER_THREAD = "environment:thread-2";
const completed: QueuedMessageThread = {
  archivedAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null,
  latestUserMessageAt: "2026-01-01T00:00:00.000Z",
  latestTurn: {
    turnId: TurnId.make("original-turn"),
    state: "completed",
    requestedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    assistantMessageId: MessageId.make("reply"),
  },
};

beforeEach(() => useQueuedMessageStore.setState({ byThreadKey: {} }));

describe("queued message dispatch", () => {
  it("sends an unselected thread after its turn finishes and retains the queue until acknowledgement", async () => {
    const dispatch = createQueuedMessageDispatcher();
    const send = vi.fn(async (_message: QueuedMessage) => {});
    const queue = useQueuedMessageStore.getState();
    queue.queue(THREAD, "follow up");
    queue.queue(OTHER_THREAD, "other work");
    await dispatch({
      threadKey: THREAD,
      thread: {
        ...completed,
        latestTurn: { ...completed.latestTurn!, state: "running", completedAt: null },
      },
      live: true,
      send,
    });
    expect(send).not.toHaveBeenCalled();

    await dispatch({ threadKey: THREAD, thread: completed, live: true, send });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({ prompt: "follow up" });
    const message = useQueuedMessageStore.getState().byThreadKey[THREAD]!;
    expect(message.sentAt).toBeDefined();
    await dispatch({ threadKey: THREAD, thread: completed, live: true, send });
    expect(send).toHaveBeenCalledOnce();
    await dispatch({
      threadKey: THREAD,
      thread: {
        ...completed,
        latestUserMessageAt: message.sentAt!,
      },
      live: true,
      acknowledged: true,
      send,
    });
    expect(useQueuedMessageStore.getState().byThreadKey[THREAD]).toBeUndefined();
    expect(useQueuedMessageStore.getState().byThreadKey[OTHER_THREAD]?.prompt).toBe("other work");
  });

  it("does not send using stale disconnected snapshots, and drains after reconnect", async () => {
    const dispatch = createQueuedMessageDispatcher();
    const send = vi.fn(async (_message: QueuedMessage) => {});
    useQueuedMessageStore.getState().queue(THREAD, "later");
    await dispatch({ threadKey: THREAD, thread: completed, live: false, send });
    expect(send).not.toHaveBeenCalled();
    await dispatch({ threadKey: THREAD, thread: completed, live: true, send });
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { archivedAt: "2026-01-01T00:00:00Z" },
    { latestUserMessageAt: new Date().toISOString() },
  ])("waits while the thread is blocked: %j", async (blocker) => {
    const dispatch = createQueuedMessageDispatcher();
    const send = vi.fn(async (_message: QueuedMessage) => {});
    useQueuedMessageStore.getState().queue(THREAD, "later");
    await dispatch({ threadKey: THREAD, thread: { ...completed, ...blocker }, live: true, send });
    expect(send).not.toHaveBeenCalled();
  });

  it("retains failed sends without retrying on every event, and retries with the same identity", async () => {
    const dispatch = createQueuedMessageDispatcher();
    const send = vi.fn(async (_message: QueuedMessage) => {
      throw new Error("Offline");
    });
    const queue = useQueuedMessageStore.getState();
    queue.queue(THREAD, "keep me");
    await dispatch({ threadKey: THREAD, thread: completed, live: true, send });
    const failed = useQueuedMessageStore.getState().byThreadKey[THREAD]!;
    expect(failed).toMatchObject({ prompt: "keep me", error: "Offline" });
    await dispatch({ threadKey: THREAD, thread: completed, live: true, send });
    expect(send).toHaveBeenCalledOnce();
    queue.retry(THREAD);
    await dispatch({ threadKey: THREAD, thread: completed, live: true, send });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({ id: failed.id, sentAt: failed.sentAt });
  });

  it("uses a fresh identity after a definite server rejection", async () => {
    const dispatch = createQueuedMessageDispatcher();
    const cause = new Error("Rejected before commit");
    cause.name = "OrchestrationCommandInvariantError";
    const send = vi.fn(async (_message: QueuedMessage) => {
      throw new OrchestrationDispatchCommandError({ message: "Rejected", cause });
    });
    const queue = useQueuedMessageStore.getState();
    queue.queue(THREAD, "retry rejected work");
    await dispatch({ threadKey: THREAD, thread: completed, live: true, send });
    queue.retry(THREAD);
    await dispatch({ threadKey: THREAD, thread: completed, live: true, send });
    expect(send.mock.calls[1]?.[0].id).not.toBe(send.mock.calls[0]?.[0].id);
  });

  it("does not consume or overwrite a message while delivery is in flight", async () => {
    const dispatch = createQueuedMessageDispatcher();
    let finish!: () => void;
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const queue = useQueuedMessageStore.getState();
    queue.queue(THREAD, "in flight");
    const delivery = dispatch({ threadKey: THREAD, thread: completed, live: true, send });
    expect(queue.take(THREAD)).toBeNull();
    expect(queue.queue(THREAD, "replacement")).toBe(false);
    queue.remove(THREAD);
    expect(useQueuedMessageStore.getState().byThreadKey[THREAD]?.prompt).toBe("in flight");
    await dispatch({ threadKey: THREAD, thread: completed, live: true, send });
    expect(send).toHaveBeenCalledOnce();
    finish();
    await delivery;
  });

  it("does not mistake an older message from a faster client clock for delivery", async () => {
    const dispatch = createQueuedMessageDispatcher();
    const send = vi.fn(async (_message: QueuedMessage) => {});
    const future = new Date(Date.now() + 60_000).toISOString();
    const thread = {
      ...completed,
      latestUserMessageAt: future,
      latestTurn: { ...completed.latestTurn!, requestedAt: future, completedAt: future },
    };
    useQueuedMessageStore.getState().queue(THREAD, "keep until delivered");
    await dispatch({ threadKey: THREAD, thread, live: true, send });
    await dispatch({ threadKey: THREAD, thread, live: true, send });
    expect(useQueuedMessageStore.getState().byThreadKey[THREAD]).toBeDefined();
  });

  it("reuses persisted delivery identity after a reload", async () => {
    useQueuedMessageStore.getState().queue(THREAD, "durable");
    const firstSend = vi.fn(async (_message: QueuedMessage) => {});
    await createQueuedMessageDispatcher()({
      threadKey: THREAD,
      thread: completed,
      live: true,
      send: firstSend,
    });
    const retrySend = vi.fn(async (_message: QueuedMessage) => {});
    await createQueuedMessageDispatcher()({
      threadKey: THREAD,
      thread: completed,
      live: true,
      send: retrySend,
    });
    expect(retrySend.mock.calls).toEqual(firstSend.mock.calls);
  });
});

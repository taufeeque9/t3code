import { ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  readQueuedMessageStorageForTest,
  useQueuedMessageStore,
  writeQueuedMessageStorageForTest,
} from "./queuedMessageStore";

const THREAD = "env-1:thread-1";

// This test environment has no `localStorage`, so the store runs on its
// in-memory fallback; the reload test round-trips through that instead.
beforeEach(() => {
  writeQueuedMessageStorageForTest("{}");
  useQueuedMessageStore.setState({ byThreadKey: {} });
});

describe("queuedMessageStore", () => {
  it("queues one message per thread, replacing an earlier one", () => {
    const { queue } = useQueuedMessageStore.getState();
    expect(queue(THREAD, "first")).toBe(true);
    expect(queue(THREAD, "second")).toBe(true);
    expect(useQueuedMessageStore.getState().byThreadKey[THREAD]?.prompt).toBe("second");
  });

  it("keeps threads independent", () => {
    const { queue } = useQueuedMessageStore.getState();
    queue(THREAD, "for one");
    queue("env-1:thread-2", "for the other");
    const state = useQueuedMessageStore.getState().byThreadKey;
    expect(state[THREAD]?.prompt).toBe("for one");
    expect(state["env-1:thread-2"]?.prompt).toBe("for the other");
  });

  it("refuses an empty or whitespace-only prompt", () => {
    const { queue } = useQueuedMessageStore.getState();
    expect(queue(THREAD, "   \n ")).toBe(false);
    expect(useQueuedMessageStore.getState().byThreadKey[THREAD]).toBeUndefined();
  });

  it("trims the stored prompt", () => {
    useQueuedMessageStore.getState().queue(THREAD, "  padded  ");
    expect(useQueuedMessageStore.getState().byThreadKey[THREAD]?.prompt).toBe("padded");
  });

  it("take removes the message so it cannot be sent twice", () => {
    useQueuedMessageStore.getState().queue(THREAD, "only once");
    expect(useQueuedMessageStore.getState().take(THREAD)?.prompt).toBe("only once");
    expect(useQueuedMessageStore.getState().take(THREAD)).toBeNull();
  });

  it("remove clears without returning anything", () => {
    useQueuedMessageStore.getState().queue(THREAD, "discard me");
    useQueuedMessageStore.getState().remove(THREAD);
    expect(useQueuedMessageStore.getState().byThreadKey[THREAD]).toBeUndefined();
  });

  it("survives a reload through localStorage", () => {
    useQueuedMessageStore.getState().queue(THREAD, "still here");
    const raw = readQueuedMessageStorageForTest();
    expect(raw).toBeTruthy();
    useQueuedMessageStore.setState({ byThreadKey: {} });
    writeQueuedMessageStorageForTest(raw ?? "");
    expect(useQueuedMessageStore.getState().byThreadKey[THREAD]?.prompt).toBe("still here");
  });

  it("preserves settings and delivery identity across a reload after a failed send", () => {
    const queue = useQueuedMessageStore.getState();
    queue.queue(THREAD, "plan this", {
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      text: "formatted plan this",
    });
    const sending = queue.beginSend(THREAD, "2026-09-11T20:00:00.000Z")!;
    queue.failSend(THREAD, sending.id, "Disconnected");
    const expected = useQueuedMessageStore.getState().byThreadKey[THREAD];
    const raw = readQueuedMessageStorageForTest()!;
    useQueuedMessageStore.setState({ byThreadKey: {} });
    writeQueuedMessageStorageForTest(raw);
    expect(useQueuedMessageStore.getState().byThreadKey[THREAD]).toEqual(expected);
  });

  it("ignores malformed persisted entries rather than failing to load", () => {
    writeQueuedMessageStorageForTest(
      JSON.stringify({
        good: { prompt: "kept", queuedAt: "2026-09-07T00:00:00.000Z" },
        missingPrompt: { queuedAt: "2026-09-07T00:00:00.000Z" },
        emptyPrompt: { prompt: "", queuedAt: "2026-09-07T00:00:00.000Z" },
        notAnObject: 5,
      }),
    );
    const state = useQueuedMessageStore.getState().byThreadKey;
    expect(Object.keys(state)).toEqual(["good"]);
  });

  it("recovers from unparseable storage", () => {
    writeQueuedMessageStorageForTest("{not json");
    expect(useQueuedMessageStore.getState().byThreadKey).toEqual({});
  });
});

import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveUserMessageForkSources, userMessageForkSourcesForThread } from "./userMessageFork";

const threadId = ThreadId.make("thread-1");
const run = (
  ordinal: number,
  status: "completed" | "running" | "rolled_back" | "failed" = "completed",
) => ({
  id: RunId.make(`run-${ordinal}`),
  threadId,
  ordinal,
  userMessageId: MessageId.make(`message-${ordinal}`),
  status,
});

describe("resolveUserMessageForkSources", () => {
  it("forks each later message after the run before it", () => {
    const sources = resolveUserMessageForkSources([run(3, "failed"), run(1), run(2)]);

    expect(sources.has(MessageId.make("message-1"))).toBe(false);
    expect(sources.get(MessageId.make("message-2"))).toEqual({
      sourceThreadId: threadId,
      runId: RunId.make("run-1"),
    });
    expect(sources.get(MessageId.make("message-3"))?.runId).toBe(RunId.make("run-2"));
  });

  it("skips rolled-back runs and refuses to fork after a busy one", () => {
    const sources = resolveUserMessageForkSources([
      run(1),
      run(2, "rolled_back"),
      run(3, "running"),
      run(4),
    ]);

    expect(sources.get(MessageId.make("message-3"))?.runId).toBe(RunId.make("run-1"));
    expect(sources.has(MessageId.make("message-4"))).toBe(false);
  });

  it("forks before a completed /compact run, which leaves no reply to fork at", () => {
    const compact = new Set([MessageId.make("message-2")]);

    const sources = resolveUserMessageForkSources([run(1), run(2), run(3)], compact);

    expect(sources.get(MessageId.make("message-2"))?.runId).toBe(RunId.make("run-1"));
    expect(sources.get(MessageId.make("message-3"))?.runId).toBe(RunId.make("run-1"));
    expect(
      resolveUserMessageForkSources([run(1), run(2, "running"), run(3)], compact).has(
        MessageId.make("message-3"),
      ),
    ).toBe(false);
    expect(
      resolveUserMessageForkSources([run(1), run(2, "failed"), run(3)], compact).get(
        MessageId.make("message-3"),
      )?.runId,
    ).toBe(RunId.make("run-2"));
  });
});

describe("userMessageForkSourcesForThread", () => {
  const runs = [run(1), run(2, "running")];
  const userMessage = (id: string, text: string) => ({
    id: MessageId.make(id),
    role: "user" as const,
    text,
    attachments: [],
  });

  it("keeps one identity while only message text changes", () => {
    const first = userMessageForkSourcesForThread(runs, [userMessage("message-1", "a")]);
    const streamed = userMessageForkSourcesForThread(runs, [
      userMessage("message-1", "a"),
      { id: MessageId.make("reply"), role: "assistant", text: "partial", attachments: [] },
    ]);
    expect(streamed).toBe(first);
  });

  it("recomputes when a /compact command appears", () => {
    const first = userMessageForkSourcesForThread(runs, [userMessage("message-1", "a")]);
    const compacted = userMessageForkSourcesForThread(runs, [userMessage("message-1", "/compact")]);
    expect(compacted).not.toBe(first);
    expect(compacted.has(MessageId.make("message-2"))).toBe(false);
  });
});

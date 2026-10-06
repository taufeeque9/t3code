import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveUserMessageForkSources } from "./userMessageFork";

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
});

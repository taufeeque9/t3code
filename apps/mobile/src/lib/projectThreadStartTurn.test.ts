import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./uuid", () => ({
  randomHex: () => "deadbeef",
}));
vi.mock("./composerImages", () => ({ toUploadChatImageAttachments: () => [] }));

import {
  buildProjectThreadStartTurnInput,
  deriveThreadTitleFromPrompt,
  type ProjectThreadStartTurnSpec,
} from "./projectThreadStartTurn";

const makeSpec = (
  overrides: Partial<ProjectThreadStartTurnSpec> = {},
): ProjectThreadStartTurnSpec => ({
  projectId: ProjectId.make("project-1"),
  projectCwd: "/workspace/project-1",
  threadId: "thread-1",
  commandId: "command-1",
  messageId: "message-1",
  createdAt: "2026-08-10T12:00:00.000Z",
  text: "Build the mobile change",
  attachments: [],
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspaceMode: "worktree",
  branch: "main",
  worktreePath: null,
  startFromOrigin: false,
  ...overrides,
});

describe("project thread title", () => {
  it("keeps ordinary titles and the empty-prompt fallback", () => {
    expect(deriveThreadTitleFromPrompt("  Fix\n the parser  ")).toBe("Fix the parser");
    expect(deriveThreadTitleFromPrompt(" \n ")).toBe("New thread");
  });

  it.each([
    {
      comment: undefined,
      title: "Keep `cache[key]` & <parser> shared. Retry!",
    },
    {
      comment: 'Why "shared"?',
      title: 'Keep `cache[key]` & <parser> shared. Retry! Comment: Why "shared"?',
    },
  ])("uses readable titles and intact links with comment $comment", ({ comment, title }) => {
    const quoteText = "Keep `cache[key]` & <parser> shared.\n  Retry!";
    const text = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("source-environment"),
      threadId: ThreadId.make("source-thread"),
      messageId: MessageId.make("source-message"),
      text: quoteText,
      ...(comment === undefined ? {} : { comment }),
      start: 0,
      end: quoteText.length,
      prefix: "",
      suffix: "",
    });
    const input = buildProjectThreadStartTurnInput(
      makeSpec({
        text,
        workspaceMode: "local",
        branch: null,
      }),
    );

    expect(input.titleSeed).toBe(title);
    expect(input.bootstrap.createThread.title).toBe(input.titleSeed);
    expect(input.message.text).toBe(text);
  });
});

describe("buildProjectThreadStartTurnInput", () => {
  it("uses the configured prefix for a worktree bootstrap branch", () => {
    const input = buildProjectThreadStartTurnInput(
      makeSpec({
        worktreeBranchPrefix: "mobile-team",
      }),
    );

    expect(input.bootstrap.prepareWorktree?.branch).toBe("mobile-team/deadbeef");
  });

  it("falls back to the default prefix when the server configuration is unavailable", () => {
    const input = buildProjectThreadStartTurnInput(makeSpec());

    expect(input.bootstrap.prepareWorktree?.branch).toBe("t3code/deadbeef");
  });

  it("omits worktree preparation for a local thread", () => {
    const input = buildProjectThreadStartTurnInput(
      makeSpec({
        workspaceMode: "local",
        worktreePath: "/workspace/project-1",
      }),
    );

    expect(input.bootstrap.prepareWorktree).toBeUndefined();
  });
});

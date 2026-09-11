import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, useState, useSyncExternalStore } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { QueuedMessageThread } from "../queuedMessageDispatch";
import { useQueuedMessageStore, type QueuedMessageSettings } from "../queuedMessageStore";

type ThreadSnapshot = QueuedMessageThread &
  Pick<EnvironmentThreadShell, "modelSelection" | "runtimeMode" | "interactionMode" | "branch">;

const state = vi.hoisted(() => ({
  threads: new Map<string, ThreadSnapshot>(),
  details: new Map<string, { messages: { id: string }[] }>(),
  listeners: new Set<() => void>(),
  startTurn: vi.fn(),
  updateMetadata: vi.fn(),
  setRuntimeMode: vi.fn(),
  setInteractionMode: vi.fn(),
  shell: { status: "live" },
  environment: { connection: { phase: "connected" } },
}));

function subscribe(listener: () => void) {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

vi.mock("../state/entities", () => ({
  useThreadShell: (ref: ScopedThreadRef) =>
    useSyncExternalStore(subscribe, () => state.threads.get(scopedThreadKey(ref)) ?? null),
  useThreadDetail: (ref: ScopedThreadRef | null) =>
    useSyncExternalStore(subscribe, () =>
      ref ? (state.details.get(scopedThreadKey(ref)) ?? null) : null,
    ),
}));
vi.mock("../state/environments", () => ({ useEnvironment: () => state.environment }));
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: () => state.shell },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.shell }));
vi.mock("../state/threads", () => ({
  threadEnvironment: {
    startTurn: "startTurn",
    updateMetadata: "updateMetadata",
    setRuntimeMode: "setRuntimeMode",
    setInteractionMode: "setInteractionMode",
  },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (
    command: "startTurn" | "updateMetadata" | "setRuntimeMode" | "setInteractionMode",
  ) => state[command],
}));

import { QueuedMessageCoordinator } from "./QueuedMessageCoordinator";

const threadRef = {
  environmentId: EnvironmentId.make("queue-environment"),
  threadId: ThreadId.make("thread-1"),
};
const threadKey = scopedThreadKey(threadRef);
const completed: ThreadSnapshot = {
  branch: null,
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
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.3-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

let renderer: ReactTestRenderer | null = null;

function SelectedRoute() {
  const [thread, selectThread] = useState("thread-1");
  return <button onClick={() => selectThread("thread-2")}>{thread}</button>;
}

async function publish() {
  await act(async () => {
    for (const listener of state.listeners) listener();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useQueuedMessageStore.setState({ byThreadKey: {} });
  state.threads.clear();
  state.details.clear();
  state.startTurn.mockReset().mockResolvedValue({ _tag: "Success" });
  state.updateMetadata.mockReset().mockResolvedValue({ _tag: "Success" });
  state.setRuntimeMode.mockReset().mockResolvedValue({ _tag: "Success" });
  state.setInteractionMode.mockReset().mockResolvedValue({ _tag: "Success" });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("QueuedMessageCoordinator", () => {
  it("delivers and acknowledges queued work after navigating away from its thread", async () => {
    state.threads.set(threadKey, {
      ...completed,
      latestTurn: { ...completed.latestTurn!, state: "running", completedAt: null },
    });
    await act(async () => {
      renderer = create(
        <>
          <QueuedMessageCoordinator />
          <SelectedRoute />
        </>,
      );
    });
    await act(async () => {
      useQueuedMessageStore.getState().queue(threadKey, "do the follow-up work");
    });
    expect(state.startTurn).not.toHaveBeenCalled();

    await act(async () => renderer!.root.findByType("button").props.onClick());
    expect(renderer!.root.findByType("button").children).toEqual(["thread-2"]);

    state.threads.set(threadKey, completed);
    await publish();

    const queued = useQueuedMessageStore.getState().byThreadKey[threadKey]!;
    expect(queued.sentAt).toBeDefined();
    expect(state.startTurn).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: {
        commandId: queued.id,
        threadId: threadRef.threadId,
        message: {
          messageId: queued.id,
          role: "user",
          text: "do the follow-up work",
          attachments: [],
        },
        modelSelection: completed.modelSelection,
        runtimeMode: completed.runtimeMode,
        interactionMode: completed.interactionMode,
        createdAt: queued.sentAt,
      },
    });
    expect(renderer!.root.findByType("button").children).toEqual(["thread-2"]);

    state.threads.set(threadKey, { ...completed, latestUserMessageAt: queued.sentAt! });
    await publish();
    expect(useQueuedMessageStore.getState().byThreadKey[threadKey]).toBeDefined();

    state.details.set(threadKey, { messages: [{ id: queued.id }] });
    await publish();
    expect(useQueuedMessageStore.getState().byThreadKey[threadKey]).toBeUndefined();
    expect(state.startTurn).toHaveBeenCalledOnce();
    expect(renderer!.root.findByType("button").children).toEqual(["thread-2"]);
  });

  it("persists the queued model and modes and sends its formatted text", async () => {
    const settings: QueuedMessageSettings = {
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-4-6" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      text: "<context>selected file</context>\n\nMake a plan",
    };
    state.threads.set(threadKey, completed);
    useQueuedMessageStore.getState().queue(threadKey, "Make a plan", settings);
    await act(async () => {
      renderer = create(<QueuedMessageCoordinator />);
    });

    const queued = useQueuedMessageStore.getState().byThreadKey[threadKey]!;
    const target = { environmentId: threadRef.environmentId };
    const input = { threadId: threadRef.threadId, createdAt: queued.sentAt };
    expect(state.updateMetadata).toHaveBeenCalledExactlyOnceWith({
      ...target,
      input: { threadId: threadRef.threadId, modelSelection: settings.modelSelection },
    });
    expect(state.setRuntimeMode).toHaveBeenCalledExactlyOnceWith({
      ...target,
      input: { ...input, runtimeMode: settings.runtimeMode },
    });
    expect(state.setInteractionMode).toHaveBeenCalledExactlyOnceWith({
      ...target,
      input: { ...input, interactionMode: settings.interactionMode },
    });
    expect(state.startTurn).toHaveBeenCalledExactlyOnceWith({
      ...target,
      input: {
        ...input,
        commandId: queued.id,
        modelSelection: settings.modelSelection,
        runtimeMode: settings.runtimeMode,
        interactionMode: settings.interactionMode,
        message: { messageId: queued.id, role: "user", text: settings.text, attachments: [] },
      },
    });
    expect(state.setInteractionMode.mock.invocationCallOrder[0]).toBeLessThan(
      state.startTurn.mock.invocationCallOrder[0]!,
    );
  });

  it("retains queued work when saving its settings fails before the turn starts", async () => {
    state.threads.set(threadKey, completed);
    state.setRuntimeMode.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Could not save runtime mode")),
    });
    useQueuedMessageStore.getState().queue(threadKey, "Make a plan", {
      modelSelection: completed.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      text: "Make a plan",
    });
    await act(async () => {
      renderer = create(<QueuedMessageCoordinator />);
    });

    expect(state.setRuntimeMode).toHaveBeenCalledOnce();
    expect(state.setInteractionMode).not.toHaveBeenCalled();
    expect(state.startTurn).not.toHaveBeenCalled();
    expect(useQueuedMessageStore.getState().byThreadKey[threadKey]).toMatchObject({
      prompt: "Make a plan",
      error: "Could not save runtime mode",
    });
    state.threads.set(threadKey, { ...completed });
    await publish();
    expect(state.setRuntimeMode).toHaveBeenCalledOnce();
    expect(state.startTurn).not.toHaveBeenCalled();
  });
});

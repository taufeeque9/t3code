import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { applyNewThreadAccountPick } from "./newThreadAccount";

const serverConfigs = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => serverConfigs } }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));

const environmentId = EnvironmentId.make("env");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project"));
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-27T12:00:00Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const claudeA = ProviderInstanceId.make("claudeA");
const claudeB = ProviderInstanceId.make("claudeB");
const opusHigh = { model: "claude-opus-5", options: [{ id: "effort", value: "high" }] };

const provider = (instanceId: ProviderInstanceId, usedPercent: number, resetsInMs: number) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(NOW),
    models: [{ slug: "claude-opus-5", name: "Opus 5", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: iso(NOW),
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent,
          resetsAt: iso(NOW + resetsInMs),
        },
      ],
    },
  }) satisfies ServerProvider;

function setup() {
  serverConfigs.clear();
  serverConfigs.set(environmentId, {
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [claudeA]: { driver: ProviderDriverKind.make("claudeAgent") },
        [claudeB]: { driver: ProviderDriverKind.make("claudeAgent") },
      },
    },
    providers: [provider(claudeA, 20, 6 * DAY), provider(claudeB, 50, DAY)],
  });
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
  return useComposerDraftStore.getState();
}

describe("applyNewThreadAccountPick", () => {
  it("moves a sticky default to the picked account without changing the sticky selection", () => {
    const store = setup();
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const draftId = DraftId.make("draft-sticky");
    store.setStickyModelSelection({ instanceId: claudeA, ...opusHigh });
    store.applyStickyState(draftId);

    applyNewThreadAccountPick(draftId, projectRef);

    const state = useComposerDraftStore.getState();
    const draft = state.getComposerDraft(draftId);
    expect(draft?.activeProvider).toBe(claudeB);
    expect(draft?.modelSelectionByProvider[claudeB]).toEqual({ instanceId: claudeB, ...opusHigh });
    expect(draft?.modelSelectionExplicit).toBeUndefined();
    expect(state.stickyActiveProvider).toBe(claudeA);
  });

  it("keeps an account the user picked in the draft", () => {
    const store = setup();
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const draftId = DraftId.make("draft-explicit");
    store.setModelSelection(draftId, { instanceId: claudeA, ...opusHigh }, { explicit: true });

    applyNewThreadAccountPick(draftId, projectRef);

    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.activeProvider).toBe(
      claudeA,
    );
  });
});

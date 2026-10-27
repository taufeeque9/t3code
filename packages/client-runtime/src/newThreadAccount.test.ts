import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { resolveNewThreadAccountSelection } from "./newThreadAccount.ts";

const now = Date.parse("2026-10-27T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const weekly = (usedPercent: number, resetsInMs: number): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + resetsInMs)),
});

const provider = (
  id: string,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-27T11:59:00.000Z",
  models: [
    {
      slug: "claude-opus-5",
      name: "Opus 5",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
  usageLimits: { checkedAt: "2026-10-27T11:59:00.000Z", windows: [...windows] },
  ...overrides,
});

const settings = (overrides: Partial<ServerSettings> = {}): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [ProviderInstanceId.make("claudeA")]: { driver: ProviderDriverKind.make("claudeAgent") },
    [ProviderInstanceId.make("claudeB")]: { driver: ProviderDriverKind.make("claudeAgent") },
    [ProviderInstanceId.make("codexA")]: { driver: ProviderDriverKind.make("codex") },
  },
  ...overrides,
});

const selection = {
  instanceId: ProviderInstanceId.make("claudeA"),
  model: "claude-opus-5",
  options: [{ id: "effort", value: "high" }],
};
const resolve = (
  providers: ReadonlyArray<ServerProvider>,
  serverSettings = settings(),
  projectId: ProjectId | null = null,
) =>
  resolveNewThreadAccountSelection({
    settings: serverSettings,
    providers,
    projectId,
    selection,
    now,
  });

describe("resolveNewThreadAccountSelection", () => {
  it("moves to the better account and keeps the model and options", () => {
    expect(
      resolve([provider("claudeA", [weekly(20, 6 * DAY)]), provider("claudeB", [weekly(50, DAY)])]),
    ).toEqual({ ...selection, instanceId: "claudeB" });
  });

  it("leaves the selection alone when the setting is off", () => {
    expect(
      resolve(
        [provider("claudeA", [weekly(20, 6 * DAY)]), provider("claudeB", [weekly(50, DAY)])],
        settings({ autoPickProviderAccount: false }),
      ),
    ).toBeNull();
  });

  it("only considers accounts of the selection's driver", () => {
    expect(
      resolve([
        provider("claudeA", [weekly(20, 6 * DAY)]),
        provider("codexA", [weekly(10, DAY)], { driver: ProviderDriverKind.make("codex") }),
      ]),
    ).toBeNull();
  });

  it("skips accounts that are disabled for the project, signed out, or missing the model", () => {
    const projectId = ProjectId.make("project");
    const sooner = [weekly(10, DAY)];
    expect(
      resolve(
        [provider("claudeA", [weekly(20, 6 * DAY)]), provider("claudeB", sooner)],
        settings({
          projectSettingsOverrides: {
            [projectId]: {
              providerInstances: { [ProviderInstanceId.make("claudeB")]: { enabled: false } },
            },
          },
        }),
        projectId,
      ),
    ).toBeNull();
    expect(
      resolve([
        provider("claudeA", [weekly(20, 6 * DAY)]),
        provider("claudeB", sooner, { auth: { status: "unauthenticated" } }),
      ]),
    ).toBeNull();
    expect(
      resolve([
        provider("claudeA", [weekly(20, 6 * DAY)]),
        provider("claudeB", sooner, { models: [] }),
      ]),
    ).toBeNull();
  });
});

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectClaudeSignIns } from "./claudeSignIn";

const checkedAt = "2026-09-18T06:03:43.774Z";

function claudeProvider(
  instanceId: string,
  displayName: string,
  overrides: Partial<ServerProvider>,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName,
    enabled: true,
    installed: true,
    version: "2.1.273",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("collectClaudeSignIns", () => {
  it("keeps the remaining expired accounts after one account signs back in", () => {
    const providers = [
      claudeProvider("claude-work", "Claude Gmail", {
        usageLimits: {
          checkedAt,
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 10,
            },
          ],
        },
      }),
      claudeProvider("claude-sokobans", "Claude Sokobans", {
        status: "error",
        auth: { status: "unauthenticated" },
        usageLimits: {
          checkedAt,
          windows: [],
          unavailable: { reason: "unsupported" },
        },
      }),
      claudeProvider("claudeAgent", "Claude FAR", {
        status: "error",
        auth: { status: "unauthenticated" },
        usageLimits: {
          checkedAt,
          windows: [],
          unavailable: { reason: "unsupported" },
        },
      }),
    ];
    const environmentId = EnvironmentId.make("local");
    const presentations = new Map([
      [
        environmentId,
        {
          entry: { target: { label: "Local" } },
          serverConfig: { providers },
        },
      ],
    ]);

    expect(collectClaudeSignIns(presentations)).toEqual([
      {
        key: `${environmentId}:claude-sokobans`,
        environmentId,
        instanceId: ProviderInstanceId.make("claude-sokobans"),
        displayName: "Claude Sokobans",
        notice: "Sign-in expired.",
        listedInNotices: false,
      },
      {
        key: `${environmentId}:claudeAgent`,
        environmentId,
        instanceId: ProviderInstanceId.make("claudeAgent"),
        displayName: "Claude FAR",
        notice: "Sign-in expired.",
        listedInNotices: false,
      },
    ]);
  });
});

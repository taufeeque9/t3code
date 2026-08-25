import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CodexSettings, ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  codexWindowLabel,
  makeCodexLimitsEnvironment,
  normalizeClaudeBuckets,
  normalizeCodexBuckets,
  ProviderLimitsProbeError,
  readProviderLimitsSnapshot,
  type LimitProbeResult,
  type ProviderLimitsReaders,
} from "./ProviderLimitsService.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

const availableResult = (accountLabel: string): LimitProbeResult => ({
  accountLabel,
  plan: "test",
  available: true,
  buckets: [],
});

describe("ProviderLimitsService", () => {
  it("normalizes Claude structured session, weekly, and model limits", () => {
    expect(
      normalizeClaudeBuckets({
        limits: [
          { kind: "session", percent: 14, resets_at: "2026-08-25T12:00:00Z" },
          { kind: "weekly_all", percent: 63, resets_at: "2026-08-28T16:00:00Z" },
          {
            kind: "weekly_scoped",
            percent: 95,
            resets_at: "2026-08-28T16:00:00Z",
            scope: { model: { display_name: "Fable" } },
          },
        ],
      }),
    ).toEqual([
      {
        id: "session:0",
        label: "5-hour session",
        usedPercent: 14,
        resetsAt: "2026-08-25T12:00:00Z",
      },
      {
        id: "weekly_all:1",
        label: "Weekly",
        usedPercent: 63,
        resetsAt: "2026-08-28T16:00:00Z",
      },
      {
        id: "weekly_scoped:Fable",
        label: "Weekly Fable",
        usedPercent: 95,
        resetsAt: "2026-08-28T16:00:00Z",
      },
    ]);
  });

  it("normalizes the legacy Claude usage response", () => {
    expect(
      normalizeClaudeBuckets({
        five_hour: { utilization: 8, resets_at: null },
        seven_day: { utilization: 20, resets_at: "2026-09-01T00:00:00Z" },
      }),
    ).toEqual([
      {
        id: "five_hour",
        label: "5-hour session",
        usedPercent: 8,
        resetsAt: null,
      },
      {
        id: "seven_day",
        label: "Weekly",
        usedPercent: 20,
        resetsAt: "2026-09-01T00:00:00Z",
      },
    ]);
  });

  it("names Codex rate-limit windows", () => {
    expect(codexWindowLabel(300, "Primary")).toBe("5-hour session");
    expect(codexWindowLabel(10_080, "Secondary")).toBe("Weekly");
    expect(codexWindowLabel(60, "Primary")).toBe("60-minute window");
    expect(codexWindowLabel(null, "Primary")).toBe("Primary");
  });

  it("normalizes every Codex model-specific limit", () => {
    expect(
      normalizeCodexBuckets({
        codex: {
          limitId: "codex",
          primary: { usedPercent: 4, windowDurationMins: 10_080, resetsAt: 1_788_138_429 },
        },
        codex_bengalfox: {
          limitId: "codex_bengalfox",
          limitName: "GPT-5.3-Codex-Spark",
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_787_666_518 },
          secondary: {
            usedPercent: 0,
            windowDurationMins: 10_080,
            resetsAt: 1_788_253_318,
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({ id: "codex:primary", label: "Weekly", usedPercent: 4 }),
      expect.objectContaining({
        id: "codex_bengalfox:primary",
        label: "GPT-5.3-Codex-Spark · 5-hour session",
        usedPercent: 0,
      }),
      expect.objectContaining({
        id: "codex_bengalfox:secondary",
        label: "GPT-5.3-Codex-Spark · Weekly",
        usedPercent: 0,
      }),
    ]);
  });

  it.effect("does not probe disabled providers or expose unsupported providers", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const readers: ProviderLimitsReaders<never> = {
        claude: () =>
          Effect.sync(() => {
            calls.push("claude");
            return availableResult("claude@example.com");
          }),
        codex: () =>
          Effect.sync(() => {
            calls.push("codex");
            return availableResult("codex@example.com");
          }),
      };
      const snapshot = yield* readProviderLimitsSnapshot({
        settings: decodeSettings({
          providerInstances: {
            claudeAgent: {
              driver: "claudeAgent",
              enabled: false,
              config: { enabled: true },
            },
            codex: { driver: "codex", config: { enabled: false } },
            opencode: { driver: "opencode", enabled: true, config: {} },
          },
        }),
        observedAt: "2026-08-25T00:00:00Z",
        readers,
      });

      expect(calls).toEqual([]);
      expect(snapshot.accounts.map(({ driver, status }) => ({ driver, status }))).toEqual([
        { driver: "claudeAgent", status: "unavailable" },
        { driver: "codex", status: "unavailable" },
      ]);
    }),
  );

  it.effect("keeps successful accounts when another provider probe fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* readProviderLimitsSnapshot({
        settings: decodeSettings({
          providerInstances: {
            claudeAgent: { driver: "claudeAgent", enabled: true, config: {} },
            codex: { driver: "codex", enabled: true, config: {} },
          },
        }),
        observedAt: "2026-08-25T00:00:00Z",
        readers: {
          claude: () => Effect.succeed(availableResult("claude@example.com")),
          codex: () => Effect.fail(new ProviderLimitsProbeError({ cause: "unavailable" })),
        },
      });

      expect(snapshot.accounts).toEqual([
        expect.objectContaining({
          driver: "claudeAgent",
          status: "ready",
          accountLabel: "claude@example.com",
        }),
        expect.objectContaining({ driver: "codex", status: "error" }),
      ]);
    }),
  );

  it.effect("times out a hanging provider without hanging the snapshot", () =>
    Effect.gen(function* () {
      const snapshotFiber = yield* readProviderLimitsSnapshot({
        settings: decodeSettings({
          providerInstances: {
            claudeAgent: { driver: "claudeAgent", enabled: true, config: {} },
            codex: { driver: "codex", enabled: false, config: {} },
          },
        }),
        observedAt: "2026-08-25T00:00:00Z",
        readers: {
          claude: () => Effect.never,
          codex: () => Effect.succeed(availableResult("codex@example.com")),
        },
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      yield* Effect.yieldNow;
      const snapshot = yield* Fiber.join(snapshotFiber);

      expect(snapshot.accounts).toEqual([
        expect.objectContaining({ driver: "claudeAgent", status: "error" }),
        expect.objectContaining({ driver: "codex", status: "unavailable" }),
      ]);
    }),
  );

  it.effect("uses a Codex shadow home for the limits process", () =>
    Effect.gen(function* () {
      const environment = yield* makeCodexLimitsEnvironment({
        config: decodeCodexSettings({
          homePath: "/shared/codex",
          shadowHomePath: "/accounts/work",
        }),
        environment: { EXISTING_VALUE: "preserved" },
      });

      expect(environment.CODEX_HOME).toBe("/accounts/work");
      expect(environment).toMatchObject({ EXISTING_VALUE: "preserved" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

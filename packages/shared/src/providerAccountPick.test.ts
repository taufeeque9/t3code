import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { pickProviderAccountByLimits, usageWindowAppliesToModel } from "./providerAccountPick.ts";

const now = Date.parse("2026-10-27T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(now + offsetMs));

const session = (usedPercent: number, resetsInMs?: number): ServerProviderUsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent,
  ...(resetsInMs === undefined ? {} : { resetsAt: at(resetsInMs) }),
});
const weekly = (
  usedPercent: number,
  resetsInMs?: number,
  id = "seven_day",
): ServerProviderUsageWindow => ({
  id,
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  ...(resetsInMs === undefined ? {} : { resetsAt: at(resetsInMs) }),
});
const account = (
  id: string,
  windows: ReadonlyArray<ServerProviderUsageWindow> | null,
  options: { unavailable?: boolean; driver?: string } = {},
) => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(options.driver ?? "claudeAgent"),
  usageLimits:
    windows === null
      ? undefined
      : ({
          checkedAt: at(-60_000),
          windows: [...windows],
          ...(options.unavailable ? { unavailable: { reason: "probeFailed" as const } } : {}),
        } satisfies ServerProviderUsageLimits),
});
const pick = (candidates: ReadonlyArray<ReturnType<typeof account>>, model = "claude-opus-5") =>
  pickProviderAccountByLimits(candidates, model, now);

describe("pickProviderAccountByLimits", () => {
  it("spends the weekly allowance that resets sooner even with less left", () => {
    expect(
      pick([
        account("a", [session(0), weekly(20, 6 * DAY)]),
        account("b", [session(0), weekly(50, DAY)]),
      ]),
    ).toBe("b");
  });

  it("excludes accounts without readings, with failed probes, or without windows", () => {
    expect(pick([account("none", null)])).toBeNull();
    expect(pick([account("failed", [weekly(10, DAY)], { unavailable: true })])).toBeNull();
    expect(pick([account("empty", [])])).toBeNull();
    expect(
      pick([
        account("none", null),
        account("failed", [weekly(10, DAY)], { unavailable: true }),
        account("ok", [weekly(60, 3 * DAY)]),
      ]),
    ).toBe("ok");
  });

  it("excludes an account with a nearly spent session or weekly window", () => {
    expect(
      pick([
        account("spent-session", [session(95, HOUR), weekly(10, DAY)]),
        account("spent-weekly", [session(0), weekly(97, DAY)]),
        account("later", [session(0), weekly(80, 5 * DAY)]),
      ]),
    ).toBe("later");
    expect(pick([account("spent", [session(99, HOUR), weekly(10, DAY)])])).toBeNull();
  });

  it("treats a window whose reset has passed as unused", () => {
    expect(
      pick([
        account("reset", [session(100, -HOUR), weekly(30, DAY)]),
        account("later", [session(0), weekly(30, 4 * DAY)]),
      ]),
    ).toBe("reset");
  });

  it("applies the model's own weekly bucket only to that model", () => {
    const fableSpent = account("fable-spent", [
      weekly(10, 2 * DAY),
      weekly(98, 2 * DAY, "seven_day_fable"),
    ]);
    const other = account("other", [weekly(40, 5 * DAY)]);
    expect(pick([fableSpent, other], "claude-fable-5")).toBe("other");
    expect(pick([fableSpent, other], "claude-opus-5")).toBe("fable-spent");
  });

  it("binds to the model bucket when it resets sooner than the shared weekly", () => {
    expect(
      pick(
        [
          account("scoped-soon", [weekly(10, 6 * DAY), weekly(50, DAY, "seven_day_fable")]),
          account("shared", [weekly(10, 3 * DAY)]),
        ],
        "claude-fable-5",
      ),
    ).toBe("scoped-soon");
  });

  it("ignores monthly spend windows", () => {
    expect(
      pick([
        account("a", [
          weekly(10, DAY),
          { id: "monthly_spend", kind: "monthly", label: "Monthly", usedPercent: 100 },
        ]),
      ]),
    ).toBe("a");
  });

  it("ranks an unknown weekly reset after a known one", () => {
    expect(pick([account("unknown", [weekly(0)]), account("known", [weekly(70, 6 * DAY)])])).toBe(
      "known",
    );
  });

  it("prefers an open session over an idle one when weekly resets tie within an hour", () => {
    expect(
      pick([
        account("idle", [session(0), weekly(10, DAY)]),
        account("open", [session(40, 2 * HOUR), weekly(60, DAY + 30 * 60_000)]),
      ]),
    ).toBe("open");
  });

  it("prefers the open session that resets sooner", () => {
    expect(
      pick([
        account("later", [session(10, 4 * HOUR), weekly(10, DAY)]),
        account("sooner", [session(60, HOUR), weekly(10, DAY)]),
      ]),
    ).toBe("sooner");
  });

  it("does not tie weekly resets more than an hour apart", () => {
    expect(
      pick([
        account("open-later", [session(40, HOUR), weekly(10, DAY + 2 * HOUR)]),
        account("idle-sooner", [session(0), weekly(10, DAY)]),
      ]),
    ).toBe("idle-sooner");
  });

  it("falls back to the most weekly quota left among tied idle accounts", () => {
    expect(
      pick([
        account("less", [session(0), weekly(70, DAY)]),
        account("more", [session(0, 3 * HOUR), weekly(20, DAY + 10 * 60_000)]),
      ]),
    ).toBe("more");
  });

  it("ranks Codex accounts by their weekly window", () => {
    const codex = { driver: "codex" };
    expect(
      pick(
        [
          account("a", [session(0), weekly(10, 5 * DAY, "secondary")], codex),
          account("b", [session(0), weekly(60, 2 * DAY, "secondary")], codex),
        ],
        "gpt-6",
      ),
    ).toBe("b");
  });
});

describe("usageWindowAppliesToModel", () => {
  const claude = ProviderDriverKind.make("claudeAgent");
  it.each([
    ["seven_day", "claude-opus-5", true],
    ["seven_day_fable", "claude-fable-5", true],
    ["seven_day_fable", "Claude-Fable-5[1m]", true],
    ["seven_day_fable", "fableish", false],
    ["seven_day_fable", "claude-opus-5", false],
  ])("%s applies to %s: %s", (id, model, expected) => {
    expect(usageWindowAppliesToModel(weekly(0, DAY, id), claude, model)).toBe(expected);
  });
});

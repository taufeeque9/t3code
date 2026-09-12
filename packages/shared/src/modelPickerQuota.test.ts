import {
  ProviderDriverKind,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  formatPickerQuota,
  resolveAccountPickerQuota,
  resolveModelPickerQuota,
} from "./modelPickerQuota.ts";

const now = Date.parse("2026-09-11T20:00:00Z");
const window = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  usedPercent: number,
): ServerProviderUsageWindow => ({
  id,
  kind,
  label: id === "seven_day_fable" ? "Weekly · Fable" : kind === "weekly" ? "Weekly" : "Session",
  usedPercent,
  resetsAt: "2026-09-12T20:00:00Z",
});
const provider = (
  driver = "claudeAgent",
  windows = [
    window("five_hour", "session", 20),
    window("seven_day", "weekly", 35),
    window("seven_day_fable", "weekly", 96),
  ],
) => ({
  driver: ProviderDriverKind.make(driver),
  usageLimits: { checkedAt: "2026-09-11T19:59:00Z", windows },
});

describe("model picker quota", () => {
  it.each(["fable", "claude-fable-5", "Claude-Fable-5[1m]"])(
    "uses the Fable weekly bucket for %s",
    (model) => {
      expect(resolveModelPickerQuota(provider(), model, now)).toEqual({
        label: "Weekly · Fable",
        remainingPercent: 4,
      });
    },
  );

  it.each(["claude-sonnet-4-6", "opus", "notfable", "fableish"])(
    "uses shared weekly quota for %s",
    (model) => {
      expect(resolveModelPickerQuota(provider(), model, now)).toEqual({
        label: "Weekly",
        remainingPercent: 65,
      });
    },
  );

  it("keeps model weekly quota separate from the account session quota", () => {
    const account = provider("claudeAgent", [
      window("five_hour", "session", 100),
      window("seven_day", "weekly", 35),
      window("seven_day_fable", "weekly", 96),
    ]);
    expect(resolveAccountPickerQuota(account, now)?.remainingPercent).toBe(0);
    expect(resolveModelPickerQuota(account, "fable", now)?.remainingPercent).toBe(4);
    expect(resolveModelPickerQuota(account, "sonnet", now)?.remainingPercent).toBe(65);
  });

  it("does not substitute shared weekly quota when Fable quota is missing", () => {
    expect(
      resolveModelPickerQuota(
        provider("claudeAgent", [window("seven_day", "weekly", 20)]),
        "fable",
        now,
      ),
    ).toBeNull();
  });

  it("ignores other model-specific buckets for non-Fable models", () => {
    expect(
      resolveModelPickerQuota(
        provider("claudeAgent", [
          window("seven_day_sonnet", "weekly", 95),
          window("seven_day", "weekly", 20),
        ]),
        "sonnet",
        now,
      )?.remainingPercent,
    ).toBe(80);
  });

  it("shows Codex weekly quota but never its session quota in the account selector", () => {
    const account = provider("codex", [
      window("primary", "session", 90),
      window("secondary", "weekly", 12),
    ]);
    expect(resolveModelPickerQuota(account, "gpt-5", now)).toEqual({
      label: "Weekly",
      remainingPercent: 88,
    });
    expect(resolveAccountPickerQuota(account, now)).toBeNull();
  });

  it("does not mislabel Codex monthly quota as weekly", () => {
    expect(
      resolveModelPickerQuota(provider("codex", [window("primary", "monthly", 10)]), "gpt-5", now),
    ).toBeNull();
  });

  it("omits unsupported providers and missing usage data", () => {
    expect(resolveModelPickerQuota(provider("cursor"), "sonnet", now)).toBeNull();
    const account = { driver: ProviderDriverKind.make("claudeAgent") };
    expect(resolveModelPickerQuota(account, "fable", now)).toBeNull();
    expect(resolveAccountPickerQuota(account, now)).toBeNull();
  });

  it("replaces expired usage with unknown until fresh data arrives", () => {
    const account = provider();
    const afterReset = Date.parse("2026-09-12T20:00:00Z");
    expect(resolveModelPickerQuota(account, "fable", afterReset)?.remainingPercent).toBeNull();
    expect(resolveAccountPickerQuota(account, afterReset)?.remainingPercent).toBeNull();
    expect(
      resolveModelPickerQuota(
        provider("claudeAgent", [
          { ...window("seven_day_fable", "weekly", 0), resetsAt: "2026-09-19T20:00:00Z" },
        ]),
        "fable",
        afterReset,
      )?.remainingPercent,
    ).toBe(100);
  });

  it("distinguishes failed probes from unsupported quota", () => {
    const account = provider();
    const usageLimits: ServerProviderUsageLimits = {
      ...account.usageLimits,
      unavailable: { reason: "probeFailed" },
    };
    expect(
      resolveModelPickerQuota({ ...account, usageLimits }, "fable", now)?.remainingPercent,
    ).toBeNull();
    expect(
      resolveModelPickerQuota(
        { ...account, usageLimits: { ...usageLimits, unavailable: { reason: "unsupported" } } },
        "fable",
        now,
      ),
    ).toBeNull();
  });

  it.each([
    { remainingPercent: 100, text: "100% left" },
    { remainingPercent: 65.5, text: "65% left" },
    { remainingPercent: 0.2, text: "<1% left" },
    { remainingPercent: 0, text: "0% left" },
    { remainingPercent: null, text: "—" },
  ])(
    "formats $remainingPercent without implying an exhausted fraction is empty",
    ({ remainingPercent, text }) => {
      expect(formatPickerQuota({ label: "Weekly", remainingPercent })).toBe(text);
    },
  );
});

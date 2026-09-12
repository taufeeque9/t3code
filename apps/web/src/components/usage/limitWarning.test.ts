import { ProviderDriverKind, ProviderInstanceId, type UsageLimitsReport } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveLimitWarning } from "./limitWarning";

const window = (id: string, label: string, usedPercent: number, resetsAt?: string) => ({
  id,
  kind: "session" as const,
  label,
  usedPercent,
  ...(resetsAt ? { resetsAt } : {}),
});

const report = (accounts: UsageLimitsReport["accounts"]): UsageLimitsReport => ({
  createdAt: "2026-09-08T00:00:00.000Z",
  accounts,
  notices: [],
});

const account = (
  id: string,
  instanceId: string,
  windows: ReadonlyArray<ReturnType<typeof window>>,
) => ({
  id,
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("claudeAgent"),
  label: id,
  displayName: `Claude ${id}`,
  limits: { windows, checkedAt: "2026-09-08T00:00:00.000Z" },
});

describe("resolveLimitWarning", () => {
  it("warns when the thread's own account crosses the threshold", () => {
    const result = resolveLimitWarning(
      report([account("a", "claude-a", [window("five_hour", "Session", 96)])]),
      "claude-a",
      "claude-fable-5",
    );
    expect(result?.windowLabel).toBe("Session");
    expect(result?.usedPercent).toBe(96);
    expect(result?.accountLabel).toBe("Claude a");
  });

  it("stays quiet below the threshold", () => {
    expect(
      resolveLimitWarning(
        report([account("a", "claude-a", [window("five_hour", "Session", 94)])]),
        "claude-a",
        "claude-fable-5",
      ),
    ).toBeNull();
  });

  it("ignores other accounts, however spent they are", () => {
    expect(
      resolveLimitWarning(
        report([
          account("a", "claude-a", [window("five_hour", "Session", 10)]),
          account("b", "claude-b", [window("five_hour", "Session", 99)]),
        ]),
        "claude-a",
        "claude-fable-5",
      ),
    ).toBeNull();
  });

  it("names the window that will bite first when several crossed", () => {
    const result = resolveLimitWarning(
      report([
        account("a", "claude-a", [
          window("five_hour", "Session", 96),
          window("seven_day", "Weekly", 99),
        ]),
      ]),
      "claude-a",
      "claude-fable-5",
    );
    expect(result?.windowLabel).toBe("Weekly");
  });

  it("keys on the reset time so a dismissal lapses when the window rolls over", () => {
    const first = resolveLimitWarning(
      report([account("a", "claude-a", [window("five_hour", "Session", 96, "2026-09-08T05:00Z")])]),
      "claude-a",
      "claude-fable-5",
    );
    const next = resolveLimitWarning(
      report([account("a", "claude-a", [window("five_hour", "Session", 96, "2026-09-08T10:00Z")])]),
      "claude-a",
      "claude-fable-5",
    );
    expect(first?.key).not.toBe(next?.key);
  });

  it("returns nothing without a report or an instance", () => {
    expect(resolveLimitWarning(null, "claude-a", "claude-fable-5")).toBeNull();
    expect(
      resolveLimitWarning(
        report([account("a", "claude-a", [window("five_hour", "Session", 99)])]),
        null,
        "claude-fable-5",
      ),
    ).toBeNull();
  });
});

const fable = (used: number) => window("seven_day_fable", "Weekly · Fable", used);
const session = (used: number) => window("five_hour", "Session", used);
const weekly = (used: number) => window("seven_day", "Weekly", used);
const warningFor = (accounts: UsageLimitsReport["accounts"], model = "claude-fable-5") =>
  resolveLimitWarning(report(accounts), "claude-a", model);

describe("model-aware availability", () => {
  it.each(["claude-sonnet-4-6", "opus", "notfable", "fableish"])(
    "hides exhausted Fable windows for %s",
    (model) => {
      expect(warningFor([account("a", "claude-a", [fable(100), session(10)])], model)).toBeNull();
    },
  );

  it.each(["claude-fable-5", "Fable", "claude-fable-5[1m]"])(
    "recognizes Fable selection %s",
    (model) => {
      expect(warningFor([account("a", "claude-a", [fable(95)])], model)?.windowLabel).toBe(
        "Weekly · Fable",
      );
    },
  );

  it("still warns on shared limits when a different model is selected", () => {
    expect(
      warningFor([account("a", "claude-a", [fable(100), session(97)])], "sonnet")?.windowLabel,
    ).toBe("Session");
  });

  it("ranks other accounts by their tightest applicable limit", () => {
    const result = warningFor([
      account("a", "claude-a", [fable(95), session(10), weekly(10)]),
      account("b", "claude-b", [fable(20), session(70), weekly(10)]),
      account("c", "claude-c", [fable(40), session(10), weekly(10)]),
      account("d", "claude-d", [fable(0), session(100), weekly(10)]),
      account("e", "claude-e", [fable(0), session(0), weekly(100)]),
    ]);
    expect(result?.availability).toBe("Fable available: Claude c (60% left), Claude b (30% left)");
  });

  it("reports no Fable anywhere only when the selected account is also exhausted", () => {
    const other = account("b", "claude-b", [fable(100)]);
    expect(warningFor([account("a", "claude-a", [fable(95)]), other])?.availability).toBe(
      "No Fable left on other accounts",
    );
    expect(warningFor([account("a", "claude-a", [fable(100)]), other])?.availability).toBe(
      "No Fable left on any account",
    );
  });

  it.each([
    { windows: [] },
    { windows: [session(20)] },
    { windows: [fable(20), window("five_hour", "Session", 100, "2026-09-07T00:00:00Z")] },
  ])("does not invent availability for incomplete or expired windows: $windows", ({ windows }) => {
    expect(
      warningFor([
        account("a", "claude-a", [fable(100), session(20)]),
        account("b", "claude-b", windows),
      ])?.availability,
    ).toBe("Fable availability on other accounts is unknown");
  });

  it("does not recommend failed probes or claim every account is exhausted", () => {
    const other = account("b", "claude-b", [fable(0)]);
    expect(
      warningFor([
        account("a", "claude-a", [fable(100)]),
        { ...other, limits: { ...other.limits, unavailable: { reason: "probeFailed" } } },
      ])?.availability,
    ).toBe("Fable availability on other accounts is unknown");
  });

  it("keeps failed sources and accounts without any probe unknown", () => {
    const snapshot = report([account("a", "claude-a", [fable(100)])]);
    expect(
      resolveLimitWarning({ ...snapshot, notices: ["Hub unavailable"] }, "claude-a", "fable")
        ?.availability,
    ).toBe("Fable availability on other accounts is unknown");
    expect(resolveLimitWarning(snapshot, "claude-a", "fable", true)?.availability).toBe(
      "Fable availability on other accounts is unknown",
    );
  });

  it("deduplicates the selected account across instances and hubs", () => {
    expect(
      warningFor([
        { ...account("a", "claude-a", [fable(100)]), email: "me@example.com" },
        { ...account("b", "claude-b", [fable(20)]), email: "ME@example.com" },
      ])?.availability,
    ).toBe("No Fable left on any account");
  });

  it("includes hub accounts and ignores other drivers", () => {
    expect(
      warningFor([
        account("a", "claude-a", [fable(100)]),
        {
          ...account("b", "claude-b", [fable(20)]),
          instanceId: undefined,
          sourceLabel: "CLI Proxy",
        },
        { ...account("c", "codex-c", [session(0)]), driver: ProviderDriverKind.make("codex") },
      ])?.availability,
    ).toBe("Fable available: Claude b (80% left)");
  });

  it("does not warn on a window after its reset passed", () => {
    expect(
      warningFor([
        account("a", "claude-a", [
          window("seven_day_fable", "Weekly · Fable", 100, "2026-09-07T00:00:00Z"),
        ]),
      ]),
    ).toBeNull();
  });

  it("allows an exhausted warning after dismissing the near-limit warning", () => {
    expect(warningFor([account("a", "claude-a", [fable(95)])])?.key).not.toBe(
      warningFor([account("a", "claude-a", [fable(100)])])?.key,
    );
  });

  it("supports shared-only limits on other providers", () => {
    expect(
      warningFor(
        [
          { ...account("a", "claude-a", [session(95)]), driver: ProviderDriverKind.make("codex") },
          { ...account("b", "claude-b", [session(20)]), driver: ProviderDriverKind.make("codex") },
        ],
        "gpt-5",
      )?.availability,
    ).toBe("Quota available: Claude b (80% left)");
  });
});

describe("duplicate account readings", () => {
  it("uses a healthy hub read when the native read failed and keeps the native name", () => {
    const native = { ...account("b", "claude-b", [fable(0)]), email: "b@example.com" };
    expect(
      warningFor([
        account("a", "claude-a", [fable(100)]),
        { ...native, limits: { ...native.limits, unavailable: { reason: "probeFailed" } } },
        {
          ...native,
          id: "hub-b",
          instanceId: undefined,
          displayName: undefined,
          label: "Hub b",
          sourceLabel: "CLI Proxy",
        },
      ])?.availability,
    ).toBe("Fable available: Claude b (100% left)");
  });

  it("uses the freshest usable duplicate regardless of report ordering", () => {
    const stale = { ...account("b", "claude-b", [fable(100)]), email: "b@example.com" };
    const fresh = {
      ...account("b-copy", "claude-b-copy", [fable(20)]),
      email: "b@example.com",
      displayName: "Claude b",
      limits: { windows: [fable(20)], checkedAt: "2026-09-08T00:01:00.000Z" },
    };
    for (const others of [
      [stale, fresh],
      [fresh, stale],
    ]) {
      expect(warningFor([account("a", "claude-a", [fable(100)]), ...others])?.availability).toBe(
        "Fable available: Claude b (80% left)",
      );
    }
  });
});

import { describe, expect, it } from "vite-plus/test";

import { resolveLimitWarning } from "./limitWarning";

const window = (id: string, label: string, usedPercent: number, resetsAt?: string) => ({
  id,
  kind: "session" as const,
  label,
  usedPercent,
  ...(resetsAt ? { resetsAt } : {}),
});

const report = (accounts: ReadonlyArray<Record<string, unknown>>) =>
  ({ accounts, notices: [] }) as never;

const account = (
  id: string,
  instanceId: string,
  windows: ReadonlyArray<ReturnType<typeof window>>,
) => ({
  id,
  instanceId,
  driver: "claudeAgent",
  label: id,
  displayName: `Claude ${id}`,
  limits: { windows, checkedAt: "2026-09-08T00:00:00.000Z" },
});

describe("resolveLimitWarning", () => {
  it("warns when the thread's own account crosses the threshold", () => {
    const result = resolveLimitWarning(
      report([account("a", "claude-a", [window("five_hour", "Session", 96)])]),
      "claude-a",
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
    );
    expect(result?.windowLabel).toBe("Weekly");
  });

  it("keys on the reset time so a dismissal lapses when the window rolls over", () => {
    const first = resolveLimitWarning(
      report([account("a", "claude-a", [window("five_hour", "Session", 96, "2026-09-08T05:00Z")])]),
      "claude-a",
    );
    const next = resolveLimitWarning(
      report([account("a", "claude-a", [window("five_hour", "Session", 96, "2026-09-08T10:00Z")])]),
      "claude-a",
    );
    expect(first?.key).not.toBe(next?.key);
  });

  it("returns nothing without a report or an instance", () => {
    expect(resolveLimitWarning(null, "claude-a")).toBeNull();
    expect(
      resolveLimitWarning(
        report([account("a", "claude-a", [window("five_hour", "Session", 99)])]),
        null,
      ),
    ).toBeNull();
  });
});

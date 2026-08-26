import { describe, expect, it } from "vite-plus/test";

import { formatCreditAmount } from "./LimitsPage.logic";

describe("formatCreditAmount", () => {
  it("formats provider credit units using their declared decimal places", () => {
    expect(formatCreditAmount(43_270, "USD", 2, "en-US")).toBe("$432.70");
    expect(formatCreditAmount(500_000, "USD", 2, "en-US")).toBe("$5,000.00");
  });

  it("handles unavailable values and unknown currencies", () => {
    expect(formatCreditAmount(null, "USD", 2, "en-US")).toBe("—");
    expect(formatCreditAmount(1_234, null, 2, "en-US")).toBe("12.34 credits");
    expect(formatCreditAmount(1_234, "not-a-currency", 2, "en-US")).toBe("12.34 not-a-currency");
  });
});

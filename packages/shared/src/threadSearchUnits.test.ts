import { describe, expect, it } from "vite-plus/test";

import { buildThreadSearchUnits, extractUrls } from "./threadSearchUnits.ts";

describe("extractUrls", () => {
  it("finds bare and markdown URLs, dropping sentence punctuation", () => {
    expect(
      extractUrls("See https://example.com/docs, and [here](https://example.com/other-page)."),
    ).toEqual(["https://example.com/docs", "https://example.com/other-page"]);
  });

  it("de-duplicates repeats and ignores non-http text", () => {
    expect(extractUrls("https://a.example/x https://a.example/x ftp://nope.example/y")).toEqual([
      "https://a.example/x",
    ]);
  });

  it("skips fragments too short to be a real target, but keeps a short real one", () => {
    expect(extractUrls("http://ab")).toEqual([]);
    expect(extractUrls("http://a.co")).toEqual(["http://a.co"]);
  });
});

describe("buildThreadSearchUnits", () => {
  const messages = [
    { role: "user", text: "Fix the  limits\npage", createdAt: "2026-09-01T00:00:00Z" },
    {
      role: "assistant",
      text: "Done. Reference: https://example.com/limits-guide and some prose after it.",
      createdAt: "2026-09-01T00:01:00Z",
    },
  ];

  it("indexes the title, user messages whole, and assistant URLs only", () => {
    const units = buildThreadSearchUnits({ title: "Limits work", messages });
    expect(units.map((unit) => [unit.kind, unit.text])).toEqual([
      ["title", "Limits work"],
      ["user-message", "Fix the limits page"],
      ["url", "https://example.com/limits-guide"],
    ]);
  });

  it("keeps assistant prose out of the index", () => {
    const units = buildThreadSearchUnits({ title: "T", messages });
    expect(units.some((unit) => unit.text.includes("some prose after it"))).toBe(false);
  });

  it("collapses whitespace so a unit is one line", () => {
    const units = buildThreadSearchUnits({
      title: "  spaced   out  ",
      messages: [{ role: "user", text: "a\n\nb\tc", createdAt: null }],
    });
    expect(units[0]?.text).toBe("spaced out");
    expect(units[1]?.text).toBe("a b c");
  });

  it("carries the source timestamp, and none for a title", () => {
    const units = buildThreadSearchUnits({ title: "T", messages });
    expect(units[0]?.createdAt).toBeNull();
    expect(units[1]?.createdAt).toBe("2026-09-01T00:00:00Z");
    expect(units[2]?.createdAt).toBe("2026-09-01T00:01:00Z");
  });

  it("omits an empty title and empty messages rather than storing blanks", () => {
    const units = buildThreadSearchUnits({
      title: "   ",
      messages: [{ role: "user", text: "  ", createdAt: null }],
    });
    expect(units).toEqual([]);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { withForkContext } from "./ProviderCommandReactor.ts";

describe("forked session prompt context", () => {
  it("adds the source-work warning without changing the visible user text", () => {
    const prompt = withForkContext("do the alternate approach", true);
    expect(prompt).toContain("The session got forked here.");
    expect(prompt).toContain("the original session will do that");
    expect(prompt).toMatch(/<t3_fork_context>.*<\/t3_fork_context>\n\ndo the alternate approach/s);
  });

  it("leaves ordinary turns unchanged", () => {
    expect(withForkContext("continue", false)).toBe("continue");
  });
});

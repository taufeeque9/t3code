import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { expect, it } from "@effect/vitest";

import { extractResearchHubLinks } from "./ResearchHubLinksQuery.ts";

const quoteWithComment = serializeAssistantCitation({
  version: 1,
  environmentId: EnvironmentId.make("environment:local"),
  threadId: ThreadId.make("thread:quoted"),
  messageId: MessageId.make("quoted-answer"),
  text: "The thresholds hold.",
  comment: "write it up in http://hub.localhost/?project=notes&path=quoted%2Fnote.md",
  start: 0,
  end: 20,
  prefix: "",
  suffix: "",
});

it("finds hub notes and studies on any host, newest mention first", () => {
  const links = extractResearchHubLinks([
    "Note: https://tf-work.tail1234.ts.net/?project=notes&path=deception%2F2026-11-08-reviews%2Fnote.md.",
    "Study [here](http://127.0.0.1:8700/?project=studies&path=nemo-rl%2Fci%2F2026-11-09-gpu-tests), see https://github.com/org/repo/pull/1?project=notes",
    "Skills: http://hub.localhost/?project=claude&path=docs%2Fk8s.md and http://hub.localhost/?project=notes",
    "Again at http://127.0.0.2/?project=notes&path=deception%2F2026-11-08-reviews%2Fnote.md&revision=working-tree",
    "Devbox: `https://hub-devbox.tail1234.ts.net/?project=studies&path=a%2Fb%2F`",
    "Escaped http://[::1]:8700/?project=studies&amp;path=trial_ and **http://hub.localhost/?project=studies&path=c**",
    "See [trial](http://hub.localhost/?project=notes&path=x%2Ftrial(2).md)。次です",
    quoteWithComment,
  ]);
  expect(links.map((link) => link.url)).toEqual([
    "http://hub.localhost/?project=notes&path=quoted%2Fnote.md",
    "http://hub.localhost/?project=notes&path=x%2Ftrial%282%29.md",
    "http://hub.localhost/?project=studies&path=c",
    "http://[::1]:8700/?project=studies&path=trial_",
    "https://hub-devbox.tail1234.ts.net/?project=studies&path=a%2Fb",
    "https://tf-work.tail1234.ts.net/?project=notes&path=deception%2F2026-11-08-reviews%2Fnote.md",
    "http://127.0.0.1:8700/?project=studies&path=nemo-rl%2Fci%2F2026-11-09-gpu-tests",
  ]);
  expect(links[1]).toMatchObject({ project: "notes", path: "x/trial(2).md" });
});

import {
  OrchestrationV2GetResearchHubLinksError,
  type OrchestrationV2GetResearchHubLinksInput,
  type OrchestrationV2GetResearchHubLinksResult,
  type OrchestrationV2ResearchHubLink,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

const PROJECTS = new Set<string>(["notes", "studies"]);
// ASCII only: prose in other scripts often follows a URL with no space between them.
const URL_PATTERN = /https?:\/\/(?:\[[0-9a-f:.]+\])?[!#-&*-;=?-Z^_a-z|~()]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?*]+$/u;

function isLoopbackHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

/** Drops punctuation and a closing parenthesis that belong to the surrounding prose or Markdown. */
function trimUrl(raw: string) {
  let url = raw.replaceAll("&amp;", "&");
  for (;;) {
    const trimmed = url.replace(TRAILING_PUNCTUATION, "");
    const unbalanced =
      trimmed.endsWith(")") && trimmed.split("(").length < trimmed.split(")").length;
    const next = unbalanced ? trimmed.slice(0, -1) : trimmed;
    if (next === url) return url;
    url = next;
  }
}

function parseResearchHubUrl(raw: string): OrchestrationV2ResearchHubLink | null {
  let url: URL;
  try {
    url = new URL(trimUrl(raw));
  } catch {
    return null;
  }
  const project = url.searchParams.get("project");
  const path = url.searchParams.get("path")?.trim().replace(/\/+$/u, "");
  if (project === null || !PROJECTS.has(project) || !path) return null;
  const query = new URLSearchParams({ project, path });
  return {
    project: project as OrchestrationV2ResearchHubLink["project"],
    path,
    url: `${url.origin}/?${query.toString()}`,
  };
}

/**
 * Hub notes and studies named by URL in `texts`, oldest text first, deduplicated by page and
 * returned newest mention first. A page seen on several hosts opens on one reachable off this
 * machine, such as its tailnet address, when any was mentioned.
 */
export function extractResearchHubLinks(
  texts: Iterable<string>,
): ReadonlyArray<OrchestrationV2ResearchHubLink> {
  const byPage = new Map<string, OrchestrationV2ResearchHubLink>();
  for (const text of texts) {
    for (const match of assistantCitationsToPlainText(text).matchAll(URL_PATTERN)) {
      const link = parseResearchHubUrl(match[0]);
      if (link === null) continue;
      const key = `${link.project}\u0000${link.path}`;
      const previous = byPage.get(key);
      byPage.delete(key);
      const keepPrevious =
        previous !== undefined &&
        isLoopbackHost(new URL(link.url).hostname) &&
        !isLoopbackHost(new URL(previous.url).hostname);
      byPage.set(key, keepPrevious ? previous : link);
    }
  }
  return [...byPage.values()].reverse();
}

export class ResearchHubLinksQuery extends Context.Service<
  ResearchHubLinksQuery,
  {
    readonly getResearchHubLinks: (
      input: OrchestrationV2GetResearchHubLinksInput,
    ) => Effect.Effect<
      OrchestrationV2GetResearchHubLinksResult,
      OrchestrationV2GetResearchHubLinksError
    >;
  }
>()("t3/orchestration-v2/ResearchHubLinksQuery") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getResearchHubLinks = Effect.fn("ResearchHubLinksQuery.getResearchHubLinks")(
    function* (input: OrchestrationV2GetResearchHubLinksInput) {
      const rows = yield* sql<{ readonly text: string | null }>`
        SELECT json_extract(payload_json, '$.text') AS text
        FROM orchestration_v2_projection_messages
        WHERE thread_id = ${input.threadId}
          AND streaming = 0
          AND (payload_json LIKE '%project_notes%' OR payload_json LIKE '%project_studies%'
            OR payload_json LIKE '%project_3Dnotes%' OR payload_json LIKE '%project_3Dstudies%')
        ORDER BY created_at, message_id`.pipe(NodeSqliteClient.readOnly);
      return {
        links: extractResearchHubLinks(rows.flatMap((row) => (row.text ? [row.text] : []))),
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetResearchHubLinksError({ threadId: input.threadId, cause }),
        ),
      ),
  );

  return ResearchHubLinksQuery.of({ getResearchHubLinks });
});

export const layer = Layer.effect(ResearchHubLinksQuery, make);

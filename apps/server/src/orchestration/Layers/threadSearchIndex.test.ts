import { ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { layer as ThreadSearchIndexLive, ThreadSearchIndexService } from "./threadSearchIndex.ts";

const searchLayer = it.layer(
  ThreadSearchIndexLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

/** Two projects so scoping has something to exclude. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json, scripts_json,
      created_at, updated_at, deleted_at
    )
    VALUES
      ('project-a', 'A', '/a', '{"provider":"codex","model":"gpt-5-codex"}', '[]',
       '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', NULL),
      ('project-b', 'B', '/b', '{"provider":"codex","model":"gpt-5-codex"}', '[]',
       '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', NULL)
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      created_at, updated_at, deleted_at
    )
    VALUES
      ('thread-a', 'project-a', 'Upstream merge notes',
       '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
       '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:10.000Z', NULL),
      ('thread-b', 'project-b', 'Unrelated thread',
       '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
       '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:11.000Z', NULL)
  `;
  yield* sql`
    INSERT INTO projection_thread_messages
      (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
    VALUES
      ('m1', 'thread-a', 't1', 'user', 'please fix the limits dashboard', 0,
       '2026-05-01T00:00:01.000Z', '2026-05-01T00:00:01.000Z'),
      ('m2', 'thread-a', 't1', 'assistant',
       'Done. See https://example.com/limits-guide for the details and more prose.', 0,
       '2026-05-01T00:00:02.000Z', '2026-05-01T00:00:02.000Z'),
      ('m3', 'thread-b', 't2', 'user', 'totally different subject', 0,
       '2026-05-01T00:00:03.000Z', '2026-05-01T00:00:03.000Z'),
      ('m4', 'thread-a', 't1', 'assistant', 'streaming half-written limits', 1,
       '2026-05-01T00:00:04.000Z', '2026-05-01T00:00:04.000Z')
  `;
});

searchLayer("indexes on first search and matches a user message", (it) =>
  it.effect("finds the thread by words from its user message", () =>
    Effect.gen(function* () {
      yield* seed;
      const index = yield* ThreadSearchIndexService;
      const result = yield* index.searchThreadUnits({ query: "limits dashboard" });
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0]?.threadId, ThreadId.make("thread-a"));
      assert.equal(result.matches[0]?.kind, "user-message");
    }),
  ),
);

searchLayer("matches a URL an assistant produced, but not its prose", (it) =>
  it.effect("indexes assistant URLs only", () =>
    Effect.gen(function* () {
      yield* seed;
      const index = yield* ThreadSearchIndexService;

      const url = yield* index.searchThreadUnits({ query: "limits-guide" });
      assert.equal(url.matches[0]?.kind, "url");
      assert.equal(url.matches[0]?.snippet, "https://example.com/limits-guide");

      // "more prose" is assistant text that is not a URL, so it is not indexed.
      const prose = yield* index.searchThreadUnits({ query: "more prose" });
      assert.deepStrictEqual(prose.matches, []);
    }),
  ),
);

searchLayer("ranks a title match above a message match", (it) =>
  it.effect("prefers the title", () =>
    Effect.gen(function* () {
      yield* seed;
      const index = yield* ThreadSearchIndexService;
      const result = yield* index.searchThreadUnits({ query: "upstream merge" });
      assert.equal(result.matches[0]?.kind, "title");
      assert.equal(result.matches[0]?.snippet, "Upstream merge notes");
    }),
  ),
);

searchLayer("scopes to one project", (it) =>
  it.effect("excludes threads outside the requested project", () =>
    Effect.gen(function* () {
      yield* seed;
      const index = yield* ThreadSearchIndexService;

      const all = yield* index.searchThreadUnits({ query: "thread" });
      assert.ok(all.matches.length >= 1);

      const scoped = yield* index.searchThreadUnits({
        query: "different subject",
        projectId: ProjectId.make("project-a"),
      });
      assert.deepStrictEqual(scoped.matches, []);

      const inScope = yield* index.searchThreadUnits({
        query: "different subject",
        projectId: ProjectId.make("project-b"),
      });
      assert.equal(inScope.matches[0]?.threadId, ThreadId.make("thread-b"));
    }),
  ),
);

searchLayer("keeps a streaming message out of the index", (it) =>
  it.effect("ignores half-written text", () =>
    Effect.gen(function* () {
      yield* seed;
      const index = yield* ThreadSearchIndexService;
      const result = yield* index.searchThreadUnits({ query: "half-written" });
      assert.deepStrictEqual(result.matches, []);
    }),
  ),
);

searchLayer("re-indexes a thread whose text changed", (it) =>
  it.effect("follows an edit past the recorded watermark", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const index = yield* ThreadSearchIndexService;
      yield* index.searchThreadUnits({ query: "limits" });

      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'now about kangaroos instead'
        WHERE message_id = 'm1'
      `;
      // Only a newer thread updated_at makes the thread stale again.
      yield* sql`
        UPDATE projection_threads
        SET updated_at = '2026-05-02T00:00:00.000Z'
        WHERE thread_id = 'thread-a'
      `;

      const stale = yield* index.searchThreadUnits({ query: "limits dashboard" });
      assert.deepStrictEqual(stale.matches, []);
      const fresh = yield* index.searchThreadUnits({ query: "kangaroos" });
      assert.equal(fresh.matches[0]?.threadId, ThreadId.make("thread-a"));
    }),
  ),
);

searchLayer("returns one row per thread", (it) =>
  it.effect("does not let a thread fill the results with its own units", () =>
    Effect.gen(function* () {
      yield* seed;
      const index = yield* ThreadSearchIndexService;
      // "limits" hits both thread-a's user message and its URL.
      const result = yield* index.searchThreadUnits({ query: "limits" });
      const threadIds = result.matches.map((match) => match.threadId);
      assert.deepStrictEqual(threadIds, [...new Set(threadIds)]);
    }),
  ),
);

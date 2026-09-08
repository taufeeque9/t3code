/**
 * The fuzzy sidebar search index.
 *
 * Units are derived from the projection, never authoritative, so the table is
 * kept in step lazily: a thread whose `updated_at` moved past its recorded
 * watermark is re-extracted when a search touches it. That keeps every
 * projection write path untouched and makes the first search after an upgrade
 * the backfill, at the cost of some work inside that first query.
 *
 * @module threadSearchIndex
 */
import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  type OrchestrationSearchThreadUnitsInput,
  type OrchestrationSearchThreadUnitsResult,
  type OrchestrationThreadSearchUnitKind,
} from "@t3tools/contracts";
import { fuzzyMatch } from "@t3tools/shared/fuzzyMatch";
import { buildThreadSearchUnits } from "@t3tools/shared/threadSearchUnits";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";

/**
 * Threads re-indexed in one search. A first run over a long history pays this
 * once; beyond the cap the remainder is picked up by the next search, so a
 * query stays responsive rather than stalling on a full backfill.
 */
const MAX_THREADS_INDEXED_PER_SEARCH = 200;

/** Candidate units scored per search. Bounds the cost of a loose query. */
const MAX_SCORED_UNITS = 20_000;

/** Ranking nudge per kind: a title is the strongest signal a thread is the one. */
const KIND_WEIGHT: Record<OrchestrationThreadSearchUnitKind, number> = {
  title: 25,
  url: 10,
  "user-message": 0,
};

const StaleThreadRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  updatedAt: Schema.String,
});

const ThreadMessageRow = Schema.Struct({
  role: Schema.String,
  text: Schema.String,
  createdAt: Schema.NullOr(IsoDateTime),
});

const UnitRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  kind: Schema.String,
  text: Schema.String,
  createdAt: Schema.NullOr(IsoDateTime),
});

const ScopeRequest = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  limit: Schema.Int,
});

const ThreadRequest = Schema.Struct({ threadId: ThreadId });

function isUnitKind(value: string): value is OrchestrationThreadSearchUnitKind {
  return value === "title" || value === "url" || value === "user-message";
}

function makeIndex(sql: SqlClient.SqlClient) {
  /**
   * Threads whose indexed watermark is missing or behind. Ordered oldest-first
   * so a capped run still makes progress on the same threads each time.
   */
  const findStaleThreads = SqlSchema.findAll({
    Request: ScopeRequest,
    Result: StaleThreadRow,
    execute: ({ projectId, limit }) => sql`
      SELECT
        threads.thread_id AS "threadId",
        threads.project_id AS "projectId",
        threads.title AS title,
        threads.updated_at AS "updatedAt"
      FROM projection_threads AS threads
      INNER JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      LEFT JOIN projection_thread_search_state AS state
        ON state.thread_id = threads.thread_id
      WHERE threads.deleted_at IS NULL
        AND projects.deleted_at IS NULL
        AND (${projectId} IS NULL OR threads.project_id = ${projectId})
        AND (state.indexed_updated_at IS NULL OR state.indexed_updated_at < threads.updated_at)
      ORDER BY threads.updated_at ASC
      LIMIT ${limit}
    `,
  });

  const findThreadMessages = SqlSchema.findAll({
    Request: ThreadRequest,
    Result: ThreadMessageRow,
    execute: ({ threadId }) => sql`
      SELECT role, text, created_at AS "createdAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND is_streaming = 0
      ORDER BY created_at ASC, message_id ASC
    `,
  });

  const findUnitsInScope = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: Schema.NullOr(ProjectId) }),
    Result: UnitRow,
    execute: ({ projectId }) => sql`
      SELECT
        units.thread_id AS "threadId",
        units.project_id AS "projectId",
        units.kind AS kind,
        units.text AS text,
        units.created_at AS "createdAt"
      FROM projection_thread_search_units AS units
      INNER JOIN projection_threads AS threads
        ON threads.thread_id = units.thread_id
      WHERE threads.deleted_at IS NULL
        AND (${projectId} IS NULL OR units.project_id = ${projectId})
      ORDER BY threads.updated_at DESC
      LIMIT ${MAX_SCORED_UNITS}
    `,
  });

  /** Replaces one thread's units and advances its watermark in a single pass. */
  const reindexThread = Effect.fn("threadSearchIndex.reindexThread")(function* (thread: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly updatedAt: string;
  }) {
    const messages = yield* findThreadMessages({ threadId: thread.threadId });
    const units = buildThreadSearchUnits({
      title: thread.title,
      messages: messages.map((message) => ({
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
      })),
    });
    yield* sql`DELETE FROM projection_thread_search_units WHERE thread_id = ${thread.threadId}`;
    for (const [index, unit] of units.entries()) {
      yield* sql`
        INSERT INTO projection_thread_search_units
          (unit_id, thread_id, project_id, kind, text, created_at)
        VALUES (
          ${`${thread.threadId}:${index}`},
          ${thread.threadId},
          ${thread.projectId},
          ${unit.kind},
          ${unit.text},
          ${unit.createdAt}
        )
      `;
    }
    yield* sql`
      INSERT INTO projection_thread_search_state (thread_id, indexed_updated_at)
      VALUES (${thread.threadId}, ${thread.updatedAt})
      ON CONFLICT(thread_id) DO UPDATE SET indexed_updated_at = excluded.indexed_updated_at
    `;
  });

  const refreshIndex = Effect.fn("threadSearchIndex.refresh")(function* (
    projectId: ProjectId | null,
  ) {
    const stale = yield* findStaleThreads({
      projectId,
      limit: MAX_THREADS_INDEXED_PER_SEARCH,
    });
    for (const thread of stale) {
      yield* reindexThread(thread);
    }
    return stale.length;
  });

  /**
   * Fuzzy-ranks indexed units, keeping the best unit per thread so one verbose
   * thread cannot fill the results with its own messages.
   */
  const searchThreadUnits = Effect.fn("threadSearchIndex.searchThreadUnits")(function* (
    input: OrchestrationSearchThreadUnitsInput,
  ) {
    const projectId = input.projectId ?? null;
    yield* refreshIndex(projectId);
    const rows = yield* findUnitsInScope({ projectId });

    const bestByThread = new Map<string, OrchestrationSearchThreadUnitsResult["matches"][number]>();
    for (const row of rows) {
      if (!isUnitKind(row.kind)) continue;
      const match = fuzzyMatch(input.query, row.text);
      if (match.score === 0) continue;
      const score = match.score + KIND_WEIGHT[row.kind];
      const previous = bestByThread.get(row.threadId);
      if (previous && previous.score >= score) continue;
      bestByThread.set(row.threadId, {
        threadId: row.threadId,
        projectId: row.projectId,
        kind: row.kind,
        snippet: row.text,
        score,
        unitCreatedAt: row.createdAt,
      });
    }

    const matches = [...bestByThread.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, input.limit ?? 50);
    return { matches };
  });

  return { searchThreadUnits, refreshIndex };
}

/**
 * Its own service rather than a method on `ProjectionSnapshotQuery`: that shape
 * is stubbed by a dozen upstream tests, and widening it would make every one of
 * them a fork-owned edit.
 */
export class ThreadSearchIndexService extends Context.Service<
  ThreadSearchIndexService,
  {
    readonly searchThreadUnits: (
      input: OrchestrationSearchThreadUnitsInput,
    ) => Effect.Effect<OrchestrationSearchThreadUnitsResult, ProjectionRepositoryError>;
  }
>()("t3/orchestration/Layers/threadSearchIndex/ThreadSearchIndexService") {}

export const layer = Layer.effect(
  ThreadSearchIndexService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const index = makeIndex(sql);
    return ThreadSearchIndexService.of({
      searchThreadUnits: (input) =>
        index
          .searchThreadUnits(input)
          .pipe(
            Effect.mapError((cause): ProjectionRepositoryError =>
              Schema.isSchemaError(cause)
                ? toPersistenceDecodeError("ThreadSearchIndex.searchThreadUnits:decodeRows")(cause)
                : toPersistenceSqlError("ThreadSearchIndex.searchThreadUnits:query")(cause),
            ),
          ),
    });
  }),
);

export const layerTest = Layer.succeed(
  ThreadSearchIndexService,
  ThreadSearchIndexService.of({ searchThreadUnits: () => Effect.succeed({ matches: [] }) }),
);

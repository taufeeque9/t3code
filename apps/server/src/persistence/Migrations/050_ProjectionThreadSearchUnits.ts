import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One derived row per searchable unit: a thread title, an assistant URL, or a user message.
 * `projection_thread_search_state` records each thread's last indexed `updated_at`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_search_units (
      unit_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_thread_search_units_thread
    ON projection_thread_search_units (thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_thread_search_units_project
    ON projection_thread_search_units (project_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_search_state (
      thread_id TEXT PRIMARY KEY,
      indexed_updated_at TEXT NOT NULL
    )
  `;
});

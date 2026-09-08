import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * One row per searchable unit — a thread title, a URL seen in an assistant
 * message, or a user message. Fuzzy matching runs per row, so a match can never
 * span two units: that boundary is what keeps a loose query from stitching the
 * end of one message to the start of the next.
 *
 * Rows are derived, never authoritative. `projection_thread_search_state`
 * records the thread `updated_at` each thread was last indexed at, so a stale
 * thread is re-extracted on demand and the table needs no backfill of its own.
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

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { transferClaudeSessionHistory } from "./ClaudeSessionHistory.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-transfer-" });
  const sourceProjectsPath = path.join(root, "source");
  const targetProjectsPath = path.join(root, "target");
  const project = "-synthetic-project";
  const nativeSessionId = "session-123";
  yield* fs.makeDirectory(path.join(sourceProjectsPath, project), { recursive: true });
  yield* fs.makeDirectory(path.join(targetProjectsPath, project), { recursive: true });
  return {
    fs,
    path,
    sourceProjectsPath,
    targetProjectsPath,
    project,
    nativeSessionId,
    sourceTranscript: path.join(sourceProjectsPath, project, `${nativeSessionId}.jsonl`),
    targetTranscript: path.join(targetProjectsPath, project, `${nativeSessionId}.jsonl`),
  };
});

it.layer(NodeServices.layer)("ClaudeSessionHistory", (it) => {
  it.effect(
    "copies the complete transcript and nested subagent history without touching other sessions",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const transcript = new TextEncoder().encode(
          '{"type":"user","message":"first"}\n' +
            '{"type":"assistant","thinking":"完整 reasoning","tool_use":{"input":"\\u0000"}}\n' +
            '{"type":"tool_result","content":"all output"}\n',
        );
        yield* f.fs.writeFile(f.sourceTranscript, transcript);
        const sourceSubagent = f.path.join(
          f.sourceProjectsPath,
          f.project,
          f.nativeSessionId,
          "subagents",
          "agent-456.jsonl",
        );
        yield* f.fs.makeDirectory(f.path.dirname(sourceSubagent), { recursive: true });
        yield* f.fs.writeFileString(sourceSubagent, "full subagent transcript\n");
        const unrelated = f.path.join(f.targetProjectsPath, f.project, "other-session.jsonl");
        yield* f.fs.writeFileString(unrelated, "unrelated session");
        yield* f.fs.writeFileString(f.targetTranscript, "outdated destination");

        yield* transferClaudeSessionHistory(f);

        expect(Array.from(yield* f.fs.readFile(f.targetTranscript))).toEqual(
          Array.from(transcript),
        );
        expect(
          yield* f.fs.readFileString(
            f.path.join(
              f.targetProjectsPath,
              f.project,
              f.nativeSessionId,
              "subagents",
              "agent-456.jsonl",
            ),
          ),
        ).toBe("full subagent transcript\n");
        expect(yield* f.fs.readFileString(unrelated)).toBe("unrelated session");
      }),
  );

  it.effect(
    "replaces the old account's transcript with the full updated session on switchback",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const initial = '{"message":"initial history"}\n';
        const updated = `${initial}{"message":"new account turn","thinking":"retained"}\n`;
        yield* f.fs.writeFileString(f.sourceTranscript, initial);
        yield* transferClaudeSessionHistory(f);
        yield* f.fs.writeFileString(f.targetTranscript, updated);
        yield* transferClaudeSessionHistory({
          sourceProjectsPath: f.targetProjectsPath,
          targetProjectsPath: f.sourceProjectsPath,
          nativeSessionId: f.nativeSessionId,
        });
        expect(yield* f.fs.readFileString(f.sourceTranscript)).toBe(updated);
      }),
  );

  it.effect("does nothing when both paths resolve to the same store, including symlinks", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const link = f.path.join(f.path.dirname(f.sourceProjectsPath), "shared-link");
      yield* f.fs.symlink(f.sourceProjectsPath, link);
      yield* transferClaudeSessionHistory({
        sourceProjectsPath: f.sourceProjectsPath,
        targetProjectsPath: link,
        nativeSessionId: "not-present",
      });
      expect(yield* f.fs.readDirectory(f.path.join(f.sourceProjectsPath, f.project))).toEqual([]);
    }),
  );

  it.effect("fails clearly for a missing session instead of creating an empty transcript", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const error = yield* transferClaudeSessionHistory(f).pipe(Effect.flip);
      expect(error._tag).toBe("ClaudeSessionHistoryError");
      expect(error.message).toContain("was not found");
      expect(yield* f.fs.exists(f.targetTranscript)).toBe(false);
    }),
  );

  it.effect("refuses ambiguous native IDs across project directories", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(f.sourceTranscript, "first history");
      const otherProject = f.path.join(f.sourceProjectsPath, "other-project");
      yield* f.fs.makeDirectory(otherProject);
      yield* f.fs.writeFileString(
        f.path.join(otherProject, `${f.nativeSessionId}.jsonl`),
        "second history",
      );
      const error = yield* transferClaudeSessionHistory(f).pipe(Effect.flip);
      expect(error.message).toContain("multiple transcripts");
      expect(yield* f.fs.exists(f.targetTranscript)).toBe(false);
    }),
  );

  it.effect("reports filesystem failures and preserves the destination transcript", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(f.sourceTranscript, "new history");
      yield* f.fs.writeFileString(f.targetTranscript, "old history");
      yield* f.fs.makeDirectory(f.path.join(f.sourceProjectsPath, f.project, f.nativeSessionId));
      yield* f.fs.writeFileString(
        f.path.join(f.targetProjectsPath, f.project, f.nativeSessionId),
        "obstructing file",
      );
      const error = yield* transferClaudeSessionHistory(f).pipe(Effect.flip);
      expect(error.message).toContain("Failed to transfer");
      expect(error.cause).toBeDefined();
      expect(yield* f.fs.readFileString(f.targetTranscript)).toBe("old history");
    }),
  );
});

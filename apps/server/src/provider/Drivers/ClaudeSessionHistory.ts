import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class ClaudeSessionHistoryError extends Schema.TaggedError<ClaudeSessionHistoryError>()(
  "ClaudeSessionHistoryError",
  {
    nativeSessionId: Schema.String,
    sourceProjectsPath: Schema.String,
    targetProjectsPath: Schema.String,
    reason: Schema.Literals(["invalid_input", "missing", "ambiguous", "filesystem"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "invalid_input":
        return "Claude session transfer requires absolute transcript roots and a native session ID.";
      case "missing":
        return `Claude native session ${this.nativeSessionId} was not found in ${this.sourceProjectsPath}.`;
      case "ambiguous":
        return `Claude native session ${this.nativeSessionId} has multiple transcripts in ${this.sourceProjectsPath}.`;
      case "filesystem":
        return `Failed to transfer Claude native session ${this.nativeSessionId} from ${this.sourceProjectsPath} to ${this.targetProjectsPath}.`;
    }
  }
}

const isClaudeSessionHistoryError = Schema.is(ClaudeSessionHistoryError);

/** Transfer a native session before resuming it with another Claude account. */
export const transferClaudeSessionHistory = Effect.fn("transferClaudeSessionHistory")(
  function* (input: {
    readonly sourceProjectsPath: string;
    readonly targetProjectsPath: string;
    readonly nativeSessionId: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { sourceProjectsPath, targetProjectsPath, nativeSessionId } = input;
    if (
      !path.isAbsolute(sourceProjectsPath) ||
      !path.isAbsolute(targetProjectsPath) ||
      !/^[a-zA-Z0-9_-]+$/.test(nativeSessionId)
    ) {
      return yield* new ClaudeSessionHistoryError({
        ...input,
        reason: "invalid_input",
      });
    }
    if (path.resolve(sourceProjectsPath) === path.resolve(targetProjectsPath)) return;

    yield* Effect.gen(function* () {
      const sourceRoot = yield* fs.realPath(sourceProjectsPath);
      const targetRoot = yield* fs
        .exists(targetProjectsPath)
        .pipe(
          Effect.flatMap((exists) =>
            exists ? fs.realPath(targetProjectsPath) : Effect.succeed(targetProjectsPath),
          ),
        );
      if (sourceRoot === targetRoot) return;

      const transcriptName = `${nativeSessionId}.jsonl`;
      const matches: string[] = [];
      for (const project of yield* fs.readDirectory(sourceRoot)) {
        const projectPath = path.join(sourceRoot, project);
        if ((yield* fs.stat(projectPath)).type !== "Directory") continue;
        const transcript = path.join(projectPath, transcriptName);
        if (!(yield* fs.exists(transcript))) continue;
        if ((yield* fs.stat(transcript)).type === "File") matches.push(project);
      }
      if (matches.length !== 1) {
        return yield* new ClaudeSessionHistoryError({
          ...input,
          reason: matches.length === 0 ? "missing" : "ambiguous",
        });
      }
      const project = matches[0]!;
      const sourceProject = path.join(sourceRoot, project);
      const targetProject = path.join(targetRoot, project);
      yield* fs.makeDirectory(targetProject, { recursive: true });
      const sourceSessionDirectory = path.join(sourceProject, nativeSessionId);
      if (yield* fs.exists(sourceSessionDirectory)) {
        yield* fs.copy(sourceSessionDirectory, path.join(targetProject, nativeSessionId), {
          overwrite: true,
          preserveTimestamps: true,
        });
      }
      // Publish the transcript only after the ancillary session files are available.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const temporaryTranscript = yield* fs.makeTempFileScoped({
            directory: targetProject,
            prefix: "claude-session-",
          });
          yield* fs.copyFile(path.join(sourceProject, transcriptName), temporaryTranscript);
          yield* fs.rename(temporaryTranscript, path.join(targetProject, transcriptName));
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isClaudeSessionHistoryError(cause)
          ? cause
          : new ClaudeSessionHistoryError({
              ...input,
              reason: "filesystem",
              cause,
            }),
      ),
    );
  },
);

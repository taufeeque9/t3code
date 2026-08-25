import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
  ): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    const projectsPath = path.join(resolvedHomePath, "projects");
    const targetProjectsPath = yield* fileSystem.readLink(projectsPath).pipe(
      Effect.map((target) => path.resolve(path.dirname(projectsPath), target)),
      Effect.orElseSucceed(() => projectsPath),
    );
    // realPath rejects dangling links, so canonicalize their nearest existing ancestor.
    let candidatePath = targetProjectsPath;
    const missingSegments: string[] = [];
    while (true) {
      const canonicalPath = yield* Effect.option(fileSystem.realPath(candidatePath));
      if (Option.isSome(canonicalPath)) {
        const canonicalProjectsPath = path.join(
          canonicalPath.value,
          ...missingSegments.toReversed(),
        );
        return `claude:projects:${canonicalProjectsPath}`;
      }
      const parentPath = path.dirname(candidatePath);
      if (parentPath === candidatePath) {
        return `claude:projects:${targetProjectsPath}`;
      }
      missingSegments.push(path.basename(candidatePath));
      candidatePath = parentPath;
    }
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

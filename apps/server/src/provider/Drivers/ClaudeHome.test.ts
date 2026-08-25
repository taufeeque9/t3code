import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps environment/cache keys with it", () =>
      Effect.gen(function* () {
        const homePath = "~/.claude-work";
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("canonicalizes the existing prefix of a missing transcript store", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-claude-home-",
        });
        const canonicalHomePath = yield* fileSystem.realPath(homePath);

        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(
          `claude:projects:${path.join(canonicalHomePath, "projects")}`,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same transcript store", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedProjects = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-claude-projects-",
        });
        const firstHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-claude-first-",
        });
        const secondHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-claude-second-",
        });
        yield* fileSystem.symlink(sharedProjects, path.join(firstHome, "projects"));
        yield* fileSystem.symlink(sharedProjects, path.join(secondHome, "projects"));

        const firstKey = yield* makeClaudeContinuationGroupKey({ homePath: firstHome });
        const secondKey = yield* makeClaudeContinuationGroupKey({ homePath: secondHome });
        const canonicalProjects = yield* fileSystem.realPath(sharedProjects);

        expect(firstKey).toBe(`claude:projects:${canonicalProjects}`);
        expect(secondKey).toBe(firstKey);
      }),
    );

    it.effect("keeps dangling links to the same future transcript store compatible", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-claude-shared-",
        });
        const sharedProjects = path.join(sharedRoot, "future", "projects");
        const firstHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-claude-first-",
        });
        const secondHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-claude-second-",
        });
        yield* fileSystem.symlink(sharedProjects, path.join(firstHome, "projects"));
        yield* fileSystem.symlink(sharedProjects, path.join(secondHome, "projects"));

        const firstKey = yield* makeClaudeContinuationGroupKey({ homePath: firstHome });
        const secondKey = yield* makeClaudeContinuationGroupKey({ homePath: secondHome });
        const canonicalRoot = yield* fileSystem.realPath(sharedRoot);

        expect(firstKey).toBe(`claude:projects:${path.join(canonicalRoot, "future", "projects")}`);
        expect(secondKey).toBe(firstKey);
      }),
    );

    it.effect("separates instances backed by different transcript stores", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const firstHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-claude-first-",
        });
        const secondHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-claude-second-",
        });
        yield* fileSystem.makeDirectory(path.join(firstHome, "projects"));
        yield* fileSystem.makeDirectory(path.join(secondHome, "projects"));

        const firstKey = yield* makeClaudeContinuationGroupKey({ homePath: firstHome });
        const secondKey = yield* makeClaudeContinuationGroupKey({ homePath: secondHome });

        expect(firstKey).not.toBe(secondKey);
      }),
    );
  });
});

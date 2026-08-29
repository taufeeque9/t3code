import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

it.layer(NodeServices.layer)("custom app updater", (it) => {
  it.effect("does not query session storage in after-app-exit mode", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const updaterScript = path.join(import.meta.dirname, "update-installed-app.sh");
        const fixtureDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-custom-updater-",
        });
        const binDirectory = path.join(fixtureDirectory, "bin");
        const repositoryDirectory = path.join(fixtureDirectory, "repo");
        const stateDirectory = path.join(fixtureDirectory, "state");
        const databasePath = path.join(fixtureDirectory, "state.sqlite");
        const runtimeStatePath = path.join(fixtureDirectory, "server-runtime.json");
        const sqliteInvocationPath = path.join(fixtureDirectory, "sqlite-invoked");
        const desiredCommit = "77aab3ebb9ff5a0126c588cc4711225bb71dce6f";

        yield* fs.makeDirectory(binDirectory, { recursive: true });
        yield* fs.makeDirectory(repositoryDirectory, { recursive: true });
        yield* fs.makeDirectory(
          path.join(stateDirectory, "builds", desiredCommit, "T3 Code Custom.app"),
          { recursive: true },
        );
        yield* fs.writeFileString(path.join(stateDirectory, "built-commit"), `${desiredCommit}\n`);
        yield* fs.writeFileString(databasePath, "database is unavailable during shutdown");
        yield* fs.writeFileString(runtimeStatePath, "{}");

        const gitStub = path.join(binDirectory, "git");
        yield* fs.writeFileString(
          gitStub,
          `#!/bin/bash
case "$*" in
  *"ls-remote origin refs/heads/custom"*) printf '%s refs/heads/custom\\n' "${desiredCommit}" ;;
  *"status --porcelain"*) ;;
  *"branch --show-current"*) printf 'custom\\n' ;;
  *"fetch origin custom"*|*"merge --ff-only origin/custom"*) ;;
  *) exit 1 ;;
esac
`,
        );
        yield* fs.chmod(gitStub, 0o755);

        const sqliteStub = path.join(binDirectory, "sqlite3");
        yield* fs.writeFileString(
          sqliteStub,
          `#!/bin/bash
touch "$T3_TEST_SQLITE_INVOCATION"
exit 14
`,
        );
        yield* fs.chmod(sqliteStub, 0o755);

        const updater = yield* spawner.spawn(
          ChildProcess.make("/bin/bash", [updaterScript, "--after-app-exit"], {
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
              T3_TEST_SQLITE_INVOCATION: sqliteInvocationPath,
              T3CODE_CUSTOM_REPO: repositoryDirectory,
              T3CODE_CUSTOM_UPDATER_HOME: stateDirectory,
              T3CODE_CUSTOM_DATABASE: databasePath,
              T3CODE_CUSTOM_RUNTIME_STATE: runtimeStatePath,
            },
          }),
        );
        const stdout = yield* updater.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (output, chunk) => output + chunk,
          ),
        );

        assert.equal(Number(yield* updater.exitCode), 0);
        assert.include(stdout, "The quit trigger fired while T3 is still running");
        assert.isFalse(yield* fs.exists(sqliteInvocationPath));
      }),
    ),
  );
});

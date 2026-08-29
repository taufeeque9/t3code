import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

it.layer(NodeServices.layer)("custom app updater", (it) => {
  it.effect("installs the staged app after exit without Git or session storage", () =>
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
        const destinationPath = path.join(fixtureDirectory, "Applications", "T3 Code Custom.app");
        const gitInvocationPath = path.join(fixtureDirectory, "git-invoked");
        const sqliteInvocationPath = path.join(fixtureDirectory, "sqlite-invoked");
        const restartInvocationPath = path.join(fixtureDirectory, "restart-invoked");
        const desiredCommit = "77aab3ebb9ff5a0126c588cc4711225bb71dce6f";
        const stagedApp = path.join(stateDirectory, "builds", desiredCommit, "T3 Code Custom.app");

        yield* fs.makeDirectory(binDirectory, { recursive: true });
        yield* fs.makeDirectory(repositoryDirectory, { recursive: true });
        yield* fs.makeDirectory(stagedApp, { recursive: true });
        yield* fs.makeDirectory(destinationPath, { recursive: true });
        yield* fs.writeFileString(path.join(stateDirectory, "built-commit"), `${desiredCommit}\n`);
        yield* fs.writeFileString(path.join(stagedApp, "version.txt"), "new");
        yield* fs.writeFileString(path.join(destinationPath, "version.txt"), "old");
        yield* fs.writeFileString(databasePath, "database is unavailable during shutdown");

        const gitStub = path.join(binDirectory, "git");
        yield* fs.writeFileString(
          gitStub,
          `#!/bin/bash
touch "$T3_TEST_GIT_INVOCATION"
exit 14
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

        const osascriptStub = path.join(binDirectory, "osascript");
        yield* fs.writeFileString(osascriptStub, "#!/bin/bash\nprintf 'false\\n'\n");
        yield* fs.chmod(osascriptStub, 0o755);

        const dittoStub = path.join(binDirectory, "ditto");
        yield* fs.writeFileString(dittoStub, '#!/bin/bash\nmkdir -p "$2"\ncp -R "$1"/. "$2"/\n');
        yield* fs.chmod(dittoStub, 0o755);

        const codesignStub = path.join(binDirectory, "codesign");
        yield* fs.writeFileString(codesignStub, "#!/bin/bash\nexit 0\n");
        yield* fs.chmod(codesignStub, 0o755);

        const openStub = path.join(binDirectory, "open");
        yield* fs.writeFileString(openStub, '#!/bin/bash\ntouch "$T3_TEST_RESTART_INVOCATION"\n');
        yield* fs.chmod(openStub, 0o755);

        const updater = yield* spawner.spawn(
          ChildProcess.make("/bin/bash", [updaterScript, "--after-app-exit"], {
            stdout: "pipe",
            stderr: "pipe",
            env: {
              ...process.env,
              PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
              T3_TEST_GIT_INVOCATION: gitInvocationPath,
              T3_TEST_SQLITE_INVOCATION: sqliteInvocationPath,
              T3_TEST_RESTART_INVOCATION: restartInvocationPath,
              T3CODE_CUSTOM_REPO: repositoryDirectory,
              T3CODE_CUSTOM_UPDATER_HOME: stateDirectory,
              T3CODE_CUSTOM_DATABASE: databasePath,
              T3CODE_CUSTOM_RUNTIME_STATE: runtimeStatePath,
              T3CODE_CUSTOM_DESTINATION: destinationPath,
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
        assert.include(stdout, `Installed T3 Code Custom at ${desiredCommit.slice(0, 12)}`);
        assert.include(stdout, "Restarted T3 Code Custom");
        assert.equal(yield* fs.readFileString(path.join(destinationPath, "version.txt")), "new");
        assert.equal(
          yield* fs.readFileString(path.join(stateDirectory, "installed-commit")),
          `${desiredCommit}\n`,
        );
        assert.isFalse(yield* fs.exists(gitInvocationPath));
        assert.isFalse(yield* fs.exists(sqliteInvocationPath));
        assert.isTrue(yield* fs.exists(restartInvocationPath));
      }),
    ),
  );
});

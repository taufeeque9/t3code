import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type ClientSettingsPatch,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "./DesktopClientSettings.ts";

const clientSettings: ClientSettings = {
  ...DEFAULT_CLIENT_SETTINGS,
  notificationMode: "notifications-and-sound",
  inAppNotificationsEnabled: true,
  appearanceContrast: 100,
  browserDefaultViewport: { _tag: "preset", width: 1024, height: 600, presetId: "nest-hub" },
  browserDefaultZoomFactor: 1.25,
  browserDefaultAppearance: "dark",
  browserRecordingFrameRate: 60,
  browserLinkTarget: "app",
  browserAutoShowFloatingPreview: false,
  browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
  browserDefaultProfileId: "work",
  confirmQuit: "double-click",
  confirmThreadArchive: true,
  confirmThreadDelete: false,
  confirmThreadUnpin: false,
  diffFilesCollapsed: true,
  diffIgnoreWhitespace: true,
  diffLayout: "stacked",
  environmentIdentificationMode: "artwork",
  favorites: [],
  fontFamilyCode: "",
  fontFamilyComposer: "",
  fontFamilySans: "",
  fontFamilyTerminal: "",
  fontSizeCode: 13,
  fontSizeInterface: 16,
  fontSizePrompt: 14,
  fontSizeTerminal: 12,
  fontSmoothing: true,
  glassOpacity: 80,
  onboardingCompletedAt: null,
  panelAnimationDurationMs: 0,
  proactivePanelsEnabled: true,
  showSkillsInSlashMenu: false,
  persistComposerContextStrip: true,
  providerModelPreferences: {},
  sidebarProjectGroupingMode: "repository_path",
  sidebarProjectGroupingOverrides: {
    "environment-1:/tmp/project-a": "separate",
  },
  sidebarProjectSortOrder: "manual",
  sidebarThreadSortOrder: "created_at",
  boringSidebarEnabled: false,
  boringSidebarMultilineRows: false,
  threadDetailsUsageEnabled: false,
  threadDetailsItems: {},
  sidebarWorkingShelfEnabled: false,
  loadBalancingEnabled: false,
  loadBalancingWeights: { "environment-1": 75, "environment-2": 0 },
  pullRequestMergeMethodOverrides: {},
  timestampFormat: "24-hour",
  wordWrap: true,
};

const decodeClientSettingsJson = Schema.decodeEffect(Schema.fromJsonString(ClientSettingsSchema));
function layer(baseDir: string) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        DesktopConfig.layerTest({ T3CODE_HOME: baseDir }),
      ),
    ),
  );

  return DesktopClientSettings.layer.pipe(
    Layer.provideMerge(layerEnvironment),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
}

const withClientSettings = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopClientSettings.DesktopClientSettings>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-client-settings-test-",
    });
    return yield* effect.pipe(Effect.provide(layer(baseDir)));
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

/**
 * The service on a scripted watch backend. `touch` reports an event 1 ms of test time later, and
 * `settle` passes the debounce and waits for the read it triggers. Work a clock wake starts runs
 * before `TestClock.adjust` returns, so call counts read right after an adjust are exact.
 */
const watchClientSettings = Effect.fn("test.watchClientSettings")(function* (options: {
  readonly directories: ReadonlyArray<string>;
  readonly armed: number;
  readonly failFirstWatchOf?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const reads = yield* Queue.unbounded<void>();
  const registered = yield* Queue.unbounded<string>();
  const changes = yield* Queue.unbounded<ClientSettings>();
  const events = new Map<string, Queue.Queue<FileSystem.WatchEvent>>();
  for (const directory of options.directories) {
    events.set(directory, yield* Queue.unbounded<FileSystem.WatchEvent>());
  }
  const readStarted = yield* Queue.unbounded<void>();
  const calls = { readFileString: 0, readLink: 0, makeDirectory: 0 };
  let heldRead: Deferred.Deferred<void> | undefined;
  const settings = yield* DesktopClientSettings.make.pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.FileSystem.of({
        ...fileSystem,
        readFileString: (filePath, encoding) =>
          Effect.suspend(() => {
            calls.readFileString += 1;
            const gate = heldRead;
            heldRead = undefined;
            const read = fileSystem.readFileString(filePath, encoding);
            return (
              gate === undefined
                ? read
                : Queue.offer(readStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(gate)),
                    Effect.andThen(read),
                  )
            ).pipe(Effect.ensuring(Queue.offer(reads, undefined)));
          }),
        readLink: (linkPath) =>
          Effect.suspend(() => {
            calls.readLink += 1;
            return fileSystem.readLink(linkPath);
          }),
        makeDirectory: (directory, makeOptions) =>
          Effect.suspend(() => {
            calls.makeDirectory += 1;
            return fileSystem.makeDirectory(directory, makeOptions);
          }),
      }),
    ),
  );
  let failWatch = options.failFirstWatchOf;
  yield* settings.externalChanges.pipe(
    Stream.runForEach((changed) => Queue.offer(changes, changed)),
    Effect.provideService(FileSystem.WatchBackend, {
      register: (directory) => {
        const started = Stream.fromEffect(Queue.offer(registered, directory)).pipe(Stream.drain);
        const queue = events.get(directory);
        if (queue === undefined) return Option.some(Stream.concat(started, Stream.never));
        if (failWatch !== directory) {
          return Option.some(Stream.concat(started, Stream.fromQueue(queue)));
        }
        failWatch = undefined;
        const failure = PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: "watch",
          pathOrDescriptor: directory,
        });
        return Option.some(
          Stream.concat(
            started,
            Stream.fromQueue(queue).pipe(Stream.mapEffect(() => Effect.fail(failure))),
          ),
        );
      },
    }),
    Effect.forkScoped,
  );
  yield* Queue.take(reads);
  const armed = Effect.fn("test.armed")(function* (count: number) {
    const directories: Array<string> = [];
    for (let index = 0; index < count; index++) directories.push(yield* Queue.take(registered));
    return directories.toSorted();
  });
  yield* armed(options.armed);

  return {
    settings,
    changes,
    armed,
    calls,
    awaitRead: Queue.take(reads),
    /** The next file read reports `readStarted` and waits for `gate` before reading. */
    holdNextRead: (gate: Deferred.Deferred<void>) => {
      heldRead = gate;
    },
    readStarted,
    touch: Effect.fn("test.touch")(function* (filePath: string) {
      const queue = events.get(path.dirname(filePath));
      assert.isDefined(queue);
      yield* Effect.sleep("1 millis").pipe(
        Effect.andThen(Queue.offer(queue, { _tag: "Update", path: path.basename(filePath) })),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 millis");
    }),
    settle: TestClock.adjust(DesktopClientSettings.EXTERNAL_CHANGE_DEBOUNCE).pipe(
      Effect.andThen(Queue.take(reads)),
    ),
    patch: (patch: ClientSettingsPatch) =>
      settings.patch(patch).pipe(Effect.ensuring(Queue.take(reads))),
  };
});

const edited: ClientSettings = { ...clientSettings, timestampFormat: "12-hour" };
const editedAgain: ClientSettings = { ...clientSettings, wordWrap: false };

describe("DesktopClientSettings", () => {
  it.effect("announces an outside edit once its burst of events settles, and not before", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settingsPath = environment.clientSettingsPath;
        const watched = yield* watchClientSettings({
          directories: [environment.stateDir],
          armed: 1,
        });

        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(edited));
        yield* watched.touch(settingsPath);
        yield* watched.touch(settingsPath);
        yield* watched.touch(settingsPath);
        const settledBefore = watched.calls.readLink;
        yield* TestClock.adjust("149 millis");
        assert.equal(watched.calls.readLink, settledBefore);
        yield* TestClock.adjust("1 millis");
        assert.equal(watched.calls.readLink, settledBefore + 1);
        yield* watched.awaitRead;
        assert.deepEqual(yield* Queue.take(watched.changes), edited);

        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(editedAgain));
        yield* watched.touch(settingsPath);
        yield* watched.settle;
        assert.deepEqual(yield* Queue.take(watched.changes), editedAgain);
      }),
    ),
  );

  it.effect("stays silent for its own saves, unchanged content, and unreadable files", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settingsPath = environment.clientSettingsPath;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(clientSettings));
        const watched = yield* watchClientSettings({
          directories: [environment.stateDir],
          armed: 1,
        });
        const touchAndSettle = watched.touch(settingsPath).pipe(Effect.andThen(watched.settle));

        yield* touchAndSettle;
        yield* watched.patch({ wordWrap: false });
        yield* touchAndSettle;
        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(editedAgain, null, 4));
        yield* touchAndSettle;
        yield* fileSystem.writeFileString(settingsPath, '{"timestampFormat": ');
        yield* touchAndSettle;
        yield* fileSystem.remove(settingsPath);
        yield* touchAndSettle;
        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(edited));
        const settledBefore = watched.calls.readLink;
        yield* watched.touch(`${settingsPath}.1.temp.tmp`);
        yield* TestClock.adjust(DesktopClientSettings.EXTERNAL_CHANGE_DEBOUNCE);
        assert.equal(watched.calls.readLink, settledBefore);

        yield* touchAndSettle;
        assert.deepEqual(yield* Queue.take(watched.changes), edited);
      }),
    ),
  );

  it.effect("keeps an outside edit that a save from an older snapshot overtakes", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settingsPath = environment.clientSettingsPath;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(clientSettings));
        const watched = yield* watchClientSettings({
          directories: [environment.stateDir],
          armed: 1,
        });
        const merged: ClientSettings = { ...edited, wordWrap: false };

        // The edit lands, and the renderer saves before the edit settles.
        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(edited));
        yield* watched.touch(settingsPath);
        assert.deepEqual(yield* watched.patch({ wordWrap: false }), {
          settings: merged,
          mergedExternalEdit: true,
        });
        assert.deepEqual(
          yield* decodeClientSettingsJson(yield* fileSystem.readFileString(settingsPath)),
          merged,
        );
        yield* watched.settle;

        // The edit was announced, and the renderer saves before it refreshes.
        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(clientSettings));
        yield* watched.touch(settingsPath);
        yield* watched.settle;
        assert.deepEqual(yield* Queue.take(watched.changes), clientSettings);
        assert.deepEqual(yield* watched.patch({ timestampFormat: "12-hour" }), {
          settings: edited,
          mergedExternalEdit: false,
        });
        assert.deepEqual(
          yield* decodeClientSettingsJson(yield* fileSystem.readFileString(settingsPath)),
          edited,
        );
        yield* watched.touch(settingsPath);
        yield* watched.settle;

        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(editedAgain));
        yield* watched.touch(settingsPath);
        yield* watched.settle;
        assert.deepEqual(yield* Queue.take(watched.changes), editedAgain);
      }),
    ),
  );

  it.effect("reports an outside edit a save merges before anything was known", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.clientSettingsPath, JSON.stringify(edited));

        assert.deepEqual(yield* settings.patch({ wordWrap: false }), {
          settings: { ...edited, wordWrap: false },
          mergedExternalEdit: true,
        });
      }),
    ),
  );

  it.effect("announces an outside write of settings whose own save failed", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settingsPath = environment.clientSettingsPath;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(clientSettings));
        const watched = yield* watchClientSettings({
          directories: [environment.stateDir],
          armed: 1,
        });

        yield* fileSystem.remove(settingsPath);
        yield* fileSystem.makeDirectory(`${settingsPath}/occupied`, { recursive: true });
        const error = yield* watched.patch({ wordWrap: false }).pipe(Effect.flip);
        assert.equal(error.operation, "replace-settings-file");
        yield* fileSystem.remove(settingsPath, { recursive: true });

        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(editedAgain));
        yield* watched.touch(settingsPath);
        yield* watched.settle;
        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(edited));
        yield* watched.touch(settingsPath);
        yield* watched.settle;
        assert.deepEqual(yield* Queue.take(watched.changes), editedAgain);
        assert.deepEqual(yield* Queue.take(watched.changes), edited);
      }),
    ),
  );

  it.effect("follows a settings link to a new target", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const settingsPath = environment.clientSettingsPath;
        const first = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-settings-a-" });
        const second = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-settings-b-" });
        const firstTarget = path.join(first, "client-settings.json");
        const secondTarget = path.join(second, "client-settings.json");
        yield* fileSystem.writeFileString(firstTarget, JSON.stringify(clientSettings));
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.symlink(firstTarget, settingsPath);
        const watched = yield* watchClientSettings({
          directories: [environment.stateDir, first, second],
          armed: 2,
        });

        yield* fileSystem.writeFileString(firstTarget, JSON.stringify(edited));
        yield* watched.touch(firstTarget);
        yield* watched.settle;
        assert.deepEqual(yield* Queue.take(watched.changes), edited);

        yield* fileSystem.writeFileString(secondTarget, JSON.stringify(editedAgain));
        yield* fileSystem.remove(settingsPath);
        yield* fileSystem.symlink(secondTarget, settingsPath);
        yield* watched.touch(settingsPath);
        yield* watched.settle;
        assert.deepEqual(yield* Queue.take(watched.changes), editedAgain);
        assert.deepEqual(yield* watched.armed(1), [second]);

        yield* fileSystem.writeFileString(secondTarget, JSON.stringify(clientSettings));
        yield* watched.touch(secondTarget);
        yield* watched.settle;
        assert.deepEqual(yield* Queue.take(watched.changes), clientSettings);
      }),
    ),
  );

  it.effect("rewatches after a watch failure and announces an edit made meanwhile", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settingsPath = environment.clientSettingsPath;
        const watched = yield* watchClientSettings({
          directories: [environment.stateDir],
          armed: 1,
          failFirstWatchOf: environment.stateDir,
        });

        const restartsBefore = watched.calls.makeDirectory;
        yield* watched.touch(settingsPath);
        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(edited));
        yield* TestClock.adjust("999 millis");
        assert.equal(watched.calls.makeDirectory, restartsBefore);
        yield* TestClock.adjust("1 millis");
        assert.equal(watched.calls.makeDirectory, restartsBefore + 1);
        yield* watched.awaitRead;
        assert.deepEqual(yield* Queue.take(watched.changes), edited);
        assert.deepEqual(yield* watched.armed(1), [environment.stateDir]);

        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(editedAgain));
        yield* watched.touch(settingsPath);
        yield* watched.settle;
        assert.deepEqual(yield* Queue.take(watched.changes), editedAgain);
      }),
    ),
  );

  it.effect("holds a save until the watcher finishes comparing the file", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settingsPath = environment.clientSettingsPath;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(clientSettings));
        const watched = yield* watchClientSettings({
          directories: [environment.stateDir],
          armed: 1,
        });
        const gate = yield* Deferred.make<void>();

        yield* fileSystem.writeFileString(settingsPath, JSON.stringify(edited));
        yield* watched.touch(settingsPath);
        watched.holdNextRead(gate);
        yield* TestClock.adjust(DesktopClientSettings.EXTERNAL_CHANGE_DEBOUNCE);
        yield* Queue.take(watched.readStarted);
        const readsBefore = watched.calls.readFileString;
        const save = yield* watched.settings
          .patch({ wordWrap: false })
          .pipe(Effect.delay("1 millis"), Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("1 millis");
        assert.equal(watched.calls.readFileString, readsBefore);

        yield* Deferred.succeed(gate, undefined);
        assert.deepEqual(yield* Queue.take(watched.changes), edited);
        assert.deepEqual(yield* Fiber.join(save), {
          settings: { ...edited, wordWrap: false },
          mergedExternalEdit: false,
        });
      }),
    ),
  );

  it.effect("saves through a symlinked client settings file without replacing the link", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        const dotfiles = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-client-settings-dotfiles-",
        });
        const linkedSettingsPath = `${dotfiles}/client-settings.json`;
        yield* fileSystem.writeFileString(linkedSettingsPath, "{}\n");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.symlink(linkedSettingsPath, environment.clientSettingsPath);

        yield* settings.patch(clientSettings);

        assert.equal(
          yield* fileSystem.readLink(environment.clientSettingsPath),
          linkedSettingsPath,
        );
        assert.deepEqual(
          yield* decodeClientSettingsJson(yield* fileSystem.readFileString(linkedSettingsPath)),
          clientSettings,
        );
      }),
    ),
  );

  it.effect("removes its temporary file when replacing the settings file fails", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(`${environment.clientSettingsPath}/occupied`, {
          recursive: true,
        });

        const error = yield* settings.patch(clientSettings).pipe(Effect.flip);

        assert.equal(error.operation, "replace-settings-file");
        assert.deepEqual(
          (yield* fileSystem.readDirectory(environment.stateDir)).filter((name) =>
            name.endsWith(".tmp"),
          ),
          [],
        );
      }),
    ),
  );

  it.effect.each([
    { label: "permission", reason: "PermissionDenied" },
    { label: "I/O", reason: "Unknown" },
  ] as const)("preserves saved preferences across $label read failures and retries", (failure) =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        const savedSettings = {
          ...clientSettings,
          onboardingCompletedAt: "2026-09-05T12:00:00.000Z",
        };
        yield* settings.patch(savedSettings);
        const savedContents = yield* fileSystem.readFileString(environment.clientSettingsPath);
        const cause = PlatformError.systemError({
          _tag: failure.reason,
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: environment.clientSettingsPath,
        });
        let failRead = true;
        const retryableSettings = yield* DesktopClientSettings.make.pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.FileSystem.of({
              ...fileSystem,
              readFileString: (path) =>
                Effect.suspend(() =>
                  failRead ? Effect.fail(cause) : fileSystem.readFileString(path),
                ),
            }),
          ),
        );

        const error = yield* retryableSettings.get.pipe(Effect.flip);
        assert.instanceOf(error, DesktopClientSettings.DesktopClientSettingsReadError);
        assert.equal(error.operation, "read-file");
        assert.equal(error.path, environment.clientSettingsPath);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          yield* fileSystem.readFileString(environment.clientSettingsPath),
          savedContents,
        );

        failRead = false;
        assert.deepEqual(yield* retryableSettings.get, Option.some(savedSettings));
      }),
    ),
  );

  it.effect("loads lenient direct client settings documents", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.clientSettingsPath,
          `{
            // Matches server settings parsing.
            "timestampFormat": "24-hour",
          }\n`,
        );

        const persisted = yield* settings.get;
        assert.isTrue(Option.isSome(persisted));
        if (Option.isSome(persisted)) {
          assert.equal(persisted.value.timestampFormat, "24-hour");
        }
      }),
    ),
  );

  it.effect("loads legacy wrapped client settings documents", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.clientSettingsPath,
          `{
            "settings": {
              "timestampFormat": "12-hour"
            }
          }\n`,
        );

        const persisted = yield* settings.get;
        assert.isTrue(Option.isSome(persisted));
        if (Option.isSome(persisted)) {
          assert.equal(persisted.value.timestampFormat, "12-hour");
        }
      }),
    ),
  );

  it.effect.each([
    { label: "malformed JSON", contents: "{not-json" },
    { label: "invalid legacy settings", contents: '{"settings":{"fontSizeCode":"large"}}' },
  ])("reports $label without treating the settings file as absent", (document) =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.clientSettingsPath, document.contents);

        const error = yield* settings.get.pipe(Effect.flip);
        assert.instanceOf(error, DesktopClientSettings.DesktopClientSettingsReadError);
        assert.equal(error.operation, "decode-document");
        assert.equal(error.path, environment.clientSettingsPath);
        assert.instanceOf(error.cause, Schema.SchemaError);
        assert.equal(
          yield* fileSystem.readFileString(environment.clientSettingsPath),
          document.contents,
        );
      }),
    ),
  );
});

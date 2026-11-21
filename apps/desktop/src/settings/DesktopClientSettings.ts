import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type ClientSettingsPatch,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const ClientSettingsJson = fromLenientJson(ClientSettingsSchema);
const decodeClientSettingsDocument = Schema.decodeEffect(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeClientSettingsValue = Schema.decodeUnknownEffect(ClientSettingsSchema);
const decodeClientSettingsJson = Effect.fnUntraced(function* (raw: string) {
  const document = yield* decodeClientSettingsDocument(raw);
  // Select the shape before validation so invalid legacy settings cannot become defaults.
  return yield* decodeClientSettingsValue(
    Object.hasOwn(document, "settings") ? document.settings : document,
  );
});
const encodeClientSettingsJson = Schema.encodeEffect(ClientSettingsJson);

// Editors and agents often save in several steps; read once the file settles.
export const EXTERNAL_CHANGE_DEBOUNCE = Duration.millis(150);
// A save waits this long for a half-written file to become readable before giving up.
const UNREADABLE_SAVE_RETRY = { schedule: Schedule.spaced("100 millis"), times: 3 };
// Each attempt re-reads before replacing; the last one replaces regardless.
const SAVE_ATTEMPTS = 3;
const WATCH_RETRY = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.minutes(1))),
  ),
);

export class DesktopClientSettingsReadError extends Schema.TaggedError<DesktopClientSettingsReadError>()(
  "DesktopClientSettingsReadError",
  {
    operation: Schema.Literals(["read-file", "decode-document"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop client settings read failed during ${this.operation} at ${this.path}.`;
  }
}

const DesktopClientSettingsWriteOperation = Schema.Literals([
  "read-current-settings",
  "create-temporary-file-name",
  "resolve-symlink",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-settings-file",
]);

export class DesktopClientSettingsWriteError extends Schema.TaggedError<DesktopClientSettingsWriteError>()(
  "DesktopClientSettingsWriteError",
  {
    operation: DesktopClientSettingsWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop client settings write failed during ${this.operation} at ${this.path}.`;
  }
}

export interface PatchedClientSettings {
  readonly settings: ClientSettings;
  /** The file held settings this service had not written or announced; they were kept. */
  readonly mergedExternalEdit: boolean;
}

interface KnownSettings {
  readonly encoded: string;
  readonly settings: ClientSettings;
}

export class DesktopClientSettings extends Context.Service<
  DesktopClientSettings,
  {
    readonly get: Effect.Effect<Option.Option<ClientSettings>, DesktopClientSettingsReadError>;
    /** Applies `patch` to the file's current settings, so edits made outside the app survive. */
    readonly patch: (
      patch: ClientSettingsPatch,
    ) => Effect.Effect<PatchedClientSettings, DesktopClientSettingsWriteError>;
    /** Settings written to the file by someone other than this service. One consumer. */
    readonly externalChanges: Stream.Stream<ClientSettings, PlatformError.PlatformError>;
  }
>()("@t3tools/desktop/settings/DesktopClientSettings") {}

const readRawClientSettings = (
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
): Effect.Effect<Option.Option<string>, DesktopClientSettingsReadError> =>
  fileSystem.readFileString(settingsPath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(
              new DesktopClientSettingsReadError({
                operation: "read-file",
                path: settingsPath,
                cause,
              }),
            ),
    }),
  );

const decodeRawClientSettings = (
  raw: Option.Option<string>,
  settingsPath: string,
): Effect.Effect<Option.Option<ClientSettings>, DesktopClientSettingsReadError> =>
  Option.match(raw, {
    onNone: () => Effect.succeed(Option.none<ClientSettings>()),
    onSome: (contents) =>
      decodeClientSettingsJson(contents).pipe(
        Effect.asSome,
        Effect.mapError(
          (cause) =>
            new DesktopClientSettingsReadError({
              operation: "decode-document",
              path: settingsPath,
              cause,
            }),
        ),
      ),
  });

const writeClientSettings = Effect.fnUntraced(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly settingsPath: string;
  readonly encoded: string;
  readonly suffix: string;
  /** Runs just before the rename; `false` leaves the file alone and reports it not replaced. */
  readonly stillCurrent?: Effect.Effect<boolean>;
}): Effect.fn.Return<boolean, DesktopClientSettingsWriteError> {
  const targetPath = yield* resolveSymlinkTarget(input.settingsPath).pipe(
    Effect.provideService(FileSystem.FileSystem, input.fileSystem),
    Effect.provideService(Path.Path, input.path),
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "resolve-symlink",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
  const directory = input.path.dirname(targetPath);
  const tempPath = `${targetPath}.${process.pid}.${input.suffix}.tmp`;
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  return yield* Effect.gen(function* () {
    yield* input.fileSystem.writeFileString(tempPath, `${input.encoded}\n`).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopClientSettingsWriteError({
            operation: "write-temporary-file",
            path: tempPath,
            cause,
          }),
      ),
    );
    if (input.stillCurrent && !(yield* input.stillCurrent)) return false;
    yield* input.fileSystem.rename(tempPath, targetPath).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopClientSettingsWriteError({
            operation: "replace-settings-file",
            path: input.settingsPath,
            cause,
          }),
      ),
    );
    return true;
  }).pipe(Effect.ensuring(input.fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)));
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const settingsPath = environment.clientSettingsPath;
  const readRaw = readRawClientSettings(fileSystem, settingsPath);
  const readUnlogged = readRaw.pipe(
    Effect.flatMap((raw) => decodeRawClientSettings(raw, settingsPath)),
  );
  const read = readUnlogged.pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Could not read desktop client settings.", error).pipe(
        Effect.annotateLogs({ settingsPath }),
      ),
    ),
  );
  const toKnown = (settings: ClientSettings) =>
    encodeClientSettingsJson(settings).pipe(
      Effect.map((encoded): KnownSettings => ({ encoded, settings })),
      Effect.orDie,
    );
  // Patches and the watcher's compare each read the file and update lastKnownRef as one step.
  const fileLock = yield* Semaphore.make(1);
  // What the app last wrote or announced, so its own writes stay silent.
  const lastKnownRef = yield* Ref.make(Option.none<KnownSettings>());

  const readKnown = read.pipe(
    Effect.flatMap((settings) => Effect.transposeOption(Option.map(settings, toKnown))),
    Effect.orElseSucceed(() => Option.none<KnownSettings>()),
  );
  // A missing file reads as none; one that exists but stays unreadable fails the save.
  const readForSave = Effect.gen(function* () {
    const raw = yield* readRaw;
    const current = yield* decodeRawClientSettings(raw, settingsPath).pipe(
      Effect.flatMap((settings) => Effect.transposeOption(Option.map(settings, toKnown))),
    );
    return { raw, current };
  }).pipe(
    Effect.retry(UNREADABLE_SAVE_RETRY),
    Effect.tapError((error) =>
      Effect.logWarning("Not saving over desktop client settings that cannot be read.", error).pipe(
        Effect.annotateLogs({ settingsPath }),
      ),
    ),
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "read-current-settings",
          path: settingsPath,
          cause,
        }),
    ),
  );
  const isLastKnown = (known: KnownSettings, lastKnown: Option.Option<KnownSettings>) =>
    Option.isSome(lastKnown) && lastKnown.value.encoded === known.encoded;

  /* Runs once per settled file event; the stream boundary already traces the watcher. */
  const readExternalChange = Effect.fnUntraced(function* () {
    const current = yield* readKnown;
    if (Option.isNone(current) || isLastKnown(current.value, yield* Ref.get(lastKnownRef))) {
      return Option.none<ClientSettings>();
    }
    yield* Ref.set(lastKnownRef, current);
    return Option.some(current.value.settings);
  }, fileLock.withPermits(1));

  const seedLastKnown = Effect.gen(function* () {
    if (Option.isNone(yield* Ref.get(lastKnownRef))) {
      yield* Ref.set(lastKnownRef, yield* readKnown);
    }
  }).pipe(fileLock.withPermits(1));
  const watchStartedRef = yield* Ref.make(false);

  const resolveSettingsTarget = resolveSymlinkTarget(settingsPath).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );
  // Writes replace files by rename, which detaches a watcher on the file itself.
  const watchFile = (filePath: string, ready: Deferred.Deferred<void>) =>
    fileSystem
      .watch(path.dirname(filePath), { onReady: () => Deferred.doneUnsafe(ready, Effect.void) })
      .pipe(Stream.filter((event) => path.basename(event.path) === path.basename(filePath)));

  // The settings path reports edits and replaced links; a link's target directory reports edits
  // made through the link. Links are re-resolved once events settle, re-arming the target watch.
  const externalChanges = Stream.unwrap(
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(path.dirname(settingsPath), { recursive: true });
      const restarted = yield* Ref.getAndSet(watchStartedRef, true);
      const linkPath = path.resolve(settingsPath);
      const targetRef = yield* SubscriptionRef.make(yield* resolveSettingsTarget);
      const linkReady = yield* Deferred.make<void>();
      const targetReady = yield* Deferred.make<void>();
      const targetEvents = SubscriptionRef.changes(targetRef).pipe(
        Stream.changes,
        Stream.switchMap((target) =>
          target === linkPath
            ? Stream.fromEffect(Deferred.succeed(targetReady, undefined)).pipe(Stream.drain)
            : watchFile(target, targetReady),
        ),
      );
      // Read once the watches are armed, so an edit during startup is either read or reported.
      // A restart after a watch failure may have missed an edit, so it compares instead of seeding.
      const reconcile = Stream.fromEffect(
        Deferred.await(linkReady).pipe(
          Effect.andThen(Deferred.await(targetReady)),
          Effect.andThen(
            restarted
              ? readExternalChange()
              : seedLastKnown.pipe(Effect.as(Option.none<ClientSettings>())),
          ),
        ),
      );
      const settledChanges = Stream.merge(watchFile(settingsPath, linkReady), targetEvents).pipe(
        Stream.debounce(EXTERNAL_CHANGE_DEBOUNCE),
        Stream.mapEffect(() =>
          resolveSettingsTarget.pipe(
            Effect.flatMap((target) => SubscriptionRef.set(targetRef, target)),
            Effect.andThen(readExternalChange()),
          ),
        ),
      );
      return Stream.merge(reconcile, settledChanges);
    }),
  ).pipe(
    Stream.filter(Option.isSome),
    Stream.map((settings) => settings.value),
    Stream.tapError((error) =>
      Effect.logWarning("Watching desktop client settings failed; retrying.", error).pipe(
        Effect.annotateLogs({ settingsPath }),
      ),
    ),
    Stream.retry(WATCH_RETRY),
  );

  return DesktopClientSettings.of({
    get: read.pipe(Effect.withSpan("desktop.clientSettings.get")),
    patch: Effect.fn("desktop.clientSettings.patch")(function* (patch) {
      const lastKnown = yield* Ref.get(lastKnownRef);
      for (let attempt = 1; ; attempt += 1) {
        const { raw, current } = yield* readForSave;
        // A missing file keeps what the app last knew rather than resetting.
        const base = Option.orElse(current, () => lastKnown).pipe(
          Option.match({
            onNone: () => DEFAULT_CLIENT_SETTINGS,
            onSome: (known) => known.settings,
          }),
        );
        const settings: ClientSettings = { ...base, ...patch };
        const encoded = yield* encodeClientSettingsJson(settings).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopClientSettingsWriteError({
                operation: "encode-document",
                path: settingsPath,
                cause,
              }),
          ),
        );
        const suffix = (yield* random.uuidV4()).replace(/-/g, "");
        // An outside write between the read and the rename is re-read and patched instead.
        const replaced = yield* writeClientSettings({
          fileSystem,
          path,
          settingsPath,
          encoded,
          suffix,
          ...(attempt < SAVE_ATTEMPTS && {
            stillCurrent: readRaw.pipe(
              Effect.map((now) => Equal.equals(now, raw)),
              Effect.orElseSucceed(() => false),
            ),
          }),
        });
        if (!replaced) continue;
        yield* Ref.set(lastKnownRef, Option.some({ encoded, settings }));
        return {
          settings,
          mergedExternalEdit: Option.isSome(current) && !isLastKnown(current.value, lastKnown),
        };
      }
    }, fileLock.withPermits(1)),
    externalChanges,
  });
});

export const layer = Layer.effect(DesktopClientSettings, make);

export const layerTest = (initialSettings: Option.Option<ClientSettings> = Option.none()) =>
  Layer.effect(
    DesktopClientSettings,
    Effect.gen(function* () {
      const settingsRef = yield* Ref.make(initialSettings);
      return DesktopClientSettings.of({
        get: Ref.get(settingsRef),
        patch: Effect.fn("DesktopClientSettings.patch")(function* (patch) {
          const current = yield* Ref.get(settingsRef);
          const settings: ClientSettings = {
            ...Option.getOrElse(current, () => DEFAULT_CLIENT_SETTINGS),
            ...patch,
          };
          yield* Ref.set(settingsRef, Option.some(settings));
          return { settings, mergedExternalEdit: false };
        }),
        externalChanges: Stream.empty,
      });
    }),
  );

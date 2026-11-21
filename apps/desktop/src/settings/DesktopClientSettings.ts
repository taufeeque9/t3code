import { ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

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
const EXTERNAL_CHANGE_DEBOUNCE = Duration.millis(150);

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

export class DesktopClientSettings extends Context.Service<
  DesktopClientSettings,
  {
    readonly get: Effect.Effect<Option.Option<ClientSettings>, DesktopClientSettingsReadError>;
    readonly set: (
      settings: ClientSettings,
    ) => Effect.Effect<void, DesktopClientSettingsWriteError>;
    /** Settings written to the file by someone other than this service. One consumer. */
    readonly externalChanges: Stream.Stream<ClientSettings, PlatformError.PlatformError>;
  }
>()("@t3tools/desktop/settings/DesktopClientSettings") {}

const readClientSettings = (
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
): Effect.Effect<Option.Option<ClientSettings>, DesktopClientSettingsReadError> =>
  fileSystem.readFileString(settingsPath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.logWarning("Could not read desktop client settings.", cause).pipe(
              Effect.annotateLogs({ settingsPath }),
              Effect.andThen(
                Effect.fail(
                  new DesktopClientSettingsReadError({
                    operation: "read-file",
                    path: settingsPath,
                    cause,
                  }),
                ),
              ),
            ),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<ClientSettings>()),
        onSome: (raw) =>
          decodeClientSettingsJson(raw).pipe(
            Effect.asSome,
            Effect.catchTags({
              SchemaError: (cause) =>
                Effect.logWarning("Could not decode desktop client settings.", cause).pipe(
                  Effect.annotateLogs({ settingsPath }),
                  Effect.andThen(
                    Effect.fail(
                      new DesktopClientSettingsReadError({
                        operation: "decode-document",
                        path: settingsPath,
                        cause,
                      }),
                    ),
                  ),
                ),
            }),
          ),
      }),
    ),
  );

const writeClientSettings = Effect.fnUntraced(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly settingsPath: string;
  readonly encoded: string;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopClientSettingsWriteError> {
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
  yield* Effect.gen(function* () {
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
  }).pipe(Effect.ensuring(input.fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)));
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const settingsPath = environment.clientSettingsPath;
  const read = readClientSettings(fileSystem, settingsPath);
  // Encoded form of the settings the app last wrote or announced, so its own writes stay silent.
  const lastKnownRef = yield* Ref.make(Option.none<string>());

  const encodeReadSettings = (settings: ClientSettings) =>
    encodeClientSettingsJson(settings).pipe(Effect.option);

  /* Runs once per settled file event; the stream boundary already traces the watcher. */
  const readExternalChange = Effect.fnUntraced(function* () {
    const settings = yield* read.pipe(Effect.orElseSucceed(() => Option.none<ClientSettings>()));
    if (Option.isNone(settings)) return Option.none<ClientSettings>();
    const encoded = yield* encodeReadSettings(settings.value);
    if (Option.isNone(encoded)) return Option.none<ClientSettings>();
    const changed = yield* Ref.modify(lastKnownRef, (lastKnown) =>
      Option.isSome(lastKnown) && lastKnown.value === encoded.value
        ? [false, lastKnown]
        : [true, encoded],
    );
    return changed ? settings : Option.none<ClientSettings>();
  });

  const externalChanges = Stream.unwrap(
    Effect.gen(function* () {
      const targetPath = yield* resolveSymlinkTarget(settingsPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const directory = path.dirname(targetPath);
      const fileName = path.basename(targetPath);
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      const initial = yield* read.pipe(Effect.orElseSucceed(() => Option.none<ClientSettings>()));
      if (Option.isSome(initial)) {
        const encoded = yield* encodeReadSettings(initial.value);
        yield* Ref.update(lastKnownRef, (lastKnown) =>
          Option.isSome(lastKnown) ? lastKnown : encoded,
        );
      }
      // Writes replace the file by rename, which detaches a watcher on the file itself.
      return fileSystem.watch(directory).pipe(
        Stream.filter((event) => path.basename(event.path) === fileName),
        Stream.debounce(EXTERNAL_CHANGE_DEBOUNCE),
        Stream.mapEffect(readExternalChange),
        Stream.filter(Option.isSome),
        Stream.map((settings) => settings.value),
      );
    }),
  );

  return DesktopClientSettings.of({
    get: read.pipe(Effect.withSpan("desktop.clientSettings.get")),
    set: Effect.fn("desktop.clientSettings.set")(function* (settings) {
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
      yield* Ref.set(lastKnownRef, Option.some(encoded));
      yield* writeClientSettings({ fileSystem, path, settingsPath, encoded, suffix });
    }),
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
        set: Effect.fn("DesktopClientSettings.set")(function (settings) {
          return Ref.set(settingsRef, Option.some(settings));
        }),
        externalChanges: Stream.empty,
      });
    }),
  );

import { ClientSettingsPatch, ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { applyLanguage } from "../../i18n/messages.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const applyNativeClientSettings = Effect.fn("desktop.ipc.clientSettings.applyNative")(function* (
  settings: ClientSettings,
) {
  const snapShot = yield* DesktopSnapShot.DesktopSnapShot;
  yield* snapShot.configure(settings);
  yield* applyLanguage(settings.language);
});

const announceClientSettingsChange = Effect.fn("desktop.ipc.clientSettings.announceChange")(
  function* () {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    yield* electronWindow.sendAll(IpcChannels.CLIENT_SETTINGS_CHANGED_CHANNEL);
  },
);

export const installClientSettingsChangeForwarding = Effect.fn(
  "desktop.ipc.clientSettings.installChangeForwarding",
)(function* () {
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  yield* clientSettings.externalChanges.pipe(
    Stream.runForEach((settings) =>
      applyNativeClientSettings(settings).pipe(Effect.andThen(announceClientSettingsChange())),
    ),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );
});

export const getClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(ClientSettingsSchema),
  handler: Effect.fn("desktop.ipc.clientSettings.get")(function* () {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    return Option.getOrNull(yield* clientSettings.get);
  }),
});

export const patchClientSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PATCH_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsPatch,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.clientSettings.patch")(function* (patch, event) {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const patched = yield* clientSettings.patch(patch);
    yield* applyNativeClientSettings(patched.settings);
    // The sender already shows its own save, and refreshing it would race its queued saves.
    // A merged outside edit is missing from its snapshot too.
    if (patched.mergedExternalEdit || event === undefined) {
      yield* announceClientSettingsChange();
    } else {
      yield* electronWindow.sendAllExcept(
        event.sender.id,
        IpcChannels.CLIENT_SETTINGS_CHANGED_CHANNEL,
      );
    }
  }),
});

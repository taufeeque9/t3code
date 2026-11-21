import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import * as IpcChannels from "../channels.ts";
import { patchClientSettings } from "./clientSettings.ts";

it.effect("tells every other window about a save", () => {
  const sent: Array<{ readonly except: number | null; readonly channel: string }> = [];
  return Effect.gen(function* () {
    yield* patchClientSettings.handler({ wordWrap: false }, { sender: { id: 7 } });
    assert.deepEqual(sent, [{ except: 7, channel: IpcChannels.CLIENT_SETTINGS_CHANGED_CHANNEL }]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        DesktopClientSettings.layerTest(),
        Layer.mock(ElectronWindow.ElectronWindow, {
          sendAll: (channel) => Effect.sync(() => void sent.push({ except: null, channel })),
          sendAllExcept: (except, channel) =>
            Effect.sync(() => void sent.push({ except, channel })),
        }),
        Layer.mock(DesktopSnapShot.DesktopSnapShot, { configure: () => Effect.void }),
        Layer.mock(ElectronApp.ElectronApp, { preferredSystemLanguages: Effect.succeed([]) }),
      ),
    ),
  );
});

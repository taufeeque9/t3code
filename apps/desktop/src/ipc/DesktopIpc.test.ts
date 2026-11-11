import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "./DesktopIpc.ts";

it.effect("answers only app windows' top frames", () =>
  Effect.gen(function* () {
    const mainFrame = {};
    const secondaryFrame = {};
    const appWindows = new Map([
      [1, { webContents: { id: 1, mainFrame } }],
      [3, { webContents: { id: 3, mainFrame: secondaryFrame } }],
    ]);
    const invoke = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const sync = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
    const ipc = yield* DesktopIpc.DesktopIpc.pipe(
      Effect.provide(
        DesktopIpc.layer({
          removeHandler: (channel) => void invoke.delete(channel),
          handle: (channel, listener) => void invoke.set(channel, listener),
          removeAllListeners: (channel) => void sync.delete(channel),
          on: (channel, listener) => void sync.set(channel, listener),
        }).pipe(
          Layer.provide(
            Layer.mock(ElectronWindow.ElectronWindow, {
              appWindowFor: (id) =>
                Effect.succeed(
                  Option.fromNullishOr(appWindows.get(id) as Electron.BrowserWindow | undefined),
                ),
            }),
          ),
        ),
      ),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: "token",
        payload: Schema.Void,
        result: Schema.String,
        handler: () => Effect.succeed("secret"),
      }),
    );
    yield* ipc.handleSync({ channel: "token-sync", handler: () => Effect.succeed("secret") });

    const senders = {
      app: { sender: { id: 1 }, senderFrame: mainFrame },
      appSubframe: { sender: { id: 1 }, senderFrame: {} },
      secondaryWindow: { sender: { id: 3 }, senderFrame: secondaryFrame },
      previewGuest: { sender: { id: 2 }, senderFrame: {} },
    };
    const results: Record<string, unknown> = {};
    for (const [name, sender] of Object.entries(senders)) {
      const event = { ...sender, returnValue: "unset" as unknown };
      sync.get("token-sync")!(event);
      results[name] = [
        yield* Effect.promise(() =>
          Promise.resolve(invoke.get("token")!(sender, undefined)).catch(() => "rejected"),
        ),
        event.returnValue,
      ];
    }
    assert.deepEqual(results, {
      app: ["secret", "secret"],
      appSubframe: ["rejected", undefined],
      secondaryWindow: ["secret", "secret"],
      previewGuest: ["rejected", undefined],
    });
  }).pipe(Effect.scoped),
);

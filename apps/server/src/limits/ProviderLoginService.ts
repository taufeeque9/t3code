/**
 * ProviderLoginService - signs a Claude provider instance back in.
 *
 * `claude auth login` prints an authorization URL and then blocks on stdin for
 * the code the browser hands back, so one sign-in spans two client calls:
 * `start` returns the URL, `submit` feeds the code in and waits for the CLI to
 * exit. The child therefore has to outlive the first call, which is why it is
 * held here rather than scoped to the request.
 *
 * @module ProviderLoginService
 */
// @effect-diagnostics nodeBuiltinImport:off - the login child outlives the
// request that spawned it, which Effect's scoped spawner cannot express.
import * as NodeChildProcess from "node:child_process";

import {
  ClaudeSettings,
  ProviderLoginError,
  resolveProviderInstanceEnabled,
  type ProviderInstanceId,
  type ProviderLoginStartResult,
  type ProviderLoginSubmitResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../serverSettings.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";

const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);

/** Long enough for a slow CLI start, short enough to fail visibly. */
const AUTHORIZE_URL_TIMEOUT = "30 seconds";
/** A sign-in nobody finishes must not keep a CLI alive forever. */
const PENDING_LOGIN_TIMEOUT = "10 minutes";
/** How long a code-less submit waits for the browser callback to land. */
const BROWSER_CALLBACK_TIMEOUT = "90 seconds";
/** Bounds the buffered CLI output; the URL arrives in the first few lines. */
const MAX_OUTPUT_CHARS = 64 * 1024;

const AUTHORIZE_URL_PATTERN = /https:\/\/\S*oauth\/authorize\S*/;

interface PendingLogin {
  readonly loginId: string;
  readonly instanceId: ProviderInstanceId;
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly accountLabel: string | null;
  /** Everything the CLI has written, used for the URL and for failure detail. */
  output: string;
  /** Set once the CLI exits, which the browser callback can do on its own. */
  exitCode: number | null;
}

export class ProviderLoginService extends Context.Service<
  ProviderLoginService,
  {
    readonly start: (input: {
      readonly instanceId: ProviderInstanceId;
    }) => Effect.Effect<ProviderLoginStartResult, ProviderLoginError>;
    readonly submit: (input: {
      readonly loginId: string;
      readonly code: string;
    }) => Effect.Effect<ProviderLoginSubmitResult, ProviderLoginError>;
  }
>()("t3/limits/ProviderLoginService") {}

/**
 * Resolves once the CLI prints its authorization URL, or fails when it exits or
 * goes quiet first. Output keeps accumulating afterwards so a later failure can
 * still be reported with the CLI's own words.
 */
function awaitAuthorizeUrl(pending: PendingLogin): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      run();
    };

    const onData = (chunk: Buffer | string) => {
      if (pending.output.length < MAX_OUTPUT_CHARS) {
        pending.output += String(chunk);
      }
      const match = AUTHORIZE_URL_PATTERN.exec(pending.output);
      if (match) {
        finish(() => resolve(match[0]));
      }
    };
    pending.child.stdout.on("data", onData);
    pending.child.stderr.on("data", onData);
    pending.child.once("error", (error) => {
      finish(() => reject(error));
    });
    pending.child.once("exit", () => {
      finish(() => reject(new Error("The sign-in command exited before printing a URL.")));
    });
  });
}

/** Last line the CLI printed, which carries its failure reason. */
function lastMeaningfulLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? null;
}

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  // Held here so the service's own signature stays context-free.
  const path = yield* Path.Path;
  const pendingByLoginId = new Map<string, PendingLogin>();

  const forget = (pending: PendingLogin) => {
    pendingByLoginId.delete(pending.loginId);
  };

  const abandon = (pending: PendingLogin) => {
    forget(pending);
    pending.child.kill();
  };

  const start = Effect.fn("ProviderLoginService.start")(function* (input: {
    readonly instanceId: ProviderInstanceId;
  }) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderLoginError({
            reason: "login-failed",
            message: "Server settings could not be read.",
            cause,
          }),
      ),
    );
    const instances = deriveProviderInstanceConfigMap(settings);
    const instance = instances[input.instanceId];
    if (!instance || !resolveProviderInstanceEnabled(instance)) {
      return yield* new ProviderLoginError({
        reason: "instance-not-found",
        message: `Provider '${input.instanceId}' is not configured on this environment.`,
      });
    }
    if (instance.driver !== "claudeAgent") {
      return yield* new ProviderLoginError({
        reason: "unsupported-provider",
        message: "Signing in from T3 Code is only supported for Claude accounts.",
      });
    }

    const claudeSettings = yield* decodeClaudeSettings(instance.config).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderLoginError({
            reason: "login-failed",
            message: "Claude provider settings could not be read.",
            cause,
          }),
      ),
    );
    const environment = yield* makeClaudeEnvironment(
      claudeSettings,
      mergeProviderInstanceEnvironment(instance.environment),
    ).pipe(Effect.provideService(Path.Path, path));

    // One attempt per instance: starting again replaces whatever was pending so
    // an abandoned sign-in cannot leave a second CLI holding the same account.
    for (const pending of pendingByLoginId.values()) {
      if (pending.instanceId === input.instanceId) abandon(pending);
    }

    const child = NodeChildProcess.spawn(
      claudeSettings.binaryPath,
      ["auth", "login", "--claudeai"],
      { env: environment, stdio: ["pipe", "pipe", "pipe"] },
    ) as NodeChildProcess.ChildProcessWithoutNullStreams;

    const loginId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const pending: PendingLogin = {
      loginId,
      instanceId: input.instanceId,
      child,
      accountLabel: instance.displayName ?? null,
      output: "",
      exitCode: null,
    };
    pendingByLoginId.set(loginId, pending);
    // The CLI's own callback server can complete the sign-in without a pasted
    // code, so its exit is recorded whether or not anyone is waiting on it.
    child.once("exit", (code) => {
      pending.exitCode = code ?? 1;
    });
    // Expiry sweep rather than a cancellable timer: a sign-in that already
    // finished is simply no longer the map's entry for this id.
    yield* Effect.sleep(PENDING_LOGIN_TIMEOUT).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (pendingByLoginId.get(loginId) === pending) abandon(pending);
        }),
      ),
      Effect.forkDetach,
    );

    const authorizeUrl = yield* Effect.tryPromise({
      try: () => awaitAuthorizeUrl(pending),
      catch: (cause) =>
        new ProviderLoginError({
          reason: "login-failed",
          message:
            lastMeaningfulLine(pending.output) ??
            "The Claude CLI did not return a sign-in URL. Check its binary path.",
          cause,
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: AUTHORIZE_URL_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ProviderLoginError({
              reason: "login-failed",
              message: "Timed out waiting for the Claude CLI to return a sign-in URL.",
            }),
          ),
      }),
      Effect.tapError(() => Effect.sync(() => abandon(pending))),
    );

    return { loginId, authorizeUrl } satisfies ProviderLoginStartResult;
  });

  const finishLogin = (pending: PendingLogin, exitCode: number) =>
    exitCode === 0
      ? Effect.succeed({ accountLabel: pending.accountLabel } satisfies ProviderLoginSubmitResult)
      : Effect.fail(
          new ProviderLoginError({
            reason: "login-failed",
            message:
              lastMeaningfulLine(pending.output) ?? "The Claude CLI rejected the sign-in code.",
          }),
        );

  const submit = Effect.fn("ProviderLoginService.submit")(function* (input: {
    readonly loginId: string;
    readonly code: string;
  }) {
    const pending = pendingByLoginId.get(input.loginId);
    if (!pending) {
      return yield* new ProviderLoginError({
        reason: "login-not-pending",
        message: "This sign-in expired. Start it again.",
      });
    }
    const code = input.code.trim();

    // The browser may already have finished it, in which case there is nothing
    // to send and the recorded exit is the whole answer.
    if (pending.exitCode !== null) {
      forget(pending);
      return yield* finishLogin(pending, pending.exitCode);
    }
    forget(pending);

    const exitCode = yield* Effect.tryPromise({
      try: () =>
        new Promise<number>((resolve, reject) => {
          pending.child.once("error", reject);
          pending.child.once("exit", (exited) => resolve(exited ?? 1));
          // An empty code means "the browser is handling it": wait for the CLI
          // to exit on its own rather than feeding it an invalid line.
          if (code.length > 0) {
            pending.child.stdin.write(`${code}\n`, (error) => {
              if (error) reject(error);
            });
          }
        }),
      catch: (cause) =>
        new ProviderLoginError({
          reason: "login-failed",
          message: "The sign-in code could not be delivered to the Claude CLI.",
          cause,
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: BROWSER_CALLBACK_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ProviderLoginError({
              reason: "login-pending",
              message:
                "Still waiting for the browser to finish signing in. Approve it, then try again.",
            }),
          ),
      }),
      // A timeout leaves the CLI running so the browser can still finish it;
      // only a hard failure is worth killing.
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error.reason === "login-pending") {
            pendingByLoginId.set(pending.loginId, pending);
            return;
          }
          pending.child.kill();
        }),
      ),
    );

    return yield* finishLogin(pending, exitCode);
  });

  return ProviderLoginService.of({ start, submit });
});

export const layer = Layer.effect(ProviderLoginService, make);

export const layerTest = Layer.succeed(
  ProviderLoginService,
  ProviderLoginService.of({
    start: () =>
      Effect.succeed({ loginId: "login-1", authorizeUrl: "https://example.test/oauth/authorize" }),
    submit: () => Effect.succeed({ accountLabel: null }),
  }),
);

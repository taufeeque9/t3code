// @effect-diagnostics nodeBuiltinImport:off - the suite writes a stub CLI to
// disk so the service can spawn a real child process.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as ProviderLoginService from "./ProviderLoginService.ts";

const AUTHORIZE_URL = "https://claude.test/cai/oauth/authorize?state=stub";

/**
 * Stands in for `claude auth login`: prints the authorization URL, then accepts
 * exactly one code on stdin and exits non-zero for anything but the good one.
 */
const STUB_CLI = `#!/usr/bin/env node
process.stdout.write("Opening browser to sign in…\\n");
process.stdout.write("If the browser didn't open, visit: ${AUTHORIZE_URL}\\n");
let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  const newline = buffered.indexOf("\\n");
  if (newline === -1) return;
  const code = buffered.slice(0, newline).trim();
  if (code === "good-code") process.exit(0);
  process.stdout.write("That code was not accepted.\\n");
  process.exit(1);
});
`;

/** Mimics the CLI's own browser callback finishing the sign-in unprompted. */
const SELF_COMPLETING_CLI = `#!/usr/bin/env node
process.stdout.write("If the browser didn't open, visit: ${AUTHORIZE_URL}\\n");
setTimeout(() => {
  process.stdout.write("Login successful.\\n");
  process.exit(0);
}, 50);
`;

/** A CLI that dies before printing anything, like a bad binary path. */
const FAILING_CLI = `#!/usr/bin/env node
process.stdout.write("not logged in: profile missing\\n");
process.exit(3);
`;

const setup = (source: string) =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "provider-login-test-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
    );
    const binaryPath = NodePath.join(home, "claude-stub.mjs");
    yield* Effect.promise(async () => {
      await NodeFSP.writeFile(binaryPath, source);
      await NodeFSP.chmod(binaryPath, 0o755);
    });
    return {
      home,
      settings: {
        providerInstances: {
          [ProviderInstanceId.make("claude-alt")]: {
            driver: "claudeAgent",
            displayName: "Claude Alt",
            config: { binaryPath, homePath: home },
          },
          [ProviderInstanceId.make("codex")]: {
            driver: "codex",
            config: { binaryPath: "codex" },
          },
        },
      },
    };
  });

const makeService = (settings: Parameters<typeof ServerSettings.layerTest>[0]) =>
  ProviderLoginService.make.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, ServerSettings.layerTest(settings))),
  );

describe("ProviderLoginService", () => {
  it.live("returns the CLI's authorization URL and accepts the pasted code", () =>
    Effect.gen(function* () {
      const { settings } = yield* setup(STUB_CLI);
      const service = yield* makeService(settings);

      const started = yield* service.start({ instanceId: ProviderInstanceId.make("claude-alt") });
      assert.strictEqual(started.authorizeUrl, AUTHORIZE_URL);

      const submitted = yield* service.submit({ loginId: started.loginId, code: "good-code" });
      assert.strictEqual(submitted.accountLabel, "Claude Alt");
    }).pipe(Effect.scoped),
  );

  it.live("reports the CLI's own message when it rejects the code", () =>
    Effect.gen(function* () {
      const { settings } = yield* setup(STUB_CLI);
      const service = yield* makeService(settings);

      const started = yield* service.start({ instanceId: ProviderInstanceId.make("claude-alt") });
      const failure = yield* Effect.flip(
        service.submit({ loginId: started.loginId, code: "wrong-code" }),
      );
      assert.strictEqual(failure.reason, "login-failed");
      assert.strictEqual(failure.message, "That code was not accepted.");

      // The attempt is spent, so the same id cannot be submitted twice.
      const reused = yield* Effect.flip(
        service.submit({ loginId: started.loginId, code: "good-code" }),
      );
      assert.strictEqual(reused.reason, "login-not-pending");
    }).pipe(Effect.scoped),
  );

  it.live("fails with the CLI output when no URL is printed", () =>
    Effect.gen(function* () {
      const { settings } = yield* setup(FAILING_CLI);
      const service = yield* makeService(settings);

      const failure = yield* Effect.flip(
        service.start({ instanceId: ProviderInstanceId.make("claude-alt") }),
      );
      assert.strictEqual(failure.reason, "login-failed");
      assert.strictEqual(failure.message, "not logged in: profile missing");
    }).pipe(Effect.scoped),
  );

  it.live("accepts a sign-in the browser completed without a pasted code", () =>
    Effect.gen(function* () {
      const { settings } = yield* setup(SELF_COMPLETING_CLI);
      const service = yield* makeService(settings);

      const started = yield* service.start({ instanceId: ProviderInstanceId.make("claude-alt") });
      // No code: the CLI exits on its own once the browser callback lands.
      const submitted = yield* service.submit({ loginId: started.loginId, code: "" });
      assert.strictEqual(submitted.accountLabel, "Claude Alt");
    }).pipe(Effect.scoped),
  );

  it.live("refuses instances it cannot sign in", () =>
    Effect.gen(function* () {
      const { settings } = yield* setup(STUB_CLI);
      const service = yield* makeService(settings);

      const unsupported = yield* Effect.flip(
        service.start({ instanceId: ProviderInstanceId.make("codex") }),
      );
      assert.strictEqual(unsupported.reason, "unsupported-provider");

      const missing = yield* Effect.flip(
        service.start({ instanceId: ProviderInstanceId.make("claude-missing") }),
      );
      assert.strictEqual(missing.reason, "instance-not-found");
    }).pipe(Effect.scoped),
  );
});

import { query, type SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSettings,
  CodexSettings,
  resolveProviderInstanceEnabled,
  type ProviderLimitBucket,
  type ProviderLimitsAccount,
  type ProviderLimitsSnapshot,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";

import { ServerSettingsService } from "../serverSettings.ts";
import { buildCodexInitializeParams } from "../provider/Layers/CodexProvider.ts";
import { codexSessionAppServerArgs } from "../provider/Layers/codexLaunchArgs.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { resolveClaudeSdkExecutablePath } from "../provider/Drivers/ClaudeExecutable.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";

const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

export class ProviderLimitsProbeError extends Schema.TaggedErrorClass<ProviderLimitsProbeError>()(
  "ProviderLimitsProbeError",
  { cause: Schema.Defect() },
) {}

const PROVIDER_LIMITS_PROBE_TIMEOUT = "10 seconds";
const PROVIDER_LIMITS_PROBE_CONCURRENCY = 8;

export type ClaudeRateLimits = NonNullable<SDKControlGetUsageResponse["rate_limits"]> & {
  readonly limits?: ReadonlyArray<{
    readonly kind?: string;
    readonly percent?: number | null;
    readonly resets_at?: string | null;
    readonly scope?: { readonly model?: { readonly display_name?: string | null } | null } | null;
  }>;
  readonly model_scoped?: ReadonlyArray<{
    readonly display_name?: string | null;
    readonly utilization?: number | null;
    readonly resets_at?: string | null;
  }>;
};

export interface LimitProbeResult {
  readonly accountLabel: string | null;
  readonly plan: string | null;
  readonly available: boolean;
  readonly buckets: ProviderLimitBucket[];
}

export interface ProviderLimitsReaders<R> {
  readonly claude: (input: {
    readonly config: ClaudeSettings;
    readonly environment: NodeJS.ProcessEnv;
  }) => Effect.Effect<LimitProbeResult, ProviderLimitsProbeError, R>;
  readonly codex: (input: {
    readonly config: CodexSettings;
    readonly environment: NodeJS.ProcessEnv;
  }) => Effect.Effect<LimitProbeResult, ProviderLimitsProbeError, R>;
}

function claudeLimitLabel(
  kind: string | undefined,
  model: string | undefined,
  fallbackIndex: number,
): string {
  switch (kind) {
    case "session":
      return "5-hour session";
    case "weekly_all":
      return "Weekly";
    case "weekly_scoped":
      return model ? `Weekly ${model}` : "weekly scoped";
    default:
      return kind?.replaceAll("_", " ") || `Limit ${fallbackIndex + 1}`;
  }
}

export function normalizeClaudeBuckets(rateLimits: ClaudeRateLimits): ProviderLimitBucket[] {
  if (rateLimits.limits && rateLimits.limits.length > 0) {
    return rateLimits.limits.map((limit, index) => {
      const model = limit.scope?.model?.display_name?.trim();
      return {
        id: `${limit.kind ?? "limit"}:${model ?? index}`,
        label: claudeLimitLabel(limit.kind, model, index),
        usedPercent: limit.percent ?? null,
        resetsAt: limit.resets_at ?? null,
      };
    });
  }

  const buckets: ProviderLimitBucket[] = [];
  const add = (
    id: string,
    label: string,
    value: { utilization: number | null; resets_at: string | null } | null | undefined,
  ) => {
    if (!value) return;
    buckets.push({ id, label, usedPercent: value.utilization, resetsAt: value.resets_at });
  };
  add("five_hour", "5-hour session", rateLimits.five_hour);
  add("seven_day", "Weekly", rateLimits.seven_day);
  add("seven_day_opus", "Weekly Opus", rateLimits.seven_day_opus);
  add("seven_day_sonnet", "Weekly Sonnet", rateLimits.seven_day_sonnet);
  for (const [index, scoped] of (rateLimits.model_scoped ?? []).entries()) {
    const model = scoped.display_name?.trim() || `Model ${index + 1}`;
    add(`model:${model}`, `Weekly ${model}`, {
      utilization: scoped.utilization ?? null,
      resets_at: scoped.resets_at ?? null,
    });
  }
  return buckets;
}

const readClaudeLimits = Effect.fn("ProviderLimitsService.readClaudeLimits")(function* (input: {
  readonly config: ClaudeSettings;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const claudeEnvironment = yield* makeClaudeEnvironment(input.config, input.environment);
  const executable = yield* resolveClaudeSdkExecutablePath(
    input.config.binaryPath,
    claudeEnvironment,
  );
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener("abort", abort, { once: true });
      }
      async function* prompt() {
        if (!abortController.signal.aborted) {
          await new Promise<void>((resolve) =>
            abortController.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        yield* [];
      }
      const runtime = query({
        prompt: prompt(),
        options: {
          pathToClaudeCodeExecutable: executable,
          abortController,
          settingSources: ["user"],
          env: claudeEnvironment,
        },
      });
      try {
        const [usage, account] = await Promise.all([
          runtime.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
          runtime.accountInfo(),
        ]);
        return {
          accountLabel: account?.email ?? null,
          plan: usage.subscription_type,
          available: usage.rate_limits_available && usage.rate_limits !== null,
          buckets: usage.rate_limits
            ? normalizeClaudeBuckets(usage.rate_limits as ClaudeRateLimits)
            : [],
        };
      } finally {
        signal.removeEventListener("abort", abort);
        runtime.close();
        abortController.abort();
      }
    },
    catch: (cause) => new ProviderLimitsProbeError({ cause }),
  });
});

export function codexWindowLabel(
  durationMinutes: number | null | undefined,
  fallback: string,
): string {
  if (durationMinutes === 300) return "5-hour session";
  if (durationMinutes === 10_080) return "Weekly";
  return durationMinutes ? `${durationMinutes}-minute window` : fallback;
}

interface CodexLimitWindow {
  readonly usedPercent: number;
  readonly windowDurationMins?: number | null;
  readonly resetsAt?: number | null;
}

interface CodexLimitSnapshot {
  readonly limitId?: string | null;
  readonly limitName?: string | null;
  readonly primary?: CodexLimitWindow | null;
  readonly secondary?: CodexLimitWindow | null;
}

export const makeCodexLimitsEnvironment = Effect.fn(
  "ProviderLimitsService.makeCodexLimitsEnvironment",
)(function* (input: { readonly config: CodexSettings; readonly environment: NodeJS.ProcessEnv }) {
  const homeLayout = yield* resolveCodexHomeLayout(input.config);
  return {
    ...input.environment,
    ...(homeLayout.effectiveHomePath ? { CODEX_HOME: homeLayout.effectiveHomePath } : {}),
  };
});

export function normalizeCodexBuckets(
  limitsById: Readonly<Record<string, CodexLimitSnapshot>>,
): ProviderLimitBucket[] {
  const buckets: ProviderLimitBucket[] = [];
  for (const [limitId, limits] of Object.entries(limitsById)) {
    const limitLabel = limits.limitName?.trim();
    for (const [windowId, fallbackLabel, window] of [
      ["primary", "Primary", limits.primary],
      ["secondary", "Secondary", limits.secondary],
    ] as const) {
      if (!window) continue;
      const windowLabel = codexWindowLabel(window.windowDurationMins, fallbackLabel);
      buckets.push({
        id: `${limitId}:${windowId}`,
        label: limitLabel ? `${limitLabel} · ${windowLabel}` : windowLabel,
        usedPercent: window.usedPercent,
        resetsAt:
          window.resetsAt == null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(window.resetsAt * 1000)),
      });
    }
  }
  return buckets;
}

const readCodexLimits = Effect.fn("ProviderLimitsService.readCodexLimits")(function* (input: {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const environment = yield* makeCodexLimitsEnvironment(input);
  const spawnCommand = yield* resolveSpawnCommand(
    input.config.binaryPath,
    codexSessionAppServerArgs(undefined, input.config.launchArgs),
    { env: environment },
  );
  const child = yield* spawner.spawn(
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
      forceKillAfter: "2 seconds",
    }),
  );
  const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
    Layer.build,
    Effect.provideService(Scope.Scope, scope),
  );
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );
  yield* client.request("initialize", buildCodexInitializeParams());
  yield* client.notify("initialized", undefined);
  const [response, accountResponse] = yield* Effect.all(
    [client.request("account/rateLimits/read", undefined), client.request("account/read", {})],
    { concurrency: "unbounded" },
  );
  const limitsById = response.rateLimitsByLimitId ?? {
    [response.rateLimits.limitId ?? "codex"]: response.rateLimits,
  };
  const buckets = normalizeCodexBuckets(limitsById);
  const account = accountResponse.account;
  const isChatGptAccount = account?.type === "chatgpt";
  return {
    accountLabel: isChatGptAccount ? account.email : null,
    plan: isChatGptAccount ? account.planType : (response.rateLimits.planType ?? null),
    available: buckets.length > 0,
    buckets,
  };
});

const liveReaders: ProviderLimitsReaders<Path.Path | ChildProcessSpawner.ChildProcessSpawner> = {
  claude: readClaudeLimits,
  codex: (input) =>
    Effect.scoped(readCodexLimits(input)).pipe(
      Effect.mapError((cause) => new ProviderLimitsProbeError({ cause })),
    ),
};

export function readProviderLimitsSnapshot<R>(input: {
  readonly settings: ServerSettings;
  readonly observedAt: string;
  readonly readers: ProviderLimitsReaders<R>;
}): Effect.Effect<ProviderLimitsSnapshot, never, R> {
  const instances = deriveProviderInstanceConfigMap(input.settings);
  const instanceEntries = Object.keys(instances).flatMap((instanceId) => {
    const instance = instances[instanceId as keyof typeof instances];
    return instance && (instance.driver === "claudeAgent" || instance.driver === "codex")
      ? [[instanceId, instance] as const]
      : [];
  });

  return Effect.forEach(
    instanceEntries,
    ([rawInstanceId, instance]) =>
      Effect.gen(function* () {
        const instanceId = rawInstanceId as ProviderLimitsAccount["instanceId"];
        const displayName = instance.displayName ?? rawInstanceId;
        const accountIdentity = {
          instanceId,
          driver: instance.driver,
          displayName,
          observedAt: input.observedAt,
        } as const;
        if (!resolveProviderInstanceEnabled(instance)) {
          return {
            ...accountIdentity,
            accountLabel: null,
            plan: null,
            status: "unavailable",
            buckets: [],
            detail: "Provider is disabled.",
          } satisfies ProviderLimitsAccount;
        }

        const environment = mergeProviderInstanceEnvironment(instance.environment);
        let probe: Effect.Effect<LimitProbeResult, ProviderLimitsProbeError, R>;
        if (instance.driver === "claudeAgent") {
          probe = decodeClaudeSettings(instance.config).pipe(
            Effect.flatMap((config) => input.readers.claude({ config, environment })),
            Effect.mapError((cause) => new ProviderLimitsProbeError({ cause })),
          );
        } else {
          probe = decodeCodexSettings(instance.config).pipe(
            Effect.flatMap((config) => input.readers.codex({ config, environment })),
            Effect.mapError((cause) => new ProviderLimitsProbeError({ cause })),
          );
        }
        const result = yield* Effect.result(
          probe.pipe(Effect.timeout(PROVIDER_LIMITS_PROBE_TIMEOUT)),
        );
        if (Result.isFailure(result)) {
          return {
            ...accountIdentity,
            accountLabel: null,
            plan: null,
            status: "error",
            buckets: [],
            detail: "Provider limits could not be read.",
          } satisfies ProviderLimitsAccount;
        }
        return {
          ...accountIdentity,
          accountLabel: result.success.accountLabel,
          plan: result.success.plan,
          status: result.success.available ? "ready" : "unavailable",
          buckets: result.success.buckets,
          detail: result.success.available
            ? null
            : "The account credential does not expose subscription limits.",
        } satisfies ProviderLimitsAccount;
      }),
    { concurrency: PROVIDER_LIMITS_PROBE_CONCURRENCY },
  ).pipe(
    Effect.map(
      (accounts) =>
        ({ readAt: input.observedAt, accounts, detail: null }) satisfies ProviderLimitsSnapshot,
    ),
  );
}

export class ProviderLimitsService extends Context.Service<
  ProviderLimitsService,
  {
    readonly read: Effect.Effect<
      ProviderLimitsSnapshot,
      never,
      Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >;
  }
>()("t3/limits/ProviderLimitsService") {}

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;

  const read = Effect.fn("ProviderLimitsService.read")(function* () {
    const settingsResult = yield* Effect.result(settingsService.getSettings);
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    if (Result.isFailure(settingsResult)) {
      return {
        readAt: observedAt,
        accounts: [],
        detail: "Provider settings could not be read.",
      } satisfies ProviderLimitsSnapshot;
    }
    return yield* readProviderLimitsSnapshot({
      settings: settingsResult.success,
      observedAt,
      readers: liveReaders,
    });
  });

  return ProviderLimitsService.of({ read: read() });
});

export const layer = Layer.effect(ProviderLimitsService, make);

export const layerTest = Layer.succeed(
  ProviderLimitsService,
  ProviderLimitsService.of({
    read: Effect.succeed({
      readAt: "1970-01-01T00:00:00.000Z",
      accounts: [],
      detail: null,
    }),
  }),
);

import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

/* ── Provider account sign-in ─────────────────────────────── */

/**
 * Signing in spans two calls because the CLI prints an authorization URL and
 * then blocks on stdin for the code the browser hands back. `loginId`
 * correlates the two.
 */
export const ProviderLoginStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderLoginStartInput = typeof ProviderLoginStartInput.Type;

export const ProviderLoginStartResult = Schema.Struct({
  loginId: Schema.String,
  authorizeUrl: Schema.String,
});
export type ProviderLoginStartResult = typeof ProviderLoginStartResult.Type;

export const ProviderLoginSubmitInput = Schema.Struct({
  loginId: Schema.String,
  code: Schema.String,
});
export type ProviderLoginSubmitInput = typeof ProviderLoginSubmitInput.Type;

export const ProviderLoginSubmitResult = Schema.Struct({
  /** Echoed back so the client can confirm which account was signed in. */
  accountLabel: Schema.NullOr(Schema.String),
});
export type ProviderLoginSubmitResult = typeof ProviderLoginSubmitResult.Type;

export const ProviderLoginErrorReason = Schema.Literals([
  "instance-not-found",
  "unsupported-provider",
  "login-not-pending",
  "login-pending",
  "login-failed",
]);
export type ProviderLoginErrorReason = typeof ProviderLoginErrorReason.Type;

export class ProviderLoginError extends Schema.TaggedErrorClass<ProviderLoginError>()(
  "ProviderLoginError",
  {
    reason: ProviderLoginErrorReason,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

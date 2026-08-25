import * as Schema from "effect/Schema";

import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ProviderLimitBucket = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  usedPercent: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(Schema.String),
});
export type ProviderLimitBucket = typeof ProviderLimitBucket.Type;

export const ProviderExtraUsage = Schema.Struct({
  usedCredits: Schema.NullOr(Schema.Number),
  monthlyLimit: Schema.NullOr(Schema.Number),
  usedPercent: Schema.NullOr(Schema.Number),
  currency: Schema.NullOr(Schema.String),
  decimalPlaces: Schema.Number,
});
export type ProviderExtraUsage = typeof ProviderExtraUsage.Type;

export const ProviderLimitsStatus = Schema.Literals(["ready", "unavailable", "error"]);
export type ProviderLimitsStatus = typeof ProviderLimitsStatus.Type;

export const ProviderLimitsAccount = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.String,
  accountLabel: Schema.NullOr(Schema.String),
  plan: Schema.NullOr(Schema.String),
  status: ProviderLimitsStatus,
  observedAt: Schema.String,
  buckets: Schema.Array(ProviderLimitBucket),
  extraUsage: Schema.optionalKey(ProviderExtraUsage),
  detail: Schema.NullOr(Schema.String),
});
export type ProviderLimitsAccount = typeof ProviderLimitsAccount.Type;

export const ProviderLimitsSnapshot = Schema.Struct({
  readAt: Schema.String,
  accounts: Schema.Array(ProviderLimitsAccount),
  detail: Schema.NullOr(Schema.String),
});
export type ProviderLimitsSnapshot = typeof ProviderLimitsSnapshot.Type;

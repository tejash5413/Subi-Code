export * as LearnSmartAccount from "./learnsmart-account.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"

const balance = Schema.NullOr(Schema.Number)
export const Snapshot = Schema.Struct({
  status: Schema.Literals(["idle", "loading", "allowed", "blocked", "unavailable"]),
  accountType: Schema.optional(Schema.Literals(["school", "individual"])),
  quotaMode: Schema.optional(Schema.Literals(["school_tokens", "individual_credits"])),
  models: Schema.Array(
    Schema.Struct({
      modelKey: Schema.String,
      displayName: Schema.String,
      contextLength: Schema.optional(Schema.Number),
    }),
  ),
  monthlyLimit: Schema.Struct({ configured: Schema.Boolean, monthlyTokenLimit: balance }),
  usage: Schema.Struct({
    status: Schema.Literals(["idle", "loading", "ready", "error"]),
    usedTokens: Schema.optional(Schema.Number),
    remainingTokens: Schema.optional(balance),
    errorCode: Schema.optional(Schema.String),
  }),
  credits: Schema.optional(
    Schema.Struct({
      health: Schema.String,
      totalAvailableMilli: balance,
      monthlyGrantMilli: balance,
      monthlyRemainingMilli: balance,
      rolloverRemainingMilli: balance,
      purchasedRemainingMilli: balance,
      reservedMilli: balance,
      cycleEndsAtMs: balance,
    }),
  ),
  subscription: Schema.optional(Schema.Struct({ active: Schema.Boolean, renewalDateMs: balance })),
  errorCode: Schema.optional(Schema.String),
  // True only when the connected gateway advertises the native protocol and assigned models are usable.
  inferenceAvailable: Schema.Boolean,
})
export type Snapshot = typeof Snapshot.Type

/** Safe account display over the existing per-location plugin RPC transport. */
export const Contract = Rpc.define({
  id: "subi.learnsmart.account",
  methods: {
    get: { input: Schema.toStandardSchemaV1(Schema.Struct({})), output: Schema.toStandardSchemaV1(Snapshot) },
  },
  events: {},
})

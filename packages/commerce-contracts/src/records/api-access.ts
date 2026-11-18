// Plan 78 step 2: the API scopes of Commerce admin credentials and the app
// installation that packages/commerce-client reads in
// src/admin-client.ts. `pnpm lint:commerce-spec` reads the scope list here.
import { Type, type Static } from "typebox";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  wireRecordParser,
} from "./wire-objects.ts";
import { Nullable } from "./client-wire-fields.ts";

export const COMMERCE_API_SCOPES = [
  "catalog:read",
  "catalog:write",
  "inventory:read",
  "inventory:write",
  "orders:read",
  "orders:write",
  "customers:read",
  "customers:write",
  "discounts:read",
  "discounts:write",
  // Gift cards and store credit (Plan 76 phase 8).
  "stored_value:read",
  "stored_value:write",
  "settings:read",
  "settings:write",
  "events:read",
  "webhooks:write",
  "entity_plane:read",
  "entity_plane:write",
  // Creates, lists and revokes the merchant's API keys (Plan 80 step 3). A
  // key may only grant scopes that its creator holds, and no key may hold
  // this scope or payments:record.
  "credentials:write",
  // Records provider results (captures, disputes, payment resolutions) that
  // Commerce does not check with the provider. Only an app installation may
  // hold it; an API key may not.
  "payments:record",
] as const;

export const commerceApiScopeSchema = Type.Union(
  COMMERCE_API_SCOPES.map(scopeLiteral),
);
export type CommerceApiScope = (typeof COMMERCE_API_SCOPES)[number];

function scopeLiteral(scope: CommerceApiScope) {
  return Type.Literal(scope);
}

/** `parseAppInstallation`: the token of one app on one merchant. */
export const commerceAppInstallationV1Schema = ReadonlyOpenObject({
  credentialId: Type.String(),
  appId: Type.String(),
  scopes: ImmutableArray(commerceApiScopeSchema),
  token: Type.String(),
});
export type CommerceAppInstallationV1 = Static<
  typeof commerceAppInstallationV1Schema
>;

export const parseCommerceAppInstallationV1Record = wireRecordParser(
  commerceAppInstallationV1Schema,
);

/**
 * The lifecycle of an API credential (Refactor 15, refactor 11): `active`,
 * then `revoked` by a person, by the revocation of the credential that issued
 * it, or by the merchant's closure, or `expired` at its `expiresAt`.
 */
export type CredentialState = "active" | "revoked" | "expired";

/** One API credential of a merchant: an API key or an app installation. */
export const commerceApiCredentialV1Schema = ReadonlyOpenObject({
  credentialId: Type.String(),
  kind: Type.Union([Type.Literal("api_key"), Type.Literal("app_installation")]),
  appId: Nullable(Type.String()),
  label: Type.String(),
  scopes: ImmutableArray(commerceApiScopeSchema),
  createdAt: Type.String(),
  revokedAt: Nullable(Type.String()),
  state: Type.Optional(
    Type.Union([
      Type.Literal("active"),
      Type.Literal("revoked"),
      Type.Literal("expired"),
    ]),
  ),
  /**
   * Who revoked it: `operator`, `credential:<id>`, `parent:<id>` when the
   * credential that issued it was revoked, or `merchant_closure`.
   */
  revokedBy: Type.Optional(Nullable(Type.String())),
  expiresAt: Type.Optional(Nullable(Type.String())),
  /** The app installation that issued this key; null for the operator. */
  parentCredentialId: Type.Optional(Nullable(Type.String())),
});
export type CommerceApiCredentialV1 = Static<
  typeof commerceApiCredentialV1Schema
>;

/** A new API key (Plan 80 step 3); `key` is shown only in this answer. */
export const commerceIssuedApiKeyV1Schema = ReadonlyOpenObject({
  ...commerceApiCredentialV1Schema.properties,
  key: Type.String(),
});
export type CommerceIssuedApiKeyV1 = Static<
  typeof commerceIssuedApiKeyV1Schema
>;

export const commerceApiCredentialsV1Schema = ReadonlyOpenObject({
  credentials: ImmutableArray(commerceApiCredentialV1Schema),
});
export type CommerceApiCredentialsV1 = Static<
  typeof commerceApiCredentialsV1Schema
>;

export const parseCommerceApiCredentialV1Record = wireRecordParser(
  commerceApiCredentialV1Schema,
);
export const parseCommerceIssuedApiKeyV1Record = wireRecordParser(
  commerceIssuedApiKeyV1Schema,
);
export const parseCommerceApiCredentialsV1Record = wireRecordParser(
  commerceApiCredentialsV1Schema,
);

/**
 * What a merchant's closure ended (Refactor 15, refactor 11): every
 * credential, every outbound webhook subscription and the provider links.
 * A repeated closure answers the first one.
 */
export const commerceMerchantClosureV1Schema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.merchant-closure.v1"),
  merchantId: Type.String(),
  closedAt: Type.String(),
  revokedCredentials: Type.Integer({ minimum: 0 }),
  removedWebhookSubscriptions: Type.Integer({ minimum: 0 }),
  removedStripeAccounts: Type.Integer({ minimum: 0 }),
  /** `revoked` at Square, `forgotten` here only, or `none`. */
  square: Type.Union([
    Type.Literal("revoked"),
    Type.Literal("forgotten"),
    Type.Literal("none"),
  ]),
});
export type CommerceMerchantClosureV1 = Static<
  typeof commerceMerchantClosureV1Schema
>;

export const parseCommerceMerchantClosureV1Record = wireRecordParser(
  commerceMerchantClosureV1Schema,
);

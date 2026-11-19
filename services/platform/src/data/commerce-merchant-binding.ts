import type { OrganisationDatabase } from "../database-handles";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../ids";
import type { Result } from "../result";
import type { OrganisationEnvironment } from "./control-plane";
import { decodeBase64Url, encodeBase64Url } from "@purin-labs/std";

declare const commerceBindingIdBrand: unique symbol;
declare const commerceMerchantIdBrand: unique symbol;
declare const commerceSigningKeyIdBrand: unique symbol;

export type CommerceBindingId = string & {
  readonly [commerceBindingIdBrand]: "CommerceBindingId";
};
export type CommerceEngineMerchantId = string & {
  readonly [commerceMerchantIdBrand]: "CommerceEngineMerchantId";
};
export type CommerceSigningKeyId = string & {
  readonly [commerceSigningKeyIdBrand]: "CommerceSigningKeyId";
};

export function parseCommerceBindingId(
  value: unknown,
): Result<CommerceBindingId, CommerceMerchantBindingError> {
  return parseCommerceId(value, "bindingId", "underclerk_binding_");
}

export function parseCommerceEngineMerchantId(
  value: unknown,
): Result<CommerceEngineMerchantId, CommerceMerchantBindingError> {
  return parseCommerceId(value, "merchantId", "merchant_");
}

export type CommerceMerchantBinding = Readonly<{
  bindingId: CommerceBindingId;
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  merchantId: CommerceEngineMerchantId;
  environment: OrganisationEnvironment;
  deliverySigningKeyId: CommerceSigningKeyId;
  deliverySigningPublicKey: Uint8Array;
  revision: number;
  createdAt: number;
  updatedAt: number;
}>;

type CommerceMerchantBindingError =
  | Readonly<{ code: "underclerk_binding_invalid"; field: string }>
  | Readonly<{ code: "underclerk_binding_not_found" }>
  | Readonly<{ code: "underclerk_binding_conflict" }>
  | Readonly<{ code: "underclerk_provision_failed" }>;

type BindingRow = Readonly<{
  bindingId: unknown;
  organisationId: unknown;
  integrationAccountId: unknown;
  merchantId: unknown;
  environment: unknown;
  deliverySigningKeyId: unknown;
  deliverySigningPublicKeyB64: unknown;
  revision: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}>;

export async function bindCommerceMerchant(
  input: Readonly<{
    db: OrganisationDatabase;
    bindingId: string;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    merchantId: string;
    environment: OrganisationEnvironment;
    deliverySigningKeyId: string;
    deliverySigningPublicKey: Uint8Array;
    now: number;
  }>,
): Promise<Result<CommerceMerchantBinding, CommerceMerchantBindingError>> {
  const identity = parseBindingIdentity(input);
  if (!identity.ok) return identity;
  const publicKeyB64 = encodeBase64Url(input.deliverySigningPublicKey);
  try {
    await input.db
      .prepare(
        `INSERT INTO underclerk_merchant_binding (
         binding_id, organisation_id, integration_account_id, merchant_id, environment,
         delivery_signing_key_id, delivery_signing_public_key_b64,
         revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        identity.value.bindingId,
        input.organisationId,
        input.integrationAccountId,
        identity.value.merchantId,
        input.environment,
        identity.value.deliverySigningKeyId,
        publicKeyB64,
        input.now,
        input.now,
      )
      .run();
  } catch {
    const existing = await resolveCommerceMerchantBinding({
      db: input.db,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
    });
    if (
      !existing.ok ||
      !bindingMatches(existing.value, {
        bindingId: identity.value.bindingId,
        merchantId: identity.value.merchantId,
        environment: input.environment,
        deliverySigningKeyId: identity.value.deliverySigningKeyId,
        deliverySigningPublicKey: input.deliverySigningPublicKey,
      })
    ) {
      return { ok: false, error: { code: "underclerk_binding_conflict" } };
    }
    return existing;
  }
  return resolveCommerceMerchantBinding({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
}

export async function resolveCommerceMerchantBinding(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
  }>,
): Promise<Result<CommerceMerchantBinding, CommerceMerchantBindingError>> {
  const row = await input.db
    .prepare(
      `SELECT binding_id AS bindingId, organisation_id AS organisationId,
            integration_account_id AS integrationAccountId, merchant_id AS merchantId,
            environment, delivery_signing_key_id AS deliverySigningKeyId,
            delivery_signing_public_key_b64 AS deliverySigningPublicKeyB64,
            revision, created_at AS createdAt, updated_at AS updatedAt
     FROM underclerk_merchant_binding
     WHERE organisation_id = ? AND integration_account_id = ?`,
    )
    .bind(input.organisationId, input.integrationAccountId)
    .first<BindingRow>();
  if (row === null)
    return { ok: false, error: { code: "underclerk_binding_not_found" } };
  return parseActiveBinding(row);
}

export async function resolveCommerceMerchantBindingById(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    bindingId: CommerceBindingId;
  }>,
): Promise<Result<CommerceMerchantBinding, CommerceMerchantBindingError>> {
  const row = await input.db
    .prepare(
      `SELECT binding_id AS bindingId, organisation_id AS organisationId,
            integration_account_id AS integrationAccountId, merchant_id AS merchantId,
            environment, delivery_signing_key_id AS deliverySigningKeyId,
            delivery_signing_public_key_b64 AS deliverySigningPublicKeyB64,
            revision, created_at AS createdAt, updated_at AS updatedAt
     FROM underclerk_merchant_binding
     WHERE organisation_id = ? AND binding_id = ?`,
    )
    .bind(input.organisationId, input.bindingId)
    .first<BindingRow>();
  if (row === null)
    return { ok: false, error: { code: "underclerk_binding_not_found" } };
  return parseActiveBinding(row);
}

export async function resolveOrganisationCommerceMerchantBinding(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    environment: OrganisationEnvironment;
  }>,
): Promise<Result<CommerceMerchantBinding, CommerceMerchantBindingError>> {
  const row = await input.db
    .prepare(
      `SELECT binding_id AS bindingId, organisation_id AS organisationId,
            integration_account_id AS integrationAccountId, merchant_id AS merchantId,
            environment, delivery_signing_key_id AS deliverySigningKeyId,
            delivery_signing_public_key_b64 AS deliverySigningPublicKeyB64,
            revision, created_at AS createdAt, updated_at AS updatedAt
     FROM underclerk_merchant_binding
     WHERE organisation_id = ? AND environment = ?`,
    )
    .bind(input.organisationId, input.environment)
    .first<BindingRow>();
  if (row === null)
    return { ok: false, error: { code: "underclerk_binding_not_found" } };
  return parseActiveBinding(row);
}

export async function resolveCurrentOrganisationCommerceMerchantBinding(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
  }>,
): Promise<Result<CommerceMerchantBinding, CommerceMerchantBindingError>> {
  const row = await input.db
    .prepare(
      `SELECT binding.binding_id AS bindingId, binding.organisation_id AS organisationId,
            binding.integration_account_id AS integrationAccountId,
            binding.merchant_id AS merchantId, binding.environment,
            binding.delivery_signing_key_id AS deliverySigningKeyId,
            binding.delivery_signing_public_key_b64 AS deliverySigningPublicKeyB64,
            binding.revision, binding.created_at AS createdAt,
            binding.updated_at AS updatedAt
       FROM underclerk_merchant_binding AS binding
       JOIN organisation_onboarding AS onboarding
         ON onboarding.organisation_id = binding.organisation_id
        AND onboarding.environment = binding.environment
      WHERE binding.organisation_id = ?`,
    )
    .bind(input.organisationId)
    .first<BindingRow>();
  if (row === null)
    return { ok: false, error: { code: "underclerk_binding_not_found" } };
  return parseActiveBinding(row);
}

/**
 * Ensures the entity-plane merchant exists independently of the selected
 * transaction authority. The callback owns the remote provisioning boundary;
 * this module owns the single local binding invariant.
 */
export async function ensureEntityPlaneCommerceMerchantBinding(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    environment: OrganisationEnvironment;
    bindingId: string;
    integrationAccountId: IntegrationAccountId;
    merchantId: string;
    deliverySigningKeyId: string;
    deliverySigningPublicKey: Uint8Array;
    now: number;
    provision: () => Promise<boolean>;
  }>,
): Promise<Result<CommerceMerchantBinding, CommerceMerchantBindingError>> {
  const existing = await resolveOrganisationCommerceMerchantBinding({
    db: input.db,
    organisationId: input.organisationId,
    environment: input.environment,
  });
  if (existing.ok) return existing;
  if (existing.error.code !== "underclerk_binding_not_found") return existing;
  try {
    if (!(await input.provision()))
      return { ok: false, error: { code: "underclerk_provision_failed" } };
  } catch {
    return { ok: false, error: { code: "underclerk_provision_failed" } };
  }
  return bindCommerceMerchant({
    db: input.db,
    bindingId: input.bindingId,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    merchantId: input.merchantId,
    environment: input.environment,
    deliverySigningKeyId: input.deliverySigningKeyId,
    deliverySigningPublicKey: input.deliverySigningPublicKey,
    now: input.now,
  });
}

function parseBindingIdentity(
  input: Readonly<{
    bindingId: string;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
    merchantId: string;
    deliverySigningKeyId: string;
    deliverySigningPublicKey: Uint8Array;
  }>,
): Result<
  Readonly<{
    bindingId: CommerceBindingId;
    merchantId: CommerceEngineMerchantId;
    deliverySigningKeyId: CommerceSigningKeyId;
  }>,
  CommerceMerchantBindingError
> {
  const bindingId = parseCommerceBindingId(input.bindingId);
  if (!bindingId.ok) return bindingId;
  const merchantId = parseCommerceEngineMerchantId(input.merchantId);
  if (!merchantId.ok) return merchantId;
  const signingKeyId = parseBoundedId(
    input.deliverySigningKeyId,
    "deliverySigningKeyId",
    "key_",
  );
  if (!signingKeyId.ok) return signingKeyId;
  if (input.deliverySigningPublicKey.byteLength !== 32)
    return invalid("deliverySigningPublicKey");
  return {
    ok: true,
    value: {
      bindingId: bindingId.value,
      merchantId: merchantId.value,
      deliverySigningKeyId: signingKeyId.value as CommerceSigningKeyId,
    },
  };
}

function parseActiveBinding(
  row: BindingRow,
): Result<CommerceMerchantBinding, CommerceMerchantBindingError> {
  if (
    typeof row.bindingId !== "string" ||
    typeof row.merchantId !== "string" ||
    typeof row.deliverySigningKeyId !== "string" ||
    typeof row.deliverySigningPublicKeyB64 !== "string" ||
    (row.environment !== "development" && row.environment !== "production") ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    typeof row.createdAt !== "number" ||
    !Number.isSafeInteger(row.createdAt) ||
    typeof row.updatedAt !== "number" ||
    !Number.isSafeInteger(row.updatedAt)
  ) {
    return invalid("row");
  }
  const organisationId =
    typeof row.organisationId === "string"
      ? parseOrganisationId(row.organisationId)
      : null;
  const integrationAccountId =
    typeof row.integrationAccountId === "string"
      ? parseIntegrationAccountId(row.integrationAccountId)
      : null;
  const identity =
    organisationId?.ok && integrationAccountId?.ok
      ? parseBindingIdentity({
          bindingId: row.bindingId,
          organisationId: organisationId.value,
          integrationAccountId: integrationAccountId.value,
          merchantId: row.merchantId,
          deliverySigningKeyId: row.deliverySigningKeyId,
          deliverySigningPublicKey:
            decodeBase64Url(row.deliverySigningPublicKeyB64) ??
            new Uint8Array(),
        })
      : invalid("identity");
  if (
    !identity.ok ||
    organisationId === null ||
    !organisationId.ok ||
    integrationAccountId === null ||
    !integrationAccountId.ok
  ) {
    return identity.ok ? invalid("identity") : identity;
  }
  return {
    ok: true,
    value: {
      ...identity.value,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      environment: row.environment,
      deliverySigningPublicKey:
        decodeBase64Url(row.deliverySigningPublicKeyB64) ?? new Uint8Array(),
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  };
}

function bindingMatches(
  existing: CommerceMerchantBinding,
  expected: Readonly<{
    bindingId: CommerceBindingId;
    merchantId: CommerceEngineMerchantId;
    environment: OrganisationEnvironment;
    deliverySigningKeyId: CommerceSigningKeyId;
    deliverySigningPublicKey: Uint8Array;
  }>,
): boolean {
  return (
    existing.bindingId === expected.bindingId &&
    existing.merchantId === expected.merchantId &&
    existing.environment === expected.environment &&
    existing.deliverySigningKeyId === expected.deliverySigningKeyId &&
    byteArraysEqual(
      existing.deliverySigningPublicKey,
      expected.deliverySigningPublicKey,
    )
  );
}

function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function parseCommerceId<T extends string>(
  value: unknown,
  field: string,
  prefix: string,
): Result<T, CommerceMerchantBindingError> {
  return typeof value === "string" &&
    value.startsWith(prefix) &&
    /^[a-z0-9_-]{8,160}$/u.test(value)
    ? { ok: true, value: value as T }
    : invalid(field);
}

function parseBoundedId(
  value: string,
  field: string,
  prefix: string,
): Result<string, CommerceMerchantBindingError> {
  return parseCommerceId(value, field, prefix);
}

function invalid(field: string): Result<never, CommerceMerchantBindingError> {
  return { ok: false, error: { code: "underclerk_binding_invalid", field } };
}

import {
  parseCheckoutProfileConfiguration,
  type CheckoutProfile,
  type CheckoutProfileLifecycle,
} from "@purin-labs/commerce-contracts";

import type { CommerceDatabase } from "./database.ts";
import { hasExactKeys, isPositiveInteger, isRecord } from "@purin-labs/std";

export type CheckoutProfileActivation = Readonly<{
  merchantId: string;
  storefrontId: string;
  checkoutProfileId: string;
  checkoutProfileRevision: number;
  activatedAt: string;
  activatedBy: string;
}>;

export type ActiveStorefrontCheckoutProfile = Readonly<{
  activation: CheckoutProfileActivation;
  profile: CheckoutProfile;
}>;

type CheckoutProfileRow = Readonly<{
  merchantId: string;
  checkoutProfileId: string;
  revision: number;
  name: string;
  configurationJson: string;
  lifecycleState: string;
  lifecycleJson: string;
}>;

type ActivationRow = Readonly<{
  merchantId: string;
  storefrontId: string;
  checkoutProfileId: string;
  checkoutProfileRevision: number;
  activatedAt: string;
  activatedBy: string;
}>;

type ExistsRow = Readonly<{ present: number }>;

export function insertProfile(
  database: CommerceDatabase,
  profile: CheckoutProfile,
  recordedAt: string,
): void {
  database
    .prepare(
      `INSERT INTO checkout_profile_revision (
       merchant_id, checkout_profile_id, revision, name, configuration_json,
       lifecycle_state, lifecycle_json, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      profile.merchantId,
      profile.checkoutProfileId,
      profile.revision,
      profile.name,
      JSON.stringify(profile.configuration),
      profile.lifecycle.state,
      JSON.stringify(profile.lifecycle),
      recordedAt,
    );
}

export function updateProfileLifecycle(
  database: CommerceDatabase,
  profile: CheckoutProfile,
): void {
  const result = database
    .prepare(
      `UPDATE checkout_profile_revision
     SET lifecycle_state = ?, lifecycle_json = ?
     WHERE merchant_id = ? AND checkout_profile_id = ? AND revision = ?`,
    )
    .run(
      profile.lifecycle.state,
      JSON.stringify(profile.lifecycle),
      profile.merchantId,
      profile.checkoutProfileId,
      profile.revision,
    );
  if (result.changes !== 1)
    throw new Error("Checkout profile lifecycle update lost its revision");
}

export function readLatestProfile(
  database: CommerceDatabase,
  merchantId: string,
  checkoutProfileId: string,
): CheckoutProfile | undefined {
  const row = database
    .prepare(
      `${profileSelect()}
     WHERE merchant_id = ? AND checkout_profile_id = ?
     ORDER BY revision DESC LIMIT 1`,
    )
    .get<CheckoutProfileRow>(merchantId, checkoutProfileId);
  return row === undefined ? undefined : parseStoredProfile(row);
}

export function readProfile(
  database: CommerceDatabase,
  merchantId: string,
  checkoutProfileId: string,
  revision: number,
): CheckoutProfile | undefined {
  const row = database
    .prepare(
      `${profileSelect()}
     WHERE merchant_id = ? AND checkout_profile_id = ? AND revision = ?`,
    )
    .get<CheckoutProfileRow>(merchantId, checkoutProfileId, revision);
  return row === undefined ? undefined : parseStoredProfile(row);
}

export function listLatestProfiles(
  database: CommerceDatabase,
  merchantId: string,
): readonly CheckoutProfile[] {
  return database
    .prepare(
      `SELECT profile.merchant_id AS merchantId,
            profile.checkout_profile_id AS checkoutProfileId,
            profile.revision,
            profile.name,
            profile.configuration_json AS configurationJson,
            profile.lifecycle_state AS lifecycleState,
            profile.lifecycle_json AS lifecycleJson
     FROM checkout_profile_revision AS profile
     WHERE profile.merchant_id = ?
       AND profile.revision = (
         SELECT MAX(candidate.revision)
         FROM checkout_profile_revision AS candidate
         WHERE candidate.merchant_id = profile.merchant_id
           AND candidate.checkout_profile_id = profile.checkout_profile_id
       )
     ORDER BY profile.name, profile.checkout_profile_id`,
    )
    .all<CheckoutProfileRow>(merchantId)
    .map(parseStoredProfile);
}

export function readActiveProfile(
  database: CommerceDatabase,
  merchantId: string,
  storefrontId: string,
): ActiveStorefrontCheckoutProfile | undefined {
  const activation = database
    .prepare(
      `SELECT merchant_id AS merchantId,
            storefront_id AS storefrontId,
            checkout_profile_id AS checkoutProfileId,
            checkout_profile_revision AS checkoutProfileRevision,
            activated_at AS activatedAt,
            activated_by AS activatedBy
     FROM storefront_checkout_profile_activation
     WHERE merchant_id = ? AND storefront_id = ?`,
    )
    .get<ActivationRow>(merchantId, storefrontId);
  if (activation === undefined) return undefined;
  const profile = readProfile(
    database,
    activation.merchantId,
    activation.checkoutProfileId,
    activation.checkoutProfileRevision,
  );
  if (profile === undefined)
    throw new Error("Checkout profile activation lost its profile revision");
  return { activation: parseActivation(activation), profile };
}

export function readActivationForProfile(
  database: CommerceDatabase,
  merchantId: string,
  checkoutProfileId: string,
  revision: number,
): CheckoutProfileActivation | undefined {
  const row = database
    .prepare(
      `SELECT merchant_id AS merchantId,
            storefront_id AS storefrontId,
            checkout_profile_id AS checkoutProfileId,
            checkout_profile_revision AS checkoutProfileRevision,
            activated_at AS activatedAt,
            activated_by AS activatedBy
     FROM storefront_checkout_profile_activation
     WHERE merchant_id = ? AND checkout_profile_id = ? AND checkout_profile_revision = ?
     ORDER BY storefront_id LIMIT 1`,
    )
    .get<ActivationRow>(merchantId, checkoutProfileId, revision);
  return row === undefined ? undefined : parseActivation(row);
}

export function listProfileActivations(
  database: CommerceDatabase,
  merchantId: string,
): readonly CheckoutProfileActivation[] {
  return database
    .prepare(
      `SELECT merchant_id AS merchantId,
            storefront_id AS storefrontId,
            checkout_profile_id AS checkoutProfileId,
            checkout_profile_revision AS checkoutProfileRevision,
            activated_at AS activatedAt,
            activated_by AS activatedBy
     FROM storefront_checkout_profile_activation
     WHERE merchant_id = ?
     ORDER BY storefront_id`,
    )
    .all<ActivationRow>(merchantId)
    .map(parseActivation);
}

export function writeActivation(
  database: CommerceDatabase,
  activation: CheckoutProfileActivation,
): void {
  database
    .prepare(
      `INSERT INTO storefront_checkout_profile_activation (
       merchant_id, storefront_id, checkout_profile_id, checkout_profile_revision,
       activated_at, activated_by
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (merchant_id, storefront_id) DO UPDATE SET
       checkout_profile_id = excluded.checkout_profile_id,
       checkout_profile_revision = excluded.checkout_profile_revision,
       activated_at = excluded.activated_at,
       activated_by = excluded.activated_by`,
    )
    .run(
      activation.merchantId,
      activation.storefrontId,
      activation.checkoutProfileId,
      activation.checkoutProfileRevision,
      activation.activatedAt,
      activation.activatedBy,
    );
}

export function merchantExists(
  database: CommerceDatabase,
  merchantId: string,
): boolean {
  return (
    database
      .prepare("SELECT 1 AS present FROM merchant WHERE merchant_id = ?")
      .get<ExistsRow>(merchantId)?.present === 1
  );
}

export function profileExists(
  database: CommerceDatabase,
  merchantId: string,
  checkoutProfileId: string,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS present FROM checkout_profile_revision
     WHERE merchant_id = ? AND checkout_profile_id = ? LIMIT 1`,
      )
      .get<ExistsRow>(merchantId, checkoutProfileId)?.present === 1
  );
}

export function storefrontExists(
  database: CommerceDatabase,
  merchantId: string,
  storefrontId: string,
): boolean {
  return (
    database
      .prepare(
        "SELECT 1 AS present FROM storefront WHERE merchant_id = ? AND storefront_id = ?",
      )
      .get<ExistsRow>(merchantId, storefrontId)?.present === 1
  );
}

export function listStorefrontIds(
  database: CommerceDatabase,
  merchantId: string,
): readonly string[] {
  return database
    .prepare(
      `SELECT storefront_id AS storefrontId
       FROM storefront
       WHERE merchant_id = ?
       ORDER BY storefront_id`,
    )
    .all<{ storefrontId: string }>(merchantId)
    .map(readStorefrontId);
}

function readStorefrontId(row: { storefrontId: string }): string {
  return row.storefrontId;
}

function profileSelect(): string {
  return `SELECT merchant_id AS merchantId,
                 checkout_profile_id AS checkoutProfileId,
                 revision,
                 name,
                 configuration_json AS configurationJson,
                 lifecycle_state AS lifecycleState,
                 lifecycle_json AS lifecycleJson
          FROM checkout_profile_revision`;
}

function parseStoredProfile(row: CheckoutProfileRow): CheckoutProfile {
  const configurationRaw = requireJson(
    row.configurationJson,
    "configuration_json",
  );
  const configuration = parseCheckoutProfileConfiguration(configurationRaw);
  if (!configuration.ok) {
    throw new Error(
      `Stored checkout profile configuration is invalid: ${configuration.error.field}`,
    );
  }
  if (!isPositiveInteger(row.revision)) {
    throw new Error("Stored checkout profile revision is invalid");
  }
  return {
    merchantId: requireStoredIdentity(row.merchantId, "merchant_id"),
    checkoutProfileId: requireStoredIdentity(
      row.checkoutProfileId,
      "checkout_profile_id",
    ),
    revision: row.revision,
    name: requireStoredIdentity(row.name, "name"),
    configuration: configuration.value,
    lifecycle: parseStoredLifecycle(row.lifecycleJson, row.lifecycleState),
  };
}

function parseStoredLifecycle(
  rawJson: string,
  state: string,
): CheckoutProfileLifecycle {
  const raw = requireJson(rawJson, "lifecycle_json");
  if (!isRecord(raw) || raw.state !== state) {
    throw new Error("Stored checkout profile lifecycle state is invalid");
  }
  switch (state) {
    case "draft":
      if (hasExactKeys(raw, ["state", "createdAt", "updatedAt"])) {
        const createdAt = requireStoredTimestamp(raw.createdAt, "createdAt");
        const updatedAt = requireStoredTimestamp(raw.updatedAt, "updatedAt");
        requireStoredTimestampOrder(createdAt, updatedAt, "draft lifecycle");
        return {
          state,
          createdAt,
          updatedAt,
        };
      }
      break;
    case "published":
      if (hasExactKeys(raw, ["state", "publishedAt", "publishedBy"])) {
        const publishedAt = requireStoredTimestamp(
          raw.publishedAt,
          "publishedAt",
        );
        return {
          state,
          publishedAt,
          publishedBy: requireStoredIdentity(raw.publishedBy, "publishedBy"),
        };
      }
      break;
    case "retired":
      if (
        hasExactKeys(raw, ["state", "publishedAt", "retiredAt", "retiredBy"])
      ) {
        const publishedAt = requireStoredTimestamp(
          raw.publishedAt,
          "publishedAt",
        );
        const retiredAt = requireStoredTimestamp(raw.retiredAt, "retiredAt");
        requireStoredTimestampOrder(
          publishedAt,
          retiredAt,
          "retired lifecycle",
        );
        return {
          state,
          publishedAt,
          retiredAt,
          retiredBy: requireStoredIdentity(raw.retiredBy, "retiredBy"),
        };
      }
      break;
  }
  throw new Error("Stored checkout profile lifecycle is invalid");
}

function parseActivation(row: ActivationRow): CheckoutProfileActivation {
  if (!isPositiveInteger(row.checkoutProfileRevision)) {
    throw new Error("Stored checkout profile activation revision is invalid");
  }
  return {
    merchantId: requireStoredIdentity(row.merchantId, "merchant_id"),
    storefrontId: requireStoredIdentity(row.storefrontId, "storefront_id"),
    checkoutProfileId: requireStoredIdentity(
      row.checkoutProfileId,
      "checkout_profile_id",
    ),
    checkoutProfileRevision: row.checkoutProfileRevision,
    activatedAt: requireStoredTimestamp(row.activatedAt, "activated_at"),
    activatedBy: requireStoredIdentity(row.activatedBy, "activated_by"),
  };
}

function requireStoredIdentity(raw: unknown, field: string): string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > 255 ||
    raw.trim() !== raw
  ) {
    throw new Error(`Stored checkout profile ${field} is invalid`);
  }
  return raw;
}

function requireStoredTimestamp(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.trim() !== raw) {
    throw new Error(`Stored checkout profile ${field} is invalid`);
  }
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds))
    throw new Error(`Stored checkout profile ${field} is invalid`);
  return new Date(milliseconds).toISOString();
}

function requireStoredTimestampOrder(
  previous: string,
  next: string,
  field: string,
): void {
  if (Date.parse(next) < Date.parse(previous)) {
    throw new Error(
      `Stored checkout profile ${field} timestamps are out of order`,
    );
  }
}

function requireJson(raw: string, field: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Stored checkout profile ${field} is invalid JSON`);
  }
}

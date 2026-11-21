import type { CommerceSystemKind } from "@purin-labs/contracts";
import type { OrganisationDatabase } from "../database-handles";
import {
  parseUserId,
  parseIntegrationAccountId,
  parseOrganisationId,
  type UserId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../ids";
import type { Result } from "../result";
import {
  resolveOrganisationCommerceSystemAuthority,
  type CommerceSystemRevision,
} from "./organisation-commerce-system";
import type { OrganisationQuerySource } from "./query-source";
import { isNonNegativeInteger, isPositiveInteger, isRecord } from "@purin-labs/std";

declare const capabilityActivationIdBrand: unique symbol;
declare const capabilityContractRevisionBrand: unique symbol;
declare const commerceLocationIdBrand: unique symbol;

type CapabilityActivationId = string & {
  readonly [capabilityActivationIdBrand]: "CapabilityActivationId";
};

export type CapabilityContractRevision = string & {
  readonly [capabilityContractRevisionBrand]: "CapabilityContractRevision";
};

export type CommerceLocationId = string & {
  readonly [commerceLocationIdBrand]: "CommerceLocationId";
};

export type CommerceCapability =
  | "core"
  | "food_service"
  | "retail_operations"
  | "online_commerce"
  | "returns"
  | "automation";

export type CapabilityScope =
  | Readonly<{ kind: "organisation" }>
  | Readonly<{ kind: "location"; locationId: CommerceLocationId }>;

type CapabilityAuthority = Readonly<{
  kind: CommerceSystemKind;
  integrationAccountId: IntegrationAccountId;
  commerceSystemRevision: CommerceSystemRevision;
}>;

type CapabilityActivationCommon = Readonly<{
  activationId: CapabilityActivationId;
  organisationId: OrganisationId;
  capability: CommerceCapability;
  scope: CapabilityScope;
  authority: CapabilityAuthority;
  contractRevision: CapabilityContractRevision;
  revision: number;
  configuredAt: number;
  configuredByUserId: UserId;
}>;

export type CommerceCapabilityActivation =
  | (CapabilityActivationCommon &
      Readonly<{
        lifecycle: Readonly<{ state: "configured" }>;
      }>)
  | (CapabilityActivationCommon &
      Readonly<{
        lifecycle: Readonly<{
          state: "active";
          activatedAt: number;
          activatedByUserId: UserId;
        }>;
      }>)
  | (CapabilityActivationCommon &
      Readonly<{
        lifecycle: Readonly<{
          state: "inactive";
          activatedAt: number;
          activatedByUserId: UserId;
          inactivatedAt: number;
          inactivatedByUserId: UserId;
          reason: string;
        }>;
      }>);

type ConfigureCapabilityOutcome =
  | Readonly<{ kind: "configured"; activation: CommerceCapabilityActivation }>
  | Readonly<{
      kind: "already_configured";
      activation: CommerceCapabilityActivation;
    }>;

type ActivateCapabilityOutcome =
  | Readonly<{ kind: "activated"; activation: CommerceCapabilityActivation }>
  | Readonly<{
      kind: "already_active";
      activation: CommerceCapabilityActivation;
    }>;

type InactivateCapabilityOutcome = Readonly<{
  kind: "inactivated";
  activation: CommerceCapabilityActivation;
}>;

type CommerceCapabilityAdmission =
  | Readonly<{ kind: "implicit" }>
  | Readonly<{ kind: "activated"; activation: CommerceCapabilityActivation }>;

export type CapabilityActivationError =
  | Readonly<{ code: "capability_activation_invalid"; field: string }>
  | Readonly<{ code: "capability_activation_not_found" }>
  | Readonly<{ code: "capability_activation_conflict" }>
  | Readonly<{ code: "capability_activation_revision_conflict" }>
  | Readonly<{ code: "capability_activation_lifecycle_conflict" }>
  | Readonly<{ code: "capability_activation_authority_mismatch" }>;

type CapabilityActivationRow = Readonly<{
  activationId: unknown;
  organisationId: unknown;
  capability: unknown;
  scopeKind: unknown;
  locationId: unknown;
  authorityKind: unknown;
  integrationAccountId: unknown;
  commerceSystemRevision: unknown;
  contractRevision: unknown;
  lifecycle: unknown;
  revision: unknown;
  configuredAt: unknown;
  configuredByUserId: unknown;
  activatedAt: unknown;
  activatedByUserId: unknown;
  inactivatedAt: unknown;
  inactivatedByUserId: unknown;
  inactivationReason: unknown;
}>;

const CAPABILITIES: readonly CommerceCapability[] = [
  "core",
  "food_service",
  "retail_operations",
  "online_commerce",
  "returns",
  "automation",
];

const IMPLICIT_CAPABILITIES: ReadonlySet<CommerceCapability> = new Set([
  "core",
  "online_commerce",
]);

export function parseCapabilityActivationId(
  value: unknown,
): Result<CapabilityActivationId, CapabilityActivationError> {
  return typeof value === "string" &&
    /^capability_activation_[A-Za-z0-9_-]{1,160}$/u.test(value)
    ? { ok: true, value: value as CapabilityActivationId }
    : invalid("activationId");
}

export function parseCapabilityContractRevision(
  value: unknown,
): Result<CapabilityContractRevision, CapabilityActivationError> {
  return isNormalizedIdentity(value, 128)
    ? { ok: true, value: value as CapabilityContractRevision }
    : invalid("contractRevision");
}

export function parseCommerceLocationId(
  value: unknown,
): Result<CommerceLocationId, CapabilityActivationError> {
  return isNormalizedIdentity(value, 200)
    ? { ok: true, value: value as CommerceLocationId }
    : invalid("locationId");
}

export function parseCommerceCapability(
  value: unknown,
): Result<CommerceCapability, CapabilityActivationError> {
  return typeof value === "string" &&
    CAPABILITIES.some(matchesCapability.bind(undefined, value))
    ? { ok: true, value: value as CommerceCapability }
    : invalid("capability");
}

export function parseCapabilityScope(
  value: unknown,
): Result<CapabilityScope, CapabilityActivationError> {
  if (!isRecord(value)) return invalid("scope");
  const keys = Object.keys(value);
  switch (value.kind) {
    case "organisation":
      return keys.length === 1
        ? { ok: true, value: { kind: "organisation" } }
        : invalid("scope");
    case "location": {
      const locationId = parseCommerceLocationId(value.locationId);
      return keys.length === 2 && locationId.ok
        ? {
            ok: true,
            value: { kind: "location", locationId: locationId.value },
          }
        : invalid("scope");
    }
    default:
      return invalid("scope");
  }
}

export async function configureCommerceCapability(
  input: Readonly<{
    db: OrganisationDatabase;
    activationId: CapabilityActivationId;
    organisationId: OrganisationId;
    capability: CommerceCapability;
    scope: CapabilityScope;
    contractRevision: CapabilityContractRevision;
    configuredByUserId: UserId;
    now: number;
  }>,
): Promise<Result<ConfigureCapabilityOutcome, CapabilityActivationError>> {
  if (!isNonNegativeInteger(input.now)) return invalid("now");
  const session = input.db.withSession("first-primary");
  const authority = await resolveActiveCapabilityAuthority({
    db: session,
    organisationId: input.organisationId,
    userId: input.configuredByUserId,
  });
  if (!authority.ok) return authority;
  const existing = await readCapabilityActivationByScope({
    db: session,
    organisationId: input.organisationId,
    capability: input.capability,
    scope: input.scope,
  });
  if (existing.ok) {
    return sameConfiguration(
      existing.value,
      authority.value,
      input.contractRevision,
    )
      ? {
          ok: true,
          value: { kind: "already_configured", activation: existing.value },
        }
      : { ok: false, error: { code: "capability_activation_conflict" } };
  }
  if (existing.error.code !== "capability_activation_not_found")
    return existing;
  const scope = persistenceScope(input.scope);
  try {
    await session
      .prepare(
        `INSERT INTO commerce_capability_activation (
         activation_id, organisation_id, capability, scope_kind, location_id,
         authority_kind, integration_account_id, commerce_system_revision,
         contract_revision, lifecycle, revision, configured_at,
         configured_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'configured', 1, ?, ?)`,
      )
      .bind(
        input.activationId,
        input.organisationId,
        input.capability,
        scope.kind,
        scope.locationId,
        authority.value.kind,
        authority.value.integrationAccountId,
        authority.value.commerceSystemRevision,
        input.contractRevision,
        input.now,
        input.configuredByUserId,
      )
      .run();
  } catch {
    return { ok: false, error: { code: "capability_activation_conflict" } };
  }
  const activation = await readCommerceCapabilityActivation({
    db: session,
    organisationId: input.organisationId,
    activationId: input.activationId,
  });
  return activation.ok
    ? { ok: true, value: { kind: "configured", activation: activation.value } }
    : activation;
}

export async function activateCommerceCapability(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    activationId: CapabilityActivationId;
    expectedRevision: number;
    activatedByUserId: UserId;
    now: number;
  }>,
): Promise<Result<ActivateCapabilityOutcome, CapabilityActivationError>> {
  if (!isPositiveInteger(input.expectedRevision))
    return invalid("expectedRevision");
  if (!isNonNegativeInteger(input.now)) return invalid("now");
  const session = input.db.withSession("first-primary");
  const current = await readCommerceCapabilityActivation({
    db: session,
    organisationId: input.organisationId,
    activationId: input.activationId,
  });
  if (!current.ok) return current;
  if (current.value.revision !== input.expectedRevision) {
    return {
      ok: false,
      error: { code: "capability_activation_revision_conflict" },
    };
  }
  const authority = await resolveActiveCapabilityAuthority({
    db: session,
    organisationId: input.organisationId,
    userId: input.activatedByUserId,
  });
  if (!authority.ok) return authority;
  if (!sameAuthority(current.value.authority, authority.value)) {
    return {
      ok: false,
      error: { code: "capability_activation_authority_mismatch" },
    };
  }
  if (current.value.lifecycle.state === "active") {
    return {
      ok: true,
      value: { kind: "already_active", activation: current.value },
    };
  }
  if (
    current.value.lifecycle.state !== "configured" &&
    current.value.lifecycle.state !== "inactive"
  ) {
    return {
      ok: false,
      error: { code: "capability_activation_lifecycle_conflict" },
    };
  }
  const updated = await session
    .prepare(
      `UPDATE commerce_capability_activation
     SET lifecycle = 'active', revision = revision + 1,
         activated_at = ?, activated_by_user_id = ?,
         inactivated_at = NULL, inactivated_by_user_id = NULL,
         inactivation_reason = NULL
     WHERE activation_id = ? AND organisation_id = ? AND revision = ?
       AND lifecycle IN ('configured', 'inactive')`,
    )
    .bind(
      input.now,
      input.activatedByUserId,
      input.activationId,
      input.organisationId,
      input.expectedRevision,
    )
    .run();
  if (updated.meta.changes !== 1) {
    return {
      ok: false,
      error: { code: "capability_activation_revision_conflict" },
    };
  }
  const activation = await readCommerceCapabilityActivation({
    db: session,
    organisationId: input.organisationId,
    activationId: input.activationId,
  });
  return activation.ok
    ? { ok: true, value: { kind: "activated", activation: activation.value } }
    : activation;
}

export async function inactivateCommerceCapability(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    activationId: CapabilityActivationId;
    expectedRevision: number;
    reason: string;
    inactivatedByUserId: UserId;
    now: number;
  }>,
): Promise<Result<InactivateCapabilityOutcome, CapabilityActivationError>> {
  if (!isPositiveInteger(input.expectedRevision))
    return invalid("expectedRevision");
  if (!isNonNegativeInteger(input.now)) return invalid("now");
  if (!isNormalizedIdentity(input.reason, 200)) return invalid("reason");
  const session = input.db.withSession("first-primary");
  const current = await readCommerceCapabilityActivation({
    db: session,
    organisationId: input.organisationId,
    activationId: input.activationId,
  });
  if (!current.ok) return current;
  if (current.value.revision !== input.expectedRevision) {
    return {
      ok: false,
      error: { code: "capability_activation_revision_conflict" },
    };
  }
  if (current.value.lifecycle.state !== "active") {
    return {
      ok: false,
      error: { code: "capability_activation_lifecycle_conflict" },
    };
  }
  const authority = await resolveActiveCapabilityAuthority({
    db: session,
    organisationId: input.organisationId,
    userId: input.inactivatedByUserId,
  });
  if (!authority.ok) return authority;
  if (!sameAuthority(current.value.authority, authority.value)) {
    return {
      ok: false,
      error: { code: "capability_activation_authority_mismatch" },
    };
  }
  const updated = await session
    .prepare(
      `UPDATE commerce_capability_activation
     SET lifecycle = 'inactive', revision = revision + 1,
         inactivated_at = ?, inactivated_by_user_id = ?,
         inactivation_reason = ?
     WHERE activation_id = ? AND organisation_id = ? AND revision = ?
       AND lifecycle = 'active'`,
    )
    .bind(
      input.now,
      input.inactivatedByUserId,
      input.reason,
      input.activationId,
      input.organisationId,
      input.expectedRevision,
    )
    .run();
  if (updated.meta.changes !== 1) {
    return {
      ok: false,
      error: { code: "capability_activation_revision_conflict" },
    };
  }
  const activation = await readCommerceCapabilityActivation({
    db: session,
    organisationId: input.organisationId,
    activationId: input.activationId,
  });
  return activation.ok
    ? { ok: true, value: { kind: "inactivated", activation: activation.value } }
    : activation;
}

export async function requireActiveCommerceCapability(
  input: Readonly<{
    db: OrganisationQuerySource;
    organisationId: OrganisationId;
    capability: CommerceCapability;
    scope: CapabilityScope;
  }>,
): Promise<Result<CommerceCapabilityActivation, CapabilityActivationError>> {
  const activation = await readCapabilityActivationByScope(input);
  if (!activation.ok) return activation;
  if (activation.value.lifecycle.state !== "active") {
    return {
      ok: false,
      error: { code: "capability_activation_lifecycle_conflict" },
    };
  }
  if (!(await capabilityRuntimeIsActive(input.db, input.organisationId))) {
    return {
      ok: false,
      error: { code: "capability_activation_authority_mismatch" },
    };
  }
  const authority = await resolveOrganisationCommerceSystemAuthority({
    db: input.db,
    organisationId: input.organisationId,
  });
  if (!authority.ok) {
    return {
      ok: false,
      error: { code: "capability_activation_authority_mismatch" },
    };
  }
  const currentAuthority = capabilityAuthority(authority.value);
  return sameAuthority(activation.value.authority, currentAuthority)
    ? activation
    : {
        ok: false,
        error: { code: "capability_activation_authority_mismatch" },
      };
}

export async function admitCommerceCapability(
  input: Readonly<{
    db: OrganisationQuerySource;
    organisationId: OrganisationId;
    capability: CommerceCapability;
    scope: CapabilityScope;
  }>,
): Promise<Result<CommerceCapabilityAdmission, CapabilityActivationError>> {
  const activation = await requireActiveCommerceCapability(input);
  if (activation.ok) {
    return {
      ok: true,
      value: { kind: "activated", activation: activation.value },
    };
  }
  return activation.error.code === "capability_activation_not_found" &&
    IMPLICIT_CAPABILITIES.has(input.capability)
    ? { ok: true, value: { kind: "implicit" } }
    : activation;
}

async function capabilityRuntimeIsActive(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS active
     FROM organisation
     JOIN organisation_onboarding AS onboarding
       ON onboarding.organisation_id = organisation.organisation_id
     WHERE organisation.organisation_id = ? AND organisation.status = 'active'
       AND onboarding.lifecycle = 'active'`,
    )
    .bind(organisationId)
    .first<{ readonly active: unknown }>();
  return row?.active === 1;
}

export async function readCommerceCapabilityActivation(
  input: Readonly<{
    db: OrganisationQuerySource;
    organisationId: OrganisationId;
    activationId: CapabilityActivationId;
  }>,
): Promise<Result<CommerceCapabilityActivation, CapabilityActivationError>> {
  const row = await input.db
    .prepare(
      `${CAPABILITY_ACTIVATION_SELECT}
     WHERE activation.organisation_id = ? AND activation.activation_id = ?`,
    )
    .bind(input.organisationId, input.activationId)
    .first<CapabilityActivationRow>();
  return row === null
    ? { ok: false, error: { code: "capability_activation_not_found" } }
    : parseCapabilityActivationRow(row);
}

export async function listCommerceCapabilityActivations(
  input: Readonly<{
    db: OrganisationQuerySource;
    organisationId: OrganisationId;
  }>,
): Promise<
  Result<readonly CommerceCapabilityActivation[], CapabilityActivationError>
> {
  const rows = await input.db
    .prepare(
      `${CAPABILITY_ACTIVATION_SELECT}
     WHERE activation.organisation_id = ?
     ORDER BY activation.capability, activation.scope_kind, activation.location_id`,
    )
    .bind(input.organisationId)
    .all<CapabilityActivationRow>();
  const activations: CommerceCapabilityActivation[] = [];
  for (const row of rows.results) {
    const parsed = parseCapabilityActivationRow(row);
    if (!parsed.ok) return parsed;
    activations.push(parsed.value);
  }
  return { ok: true, value: activations };
}

async function readCapabilityActivationByScope(
  input: Readonly<{
    db: OrganisationQuerySource;
    organisationId: OrganisationId;
    capability: CommerceCapability;
    scope: CapabilityScope;
  }>,
): Promise<Result<CommerceCapabilityActivation, CapabilityActivationError>> {
  const scope = persistenceScope(input.scope);
  const row = await input.db
    .prepare(
      `${CAPABILITY_ACTIVATION_SELECT}
     WHERE activation.organisation_id = ? AND activation.capability = ?
       AND activation.scope_kind = ? AND activation.location_id IS ?`,
    )
    .bind(input.organisationId, input.capability, scope.kind, scope.locationId)
    .first<CapabilityActivationRow>();
  return row === null
    ? { ok: false, error: { code: "capability_activation_not_found" } }
    : parseCapabilityActivationRow(row);
}

async function resolveActiveCapabilityAuthority(
  input: Readonly<{
    db: OrganisationQuerySource;
    organisationId: OrganisationId;
    userId: UserId;
  }>,
): Promise<Result<CapabilityAuthority, CapabilityActivationError>> {
  const admitted = await input.db
    .prepare(
      `SELECT 1 AS admitted
     FROM organisation
     JOIN organisation_onboarding AS onboarding
       ON onboarding.organisation_id = organisation.organisation_id
     JOIN service_role_grant AS membership
       ON membership.organisation_id = organisation.organisation_id
      AND membership.user_id = ?
      AND membership.status = 'active'
     WHERE organisation.organisation_id = ? AND organisation.status = 'active'
       AND onboarding.lifecycle = 'active'`,
    )
    .bind(input.userId, input.organisationId)
    .first<{ readonly admitted: unknown }>();
  if (admitted?.admitted !== 1) {
    return {
      ok: false,
      error: { code: "capability_activation_authority_mismatch" },
    };
  }
  const authority = await resolveOrganisationCommerceSystemAuthority({
    db: input.db,
    organisationId: input.organisationId,
  });
  return authority.ok
    ? { ok: true, value: capabilityAuthority(authority.value) }
    : {
        ok: false,
        error: { code: "capability_activation_authority_mismatch" },
      };
}

function capabilityAuthority(
  authority: Awaited<
    ReturnType<typeof resolveOrganisationCommerceSystemAuthority>
  > extends Result<infer Value, unknown>
    ? Value
    : never,
): CapabilityAuthority {
  return {
    kind: authority.commerceSystem.kind,
    integrationAccountId: authority.integrationAccountId,
    commerceSystemRevision: authority.commerceSystem.revision,
  };
}

function parseCapabilityActivationRow(
  row: CapabilityActivationRow,
): Result<CommerceCapabilityActivation, CapabilityActivationError> {
  const activationId = parseCapabilityActivationId(row.activationId);
  const organisationId =
    typeof row.organisationId === "string"
      ? parseOrganisationId(row.organisationId)
      : null;
  const capability = parseCommerceCapability(row.capability);
  const scope = parsePersistedScope(row.scopeKind, row.locationId);
  const authority = parsePersistedAuthority(row);
  const contractRevision = parseCapabilityContractRevision(
    row.contractRevision,
  );
  const configuredBy =
    typeof row.configuredByUserId === "string"
      ? parseUserId(row.configuredByUserId)
      : null;
  if (
    !activationId.ok ||
    organisationId === null ||
    !organisationId.ok ||
    !capability.ok ||
    !scope.ok ||
    !authority.ok ||
    !contractRevision.ok ||
    configuredBy === null ||
    !configuredBy.ok ||
    !isPositiveInteger(row.revision) ||
    !isNonNegativeInteger(row.configuredAt)
  ) {
    return invalid("row");
  }
  const common: CapabilityActivationCommon = {
    activationId: activationId.value,
    organisationId: organisationId.value,
    capability: capability.value,
    scope: scope.value,
    authority: authority.value,
    contractRevision: contractRevision.value,
    revision: row.revision,
    configuredAt: row.configuredAt,
    configuredByUserId: configuredBy.value,
  };
  switch (row.lifecycle) {
    case "configured":
      return hasNoActivationFields(row)
        ? { ok: true, value: { ...common, lifecycle: { state: "configured" } } }
        : invalid("row");
    case "active": {
      const activatedBy =
        typeof row.activatedByUserId === "string"
          ? parseUserId(row.activatedByUserId)
          : null;
      return isNonNegativeInteger(row.activatedAt) &&
        activatedBy !== null &&
        activatedBy.ok &&
        row.inactivatedAt === null &&
        row.inactivatedByUserId === null &&
        row.inactivationReason === null
        ? {
            ok: true,
            value: {
              ...common,
              lifecycle: {
                state: "active",
                activatedAt: row.activatedAt,
                activatedByUserId: activatedBy.value,
              },
            },
          }
        : invalid("row");
    }
    case "inactive":
      return parseInactiveActivation(row, common);
    default:
      return invalid("row");
  }
}

function parseInactiveActivation(
  row: CapabilityActivationRow,
  common: CapabilityActivationCommon,
): Result<CommerceCapabilityActivation, CapabilityActivationError> {
  const activatedBy =
    typeof row.activatedByUserId === "string"
      ? parseUserId(row.activatedByUserId)
      : null;
  const inactivatedBy =
    typeof row.inactivatedByUserId === "string"
      ? parseUserId(row.inactivatedByUserId)
      : null;
  return isNonNegativeInteger(row.activatedAt) &&
    activatedBy !== null &&
    activatedBy.ok &&
    isNonNegativeInteger(row.inactivatedAt) &&
    inactivatedBy !== null &&
    inactivatedBy.ok &&
    isNormalizedIdentity(row.inactivationReason, 200)
    ? {
        ok: true,
        value: {
          ...common,
          lifecycle: {
            state: "inactive",
            activatedAt: row.activatedAt,
            activatedByUserId: activatedBy.value,
            inactivatedAt: row.inactivatedAt,
            inactivatedByUserId: inactivatedBy.value,
            reason: row.inactivationReason,
          },
        },
      }
    : invalid("row");
}

function parsePersistedScope(
  scopeKind: unknown,
  locationId: unknown,
): Result<CapabilityScope, CapabilityActivationError> {
  if (scopeKind === "organisation" && locationId === null) {
    return { ok: true, value: { kind: "organisation" } };
  }
  if (scopeKind === "location") {
    const parsed = parseCommerceLocationId(locationId);
    return parsed.ok
      ? { ok: true, value: { kind: "location", locationId: parsed.value } }
      : parsed;
  }
  return invalid("row");
}

function parsePersistedAuthority(
  row: CapabilityActivationRow,
): Result<CapabilityAuthority, CapabilityActivationError> {
  const integrationAccountId =
    typeof row.integrationAccountId === "string"
      ? parseIntegrationAccountId(row.integrationAccountId)
      : null;
  if (
    (row.authorityKind !== "satyr_commerce" &&
      row.authorityKind !== "shopify") ||
    integrationAccountId === null ||
    !integrationAccountId.ok ||
    !isPositiveInteger(row.commerceSystemRevision)
  ) {
    return invalid("row");
  }
  return {
    ok: true,
    value: {
      kind: row.authorityKind,
      integrationAccountId: integrationAccountId.value,
      commerceSystemRevision:
        row.commerceSystemRevision as CommerceSystemRevision,
    },
  };
}

function sameConfiguration(
  activation: CommerceCapabilityActivation,
  authority: CapabilityAuthority,
  contractRevision: CapabilityContractRevision,
): boolean {
  return (
    sameAuthority(activation.authority, authority) &&
    activation.contractRevision === contractRevision
  );
}

function sameAuthority(
  left: CapabilityAuthority,
  right: CapabilityAuthority,
): boolean {
  return (
    left.kind === right.kind &&
    left.integrationAccountId === right.integrationAccountId &&
    left.commerceSystemRevision === right.commerceSystemRevision
  );
}

function persistenceScope(scope: CapabilityScope): Readonly<{
  kind: "organisation" | "location";
  locationId: CommerceLocationId | null;
}> {
  switch (scope.kind) {
    case "organisation":
      return { kind: "organisation", locationId: null };
    case "location":
      return { kind: "location", locationId: scope.locationId };
  }
}

function matchesCapability(
  value: string,
  capability: CommerceCapability,
): boolean {
  return value === capability;
}

function hasNoActivationFields(row: CapabilityActivationRow): boolean {
  return (
    row.activatedAt === null &&
    row.activatedByUserId === null &&
    row.inactivatedAt === null &&
    row.inactivatedByUserId === null &&
    row.inactivationReason === null
  );
}

function isNormalizedIdentity(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim()
  );
}

function invalid(field: string): Result<never, CapabilityActivationError> {
  return { ok: false, error: { code: "capability_activation_invalid", field } };
}

const CAPABILITY_ACTIVATION_SELECT = `
  SELECT activation.activation_id AS activationId,
         activation.organisation_id AS organisationId,
         activation.capability,
         activation.scope_kind AS scopeKind,
         activation.location_id AS locationId,
         activation.authority_kind AS authorityKind,
         activation.integration_account_id AS integrationAccountId,
         activation.commerce_system_revision AS commerceSystemRevision,
         activation.contract_revision AS contractRevision,
         activation.lifecycle,
         activation.revision,
         activation.configured_at AS configuredAt,
         activation.configured_by_user_id AS configuredByUserId,
         activation.activated_at AS activatedAt,
         activation.activated_by_user_id AS activatedByUserId,
         activation.inactivated_at AS inactivatedAt,
         activation.inactivated_by_user_id AS inactivatedByUserId,
         activation.inactivation_reason AS inactivationReason
  FROM commerce_capability_activation AS activation`;

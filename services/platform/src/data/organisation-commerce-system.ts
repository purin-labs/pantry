import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "../database-handles";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  type UserId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../ids";
import type { Result } from "../result";
import type { OrganisationEnvironment } from "./control-plane";
import {
  parseCommerceBindingId,
  parseCommerceEngineMerchantId,
  type CommerceBindingId,
  type CommerceEngineMerchantId,
} from "./commerce-merchant-binding";
import type { OrganisationQuerySource } from "./query-source";

declare const commerceSystemRevisionBrand: unique symbol;
declare const shopifyShopDomainBrand: unique symbol;

export type CommerceSystemRevision = number & {
  readonly [commerceSystemRevisionBrand]: "CommerceSystemRevision";
};
export type ShopifyShopDomain = string & {
  readonly [shopifyShopDomainBrand]: "ShopifyShopDomain";
};

export type CommerceSystem =
  | Readonly<{
      kind: "satyr_commerce";
      organisationId: OrganisationId;
      bindingId: CommerceBindingId;
      merchantId: CommerceEngineMerchantId;
      revision: CommerceSystemRevision;
    }>
  | Readonly<{
      kind: "shopify";
      organisationId: OrganisationId;
      integrationAccountId: IntegrationAccountId;
      shopDomain: ShopifyShopDomain;
      revision: CommerceSystemRevision;
    }>;

export type CommerceSystemSelection =
  | Readonly<{
      kind: "select_satyr_commerce";
      expectedRevision: number;
      underclerkBindingId: CommerceBindingId;
    }>
  | Readonly<{
      kind: "select_shopify";
      expectedRevision: number;
      integrationAccountId: IntegrationAccountId;
    }>;

export type CommerceSystemSelectionOutcome =
  | Readonly<{ kind: "selected"; commerceSystem: CommerceSystem }>
  | Readonly<{ kind: "already_selected"; commerceSystem: CommerceSystem }>;

export type CommerceSystemError =
  | Readonly<{ code: "commerce_system_invalid"; field: string }>
  | Readonly<{ code: "commerce_system_not_found" }>
  | Readonly<{ code: "commerce_system_authority_mismatch" }>
  | Readonly<{ code: "commerce_system_revision_conflict" }>
  | Readonly<{ code: "commerce_system_switch_requires_migration" }>;

export type CommerceSystemProviderAuthority = Readonly<{
  commerceSystem: CommerceSystem;
  provider: "underclerk" | "shopify";
  integrationAccountId: IntegrationAccountId;
}>;

type CommerceSystemRow = Readonly<{
  organisationId: unknown;
  systemKind: unknown;
  underclerkBindingId: unknown;
  underclerkMerchantId: unknown;
  shopifyIntegrationAccountId: unknown;
  shopDomain: unknown;
  revision: unknown;
}>;

type OrganisationSelectionState = Readonly<{
  lifecycle: unknown;
  environment: unknown;
}>;

export function parseCommerceSystemRevision(
  value: unknown,
): Result<CommerceSystemRevision, CommerceSystemError> {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? { ok: true, value: value as CommerceSystemRevision }
    : invalid("revision");
}

export function parseExpectedCommerceSystemRevision(
  value: unknown,
): Result<number, CommerceSystemError> {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { ok: true, value }
    : invalid("expectedRevision");
}

export function parseShopifyShopDomain(
  value: unknown,
): Result<ShopifyShopDomain, CommerceSystemError> {
  return typeof value === "string" &&
    /^[a-z0-9][a-z0-9-]{0,61}\.myshopify\.com$/u.test(value)
    ? { ok: true, value: value as ShopifyShopDomain }
    : invalid("shopDomain");
}

export async function resolveOrganisationCommerceSystem(
  input: Readonly<{
    db: OrganisationQuerySource;
    organisationId: OrganisationId;
  }>,
): Promise<Result<CommerceSystem, CommerceSystemError>> {
  const row = await input.db
    .prepare(
      `SELECT selected.organisation_id AS organisationId,
            selected.system_kind AS systemKind,
            selected.underclerk_binding_id AS underclerkBindingId,
            underclerk.merchant_id AS underclerkMerchantId,
            selected.shopify_integration_account_id AS shopifyIntegrationAccountId,
            shopify.provider_account_id AS shopDomain,
            selected.revision AS revision
     FROM organisation_commerce_system AS selected
     JOIN organisation_onboarding AS onboarding
       ON onboarding.organisation_id = selected.organisation_id
     LEFT JOIN underclerk_merchant_binding AS underclerk
       ON underclerk.binding_id = selected.underclerk_binding_id
      AND underclerk.organisation_id = selected.organisation_id
      AND underclerk.environment = onboarding.environment
     LEFT JOIN integration_account AS shopify
       ON shopify.integration_account_id = selected.shopify_integration_account_id
      AND shopify.organisation_id = selected.organisation_id
      AND shopify.provider = 'shopify'
      AND shopify.environment = onboarding.environment
      AND shopify.lifecycle = 'active'
     WHERE selected.organisation_id = ?`,
    )
    .bind(input.organisationId)
    .first<CommerceSystemRow>();
  if (row === null)
    return { ok: false, error: { code: "commerce_system_not_found" } };
  return parseCommerceSystemRow(row);
}

export async function resolveOrganisationCommerceSystemAuthority(
  input: Readonly<{
    db: OrganisationQuerySource;
    organisationId: OrganisationId;
  }>,
): Promise<Result<CommerceSystemProviderAuthority, CommerceSystemError>> {
  const commerceSystem = await resolveOrganisationCommerceSystem(input);
  if (!commerceSystem.ok) return commerceSystem;
  switch (commerceSystem.value.kind) {
    case "satyr_commerce": {
      const row = await input.db
        .prepare(
          `SELECT integration_account_id AS integrationAccountId
         FROM underclerk_merchant_binding
         WHERE organisation_id = ? AND binding_id = ?`,
        )
        .bind(input.organisationId, commerceSystem.value.bindingId)
        .first<{ readonly integrationAccountId: unknown }>();
      const integrationAccountId =
        typeof row?.integrationAccountId === "string"
          ? parseIntegrationAccountId(row.integrationAccountId)
          : null;
      return integrationAccountId !== null && integrationAccountId.ok
        ? {
            ok: true,
            value: {
              commerceSystem: commerceSystem.value,
              provider: "underclerk",
              integrationAccountId: integrationAccountId.value,
            },
          }
        : { ok: false, error: { code: "commerce_system_authority_mismatch" } };
    }
    case "shopify":
      return {
        ok: true,
        value: {
          commerceSystem: commerceSystem.value,
          provider: "shopify",
          integrationAccountId: commerceSystem.value.integrationAccountId,
        },
      };
  }
}

export async function selectOrganisationCommerceSystem(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    selectedByUserId: UserId;
    selection: CommerceSystemSelection;
    now: number;
  }>,
): Promise<Result<CommerceSystemSelectionOutcome, CommerceSystemError>> {
  const session = input.db.withSession("first-primary");
  const organisation = await session
    .prepare(
      `SELECT lifecycle, environment
     FROM organisation_onboarding
     WHERE organisation_id = ?`,
    )
    .bind(input.organisationId)
    .first<OrganisationSelectionState>();
  const lifecycle = parseSelectionLifecycle(organisation?.lifecycle);
  const environment = parseOrganisationEnvironment(organisation?.environment);
  if (lifecycle === null || environment === null) {
    return { ok: false, error: { code: "commerce_system_authority_mismatch" } };
  }
  const current = await resolveOrganisationCommerceSystem({
    db: session,
    organisationId: input.organisationId,
  });
  const currentRevision = current.ok ? current.value.revision : 0;
  if (currentRevision !== input.selection.expectedRevision) {
    return { ok: false, error: { code: "commerce_system_revision_conflict" } };
  }
  const target = await resolveSelectionTarget({
    db: session,
    organisationId: input.organisationId,
    environment,
    selection: input.selection,
  });
  if (!target.ok) return target;
  if (current.ok && sameCommerceSystemIdentity(current.value, target.value)) {
    return {
      ok: true,
      value: { kind: "already_selected", commerceSystem: current.value },
    };
  }
  if (lifecycle !== "draft" && lifecycle !== "configuring") {
    return {
      ok: false,
      error: { code: "commerce_system_switch_requires_migration" },
    };
  }
  const revision = currentRevision + 1;
  try {
    await persistCommerceSystemSelection({
      session,
      organisationId: input.organisationId,
      selectedByUserId: input.selectedByUserId,
      target: target.value,
      expectedRevision: currentRevision,
      revision,
      now: input.now,
    });
  } catch {
    return { ok: false, error: { code: "commerce_system_revision_conflict" } };
  }
  const selected = await resolveOrganisationCommerceSystem({
    db: session,
    organisationId: input.organisationId,
  });
  return selected.ok
    ? { ok: true, value: { kind: "selected", commerceSystem: selected.value } }
    : selected;
}

function parseCommerceSystemRow(
  row: CommerceSystemRow,
): Result<CommerceSystem, CommerceSystemError> {
  const organisationId =
    typeof row.organisationId === "string"
      ? parseOrganisationId(row.organisationId)
      : null;
  const revision = parseCommerceSystemRevision(row.revision);
  if (organisationId === null || !organisationId.ok || !revision.ok)
    return invalid("row");
  switch (row.systemKind) {
    case "satyr_commerce": {
      if (row.shopifyIntegrationAccountId !== null || row.shopDomain !== null)
        return invalid("row");
      const bindingId = parseCommerceBindingId(row.underclerkBindingId);
      const merchantId = parseCommerceEngineMerchantId(row.underclerkMerchantId);
      return bindingId.ok && merchantId.ok
        ? {
            ok: true,
            value: {
              kind: "satyr_commerce",
              organisationId: organisationId.value,
              bindingId: bindingId.value,
              merchantId: merchantId.value,
              revision: revision.value,
            },
          }
        : invalid("row");
    }
    case "shopify": {
      if (row.underclerkBindingId !== null || row.underclerkMerchantId !== null)
        return invalid("row");
      const integrationAccountId =
        typeof row.shopifyIntegrationAccountId === "string"
          ? parseIntegrationAccountId(row.shopifyIntegrationAccountId)
          : null;
      const shopDomain = parseShopifyShopDomain(row.shopDomain);
      return integrationAccountId !== null &&
        integrationAccountId.ok &&
        shopDomain.ok
        ? {
            ok: true,
            value: {
              kind: "shopify",
              organisationId: organisationId.value,
              integrationAccountId: integrationAccountId.value,
              shopDomain: shopDomain.value,
              revision: revision.value,
            },
          }
        : invalid("row");
    }
    default:
      return invalid("systemKind");
  }
}

async function resolveSelectionTarget(
  input: Readonly<{
    db: OrganisationQuerySource;
    organisationId: OrganisationId;
    environment: OrganisationEnvironment;
    selection: CommerceSystemSelection;
  }>,
): Promise<Result<CommerceSystem, CommerceSystemError>> {
  switch (input.selection.kind) {
    case "select_satyr_commerce": {
      const row = await input.db
        .prepare(
          `SELECT binding_id AS underclerkBindingId, organisation_id AS organisationId,
                merchant_id AS underclerkMerchantId, revision
         FROM underclerk_merchant_binding
         WHERE binding_id = ? AND organisation_id = ? AND environment = ?`,
        )
        .bind(
          input.selection.underclerkBindingId,
          input.organisationId,
          input.environment,
        )
        .first<{
          readonly underclerkBindingId: unknown;
          readonly organisationId: unknown;
          readonly underclerkMerchantId: unknown;
          readonly revision: unknown;
        }>();
      if (row === null)
        return {
          ok: false,
          error: { code: "commerce_system_authority_mismatch" },
        };
      return parseCommerceSystemRow({
        ...row,
        systemKind: "satyr_commerce",
        shopifyIntegrationAccountId: null,
        shopDomain: null,
        revision: 1,
      });
    }
    case "select_shopify": {
      const row = await input.db
        .prepare(
          `SELECT integration_account_id AS shopifyIntegrationAccountId,
                organisation_id AS organisationId, provider_account_id AS shopDomain
         FROM integration_account
         WHERE integration_account_id = ? AND organisation_id = ?
           AND environment = ? AND provider = 'shopify'
           AND lifecycle = 'active'`,
        )
        .bind(
          input.selection.integrationAccountId,
          input.organisationId,
          input.environment,
        )
        .first<{
          readonly shopifyIntegrationAccountId: unknown;
          readonly organisationId: unknown;
          readonly shopDomain: unknown;
        }>();
      if (row === null)
        return {
          ok: false,
          error: { code: "commerce_system_authority_mismatch" },
        };
      return parseCommerceSystemRow({
        ...row,
        systemKind: "shopify",
        underclerkBindingId: null,
        underclerkMerchantId: null,
        revision: 1,
      });
    }
    default:
      return input.selection satisfies never;
  }
}

async function persistCommerceSystemSelection(
  input: Readonly<{
    session: OrganisationDatabaseSession;
    organisationId: OrganisationId;
    selectedByUserId: UserId;
    target: CommerceSystem;
    expectedRevision: number;
    revision: number;
    now: number;
  }>,
): Promise<void> {
  const fields = commerceSystemPersistenceFields(input.target);
  if (input.expectedRevision === 0) {
    await input.session
      .prepare(
        `INSERT INTO organisation_commerce_system (
         organisation_id, system_kind, underclerk_binding_id,
         shopify_integration_account_id, revision, selected_at,
         selected_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.organisationId,
        fields.systemKind,
        fields.underclerkBindingId,
        fields.shopifyIntegrationAccountId,
        input.revision,
        input.now,
        input.selectedByUserId,
      )
      .run();
    return;
  }
  const updated = await input.session
    .prepare(
      `UPDATE organisation_commerce_system
     SET system_kind = ?, underclerk_binding_id = ?,
         shopify_integration_account_id = ?, revision = ?,
         selected_at = ?, selected_by_user_id = ?
     WHERE organisation_id = ? AND revision = ?`,
    )
    .bind(
      fields.systemKind,
      fields.underclerkBindingId,
      fields.shopifyIntegrationAccountId,
      input.revision,
      input.now,
      input.selectedByUserId,
      input.organisationId,
      input.expectedRevision,
    )
    .run();
  if (updated.meta.changes !== 1)
    throw new Error("commerce system selection revision changed");
}

function commerceSystemPersistenceFields(system: CommerceSystem): Readonly<{
  systemKind: "satyr_commerce" | "shopify";
  underclerkBindingId: CommerceBindingId | null;
  shopifyIntegrationAccountId: IntegrationAccountId | null;
}> {
  switch (system.kind) {
    case "satyr_commerce":
      return {
        systemKind: "satyr_commerce",
        underclerkBindingId: system.bindingId,
        shopifyIntegrationAccountId: null,
      };
    case "shopify":
      return {
        systemKind: "shopify",
        underclerkBindingId: null,
        shopifyIntegrationAccountId: system.integrationAccountId,
      };
  }
}

function sameCommerceSystemIdentity(
  left: CommerceSystem,
  right: CommerceSystem,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "satyr_commerce":
      return (
        right.kind === "satyr_commerce" && left.bindingId === right.bindingId
      );
    case "shopify":
      return (
        right.kind === "shopify" &&
        left.integrationAccountId === right.integrationAccountId
      );
  }
}

function parseSelectionLifecycle(
  value: unknown,
):
  | "draft"
  | "configuring"
  | "activating"
  | "active"
  | "suspended"
  | "archived"
  | null {
  switch (value) {
    case "draft":
    case "configuring":
    case "activating":
    case "active":
    case "suspended":
    case "archived":
      return value;
    default:
      return null;
  }
}

function parseOrganisationEnvironment(
  value: unknown,
): OrganisationEnvironment | null {
  return value === "development" || value === "production" ? value : null;
}

function invalid(field: string): Result<never, CommerceSystemError> {
  return { ok: false, error: { code: "commerce_system_invalid", field } };
}

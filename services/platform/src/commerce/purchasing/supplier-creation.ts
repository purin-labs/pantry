import type { OrganisationDatabase } from "../../database-handles";
import type {
  CommerceCommandResult,
  CommerceSnapshotRevision,
  CommerceMutationReceiptV1,
} from "@purin-labs/commerce-contracts";
import {
  parseEntityPlaneCommand,
  parseCommerceSnapshotRevision,
  SUPPLIER_DIRECTORY_LIST_ID,
  SUPPLIER_ENTITY_TYPE_ID,
  SUPPLIER_INVENTORY_ITEM_DEFINITION_ID,
  CommerceEntityPlaneClient,
  type CommercePurchasingReconcileResponse,
} from "@purin-labs/commerce-client";

import { inboxServices } from "../../mail-inbox/contract/inbox-services";
import { createCommerceOutboxReconcileQueueMessage } from "../contract/queue-messages";
import {
  newRequestId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../../ids";
import type { Result } from "../../result";
import type { SupplierCreation } from "@purin-labs/commerce-control-api";

export type SupplierCreationError = Readonly<{
  code: "invalid" | "purchasing_inactive" | "command_rejected" | "unavailable";
  detail: string | null;
}>;

type SupplierCreationResult = Readonly<{
  supplierId: string;
  entryId: string;
  merchantRevision: CommerceSnapshotRevision;
  receipts: readonly CommerceMutationReceiptV1[];
}>;

type SupplierCreationClient = Pick<
  CommerceEntityPlaneClient,
  "command" | "publishedResourceMetadata"
>;

export function parseSupplierCreation(
  value: Readonly<Record<string, unknown>>,
): Result<SupplierCreation, SupplierCreationError> {
  const fields = [
    "supplierId",
    "displayName",
    "legalName",
    "countryCode",
    "contactName",
    "email",
    "phone",
    "leadTimeDays",
    "minimumOrderQuantity",
    "minimumOrderUnit",
    "purchasingNotes",
    "inventoryItemIds",
  ] as const;
  if (!exactFields(value, fields))
    return invalid("Supplier fields are invalid");
  const supplierId = normalizedText(value.supplierId);
  const displayName = normalizedText(value.displayName);
  const legalName = normalizedText(value.legalName);
  const countryCode = nullableText(value.countryCode);
  const contactName = nullableText(value.contactName);
  const email = nullableText(value.email);
  const phone = nullableText(value.phone);
  const minimumOrderQuantity = nullableDecimal(value.minimumOrderQuantity);
  const minimumOrderUnit = nullableText(value.minimumOrderUnit);
  const purchasingNotes = nullableText(value.purchasingNotes);
  const inventoryItemIds = textArray(value.inventoryItemIds);
  if (
    supplierId === null ||
    displayName === null ||
    legalName === null ||
    countryCode === undefined ||
    contactName === undefined ||
    email === undefined ||
    phone === undefined ||
    minimumOrderQuantity === undefined ||
    minimumOrderUnit === undefined ||
    purchasingNotes === undefined ||
    inventoryItemIds === null ||
    (email !== null && !isEmailAddress(email)) ||
    !Number.isSafeInteger(value.leadTimeDays) ||
    Number(value.leadTimeDays) < 0 ||
    Number(value.leadTimeDays) > 365
  ) {
    return invalid("Supplier fields are invalid");
  }
  if ((minimumOrderQuantity === null) !== (minimumOrderUnit === null)) {
    return invalid("Minimum order quantity and unit must be provided together");
  }
  return {
    ok: true,
    value: {
      supplierId,
      displayName,
      legalName,
      countryCode,
      contactName,
      email,
      phone,
      leadTimeDays: Number(value.leadTimeDays),
      minimumOrderQuantity,
      minimumOrderUnit,
      purchasingNotes,
      inventoryItemIds,
    },
  };
}

export type SupplierRegistrationError =
  | SupplierCreationError
  | Readonly<{
      code:
        | "email_operational_contact_sync_failed"
        | "underclerk_scope_mismatch"
        | "underclerk_projection_refresh_unavailable";
      detail?: never;
    }>;

type SupplierRegistration = Readonly<{
  supplier: SupplierCreationResult;
  reconciliation: CommercePurchasingReconcileResponse;
}>;

/**
 * Adds one supplier, as the Suppliers page does: the directory record, its
 * email contact, the purchasing work it opens and the projection refresh. The
 * person's route and the Portal chat agent (Plan 81) both run this.
 */
export async function registerSupplier(
  input: Readonly<{
    client: Pick<
      CommerceEntityPlaneClient,
      "command" | "publishedResourceMetadata" | "reconcilePurchasing"
    >;
    db: OrganisationDatabase;
    queue: Pick<Queue, "send">;
    organisationId: OrganisationId;
    merchantId: string;
    integrationAccountId: IntegrationAccountId;
    principalId: string;
    idempotencyKey: string;
    supplier: SupplierCreation;
    now: number;
  }>,
): Promise<Result<SupplierRegistration, SupplierRegistrationError>> {
  const created = await createSupplier({
    client: input.client,
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    principalId: input.principalId,
    idempotencyKey: input.idempotencyKey,
    expiresAt: new Date(input.now + 5 * 60 * 1_000).toISOString(),
    supplier: input.supplier,
  });
  if (!created.ok) return created;
  if (input.supplier.email !== null) {
    const contact = await inboxServices
      .use()
      .registerSupplierOperationalEmailContact({
        db: input.db,
        organisationId: input.organisationId,
        supplierId: input.supplier.supplierId,
        contactRevision: Number(created.value.merchantRevision),
        address: input.supplier.email,
        displayName: input.supplier.contactName ?? input.supplier.displayName,
        now: input.now,
      });
    if (!contact.ok)
      return {
        ok: false,
        error: { code: "email_operational_contact_sync_failed" },
      };
  }
  const reconciled = await input.client.reconcilePurchasing({
    organisationId: input.organisationId,
    merchantId: input.merchantId,
  });
  if (!reconciled.ok) return unavailable();
  if (
    reconciled.value.organisationId !== input.organisationId ||
    reconciled.value.merchantId !== input.merchantId
  )
    return { ok: false, error: { code: "underclerk_scope_mismatch" } };
  try {
    await input.queue.send(
      createCommerceOutboxReconcileQueueMessage({
        requestId: newRequestId(),
        receivedAt: Date.now(),
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
      }),
      { contentType: "json" },
    );
  } catch {
    return {
      ok: false,
      error: { code: "underclerk_projection_refresh_unavailable" },
    };
  }
  return {
    ok: true,
    value: { supplier: created.value, reconciliation: reconciled.value },
  };
}

function isEmailAddress(value: string): boolean {
  return (
    value.length >= 3 &&
    value.length <= 320 &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value)
  );
}

export async function createSupplier(
  input: Readonly<{
    client: SupplierCreationClient;
    organisationId: string;
    merchantId: string;
    principalId: string;
    idempotencyKey: string;
    expiresAt: string;
    supplier: SupplierCreation;
  }>,
): Promise<Result<SupplierCreationResult, SupplierCreationError>> {
  const metadata = await input.client.publishedResourceMetadata({
    kind: "enumerate",
    organisationId: input.organisationId,
    merchantId: input.merchantId,
  });
  if (!metadata.ok || metadata.value.kind !== "enumerated")
    return unavailable();
  if (
    metadata.value.organisationId !== input.organisationId ||
    metadata.value.merchantId !== input.merchantId
  ) {
    return unavailable();
  }
  const directory = metadata.value.lists.find(
    (list) => String(list.listId) === SUPPLIER_DIRECTORY_LIST_ID,
  );
  if (directory === undefined) return purchasingInactive();

  const receipts: CommerceMutationReceiptV1[] = [];
  let merchantRevision = metadata.value.merchantRevision;
  const entity = await executeSupplierCommand(
    input,
    merchantRevision,
    supplierEntityCommand(input),
  );
  if (!entity.ok) return entity;
  receipts.push(entity.value);
  merchantRevision = parseCommerceSnapshotRevision(
    Number(entity.value.merchantRevision),
  );

  const entry = await executeSupplierCommand(
    input,
    merchantRevision,
    supplierDirectoryEntryCommand(input, Number(directory.publishedRevision)),
  );
  if (!entry.ok) return entry;
  receipts.push(entry.value);
  merchantRevision = parseCommerceSnapshotRevision(
    Number(entry.value.merchantRevision),
  );

  for (
    let index = 0;
    index < input.supplier.inventoryItemIds.length;
    index += 1
  ) {
    const inventoryItemId = input.supplier.inventoryItemIds[index];
    if (inventoryItemId === undefined)
      return invalid("Inventory item identity is missing");
    const relationship = await executeSupplierCommand(
      input,
      merchantRevision,
      supplierInventoryRelationshipCommand(input, inventoryItemId, index),
    );
    if (!relationship.ok) return relationship;
    receipts.push(relationship.value);
    merchantRevision = parseCommerceSnapshotRevision(
      Number(relationship.value.merchantRevision),
    );
  }

  return {
    ok: true,
    value: {
      supplierId: input.supplier.supplierId,
      entryId: supplierEntryId(input.supplier.supplierId),
      merchantRevision,
      receipts,
    },
  };
}

async function executeSupplierCommand(
  input: Readonly<{
    client: SupplierCreationClient;
    organisationId: string;
    merchantId: string;
    principalId: string;
    idempotencyKey: string;
    expiresAt: string;
  }>,
  expectedMerchantRevision: CommerceSnapshotRevision,
  raw: Readonly<Record<string, unknown>>,
): Promise<Result<CommerceMutationReceiptV1, SupplierCreationError>> {
  let request: ReturnType<typeof parseEntityPlaneCommand>;
  try {
    request = parseEntityPlaneCommand({
      organisationId: input.organisationId,
      merchantId: input.merchantId,
      expectedMerchantRevision,
      ...raw,
    });
  } catch (error) {
    return invalid(
      error instanceof Error ? error.message : "Supplier command is invalid",
    );
  }
  let response: Awaited<ReturnType<CommerceEntityPlaneClient["command"]>>;
  try {
    response = await input.client.command(request);
  } catch {
    return unavailable();
  }
  if (!response.ok) return unavailable();
  return acceptedReceipt(response.value);
}

function acceptedReceipt(
  result: CommerceCommandResult,
): Result<CommerceMutationReceiptV1, SupplierCreationError> {
  return result.status === "accepted"
    ? { ok: true, value: result.receipt }
    : {
        ok: false,
        error: { code: "command_rejected", detail: result.error.code },
      };
}

function supplierEntityCommand(
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    principalId: string;
    idempotencyKey: string;
    expiresAt: string;
    supplier: SupplierCreation;
  }>,
): Readonly<Record<string, unknown>> {
  const commandId = supplierCommandId(input.idempotencyKey, "entity");
  const attributes: unknown[] = [
    customTextAttribute("legal_name", input.supplier.legalName),
  ];
  if (input.supplier.countryCode !== null)
    attributes.push(
      customTextAttribute("country_code", input.supplier.countryCode),
    );
  return {
    commandId,
    authority: commandAuthority(input, commandId, "entity_create", {
      scope: {
        kind: "entity_type",
        entityTypeId: { origin: "custom", typeId: SUPPLIER_ENTITY_TYPE_ID },
      },
      target: {
        entityId: input.supplier.supplierId,
        typeId: SUPPLIER_ENTITY_TYPE_ID,
      },
    }),
    command: {
      kind: "create_custom_entity",
      command: {
        entityId: input.supplier.supplierId,
        typeId: SUPPLIER_ENTITY_TYPE_ID,
        typeRevision: 1,
        displayName: input.supplier.displayName,
        attributes,
        sensitivity: "internal",
      },
    },
  };
}

function supplierDirectoryEntryCommand(
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    principalId: string;
    idempotencyKey: string;
    expiresAt: string;
    supplier: SupplierCreation;
  }>,
  listRevision: number,
): Readonly<Record<string, unknown>> {
  const commandId = supplierCommandId(input.idempotencyKey, "directory");
  const entryId = supplierEntryId(input.supplier.supplierId);
  const entityRef = {
    origin: "custom",
    typeId: SUPPLIER_ENTITY_TYPE_ID,
    entityId: input.supplier.supplierId,
  };
  const entry = { entryId, listId: SUPPLIER_DIRECTORY_LIST_ID, revision: 1 };
  return {
    commandId,
    authority: commandAuthority(
      input,
      commandId,
      "commerce_list_entry_create",
      {
        scope: { kind: "commerce_list", listId: SUPPLIER_DIRECTORY_LIST_ID },
        target: {
          entry,
          listRevision,
          entityTypeId: { origin: "custom", typeId: SUPPLIER_ENTITY_TYPE_ID },
          entityRef,
        },
      },
    ),
    command: {
      kind: "add_commerce_list_entry",
      command: {
        entryId,
        listId: SUPPLIER_DIRECTORY_LIST_ID,
        expectedListRevision: listRevision,
        entityRef,
        attributeValues: supplierDirectoryAttributes(input.supplier),
        revision: 1,
      },
    },
  };
}

function supplierInventoryRelationshipCommand(
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    principalId: string;
    idempotencyKey: string;
    expiresAt: string;
    supplier: SupplierCreation;
  }>,
  inventoryItemId: string,
  index: number,
): Readonly<Record<string, unknown>> {
  const commandId = supplierCommandId(input.idempotencyKey, `item:${index}`);
  const target = {
    relationshipId: `supplier_item:${input.supplier.supplierId}:${inventoryItemId}`,
    definition: {
      origin: "custom",
      definitionId: SUPPLIER_INVENTORY_ITEM_DEFINITION_ID,
      revision: 1,
    },
    source: {
      origin: "custom",
      typeId: SUPPLIER_ENTITY_TYPE_ID,
      entityId: input.supplier.supplierId,
    },
    target: {
      origin: "system",
      typeId: "inventory_item",
      entityId: inventoryItemId,
    },
  };
  return {
    commandId,
    authority: commandAuthority(input, commandId, "relationship_create", {
      scope: {
        kind: "relationship_definition",
        relationshipDefinition: target.definition,
      },
      target,
    }),
    command: { kind: "create_custom_relationship", command: { target } },
  };
}

function commandAuthority(
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    principalId: string;
    expiresAt: string;
  }>,
  commandId: string,
  kind: "entity_create" | "commerce_list_entry_create" | "relationship_create",
  branch: Readonly<{ scope: unknown; target: unknown }>,
): Readonly<Record<string, unknown>> {
  return {
    kind,
    context: {
      organisationId: input.organisationId,
      merchantId: input.merchantId,
      principalId: input.principalId,
      sensitivityCeiling: "restricted",
      expiresAt: input.expiresAt,
      causation: { kind: "command", commandId },
    },
    scope: branch.scope,
    target: branch.target,
  };
}

function supplierDirectoryAttributes(
  supplier: SupplierCreation,
): readonly unknown[] {
  const scope = {
    kind: "custom",
    entityTypeId: SUPPLIER_ENTITY_TYPE_ID,
    typeRevision: 1,
  };
  const values: unknown[] = [
    listAttribute(scope, "lead_time_days", {
      kind: "integer",
      value: BigInt(supplier.leadTimeDays),
    }),
  ];
  appendNullableText(
    values,
    scope,
    "contact_name",
    supplier.contactName,
    "short_text",
  );
  appendNullableText(values, scope, "email", supplier.email, "short_text");
  appendNullableText(values, scope, "phone", supplier.phone, "short_text");
  if (supplier.minimumOrderQuantity !== null) {
    values.push(
      listAttribute(scope, "minimum_order_quantity", {
        kind: "decimal",
        value: decimalValue(supplier.minimumOrderQuantity),
      }),
    );
  }
  appendNullableText(
    values,
    scope,
    "minimum_order_unit",
    supplier.minimumOrderUnit,
    "short_text",
  );
  appendNullableText(
    values,
    scope,
    "purchasing_notes",
    supplier.purchasingNotes,
    "long_text",
  );
  return values;
}

function customTextAttribute(
  attributeId: string,
  value: string,
): Readonly<Record<string, unknown>> {
  return listAttribute(
    { kind: "custom", entityTypeId: SUPPLIER_ENTITY_TYPE_ID, typeRevision: 1 },
    attributeId,
    { kind: "short_text", value },
  );
}

function appendNullableText(
  values: unknown[],
  scope: Readonly<Record<string, unknown>>,
  attributeId: string,
  value: string | null,
  kind: "short_text" | "long_text",
): void {
  if (value !== null)
    values.push(listAttribute(scope, attributeId, { kind, value }));
}

function listAttribute(
  scope: Readonly<Record<string, unknown>>,
  attributeId: string,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    attributeId,
    scope,
    definitionRevision: 1,
    sensitivity: "internal",
    value,
  };
}

function decimalValue(
  value: string,
): Readonly<{ unscaled: number; scale: number }> {
  const [whole, fraction = ""] = value.split(".");
  const unscaled = Number(`${whole}${fraction.padEnd(3, "0")}`);
  if (!Number.isSafeInteger(unscaled))
    throw new Error("Minimum order quantity is too large");
  return { unscaled, scale: 3 };
}

function supplierEntryId(supplierId: string): string {
  return `supplier:${supplierId}`;
}

function supplierCommandId(idempotencyKey: string, step: string): string {
  return `${idempotencyKey.slice(0, 96)}:supplier:${step}`;
}

function exactFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === fields.length && keys.every(fieldPresent.bind(null, fields))
  );
}

function fieldPresent(fields: readonly string[], key: string): boolean {
  return fields.includes(key);
}

function normalizedText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : null;
}

function nullableText(value: unknown): string | null | undefined {
  return value === null ? null : (normalizedText(value) ?? undefined);
}

function nullableDecimal(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/u.test(value)
  ) {
    return undefined;
  }
  const [whole, fraction = ""] = value.split(".");
  const unscaled = Number(`${whole}${fraction.padEnd(3, "0")}`);
  return Number.isSafeInteger(unscaled) ? value : undefined;
}

function textArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100)
    return null;
  const values = value.map(normalizedText);
  if (values.some(isNull) || new Set(values).size !== values.length)
    return null;
  return values.filter(isText);
}

function isNull(value: string | null): value is null {
  return value === null;
}

function isText(value: string | null): value is string {
  return value !== null;
}

function invalid(detail: string): { ok: false; error: SupplierCreationError } {
  return { ok: false, error: { code: "invalid", detail } };
}

function purchasingInactive(): { ok: false; error: SupplierCreationError } {
  return { ok: false, error: { code: "purchasing_inactive", detail: null } };
}

function unavailable(): { ok: false; error: SupplierCreationError } {
  return { ok: false, error: { code: "unavailable", detail: null } };
}

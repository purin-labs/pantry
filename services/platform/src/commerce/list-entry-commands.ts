// The Commerce commands behind a production request and a purchase request.
// The person's route and an approved agent action build them here.
import {
  parseEntityPlaneCommand,
  productionRequestAttributes,
  type ProductionRequestFields,
} from "@seams/commerce-client";
import type { ListEntryAttributeValue } from "@seams/commerce-contracts";

type CommandScope = Readonly<{
  organisationId: string;
  merchantId: string;
  principalId: string;
  commandId: string;
  merchantRevision: number;
  listRevision: number;
}>;

function commandContext(scope: CommandScope) {
  return {
    organisationId: scope.organisationId,
    merchantId: scope.merchantId,
    principalId: scope.principalId,
    sensitivityCeiling: "restricted",
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    causation: { kind: "command", commandId: scope.commandId },
  };
}

export function productionRequestCreateCommand(
  input: CommandScope &
    Readonly<{
      entryId: string;
      inventoryItemId: string;
      fields: ProductionRequestFields;
    }>,
) {
  const entityRef = {
    origin: "system",
    typeId: "inventory_item",
    entityId: input.inventoryItemId,
  };
  const entry = {
    entryId: input.entryId,
    listId: "production_requests",
    revision: 1,
  };
  return parseEntityPlaneCommand({
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    expectedMerchantRevision: input.merchantRevision,
    commandId: input.commandId,
    authority: {
      kind: "commerce_list_entry_create",
      context: commandContext(input),
      scope: { kind: "commerce_list", listId: "production_requests" },
      target: {
        entry,
        listRevision: input.listRevision,
        entityTypeId: { origin: "system", typeId: "inventory_item" },
        entityRef,
      },
    },
    command: {
      kind: "add_commerce_list_entry",
      command: {
        entryId: input.entryId,
        listId: "production_requests",
        expectedListRevision: input.listRevision,
        entityRef,
        revision: 1,
        attributeValues: productionRequestAttributes(input.fields),
      },
    },
  });
}

export function commerceListEntryPatchCommand(
  input: CommandScope &
    Readonly<{
      listId: string;
      entryId: string;
      entryRevision: number;
      attributeValues: readonly ListEntryAttributeValue[];
    }>,
) {
  const target = {
    entry: {
      entryId: input.entryId,
      listId: input.listId,
      revision: input.entryRevision,
    },
    expectedRevision: input.entryRevision,
  };
  return parseEntityPlaneCommand({
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    expectedMerchantRevision: input.merchantRevision,
    commandId: input.commandId,
    authority: {
      kind: "commerce_list_entry_command",
      context: commandContext(input),
      scope: { kind: "commerce_list_entry", entry: target.entry },
      target,
    },
    command: {
      kind: "patch_commerce_list_entry",
      command: {
        target,
        expectedListRevision: input.listRevision,
        attributeValues: input.attributeValues,
      },
    },
  });
}

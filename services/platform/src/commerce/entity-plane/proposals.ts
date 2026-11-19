import type {
  CommerceEntityPlaneEffect,
  CommerceEntityPlaneProposal,
  CommerceEntityPlaneCommand,
  CommerceMutationReceiptV1,
} from "@purin-labs/contracts";
import { sameRelationshipDefinitionRef } from "@purin-labs/commerce-contracts/commerce-relationship-references";
import { assertCommerceEntityPlaneCommandWithLexicon } from "../commerce-wasm";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, isRecord } from "@purin-labs/std";
import { parseRecordedCommerceEntityPlaneEffect } from "@purin-labs/commerce-contracts/entity-plane-effects";

type RecordValue = Record<string, unknown>;
type PatchCustomEntityProposal = Variant<
  CommerceEntityPlaneProposal,
  "patch_custom_entity"
>;
type DeleteCustomRelationshipProposal = Variant<
  CommerceEntityPlaneProposal,
  "delete_custom_relationship"
>;
type ReplaceCustomRelationshipProposal = Variant<
  CommerceEntityPlaneProposal,
  "replace_custom_relationship"
>;
export function parseCommerceEntityPlaneProposal(
  value: unknown,
): CommerceEntityPlaneProposal | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  try {
    const command = commandValueForProposal(value);
    if (command === null) return null;
    assertCommerceEntityPlaneCommandWithLexicon(command);
    return proposalFromCommand(command);
  } catch {
    return null;
  }
}

export function parseCommerceEntityPlaneEffect(
  value: unknown,
): CommerceEntityPlaneEffect | null {
  const parsed = parseRecordedCommerceEntityPlaneEffect(value);
  return parsed.ok ? parsed.value : null;
}

export function proposalFromCommand(
  command: CommerceEntityPlaneCommand,
): CommerceEntityPlaneProposal | null {
  switch (command.kind) {
    case "patch_custom_entity":
      return {
        kind: command.kind,
        entityRef: command.command.entityRef,
        typeRevision: command.command.typeRevision,
        expectedRevision: command.command.expectedRevision,
        attributes: command.command.attributes,
        displayName: command.command.displayName,
      };
    case "create_custom_relationship":
      return {
        kind: command.kind,
        relationshipId: command.command.target.relationshipId,
        definition: command.command.target.definition,
        source: command.command.target.source,
        target: command.command.target.target,
      };
    case "delete_custom_relationship":
      return {
        kind: command.kind,
        relationship: command.command.target.relationship,
      };
    case "replace_custom_relationship":
      return {
        kind: command.kind,
        relationship: command.command.target.relationship,
        replacementTarget: command.command.target.replacementTarget,
      };
    case "add_commerce_list_entry":
      if (command.command.revision !== 1) return null;
      return {
        kind: command.kind,
        entryId: command.command.entryId,
        listId: command.command.listId,
        expectedListRevision: command.command.expectedListRevision,
        entityRef: command.command.entityRef,
        attributeValues: command.command.attributeValues,
        revision: command.command.revision,
      };
    case "patch_commerce_list_entry":
      return {
        kind: command.kind,
        entry: command.command.target,
        expectedListRevision: command.command.expectedListRevision,
        attributeValues: command.command.attributeValues,
      };
    case "remove_commerce_list_entry":
      return { kind: command.kind, entry: command.command.target };
    default:
      return null;
  }
}

/** Reconstructs the one command represented by a persisted Case proposal. */
export function commandFromCommerceEntityPlaneProposal(
  proposal: CommerceEntityPlaneProposal,
): CommerceEntityPlaneCommand {
  switch (proposal.kind) {
    case "patch_custom_entity":
      return {
        kind: proposal.kind,
        command: {
          entityRef: proposal.entityRef,
          typeRevision: proposal.typeRevision,
          expectedRevision: proposal.expectedRevision,
          attributes: proposal.attributes,
          displayName: proposal.displayName,
        },
      };
    case "create_custom_relationship":
      return {
        kind: proposal.kind,
        command: {
          target: {
            relationshipId: proposal.relationshipId,
            definition: proposal.definition,
            source: proposal.source,
            target: proposal.target,
          },
        },
      };
    case "delete_custom_relationship":
      return {
        kind: proposal.kind,
        command: { target: { relationship: proposal.relationship } },
      };
    case "replace_custom_relationship":
      return {
        kind: proposal.kind,
        command: {
          target: {
            relationship: proposal.relationship,
            replacementTarget: proposal.replacementTarget,
          },
        },
      };
    case "add_commerce_list_entry":
      return {
        kind: proposal.kind,
        command: {
          entryId: proposal.entryId,
          listId: proposal.listId,
          expectedListRevision: proposal.expectedListRevision,
          entityRef: proposal.entityRef,
          attributeValues: proposal.attributeValues,
          revision: proposal.revision,
        },
      };
    case "patch_commerce_list_entry":
      return {
        kind: proposal.kind,
        command: {
          target: proposal.entry,
          expectedListRevision: proposal.expectedListRevision,
          attributeValues: proposal.attributeValues,
        },
      };
    case "remove_commerce_list_entry":
      return {
        kind: proposal.kind,
        command: { target: proposal.entry },
      };
    default:
      return assertNever(proposal, "unsupported entity-plane proposal");
  }
}

export function buildCommerceEntityPlaneEffect(
  proposal: CommerceEntityPlaneProposal,
  receipt: CommerceMutationReceiptV1,
): CommerceEntityPlaneEffect | null {
  return receipt.deliveryId !== null &&
    effectReceiptMatchesProposal(proposal, receipt)
    ? effectFromProposal(proposal, receipt)
    : null;
}

function commandValueForProposal(value: RecordValue): RecordValue | null {
  switch (value.kind) {
    case "patch_custom_entity": {
      strictObjectValue(value, "patchCustomEntityProposal", [
        "kind",
        "entityRef",
        "typeRevision",
        "expectedRevision",
        "attributes",
        "displayName",
      ]);
      return {
        kind: value.kind,
        command: {
          entityRef: value.entityRef,
          typeRevision: value.typeRevision,
          expectedRevision: value.expectedRevision,
          attributes: value.attributes,
          displayName: value.displayName,
        },
      };
    }
    case "create_custom_relationship": {
      strictObjectValue(value, "createCustomRelationshipProposal", [
        "kind",
        "relationshipId",
        "definition",
        "source",
        "target",
      ]);
      return {
        kind: value.kind,
        command: {
          target: {
            relationshipId: value.relationshipId,
            definition: value.definition,
            source: value.source,
            target: value.target,
          },
        },
      };
    }
    case "delete_custom_relationship": {
      strictObjectValue(value, "deleteCustomRelationshipProposal", [
        "kind",
        "relationship",
      ]);
      return {
        kind: value.kind,
        command: { target: { relationship: value.relationship } },
      };
    }
    case "replace_custom_relationship": {
      strictObjectValue(value, "replaceCustomRelationshipProposal", [
        "kind",
        "relationship",
        "replacementTarget",
      ]);
      return {
        kind: value.kind,
        command: {
          target: {
            relationship: value.relationship,
            replacementTarget: value.replacementTarget,
          },
        },
      };
    }
    case "add_commerce_list_entry": {
      strictObjectValue(value, "addCommerceListEntryProposal", [
        "kind",
        "entryId",
        "listId",
        "expectedListRevision",
        "entityRef",
        "attributeValues",
        "revision",
      ]);
      return {
        kind: value.kind,
        command: {
          entryId: value.entryId,
          listId: value.listId,
          expectedListRevision: value.expectedListRevision,
          entityRef: value.entityRef,
          attributeValues: value.attributeValues,
          revision: value.revision,
        },
      };
    }
    case "patch_commerce_list_entry": {
      strictObjectValue(value, "patchCommerceListEntryProposal", [
        "kind",
        "entry",
        "expectedListRevision",
        "attributeValues",
      ]);
      return {
        kind: value.kind,
        command: {
          target: value.entry,
          expectedListRevision: value.expectedListRevision,
          attributeValues: value.attributeValues,
        },
      };
    }
    case "remove_commerce_list_entry": {
      strictObjectValue(value, "removeCommerceListEntryProposal", [
        "kind",
        "entry",
      ]);
      return { kind: value.kind, command: { target: value.entry } };
    }
    default:
      return null;
  }
}

function effectFromProposal(
  proposal: CommerceEntityPlaneProposal,
  receipt: CommerceMutationReceiptV1,
): CommerceEntityPlaneEffect {
  switch (proposal.kind) {
    case "patch_custom_entity":
      return {
        kind: proposal.kind,
        entityRef: proposal.entityRef,
        typeRevision: proposal.typeRevision,
        expectedRevision: proposal.expectedRevision,
        receipt,
      };
    case "create_custom_relationship":
      return {
        kind: proposal.kind,
        relationshipId: proposal.relationshipId,
        definition: proposal.definition,
        source: proposal.source,
        target: proposal.target,
        receipt,
      };
    case "delete_custom_relationship":
      return {
        kind: proposal.kind,
        relationship: proposal.relationship,
        receipt,
      };
    case "replace_custom_relationship":
      return {
        kind: proposal.kind,
        relationship: proposal.relationship,
        replacementTarget: proposal.replacementTarget,
        receipt,
      };
    case "add_commerce_list_entry":
      return {
        kind: proposal.kind,
        entryId: proposal.entryId,
        listId: proposal.listId,
        expectedListRevision: proposal.expectedListRevision,
        entityRef: proposal.entityRef,
        revision: proposal.revision,
        receipt,
      };
    case "patch_commerce_list_entry":
      return {
        kind: proposal.kind,
        entry: proposal.entry,
        expectedListRevision: proposal.expectedListRevision,
        receipt,
      };
    case "remove_commerce_list_entry":
      return { kind: proposal.kind, entry: proposal.entry, receipt };
    default:
      return assertNever(proposal, "unsupported entity-plane proposal");
  }
}

function effectReceiptMatchesProposal(
  proposal: CommerceEntityPlaneProposal,
  receipt: CommerceMutationReceiptV1,
): boolean {
  switch (proposal.kind) {
    case "patch_custom_entity":
      return (
        receipt.target.kind === "custom_entity" &&
        sameCustomEntityRef(receipt.target.entityRef, proposal.entityRef) &&
        receipt.target.revision === proposal.expectedRevision + 1
      );
    case "create_custom_relationship":
      return (
        receipt.target.kind === "custom_relationship" &&
        receipt.target.relationship.relationshipId ===
          proposal.relationshipId &&
        sameRelationshipDefinitionRef(
          receipt.target.relationship.definition,
          proposal.definition,
        ) &&
        receipt.target.relationship.revision === 1
      );
    case "delete_custom_relationship":
      return (
        receipt.target.kind === "custom_relationship" &&
        sameCustomRelationshipRefIgnoringRevision(
          receipt.target.relationship,
          proposal.relationship,
        ) &&
        receipt.target.relationship.revision ===
          proposal.relationship.revision + 1
      );
    case "replace_custom_relationship":
      return (
        receipt.target.kind === "custom_relationship" &&
        sameCustomRelationshipRefIgnoringRevision(
          receipt.target.relationship,
          proposal.relationship,
        ) &&
        receipt.target.relationship.revision ===
          proposal.relationship.revision + 1
      );
    case "add_commerce_list_entry":
      return (
        receipt.target.kind === "commerce_list_entry" &&
        proposal.revision === 1 &&
        receipt.target.entry.entryId === proposal.entryId &&
        receipt.target.entry.listId === proposal.listId &&
        receipt.target.entry.revision === proposal.revision &&
        receipt.target.revision === proposal.revision
      );
    case "patch_commerce_list_entry":
      return (
        receipt.target.kind === "commerce_list_entry" &&
        receipt.target.entry.entryId === proposal.entry.entry.entryId &&
        receipt.target.entry.listId === proposal.entry.entry.listId &&
        receipt.target.entry.revision === proposal.entry.entry.revision + 1 &&
        receipt.target.revision === proposal.entry.entry.revision + 1
      );
    case "remove_commerce_list_entry":
      return (
        receipt.target.kind === "commerce_list_entry" &&
        receipt.target.entry.entryId === proposal.entry.entry.entryId &&
        receipt.target.entry.listId === proposal.entry.entry.listId &&
        receipt.target.entry.revision === proposal.entry.entry.revision + 1 &&
        receipt.target.revision === proposal.entry.entry.revision + 1
      );
    default:
      return assertNever(proposal, "unsupported entity-plane proposal");
  }
}

function sameCustomEntityRef(
  left: PatchCustomEntityProposal["entityRef"],
  right: PatchCustomEntityProposal["entityRef"],
): boolean {
  return (
    left.origin === right.origin &&
    left.typeId === right.typeId &&
    left.entityId === right.entityId
  );
}

function sameCustomRelationshipRefIgnoringRevision(
  left:
    | DeleteCustomRelationshipProposal["relationship"]
    | ReplaceCustomRelationshipProposal["relationship"],
  right:
    | DeleteCustomRelationshipProposal["relationship"]
    | ReplaceCustomRelationshipProposal["relationship"],
): boolean {
  return (
    left.origin === right.origin &&
    left.relationshipId === right.relationshipId &&
    sameRelationshipDefinitionRef(left.definition, right.definition)
  );
}

function strictObjectValue(
  value: unknown,
  field: string,
  fields: readonly string[],
): RecordValue {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  ) {
    throw new Error(`${field} has unsupported fields`);
  }
  return value;
}

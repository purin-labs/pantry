// The parsers of the commerce parts of a stored grant target (Refactor 17).
// The grant store asks them through the port
// authorization/access-grants/commerce-grant-targets.ts, and the Worker
// registers this implementation. The checks and the refused fields do not
// change.
import type {
  CommerceAuthorityScope,
  CommerceMutationTarget,
  CommerceRelationshipRef,
} from "@purin-labs/commerce-contracts";
import {
  parseCommerceEntityPlaneCommand,
  parseCommerceGraphQuery,
  parseCommerceRelationshipRef,
} from "@purin-labs/commerce-client";
import { isRecord, positiveIntegerOrNull } from "@purin-labs/std";
import type {
  CommerceGrantTargetParse,
  CommerceGrantTargets,
} from "@purin-labs/authority/authorization/access-grants/commerce-grant-targets";
import type { CommerceReadGrantScope } from "@purin-labs/authority/authorization/access-grants/types";

export const COMMERCE_GRANT_TARGETS: CommerceGrantTargets = {
  parseReadScope: (raw) => parseCommerceReadScope(raw),
  parseCommandScope: (raw) => parseCommerceAuthorityScope(raw),
  parseCommandTarget: (raw) => parseCommerceMutationTarget(raw),
};

function parseCommerceReadScope(
  raw: unknown,
): CommerceGrantTargetParse<CommerceReadGrantScope> {
  const value = asRecord(raw);
  const kind = value === null ? null : readString(value.kind);
  try {
    if (kind === "entity_type") {
      const query = parseCommerceGraphQuery({
        kind: "entity_type_page",
        entityTypeId: value?.entityTypeId,
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 1, cursor: null },
        traversal: { maxDepth: 0, resultLimit: 1 },
      });
      if (query.kind !== "entity_type_page")
        throw new Error("scope kind changed");
      return { ok: true, value: { kind, entityTypeId: query.entityTypeId } };
    }
    if (kind === "commerce_list") {
      const query = parseCommerceGraphQuery({
        kind: "commerce_list_page",
        listId: value?.listId,
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 1, cursor: null },
      });
      if (query.kind !== "commerce_list_page")
        throw new Error("scope kind changed");
      return { ok: true, value: { kind, listId: query.listId } };
    }
    if (kind === "saved_selector") {
      const selector = asRecord(value?.selector);
      const query = parseCommerceGraphQuery({
        kind: "commerce_context",
        selection: { kind: "selector", selector },
        traversal: { maxDepth: 0, resultLimit: 1 },
        allowedSensitivity: "restricted",
        allowedAttributeIds: [],
        freshnessRequirement: "any",
      });
      if (
        query.kind !== "commerce_context" ||
        query.selection.kind !== "selector"
      ) {
        throw new Error("scope kind changed");
      }
      return { ok: true, value: { kind, selector: query.selection.selector } };
    }
  } catch {
    return invalidTarget("target.scope");
  }
  return invalidTarget("target.scope.kind");
}

function parseCommerceAuthorityScope(
  raw: unknown,
): CommerceGrantTargetParse<CommerceAuthorityScope> {
  const value = asRecord(raw);
  const kind = value === null ? null : readString(value.kind);
  try {
    if (
      kind === "entity_type" ||
      kind === "commerce_list" ||
      kind === "saved_selector"
    ) {
      return parseCommerceReadScope(value);
    }
    if (kind === "entity") {
      const query = parseCommerceGraphQuery({
        kind: "entity_by_ref",
        reference: value?.entityRef,
        filter: null,
        traversal: { maxDepth: 0, resultLimit: 1 },
      });
      if (query.kind !== "entity_by_ref") throw new Error("scope kind changed");
      return { ok: true, value: { kind, entityRef: query.reference } };
    }
    if (kind === "relationship_definition") {
      const query = parseCommerceGraphQuery({
        kind: "relationship_traversal",
        seeds: [
          { origin: "system", typeId: "product", entityId: "scope_seed" },
        ],
        relationshipDefinition: value?.relationshipDefinition,
        filter: null,
        traversal: { maxDepth: 0, resultLimit: 1 },
      });
      if (
        query.kind !== "relationship_traversal" ||
        query.relationshipDefinition === null
      ) {
        throw new Error("scope kind changed");
      }
      return {
        ok: true,
        value: { kind, relationshipDefinition: query.relationshipDefinition },
      };
    }
    if (kind === "relationship") {
      const relationship = parseRelationshipScope(value?.relationship);
      return relationship.ok
        ? { ok: true, value: { kind, relationship: relationship.value } }
        : relationship;
    }
    if (kind === "commerce_list_entry") {
      const command = parseCommerceEntityPlaneCommand({
        kind: "remove_commerce_list_entry",
        command: {
          target: {
            entry: value?.entry,
            expectedRevision: positiveIntegerOrNull(
              asRecord(value?.entry)?.revision,
            ),
          },
        },
      });
      if (command.kind !== "remove_commerce_list_entry")
        throw new Error("scope kind changed");
      return { ok: true, value: { kind, entry: command.command.target.entry } };
    }
    if (kind === "saved_view") {
      const query = parseCommerceGraphQuery({
        kind: "saved_commerce_view",
        viewId: value?.viewId,
        pagination: { limit: 1, cursor: null },
      });
      if (query.kind !== "saved_commerce_view")
        throw new Error("scope kind changed");
      return { ok: true, value: { kind, viewId: query.viewId } };
    }
  } catch {
    return invalidTarget("target.scope");
  }
  return invalidTarget("target.scope.kind");
}

function parseRelationshipScope(
  raw: unknown,
): CommerceGrantTargetParse<CommerceRelationshipRef> {
  try {
    return { ok: true, value: parseCommerceRelationshipRef(raw) };
  } catch {
    return invalidTarget("target.scope.relationship");
  }
}

function parseCommerceMutationTarget(
  raw: unknown,
): CommerceGrantTargetParse<CommerceMutationTarget> {
  const value = asRecord(raw);
  const kind = value === null ? null : readString(value.kind);
  try {
    if (kind === "custom_entity") {
      const command = parseCommerceEntityPlaneCommand({
        kind: "patch_custom_entity",
        command: {
          entityRef: value?.entityRef,
          typeRevision: 1,
          expectedRevision: value?.revision,
          attributes: [],
          displayName: null,
        },
      });
      if (command.kind !== "patch_custom_entity")
        throw new Error("target kind changed");
      return {
        ok: true,
        value: {
          kind,
          entityRef: command.command.entityRef,
          revision: command.command.expectedRevision,
        },
      };
    }
    if (kind === "custom_relationship") {
      const command = parseCommerceEntityPlaneCommand({
        kind: "delete_custom_relationship",
        command: { target: { relationship: value?.relationship } },
      });
      if (command.kind !== "delete_custom_relationship")
        throw new Error("target kind changed");
      return {
        ok: true,
        value: { kind, relationship: command.command.target.relationship },
      };
    }
    if (kind === "commerce_list") {
      const command = parseCommerceEntityPlaneCommand({
        kind: "create_commerce_list",
        command: {
          listId: value?.listId,
          entityTypeId: { origin: "system", typeId: "product" },
          name: "scope_list",
          membership: "unique_entity",
          entryAttributeDefinitions: [],
          publishedRevision: value?.revision,
        },
      });
      if (command.kind !== "create_commerce_list")
        throw new Error("target kind changed");
      return {
        ok: true,
        value: {
          kind,
          listId: command.command.listId,
          revision: command.command.publishedRevision,
        },
      };
    }
    if (kind === "commerce_list_entry") {
      const command = parseCommerceEntityPlaneCommand({
        kind: "remove_commerce_list_entry",
        command: {
          target: {
            entry: value?.entry,
            expectedRevision: positiveIntegerOrNull(
              asRecord(value?.entry)?.revision,
            ),
          },
        },
      });
      if (command.kind !== "remove_commerce_list_entry")
        throw new Error("target kind changed");
      return {
        ok: true,
        value: {
          kind,
          entry: command.command.target.entry,
          revision: command.command.target.entry.revision,
        },
      };
    }
    if (kind === "saved_commerce_view") {
      const command = parseCommerceEntityPlaneCommand({
        kind: "archive_saved_commerce_view",
        command: { viewId: value?.viewId, expectedRevision: value?.revision },
      });
      if (command.kind !== "archive_saved_commerce_view")
        throw new Error("target kind changed");
      return {
        ok: true,
        value: {
          kind,
          viewId: command.command.target.viewId,
          revision: command.command.target.expectedRevision,
        },
      };
    }
    if (kind === "custom_entity_type") {
      const command = parseCommerceEntityPlaneCommand({
        kind: "publish_custom_entity_type",
        command: {
          target: { typeId: value?.typeId, revision: value?.revision },
        },
      });
      if (command.kind !== "publish_custom_entity_type")
        throw new Error("target kind changed");
      return {
        ok: true,
        value: {
          kind,
          typeId: command.command.target.typeId,
          revision: command.command.target.revision,
        },
      };
    }
    if (kind === "custom_relationship_definition") {
      const command = parseCommerceEntityPlaneCommand({
        kind: "publish_custom_relationship_definition",
        command: {
          target: {
            definitionId: value?.definitionId,
            revision: value?.revision,
          },
        },
      });
      if (command.kind !== "publish_custom_relationship_definition")
        throw new Error("target kind changed");
      return {
        ok: true,
        value: {
          kind,
          definitionId: command.command.target.definitionId,
          revision: command.command.target.revision,
        },
      };
    }
    if (kind === "system_entity_extension_schema") {
      const command = parseCommerceEntityPlaneCommand({
        kind: "publish_system_entity_extension_schema",
        command: {
          target: {
            entityTypeId: value?.entityTypeId,
            revision: value?.revision,
          },
        },
      });
      if (command.kind !== "publish_system_entity_extension_schema")
        throw new Error("target kind changed");
      return {
        ok: true,
        value: {
          kind,
          entityTypeId: command.command.target.entityTypeId,
          revision: command.command.target.revision,
        },
      };
    }
  } catch {
    return invalidTarget("target.target");
  }
  return invalidTarget("target.target.kind");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function invalidTarget(field: string): CommerceGrantTargetParse<never> {
  return { ok: false, error: { field } };
}

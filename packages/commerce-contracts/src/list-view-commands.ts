import {
  OpenObject,
  StrictObject,
  parseContract,
  type ContractDecodeResult,
  NonNegativeInteger as revisionWire,
} from "./schema.ts";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
import { assertNever } from "@purin-labs/std";
import type { StrictUnion, Variant } from "@purin-labs/type-utils";
import {
  authorityTargetSchemas,
  authorityTargetWireSchemas,
  parseCommerceListEntryCommandTarget,
  parseSavedCommerceViewCommandTarget,
} from "./command-authority.ts";
import {
  commerceListSchema,
  commerceListWireSchema,
  commerceListEntrySchema,
  listEntryAttributeValueSchema,
  parseCommerceList,
  parseListEntryAttributeValues,
} from "./list-records.ts";
import {
  savedCommerceViewSchema,
  savedCommerceViewWireSchema,
  parseSavedCommerceView,
  type SavedCommerceView,
} from "./view-records.ts";
import { attributeAssignmentWireSchema } from "./entity-wire.ts";
import {
  commerceEntityRefSchema,
  parseCommerceEntityRef,
} from "./entity-reference.ts";
import { commerceEntityRefWireSchema } from "./query-wire.ts";
import {
  commerceListIdSchema,
  identityRefusal,
  invalidShape,
} from "./query-parts.ts";
import { revisionSchema } from "./entity-record.ts";

import { cursorRefusal } from "./cursor-values.ts";

const listRevisionSchema = revisionSchema<"CommerceListRevision">();
const entryRevisionSchema = commerceListEntrySchema.properties.revision;
const entryIdSchema = commerceListEntrySchema.properties.entryId;
export const listViewCommandSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("create_commerce_list"),
    command: commerceListSchema,
  }),
  OpenObject({
    kind: Type.Literal("add_commerce_list_entry"),
    command: StrictObject({
      entryId: entryIdSchema,
      listId: commerceListIdSchema,
      expectedListRevision: listRevisionSchema,
      entityRef: commerceEntityRefSchema,
      attributeValues: Type.Array(listEntryAttributeValueSchema),
      revision: entryRevisionSchema,
    }),
  }),
  OpenObject({
    kind: Type.Literal("patch_commerce_list_entry"),
    command: StrictObject({
      target: authorityTargetSchemas.commerce_list_entry_command,
      expectedListRevision: listRevisionSchema,
      attributeValues: Type.Array(listEntryAttributeValueSchema),
    }),
  }),
  OpenObject({
    kind: Type.Literal("remove_commerce_list_entry"),
    command: OpenObject({
      target: authorityTargetSchemas.commerce_list_entry_command,
    }),
  }),
  OpenObject({
    kind: Type.Literal("publish_saved_commerce_view"),
    command: OpenObject({
      view: Type.Unsafe<SavedCommerceView>(savedCommerceViewSchema),
    }),
  }),
  OpenObject({
    kind: Type.Literal("archive_saved_commerce_view"),
    command: OpenObject({
      target: authorityTargetSchemas.saved_view_administration,
    }),
  }),
]);
export type ListViewCommand = StrictUnion<
  StaticDecode<typeof listViewCommandSchema>
>;
export type CreateCommerceListCommand = Variant<
  ListViewCommand,
  "create_commerce_list"
>["command"];
export type AddCommerceListEntryCommand = Variant<
  ListViewCommand,
  "add_commerce_list_entry"
>["command"];
export type PatchCommerceListEntryCommand = Variant<
  ListViewCommand,
  "patch_commerce_list_entry"
>["command"];
export type RemoveCommerceListEntryCommand = Variant<
  ListViewCommand,
  "remove_commerce_list_entry"
>["command"];
export type PublishSavedCommerceViewCommand = Variant<
  ListViewCommand,
  "publish_saved_commerce_view"
>["command"];
export type ArchiveSavedCommerceViewCommand = Variant<
  ListViewCommand,
  "archive_saved_commerce_view"
>["command"];

const commandWire = Type.Union([
  OpenObject({
    kind: Type.Literal("create_commerce_list"),
    command: commerceListWireSchema,
  }),
  OpenObject({
    kind: Type.Literal("add_commerce_list_entry"),
    command: StrictObject({
      entryId: Type.String(),
      listId: Type.String(),
      expectedListRevision: revisionWire,
      entityRef: commerceEntityRefWireSchema,
      attributeValues: Type.Array(attributeAssignmentWireSchema),
      revision: revisionWire,
    }),
  }),
  OpenObject({
    kind: Type.Literal("patch_commerce_list_entry"),
    command: StrictObject({
      target: authorityTargetWireSchemas.commerce_list_entry_command,
      expectedListRevision: revisionWire,
      attributeValues: Type.Array(attributeAssignmentWireSchema),
    }),
  }),
  OpenObject({
    kind: Type.Literal("remove_commerce_list_entry"),
    command: OpenObject({
      target: authorityTargetWireSchemas.commerce_list_entry_command,
    }),
  }),
  OpenObject({
    kind: Type.Literal("publish_saved_commerce_view"),
    command: OpenObject({ view: savedCommerceViewWireSchema }),
  }),
  OpenObject({
    kind: Type.Literal("archive_saved_commerce_view"),
    command: OpenObject({
      target: authorityTargetWireSchemas.saved_view_administration,
    }),
  }),
]);

export function parseListViewCommand(
  input: unknown,
): ContractDecodeResult<ListViewCommand> {
  const parsed = parseContract(commandWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  switch (value.kind) {
    case "create_commerce_list": {
      const list = parseCommerceList(value.command);
      if (!list.ok) return list;
      return { ok: true, value: { kind: value.kind, command: list.value } };
    }
    case "add_commerce_list_entry": {
      const command = value.command;
      const entryId = command.entryId;
      if (!Value.Check(entryIdSchema, entryId))
        return identityRefusal("CommerceListEntryId");
      const listId = command.listId;
      if (!Value.Check(commerceListIdSchema, listId))
        return identityRefusal("CommerceListId");
      const expectedListRevision = command.expectedListRevision;
      if (!Value.Check(listRevisionSchema, expectedListRevision))
        return invalidRevision("CommerceListRevision");
      const entityRef = parseCommerceEntityRef(command.entityRef);
      if (!entityRef.ok) return entityRef;
      const revision = command.revision;
      if (!Value.Check(entryRevisionSchema, revision))
        return invalidRevision("CommerceListEntryRevision");
      const values = parseListEntryAttributeValues(command.attributeValues);
      if (!values.ok) return values;
      return {
        ok: true,
        value: {
          kind: value.kind,
          command: {
            entryId,
            listId,
            expectedListRevision,
            entityRef: entityRef.value,
            attributeValues: values.value,
            revision,
          },
        },
      };
    }
    case "patch_commerce_list_entry": {
      const target = parseCommerceListEntryCommandTarget(value.command.target);
      if (!target.ok) return target;
      const expectedListRevision = value.command.expectedListRevision;
      if (!Value.Check(listRevisionSchema, expectedListRevision))
        return invalidRevision("CommerceListRevision");
      const values = parseListEntryAttributeValues(
        value.command.attributeValues,
      );
      if (!values.ok) return values;
      return {
        ok: true,
        value: {
          kind: value.kind,
          command: {
            target: target.value,
            expectedListRevision,
            attributeValues: values.value,
          },
        },
      };
    }
    case "remove_commerce_list_entry": {
      const target = parseCommerceListEntryCommandTarget(value.command.target);
      if (!target.ok) return target;
      return {
        ok: true,
        value: { kind: value.kind, command: { target: target.value } },
      };
    }
    case "publish_saved_commerce_view": {
      const view = parseSavedCommerceView(value.command.view);
      if (!view.ok) return view;
      return {
        ok: true,
        value: { kind: value.kind, command: { view: view.value } },
      };
    }
    case "archive_saved_commerce_view": {
      const target = parseSavedCommerceViewCommandTarget(value.command.target);
      if (!target.ok) return target;
      return {
        ok: true,
        value: { kind: value.kind, command: { target: target.value } },
      };
    }
    default:
      return assertNever(value);
  }
}
function invalidRevision(field: string): ContractDecodeResult<never> {
  return cursorRefusal("invalid_revision", { field });
}

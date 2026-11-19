import {
  OpenObject,
  parseContract,
  type ContractDecodeResult,
} from "./schema.ts";
import { Type, type Static, type StaticDecode } from "typebox";
import type { StrictUnion } from "@purin-labs/type-utils";
import {
  entityLifecycleCommandSchema,
  parseEntityLifecycleCommand,
} from "./entity-commands.ts";
import {
  relationshipLifecycleCommandSchema,
  parseRelationshipLifecycleCommand,
} from "./relationship-commands.ts";
import {
  listViewCommandSchema,
  parseListViewCommand,
} from "./list-view-commands.ts";
import {
  commerceEntityAuthoritySchema,
  parseCommerceEntityAuthority,
  type CommerceEntityAuthority,
} from "./command-authority.ts";
import { commerceSnapshotRevisionSchema } from "./query-metadata.ts";
import { queryIdentitySchema, invalidShape } from "./query-parts.ts";
import { javascriptTrimmedTextSchema } from "./identity-text.ts";

export const commerceEntityPlaneCommandSchema = Type.Union([
  ...entityLifecycleCommandSchema.anyOf,
  ...relationshipLifecycleCommandSchema.anyOf,
  ...listViewCommandSchema.anyOf,
]);
export type CommerceEntityPlaneCommand = StrictUnion<
  StaticDecode<typeof commerceEntityPlaneCommandSchema>
>;
const commandIdSchema = queryIdentitySchema<"CommerceCommandId">();
export const entityPlaneCommandRequestSchema = OpenObject({
  organisationId: javascriptTrimmedTextSchema,
  merchantId: javascriptTrimmedTextSchema,
  commandId: Type.Unsafe<Static<typeof commandIdSchema>>(
    javascriptTrimmedTextSchema,
  ),
  expectedMerchantRevision: commerceSnapshotRevisionSchema,
  authority: Type.Unsafe<CommerceEntityAuthority>(
    commerceEntityAuthoritySchema,
  ),
  command: Type.Unsafe<CommerceEntityPlaneCommand>(
    commerceEntityPlaneCommandSchema,
  ),
});
export type CommerceEntityPlaneCommandRequest = Readonly<
  StaticDecode<typeof entityPlaneCommandRequestSchema>
>;
const commandKind = OpenObject({ kind: Type.String() });
const requestWire = OpenObject({
  ...entityPlaneCommandRequestSchema.properties,
  authority: Type.Optional(Type.Unknown()),
  command: Type.Optional(Type.Unknown()),
});

export function parseCommerceEntityPlaneCommand(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneCommand> {
  const parsed = parseContract(commandKind, input, invalidShape);
  if (!parsed.ok) return parsed;
  switch (parsed.value.kind) {
    case "create_custom_entity_type":
    case "publish_custom_entity_type":
    case "create_system_entity_extension_schema":
    case "publish_system_entity_extension_schema":
    case "create_custom_entity":
    case "patch_custom_entity":
    case "archive_custom_entity":
      return parseEntityLifecycleCommand(input);
    case "create_custom_relationship_definition":
    case "publish_custom_relationship_definition":
    case "create_custom_relationship":
    case "delete_custom_relationship":
    case "replace_custom_relationship":
      return parseRelationshipLifecycleCommand(input);
    case "create_commerce_list":
    case "add_commerce_list_entry":
    case "patch_commerce_list_entry":
    case "remove_commerce_list_entry":
    case "publish_saved_commerce_view":
    case "archive_saved_commerce_view":
      return parseListViewCommand(input);
    default:
      return parseContract(
        commerceEntityPlaneCommandSchema,
        input,
        invalidShape,
      );
  }
}
export function parseEntityPlaneCommand(
  input: unknown,
  now: string,
): ContractDecodeResult<CommerceEntityPlaneCommandRequest> {
  const parsed = parseContract(requestWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  const authority = parseCommerceEntityAuthority({
    authority: request.authority,
    now,
  });
  if (!authority.ok) return authority;
  const command = parseCommerceEntityPlaneCommand(request.command);
  if (!command.ok) return command;
  return {
    ok: true,
    value: {
      organisationId: request.organisationId,
      merchantId: request.merchantId,
      commandId: request.commandId,
      expectedMerchantRevision: request.expectedMerchantRevision,
      authority: authority.value,
      command: command.value,
    },
  };
}

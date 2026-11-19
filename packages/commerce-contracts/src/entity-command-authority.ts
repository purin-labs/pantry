import { assertNever, canonicalJsonByCodePoint } from "@purin-labs/std";
import { parseCommandAuthorizationInput } from "./command-authorization-input.ts";
import { parseCommerceEntityAuthority } from "./command-authority.ts";
import { parseEntityLifecycleCommand } from "./entity-commands.ts";
import { commerceSensitivitySchema } from "./entity-record.ts";
import { cursorRefusal } from "./cursor-values.ts";
import type { ContractDecodeResult } from "./schema.ts";

export function validateEntityCommandAuthority(
  input: unknown,
): ContractDecodeResult<true> {
  const parsedRequest = parseCommandAuthorizationInput(input);
  if (!parsedRequest.ok) return parsedRequest;
  const request = parsedRequest.value;
  const authority = parseCommerceEntityAuthority({
    authority: request.authority,
    now: request.now,
  });
  if (!authority.ok) return authority;
  const command = parseEntityLifecycleCommand(request.command);
  if (!command.ok) return command;
  const context = authority.value.context;
  if (
    context.organisationId !== request.organisationId ||
    context.merchantId !== request.merchantId ||
    context.causation.kind !== "command" ||
    context.causation.commandId !== request.commandId
  )
    return cursorRefusal("authority_out_of_scope");
  switch (command.value.kind) {
    case "create_custom_entity": {
      const value = command.value.command;
      if (
        authority.value.kind !== "entity_create" ||
        authority.value.target.entityId !== value.entityId ||
        authority.value.target.typeId !== value.typeId
      )
        return cursorRefusal("authority_out_of_scope");
      if (
        commerceSensitivitySchema.enum.indexOf(context.sensitivityCeiling) <
        commerceSensitivitySchema.enum.indexOf(value.sensitivity)
      )
        return cursorRefusal("sensitivity_denied");
      break;
    }
    case "patch_custom_entity":
    case "archive_custom_entity": {
      const value = command.value.command;
      if (
        authority.value.kind !== "entity_command" ||
        authority.value.target.expectedRevision !== value.expectedRevision ||
        canonicalJsonByCodePoint(authority.value.target.entityRef) !==
          canonicalJsonByCodePoint(value.entityRef)
      )
        return cursorRefusal("authority_out_of_scope");
      break;
    }
    case "create_custom_entity_type":
      if (
        authority.value.kind !== "custom_entity_type_create" ||
        authority.value.target.typeId !== command.value.command.draft.typeId
      )
        return cursorRefusal("authority_out_of_scope");
      break;
    case "publish_custom_entity_type":
      if (
        authority.value.kind !== "custom_entity_type_publish" ||
        canonicalJsonByCodePoint(authority.value.target) !==
          canonicalJsonByCodePoint(command.value.command.target)
      )
        return cursorRefusal("authority_out_of_scope");
      break;
    case "create_system_entity_extension_schema":
      if (
        authority.value.kind !== "system_entity_extension_schema_create" ||
        authority.value.target.entityTypeId !==
          command.value.command.draft.entityTypeId
      )
        return cursorRefusal("authority_out_of_scope");
      break;
    case "publish_system_entity_extension_schema":
      if (
        authority.value.kind !== "system_entity_extension_schema_publish" ||
        canonicalJsonByCodePoint(authority.value.target) !==
          canonicalJsonByCodePoint(command.value.command.target)
      )
        return cursorRefusal("authority_out_of_scope");
      break;
    default:
      return assertNever(command.value);
  }
  return { ok: true, value: true };
}

import { assertNever, canonicalJsonByCodePoint } from "@purin-labs/std";
import { parseCommandAuthorizationInput } from "./command-authorization-input.ts";
import { parseCommerceEntityAuthority } from "./command-authority.ts";
import { parseListViewCommand } from "./list-view-commands.ts";
import { cursorRefusal } from "./cursor-values.ts";
import type { ContractDecodeResult } from "@purin-labs/contract-schema";

export function validateListViewCommandAuthority(
  input: unknown,
): ContractDecodeResult<true> {
  const parsed = parseCommandAuthorizationInput(input);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  const authority = parseCommerceEntityAuthority({
    authority: request.authority,
    now: request.now,
  });
  if (!authority.ok) return authority;
  const command = parseListViewCommand(request.command);
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
    case "create_commerce_list": {
      const value = command.value.command;
      switch (authority.value.kind) {
        case "commerce_list_create":
          if (
            authority.value.target.listId !== value.listId ||
            canonicalJsonByCodePoint(authority.value.target.entityTypeId) !==
              canonicalJsonByCodePoint(value.entityTypeId)
          )
            return cursorRefusal("authority_out_of_scope");
          break;
        case "commerce_list_command":
          if (
            authority.value.target.listId !== value.listId ||
            authority.value.target.expectedRevision !== value.publishedRevision
          )
            return cursorRefusal("authority_out_of_scope");
          break;
        default:
          return cursorRefusal("authority_out_of_scope");
      }
      break;
    }
    case "add_commerce_list_entry": {
      const value = command.value.command;
      if (
        authority.value.kind !== "commerce_list_entry_create" ||
        authority.value.target.entry.entryId !== value.entryId ||
        authority.value.target.entry.listId !== value.listId ||
        authority.value.target.entry.revision !== value.revision ||
        authority.value.target.listRevision !== value.expectedListRevision ||
        canonicalJsonByCodePoint(authority.value.target.entityRef) !==
          canonicalJsonByCodePoint(value.entityRef)
      )
        return cursorRefusal("authority_out_of_scope");
      break;
    }
    case "patch_commerce_list_entry":
    case "remove_commerce_list_entry":
      if (
        authority.value.kind !== "commerce_list_entry_command" ||
        canonicalJsonByCodePoint(authority.value.target) !==
          canonicalJsonByCodePoint(command.value.command.target)
      )
        return cursorRefusal("authority_out_of_scope");
      break;
    case "publish_saved_commerce_view": {
      const view = command.value.command.view;
      switch (authority.value.kind) {
        case "saved_view_create":
          if (authority.value.target.viewId !== view.viewId)
            return cursorRefusal("authority_out_of_scope");
          break;
        case "saved_view_administration":
          if (
            authority.value.target.viewId !== view.viewId ||
            authority.value.target.expectedRevision + 1 !== view.revision
          )
            return cursorRefusal("authority_out_of_scope");
          break;
        default:
          return cursorRefusal("authority_out_of_scope");
      }
      break;
    }
    case "archive_saved_commerce_view":
      if (
        authority.value.kind !== "saved_view_administration" ||
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

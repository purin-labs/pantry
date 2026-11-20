import { isRecord } from "@purin-labs/std";
import { parseCommandAuthorizationInput } from "./command-authorization-input.ts";
import { parseCommerceEntityAuthority } from "./command-authority.ts";
import { validateEntityCommandAuthority } from "./entity-command-authority.ts";
import { parseCommerceEntityPlaneCommand } from "./entity-plane-commands.ts";
import { validateListViewCommandAuthority } from "./list-view-command-authority.ts";
import { validateRelationshipCommandAuthority } from "./relationship-authority.ts";
import { cursorRefusal } from "./cursor-values.ts";
import type { ContractDecodeResult } from "@purin-labs/contract-schema";

const RELATIONSHIP_COMMANDS: ReadonlySet<unknown> = new Set([
  "create_custom_relationship_definition",
  "publish_custom_relationship_definition",
  "create_custom_relationship",
  "delete_custom_relationship",
  "replace_custom_relationship",
]);
const RELATIONSHIP_AUTHORITIES: ReadonlySet<unknown> = new Set([
  "custom_relationship_definition_create",
  "custom_relationship_definition_publish",
  "relationship_create",
  "relationship_command",
  "relationship_replacement",
]);
const LIST_VIEW_COMMANDS: ReadonlySet<unknown> = new Set([
  "create_commerce_list",
  "add_commerce_list_entry",
  "patch_commerce_list_entry",
  "remove_commerce_list_entry",
  "publish_saved_commerce_view",
  "archive_saved_commerce_view",
]);

/**
 * Rust `validate_command_request` for every command kind: the authority, the
 * command and its scope, then the authority and command pair. A pair that no
 * rule names is out of scope.
 */
export function validateCommerceEntityPlaneCommandAuthority(
  input: unknown,
): ContractDecodeResult<true> {
  const parsed = parseCommandAuthorizationInput(input);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  const commandKind = isRecord(request.command)
    ? request.command.kind
    : undefined;
  const authorityKind = isRecord(request.authority)
    ? request.authority.kind
    : undefined;
  if (LIST_VIEW_COMMANDS.has(commandKind))
    return validateListViewCommandAuthority(input);
  if (!RELATIONSHIP_COMMANDS.has(commandKind))
    return validateEntityCommandAuthority(input);
  if (RELATIONSHIP_AUTHORITIES.has(authorityKind))
    return validateRelationshipCommandAuthority(input);
  // The relationship validator reads only relationship authorities.
  const authority = parseCommerceEntityAuthority({
    authority: request.authority,
    now: request.now,
  });
  if (!authority.ok) return authority;
  const command = parseCommerceEntityPlaneCommand(request.command);
  if (!command.ok) return command;
  return cursorRefusal("authority_out_of_scope");
}

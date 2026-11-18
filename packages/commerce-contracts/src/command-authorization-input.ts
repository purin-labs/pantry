import { isRecord } from "@seams/std";
import { Type } from "typebox";
import {
  StrictObject,
  normalizeContractInput,
  type ContractDecodeResult,
} from "./schema.ts";
import { cursorRefusal } from "./cursor-values.ts";

// The request admits an unknown authority; the selected authority parser checks it next.
export const authorityValidationRequestSchema = StrictObject({
  authority: Type.Unknown(),
  now: Type.String(),
});
export function invalidAuthorityRequest() {
  return {
    code: "invalid_request",
    reason: "invalid authority request",
    details: null,
  };
}
export type CommandAuthorizationInput = {
  authority: unknown;
  command: unknown;
  organisationId: string;
  merchantId: string;
  commandId: string;
  now: string;
};
/** Preserve the byte export's missing-field and scalar-type refusal order. */
export function parseCommandAuthorizationInput(
  input: unknown,
): ContractDecodeResult<CommandAuthorizationInput> {
  const normalized = normalizeContractInput(input);
  if (!normalized.ok) return normalized;
  if (!isRecord(normalized.value)) return cursorRefusal("invalid_request");
  const request = normalized.value;
  for (const [field, code] of [
    ["authority", "missing_authority"],
    ["command", "missing_command"],
    ["organisationId", "missing_organisation_id"],
    ["merchantId", "missing_merchant_id"],
    ["commandId", "missing_command_id"],
    ["now", "missing_now"],
  ] as const) {
    if (!Object.hasOwn(request, field)) return cursorRefusal(code);
  }
  const organisationId = request.organisationId;
  if (typeof organisationId !== "string")
    return cursorRefusal("invalid_organisation_id");
  const merchantId = request.merchantId;
  if (typeof merchantId !== "string")
    return cursorRefusal("invalid_merchant_id");
  const commandId = request.commandId;
  if (typeof commandId !== "string") return cursorRefusal("invalid_command_id");
  const now = request.now;
  if (typeof now !== "string") return cursorRefusal("invalid_now");
  return {
    ok: true,
    value: {
      authority: request.authority,
      command: request.command,
      organisationId,
      merchantId,
      commandId,
      now,
    },
  };
}

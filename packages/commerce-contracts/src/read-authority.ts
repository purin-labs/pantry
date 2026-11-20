import {
  authorityValidationRequestSchema as envelopeWire,
  invalidAuthorityRequest as invalidRequest,
} from "./command-authorization-input.ts";
import {
  OpenObject,
  StrictObject,
  parseContract,
  type ContractDecodeResult,
} from "@purin-labs/contract-schema";
import { Type, type Static } from "typebox";
import {
  commerceAuthorityContextSchema,
  commerceAuthorityContextWireSchema,
  parseCommerceAuthorityContext,
} from "./relationship-authority.ts";
import {
  commerceAuthorityScopeSchema,
  commerceAuthorityScopeWireSchema,
  parseCommerceAuthorityScope,
} from "./authority-scope.ts";

import { invalidShape } from "./query-parts.ts";
export const pantryCommerceReadAuthoritySchema = OpenObject({
  context: commerceAuthorityContextSchema,
  scope: commerceAuthorityScopeSchema,
});
export const commerceEntityReadAuthoritySchema = OpenObject({
  kind: Type.Literal("entity_read"),
  ...pantryCommerceReadAuthoritySchema.properties,
});
export type PantryCommerceReadAuthority = Static<
  typeof pantryCommerceReadAuthoritySchema
>;
export type CommerceEntityReadAuthority = Static<
  typeof commerceEntityReadAuthoritySchema
>;
const readWire = OpenObject({
  context: commerceAuthorityContextWireSchema,
  scope: commerceAuthorityScopeWireSchema,
});
const entityReadWire = OpenObject({
  kind: Type.Literal("entity_read"),
  ...readWire.properties,
});
const envelope = StrictObject({
  authority: entityReadWire,
  now: Type.String(),
});

export function parsePantryCommerceReadAuthority(
  input: unknown,
  now: string,
): ContractDecodeResult<PantryCommerceReadAuthority> {
  const parsed = parseContract(readWire, input, invalidShape);
  if (!parsed.ok) return parsed;
  const context = parseCommerceAuthorityContext(parsed.value.context, now);
  if (!context.ok) return context;
  const scope = parseCommerceAuthorityScope(parsed.value.scope);
  if (!scope.ok) return scope;
  return { ok: true, value: { context: context.value, scope: scope.value } };
}
export function parseCommerceEntityReadAuthority(
  input: unknown,
): ContractDecodeResult<CommerceEntityReadAuthority> {
  const request = parseContract(envelopeWire, input, invalidRequest);
  if (!request.ok) return request;
  const parsed = parseContract(envelope, request.value, invalidShape);
  if (!parsed.ok) return parsed;
  const authority = parsePantryCommerceReadAuthority(
    parsed.value.authority,
    parsed.value.now,
  );
  if (!authority.ok) return authority;
  return {
    ok: true,
    value: {
      kind: "entity_read",
      context: authority.value.context,
      scope: authority.value.scope,
    },
  };
}

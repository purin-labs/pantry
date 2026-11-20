import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { commerceAuthorityScopeWireSchema } from "@purin-labs/commerce-contracts/authority-scope";
import { commerceMutationTargetWireSchema } from "@purin-labs/commerce-contracts/entity-plane-receipts";
import { commerceSystemKindSchema } from "./commerce-system.ts";
import { parseCommerceGraphQuery } from "@purin-labs/commerce-contracts/graph-query";
import { systemEntityTypeIdSchema } from "@purin-labs/commerce-contracts/query-parts";
import { hasLoneSurrogate, isRecord } from "@purin-labs/std";

// Plan 78: TypeScript port of access_control.rs. Rust validates these values
// with serde alone, so each schema is the derived serde shape: every listed
// field, exact integer ranges, and no unknown field where Rust denies them.

const u32 = Type.Integer({ minimum: 0, maximum: 0xffff_ffff });
const u64 = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const strict = { additionalProperties: false } as const;

const workflowAuthorityKindSchema = Type.Literal("cue_subscription");
export const grantSubjectSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("organisation_role"), role: Type.String() },
    strict,
  ),
  Type.Object(
    { kind: Type.Literal("person"), personId: Type.String() },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("conversation"),
      integrationAccountId: Type.String(),
      conversationId: Type.String(),
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("workflow"),
      workflowKind: workflowAuthorityKindSchema,
      workflowId: Type.String(),
      workflowRevision: u64,
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("agent_mailbox"),
      integrationAccountId: Type.String(),
      mailboxBindingId: Type.String(),
      bindingRevision: u64,
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("whatsapp_support"),
      integrationAccountId: Type.String(),
      supportBindingId: Type.String(),
      bindingRevision: u64,
    },
    strict,
  ),
]);

// FileResourceScope has no deny_unknown_fields.
export const fileResourceScopeSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("dropbox_folder"),
    providerFolderId: Type.String(),
    pathDisplay: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal("dropbox_file"),
    providerFileId: Type.String(),
    pathDisplay: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal("gdrive_file"),
    providerFileId: Type.String(),
    name: Type.String(),
  }),
]);

const commerceEntityTypeIdShape = Type.Union([
  systemEntityTypeIdSchema,
  Type.Object({ origin: Type.Literal("custom"), typeId: Type.String() }),
]);
const publishedCommerceSelectorShape = Type.Object({
  selectorId: Type.String(),
  revision: u64,
  query: Type.Unknown(),
});
const commerceReadGrantScopeShape = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("entity_type"),
      entityTypeId: commerceEntityTypeIdShape,
    },
    strict,
  ),
  Type.Object(
    { kind: Type.Literal("commerce_list"), listId: Type.String() },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("saved_selector"),
      selector: publishedCommerceSelectorShape,
    },
    strict,
  ),
]);
const capability = {
  capabilityId: Type.String(),
  capabilityVersion: u32,
};
const accessGrantTargetShape = Type.Union([
  Type.Object(
    { kind: Type.Literal("platform_capability"), ...capability },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("provider_resource"),
      ...capability,
      integrationAccountId: Type.String(),
      resourceScope: Type.String(),
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("file_resource"),
      ...capability,
      integrationAccountId: Type.String(),
      scope: fileResourceScopeSchema,
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("custom_connector_operation"),
      ...capability,
      integrationAccountId: Type.String(),
      connectorId: Type.String(),
      definitionRevision: u32,
      definitionDigest: Type.String(),
      operationId: Type.String(),
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("commerce_read"),
      ...capability,
      scope: commerceReadGrantScopeShape,
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("commerce_command"),
      ...capability,
      scope: commerceAuthorityScopeWireSchema,
      target: commerceMutationTargetWireSchema,
    },
    strict,
  ),
]);

export const accessGrantLifecycleSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("active"), revision: u32, activatedAt: u64 },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("revoked"),
      revision: u32,
      revokedAt: u64,
      reason: Type.String(),
    },
    strict,
  ),
]);

const capabilityCategorySchema = Type.Union([
  Type.Literal("context"),
  Type.Literal("customer_data"),
  Type.Literal("external_data"),
  Type.Literal("commerce"),
  Type.Literal("agent_operations"),
  Type.Literal("payments"),
]);
const capabilityRiskSchema = Type.Union([
  Type.Literal("read"),
  Type.Literal("propose"),
  Type.Literal("external_effect"),
]);
const capabilityTargetKindSchema = Type.Union([
  Type.Literal("platform"),
  Type.Literal("provider_resource"),
  Type.Literal("file_resource"),
  Type.Literal("custom_connector_operation"),
  Type.Literal("commerce_read"),
  Type.Literal("commerce_command"),
]);
const capabilityProviderSchema = Type.Union([
  Type.Literal("airtable"),
  Type.Literal("dropbox"),
  Type.Literal("gmail"),
  Type.Literal("gmo_aozora"),
  Type.Literal("google_drive"),
  Type.Literal("notion"),
  Type.Literal("shopify"),
  Type.Literal("slack"),
  Type.Literal("square"),
  Type.Literal("stripe"),
  Type.Literal("whatsapp"),
  Type.Literal("wise"),
]);
const capabilityPolicyModesSchema = Type.Union([
  Type.Literal("enabled_disabled"),
  Type.Literal("approval_required_disabled"),
  Type.Literal("enabled_approval_required_disabled"),
]);
// serde ignores extra fields of a unit variant, even with deny_unknown_fields.
export const capabilityProviderDependencySchema = Type.Union([
  Type.Object({ kind: Type.Literal("none") }),
  Type.Object(
    {
      kind: Type.Literal("provider"),
      providers: Type.Array(capabilityProviderSchema),
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("commerce_system"),
      systems: Type.Array(commerceSystemKindSchema),
    },
    strict,
  ),
]);
export const capabilityDefinitionSchema = Type.Object(
  {
    capabilityId: Type.String(),
    capabilityVersion: u32,
    label: Type.String(),
    description: Type.String(),
    category: capabilityCategorySchema,
    risk: capabilityRiskSchema,
    target: capabilityTargetKindSchema,
    providerDependency: capabilityProviderDependencySchema,
    policyModes: capabilityPolicyModesSchema,
  },
  strict,
);

export type GrantSubject = Static<typeof grantSubjectSchema>;
export type FileResourceScope = Static<typeof fileResourceScopeSchema>;
export type AccessGrantLifecycle = Static<typeof accessGrantLifecycleSchema>;
export type CapabilityDefinition = Static<typeof capabilityDefinitionSchema>;
export type CapabilityProviderDependency = Static<
  typeof capabilityProviderDependencySchema
>;

// ---------------------------------------------------------------------------
// Decoders with the result form of the browser validators
// ---------------------------------------------------------------------------

export type AccessDecodeError = Readonly<{
  kind: "validation_rejected" | "input_invalid";
  code: "invalid_access_contract" | "invalid_json" | "invalid_json_integer";
  reason: string;
  details: null;
}>;
export type AccessDecodeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: AccessDecodeError }>;

function refused(reason: string): AccessDecodeResult<never> {
  return {
    ok: false,
    error: {
      kind: "validation_rejected",
      code: "invalid_access_contract",
      reason,
      details: null,
    },
  };
}

/**
 * The value as JSON reaches the Rust core: refuses what JSON.stringify cannot
 * write and a bigint or an integer beyond the safe range.
 */
function jsonInput(value: unknown): AccessDecodeResult<unknown> {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, safeInteger);
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof UnsafeIntegerError
          ? {
              kind: "input_invalid",
              code: "invalid_json_integer",
              reason: "contract integer exceeds the JavaScript safe range",
              details: null,
            }
          : {
              kind: "input_invalid",
              code: "invalid_json",
              reason: "value is not JSON serializable",
              details: null,
            },
    };
  }
  if (text === undefined)
    return {
      ok: false,
      error: {
        kind: "input_invalid",
        code: "invalid_json",
        reason: "value is not JSON serializable",
        details: null,
      },
    };
  if (hasLoneSurrogate(text)) return refused("lone surrogate in a string");
  return { ok: true, value: JSON.parse(text) };
}

class UnsafeIntegerError extends TypeError {}
function safeInteger(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || BigInt(number) !== value)
      throw new UnsafeIntegerError();
    return number;
  }
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value)
  )
    throw new UnsafeIntegerError();
  return value;
}

function checkShape(schema: TSchema, value: unknown): AccessDecodeResult<true> {
  if (Value.Check(schema, value)) return { ok: true, value: true };
  const [first] = Value.Errors(schema, value);
  return refused(
    first === undefined
      ? "value does not match the contract"
      : `${first.instancePath || "/"} ${first.message}`,
  );
}

/** serde round trip: the matching union member, with unknown fields dropped. */
function serdeValue(schema: TSchema, value: unknown): unknown {
  const members = (schema as { anyOf?: TSchema[] }).anyOf;
  if (members !== undefined) {
    const member = members.find((candidate) => Value.Check(candidate, value));
    return member === undefined ? value : serdeValue(member, value);
  }
  const properties = (schema as { properties?: Record<string, TSchema> })
    .properties;
  if (properties !== undefined && isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(properties))
      if (Object.hasOwn(value, key))
        result[key] = serdeValue(property, value[key]);
    return result;
  }
  const items = (schema as { items?: TSchema }).items;
  if (items !== undefined && Array.isArray(value))
    return value.map((item) => serdeValue(items, item));
  return value;
}

function decode<T>(schema: TSchema, value: unknown): AccessDecodeResult<T> {
  const input = jsonInput(value);
  if (!input.ok) return input;
  const shape = checkShape(schema, input.value);
  if (!shape.ok) return shape;
  return { ok: true, value: serdeValue(schema, input.value) as T };
}

export function decodeGrantSubject(
  value: unknown,
): AccessDecodeResult<GrantSubject> {
  return decode(grantSubjectSchema, value);
}

export function decodeAccessGrantLifecycle(
  value: unknown,
): AccessDecodeResult<AccessGrantLifecycle> {
  return decode(accessGrantLifecycleSchema, value);
}

export function decodeCapabilityDefinition(
  value: unknown,
): AccessDecodeResult<CapabilityDefinition> {
  return decode(capabilityDefinitionSchema, value);
}

/**
 * A saved selector's query must also be a valid graph query. Rust checks its
 * serde shape only, so this decoder refuses a few queries with valid shape and
 * invalid content that Rust accepts; the Platform never writes such a grant.
 */
export function decodeAccessGrantTarget<T>(
  value: unknown,
): AccessDecodeResult<T> {
  const decoded = decode<Record<string, unknown>>(
    accessGrantTargetShape,
    value,
  );
  if (!decoded.ok) return decoded;
  const target = decoded.value;
  const scope = target.scope;
  if (
    target.kind === "commerce_read" &&
    isRecord(scope) &&
    scope.kind === "saved_selector" &&
    isRecord(scope.selector)
  ) {
    const query = parseCommerceGraphQuery(scope.selector.query);
    if (!query.ok) return refused(`selector query: ${query.error.code}`);
    return {
      ok: true,
      value: {
        ...target,
        scope: {
          kind: "saved_selector",
          selector: { ...scope.selector, query: query.value },
        },
      } as T,
    };
  }
  return { ok: true, value: target as T };
}

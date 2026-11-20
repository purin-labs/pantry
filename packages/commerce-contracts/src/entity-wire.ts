import { systemEntityTypeIdSchema } from "./query-parts.ts";
import {
  OpenObject,
  StrictObject,
  NonNegativeInteger as revision,
  SafeInteger as integer,
} from "@purin-labs/contract-schema";
import { Type, type Static } from "typebox";

import {
  commerceFreshnessSchema,
  customCommerceEntityStateSchema,
  sourceProvenanceSchema,
} from "./entity-state.ts";

// Serde checks the complete request structure before domain validation.

const decimal = OpenObject({
  unscaled: integer,
  scale: Type.Integer({ minimum: 0, maximum: 255 }),
});
const sensitivity = Type.Enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
const systemKind = systemEntityTypeIdSchema.properties.typeId;
const attributeScopeWireSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("system"),
    entityTypeId: systemKind,
    schemaRevision: revision,
  }),
  OpenObject({
    kind: Type.Literal("merchant_extension"),
    entityTypeId: systemKind,
    schemaRevision: revision,
  }),
  OpenObject({
    kind: Type.Literal("custom"),
    entityTypeId: Type.String(),
    typeRevision: revision,
  }),
]);
export const attributeValueWireSchema = Type.Union([
  OpenObject({
    kind: Type.Enum(["short_text", "long_text", "date", "timestamp", "status"]),
    value: Type.String(),
  }),
  OpenObject({ kind: Type.Literal("integer"), value: integer }),
  OpenObject({ kind: Type.Literal("decimal"), value: decimal }),
  OpenObject({ kind: Type.Literal("boolean"), value: Type.Boolean() }),
  OpenObject({
    kind: Type.Literal("choice"),
    values: Type.Array(Type.String()),
  }),
  OpenObject({
    kind: Type.Literal("money"),
    value: OpenObject({ amountMinor: integer, currency: Type.String() }),
  }),
  OpenObject({
    kind: Type.Literal("merchant_operator_reference"),
    value: OpenObject({
      principalId: Type.String(),
      displayName: Type.String(),
    }),
  }),
  OpenObject({
    kind: Type.Literal("external_resource_reference"),
    value: OpenObject({
      source: sourceProvenanceSchema.properties.source,
      resourceId: Type.String(),
      label: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
  }),
]);
export const attributeAssignmentWireSchema = StrictObject({
  attributeId: Type.String(),
  scope: attributeScopeWireSchema,
  definitionRevision: revision,
  sensitivity,
  value: attributeValueWireSchema,
});
export type AttributeAssignmentWire = Static<
  typeof attributeAssignmentWireSchema
>;
const common = {
  revision,
  displayName: Type.String(),
  attributes: Type.Array(attributeAssignmentWireSchema),
};
export const sourceProvenanceWireSchema = OpenObject({
  ...sourceProvenanceSchema.properties,
  organisationId: Type.String(),
  integrationAccountId: Type.String(),
  resourceId: Type.String(),
  revision,
});
export const entityWireSchema = Type.Union([
  OpenObject({
    reference: OpenObject({
      origin: Type.Literal("system"),
      typeId: systemKind,
      entityId: Type.String(),
    }),
    ...common,
    provenance: sourceProvenanceWireSchema,
    freshness: commerceFreshnessSchema,
  }),
  OpenObject({
    reference: OpenObject({
      origin: Type.Literal("custom"),
      typeId: Type.String(),
      entityId: Type.String(),
    }),
    ...common,
    typeRevision: revision,
    state: customCommerceEntityStateSchema,
    sensitivity,
  }),
]);
export type EntityWire = Static<typeof entityWireSchema>;
const option = OpenObject({ id: Type.String(), label: Type.String() });
const nullableInteger = Type.Optional(Type.Union([integer, Type.Null()]));
const nullableDecimal = Type.Optional(Type.Union([decimal, Type.Null()]));
const definitionKind = Type.Union([
  OpenObject({
    kind: Type.Literal("short_text"),
    maxLength: Type.Integer({ minimum: 0, maximum: 65535 }),
  }),
  OpenObject({
    kind: Type.Literal("long_text"),
    maxLength: Type.Integer({ minimum: 0, maximum: 0xffffffff }),
  }),
  OpenObject({
    kind: Type.Literal("integer"),
    minimum: nullableInteger,
    maximum: nullableInteger,
  }),
  OpenObject({
    kind: Type.Literal("decimal"),
    scale: Type.Integer({ minimum: 0, maximum: 255 }),
    minimum: nullableDecimal,
    maximum: nullableDecimal,
  }),
  OpenObject({
    kind: Type.Enum([
      "boolean",
      "date",
      "timestamp",
      "merchant_operator_reference",
      "external_resource_reference",
    ]),
  }),
  OpenObject({ kind: Type.Literal("status"), options: Type.Array(option) }),
  OpenObject({
    kind: Type.Literal("choice"),
    options: Type.Array(option),
    allowsMultiple: Type.Boolean(),
  }),
  OpenObject({
    kind: Type.Literal("money"),
    allowedCurrencies: Type.Array(Type.String()),
  }),
]);
export const attributeDefinitionWireSchema = StrictObject({
  id: Type.String(),
  scope: attributeScopeWireSchema,
  revision,
  label: Type.String(),
  helpText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  required: Type.Boolean(),
  sensitivity,
  kind: definitionKind,
});

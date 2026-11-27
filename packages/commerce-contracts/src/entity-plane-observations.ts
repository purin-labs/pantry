import {
  commerceListEntryAuthorityScopeWireSchema,
  commerceListEntryRefSchema,
  parseCommerceListEntryRef,
} from "./authority-scope.ts";
import {
  systemEntityRefWireSchema,
  customEntityRefWireSchema,
  commerceEntityRefWireSchema,
} from "./query-wire.ts";
import {
  OpenObject,
  parseContract,
  type ContractDecodeResult,
  NonNegativeInteger as revisionWire,
} from "@purin-labs/contract-schema";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { assertNever, canonicalJsonByCodePoint } from "@purin-labs/std";
import { type StrictUnion } from "@purin-labs/type-utils";
import {
  commerceEntityRefSchema,
  systemCommerceEntityRefSchema,
  customCommerceEntityRefSchema,
  parseCommerceEntityRef,
  type CommerceEntityRef,
} from "./entity-reference.ts";

import {
  commerceRelationshipSchema,
  commerceRelationshipWireSchema,
  relationshipDefinitionSchema,
  relationshipDefinitionRecordWireSchema,
  parseObservedRelationship,
  type CommerceRelationship,
  type RelationshipDefinition,
} from "./relationships.ts";
import {
  sourceProvenanceSchema,
  parseEntityProvenance,
} from "./entity-state.ts";
import { sourceProvenanceWireSchema } from "./entity-wire.ts";
import { revisionSchema } from "./entity-record.ts";
import { merchantRevisionSchema } from "./entity-plane-receipts.ts";
import {
  queryIdentitySchema,
  identityRefusal,
  invalidShape,
} from "./query-parts.ts";
import { cursorRefusal } from "./cursor-values.ts";

const observationIdSchema = queryIdentitySchema<"CommerceCommandId">();
const entityRevisionSchema = revisionSchema<"CommerceEntityRevision">();
const entryRevisionSchema = revisionSchema<"CommerceListEntryRevision">();
const commerceEntityPlaneObservationV1Schema = Type.Union([
  OpenObject({
    kind: Type.Literal("system_entity_changed"),
    observationId: observationIdSchema,
    entityRef: systemCommerceEntityRefSchema,
    revision: entityRevisionSchema,
    provenance: sourceProvenanceSchema,
    merchantRevision: merchantRevisionSchema,
  }),
  OpenObject({
    kind: Type.Literal("custom_entity_changed"),
    observationId: observationIdSchema,
    entityRef: customCommerceEntityRefSchema,
    revision: entityRevisionSchema,
    merchantRevision: merchantRevisionSchema,
  }),
  OpenObject({
    kind: Type.Literal("relationship_changed"),
    observationId: observationIdSchema,
    relationship: Type.Unsafe<CommerceRelationship>(commerceRelationshipSchema),
    definition: Type.Unsafe<RelationshipDefinition>(
      relationshipDefinitionSchema,
    ),
    merchantRevision: merchantRevisionSchema,
  }),
  OpenObject({
    kind: Type.Literal("commerce_list_entry_changed"),
    observationId: observationIdSchema,
    entry: commerceListEntryRefSchema,
    entityRef: Type.Unsafe<CommerceEntityRef>(commerceEntityRefSchema),
    revision: entryRevisionSchema,
    merchantRevision: merchantRevisionSchema,
  }),
]);
export type CommerceEntityPlaneObservationV1 = StrictUnion<
  Static<typeof commerceEntityPlaneObservationV1Schema>
>;

const entityPlaneObservationWireSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("system_entity_changed"),
    observationId: Type.String(),
    entityRef: systemEntityRefWireSchema,
    revision: revisionWire,
    provenance: sourceProvenanceWireSchema,
    merchantRevision: revisionWire,
  }),
  OpenObject({
    kind: Type.Literal("custom_entity_changed"),
    observationId: Type.String(),
    entityRef: customEntityRefWireSchema,
    revision: revisionWire,
    merchantRevision: revisionWire,
  }),
  OpenObject({
    kind: Type.Literal("relationship_changed"),
    observationId: Type.String(),
    relationship: commerceRelationshipWireSchema,
    definition: relationshipDefinitionRecordWireSchema,
    merchantRevision: revisionWire,
  }),
  OpenObject({
    kind: Type.Literal("commerce_list_entry_changed"),
    observationId: Type.String(),
    entry: commerceListEntryAuthorityScopeWireSchema.properties.entry,
    entityRef: commerceEntityRefWireSchema,
    revision: revisionWire,
    merchantRevision: revisionWire,
  }),
]);

export function parseCommerceEntityPlaneObservation(
  input: unknown,
): ContractDecodeResult<CommerceEntityPlaneObservationV1> {
  const parsed = parseContract(
    entityPlaneObservationWireSchema,
    input,
    invalidShape,
  );
  if (!parsed.ok) return parsed;
  const observation = parsed.value;
  const observationId = observation.observationId;
  if (!Value.Check(observationIdSchema, observationId))
    return identityRefusal("CommerceCommandId");
  switch (observation.kind) {
    case "system_entity_changed": {
      const entityRef = parseCommerceEntityRef(observation.entityRef);
      if (!entityRef.ok) return entityRef;
      if (entityRef.value.origin !== "system") return cursorRefusal("parse");
      const revision = observation.revision;
      if (!Value.Check(entityRevisionSchema, revision))
        return invalidRevision("CommerceEntityRevision");
      const merchantRevision = observation.merchantRevision;
      if (!Value.Check(merchantRevisionSchema, merchantRevision))
        return invalidRevision("MerchantRevision");
      const provenance = parseEntityProvenance(observation.provenance);
      if (!provenance.ok) return provenance;
      const resourceType =
        entityRef.value.typeId === "order"
          ? "commerce_order"
          : entityRef.value.typeId;
      if (
        provenance.value.resourceType !== resourceType ||
        provenance.value.resourceId !== entityRef.value.entityId
      )
        return cursorRefusal("provenance_identity_mismatch");
      return normalizedObservation({
        kind: observation.kind,
        observationId,
        entityRef: entityRef.value,
        revision,
        provenance: provenance.value,
        merchantRevision,
      });
    }
    case "custom_entity_changed": {
      const entityRef = parseCommerceEntityRef(observation.entityRef);
      if (!entityRef.ok) return entityRef;
      if (entityRef.value.origin !== "custom") return cursorRefusal("parse");
      const revision = observation.revision;
      if (!Value.Check(entityRevisionSchema, revision))
        return invalidRevision("CommerceEntityRevision");
      const merchantRevision = observation.merchantRevision;
      if (!Value.Check(merchantRevisionSchema, merchantRevision))
        return invalidRevision("MerchantRevision");
      return normalizedObservation({
        kind: observation.kind,
        observationId,
        entityRef: entityRef.value,
        revision,
        merchantRevision,
      });
    }
    case "relationship_changed": {
      const relationship = parseObservedRelationship(
        observation.relationship,
        observation.definition,
      );
      if (!relationship.ok) return relationship;
      const merchantRevision = observation.merchantRevision;
      if (!Value.Check(merchantRevisionSchema, merchantRevision))
        return invalidRevision("MerchantRevision");
      return normalizedObservation({
        kind: observation.kind,
        observationId,
        relationship: relationship.value.relationship,
        definition: relationship.value.definition,
        merchantRevision,
      });
    }
    case "commerce_list_entry_changed": {
      const entry = parseCommerceListEntryRef(observation.entry);
      if (!entry.ok) return entry;
      const entityRef = parseCommerceEntityRef(observation.entityRef);
      if (!entityRef.ok) return entityRef;
      const revision = observation.revision;
      if (!Value.Check(entryRevisionSchema, revision))
        return invalidRevision("CommerceListEntryRevision");
      const merchantRevision = observation.merchantRevision;
      if (!Value.Check(merchantRevisionSchema, merchantRevision))
        return invalidRevision("MerchantRevision");
      if (entry.value.revision !== revision)
        return cursorRefusal("revision_conflict", {
          expected: revision,
          received: entry.value.revision,
        });
      return normalizedObservation({
        kind: observation.kind,
        observationId,
        entry: entry.value,
        entityRef: entityRef.value,
        revision,
        merchantRevision,
      });
    }
    default:
      return assertNever(observation);
  }
}
function normalizedObservation(
  value: CommerceEntityPlaneObservationV1,
): ContractDecodeResult<CommerceEntityPlaneObservationV1> {
  // Delivery signatures use the JSON bytes of the Rust-normalized observation.
  const normalized: unknown = JSON.parse(canonicalJsonByCodePoint(value));
  return parseContract(
    commerceEntityPlaneObservationV1Schema,
    normalized,
    invalidShape,
  );
}
function invalidRevision(field: string): ContractDecodeResult<never> {
  return cursorRefusal("invalid_revision", { field });
}

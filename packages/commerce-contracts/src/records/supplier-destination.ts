// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject, SafeInteger } from "@purin-labs/contract-schema";
import { resourceIdSchema } from "./identifiers.ts";
import { commerceTimestampSchema } from "./provenance.ts";

/**
 * Which rail a destination is addressed for. A destination is rail-specific:
 * a Japanese bank account and a Wise recipient are not interchangeable.
 */
const supplierDestinationRailSchema = Type.Union([
  OpenObject({ kind: Type.Literal("gmo_aozora_domestic") }),
  OpenObject({
    kind: Type.Literal("wise_recipient"),
    providerRecipientId: resourceIdSchema,
    detailsFingerprint: Type.String(),
  }),
]);
export type SupplierDestinationRail = Static<
  typeof supplierDestinationRailSchema
>;

/**
 * Where a destination revision stands. Only `active` can receive money.
 */
const supplierDestinationStateSchema = Type.Union([
  OpenObject({ kind: Type.Literal("draft"), proposedBy: resourceIdSchema }),
  OpenObject({
    kind: Type.Literal("verified"),
    proposedBy: resourceIdSchema,
    verifiedAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("active"),
    proposedBy: resourceIdSchema,
    activatedBy: resourceIdSchema,
    activatedAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("retired"),
    retiredAt: commerceTimestampSchema,
  }),
]);
export type SupplierDestinationState = Static<
  typeof supplierDestinationStateSchema
>;

/**
 * One immutable revision of a supplier destination.
 */
const supplierDestinationRevisionSchema = OpenObject({
  revisionId: resourceIdSchema,
  destinationId: resourceIdSchema,
  supplierId: resourceIdSchema,
  rail: supplierDestinationRailSchema,
  maskedSummary: Type.String(),
  configurationRef: resourceIdSchema,
  revision: SafeInteger,
  state: supplierDestinationStateSchema,
});
export type SupplierDestinationRevision = Static<
  typeof supplierDestinationRevisionSchema
>;

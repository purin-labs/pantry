import { OpenObject, StrictObject } from "./schema.ts";
import { Type, type Static } from "typebox";
import type { StrictUnion } from "@seams/type-utils";

// These Rust records accept extra input fields. Keep that boundary behavior
// until the complete query parser performs its existing normalization.
export const commerceTraversalLimitsSchema = OpenObject({
  maxDepth: Type.Integer({ minimum: 0, maximum: 8 }),
  resultLimit: Type.Integer({ minimum: 1, maximum: 500 }),
});

export const commerceFreshnessRequirementSchema = Type.Union([
  Type.Literal("any"),
  Type.Literal("current_only"),
  StrictObject({
    observed_within_seconds: OpenObject({
      seconds: Type.Integer({ minimum: 1, maximum: 0xffffffff }),
    }),
  }),
]);

export type CommerceTraversalLimits = Static<
  typeof commerceTraversalLimitsSchema
>;
export type CommerceFreshnessRequirement = StrictUnion<
  Static<typeof commerceFreshnessRequirementSchema>
>;

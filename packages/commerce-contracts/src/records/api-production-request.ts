// Plan 78 step 2: schemas of the Commerce API types that the client
// declared by hand in src/production-request.ts. Generated once from the client
// types; the type fixtures in the client prove them equal.
import { Type, type Static } from "typebox";
import { wireRecordParser } from "./wire-objects.ts";
import { OpenObject, SafeInteger } from "../schema.ts";
import { quantitySchema } from "./commerce-records.ts";

export const productionRequestFieldsSchema = OpenObject({
  status: Type.Readonly(
    Type.Union([
      Type.Literal("requested"),
      Type.Literal("accepted"),
      Type.Literal("scheduled"),
    ]),
  ),
  recipeId: Type.Readonly(Type.String()),
  recipeRevision: Type.Readonly(SafeInteger),
  locationId: Type.Readonly(Type.String()),
  quantity: Type.Readonly(quantitySchema),
  neededBy: Type.Readonly(Type.String()),
});
export type ProductionRequestFields = Static<
  typeof productionRequestFieldsSchema
>;

// Parsers of the client API types (Plan 78 step 2).
export const parseProductionRequestFields = wireRecordParser(
  productionRequestFieldsSchema,
);

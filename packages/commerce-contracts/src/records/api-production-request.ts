// Plan 78 step 2: schemas of the Commerce API types that the client
// declared by hand in src/production-request.ts. Generated once from the client
// types; the type fixtures in the client prove them equal.
import { Type, type Static } from "typebox";
import { OpenObject, SafeInteger } from "@purin-labs/contract-schema";
import { quantitySchema } from "./commerce-records.ts";

const productionRequestFieldsSchema = OpenObject({
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

import { Type, type Static } from "typebox";
import { recordParser, NonNegativeInteger } from "@purin-labs/contract-schema";
import {
  surfaceAreaSchema,
  surfaceSourceSchema,
} from "./surface-observation.ts";

/**
 * One page that the agent of a Case received from a person's screen (Plan 87
 * phase 5), as Knowledge › Context › On screen lists it. It names the page,
 * the time and the records on screen, and holds no value from the page: no
 * view, no state and no path.
 */
export const caseScreenObservationSchema = Type.Object({
  /** The page title, such as "Costs & margins". */
  page: Type.String({ minLength: 1, maxLength: 120 }),
  area: surfaceAreaSchema,
  /** The label of the record that the page had open. */
  record: Type.Union([
    Type.String({ minLength: 1, maxLength: 120 }),
    Type.Null(),
  ]),
  capturedAt: NonNegativeInteger,
  /** When the person sent the message that carried the page. */
  sentAt: NonNegativeInteger,
  sources: Type.Array(surfaceSourceSchema, { maxItems: 200 }),
});

export const caseScreenObservationsResponseSchema = Type.Object({
  ok: Type.Literal(true),
  observations: Type.Array(caseScreenObservationSchema, { maxItems: 200 }),
});

export type CaseScreenObservationView = Static<
  typeof caseScreenObservationSchema
>;

const decodeResponse = recordParser(caseScreenObservationsResponseSchema);

export function parseCaseScreenObservationsResponse(
  raw: unknown,
): readonly CaseScreenObservationView[] {
  const decoded = decodeResponse(raw);
  if (!decoded.ok) throw new Error("The On screen list is invalid.");
  return decoded.value.observations;
}

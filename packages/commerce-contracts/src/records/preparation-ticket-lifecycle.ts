// The lifecycle of a preparation ticket: the states of PREPARATION_TICKET_MACHINE
// (commerce-machines.ts). Kept beside commerce-records.ts, which re-exports it.
import { Type, type Static } from "typebox";

import { OpenObject } from "../schema.ts";
import { resourceIdSchema } from "./identifiers.ts";
import { commerceTimestampSchema } from "./provenance.ts";

export const preparationTicketLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("queued"),
    queuedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("preparing"),
    startedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("completed"),
    completedAt: commerceTimestampSchema,
    movementIds: Type.Array(resourceIdSchema),
  }),
  // Staff cancelled the order before its preparation ended.
  OpenObject({
    state: Type.Literal("cancelled"),
    cancelledAt: commerceTimestampSchema,
  }),
]);
export type PreparationTicketLifecycle = Static<
  typeof preparationTicketLifecycleSchema
>;

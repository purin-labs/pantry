// A made-to-order order that staff cancel before its preparation ends cancels
// its preparation tickets too (Refactor 15, refactor 7, decision 1). The
// core's cancellation plans the move here and writes it in its own commit.
import {
  parsePreparationTicket,
  type CommerceAggregateObservationV1,
  type CommercePreparationTicketV1,
} from "@purin-labs/commerce-client";
import {
  commerceTransition,
  type CommerceInvalidTransition,
} from "@purin-labs/commerce-contracts";

import type { CommerceDatabase } from "../../database.ts";
import { projectFoodServiceEntity } from "../../entity-plane/food-service-integration.ts";
import {
  foodServiceObservation,
  readFoodServiceResources,
  writeFoodServiceResource,
} from "./food-service-store.ts";

type TicketCancellationPlan =
  | Readonly<{
      kind: "planned";
      tickets: readonly CommercePreparationTicketV1[];
    }>
  | Readonly<{
      kind: "rejected";
      error: CommerceInvalidTransition<"preparation_ticket">;
    }>;

/**
 * The order's tickets, each moved to `cancelled`. A ticket that staff
 * already completed refuses the move: its stock was used.
 */
export function planOrderTicketCancellation(
  database: CommerceDatabase,
  merchantId: string,
  orderId: string,
  cancelledAt: string,
): TicketCancellationPlan {
  const tickets: CommercePreparationTicketV1[] = [];
  for (const ticket of readFoodServiceResources(database, merchantId)
    .preparationTickets) {
    if (ticket.orderId !== orderId) continue;
    const cancel = commerceTransition(
      "preparation_ticket",
      ticket.lifecycle,
      "cancel",
    );
    if (!cancel.allowed) return { kind: "rejected", error: cancel.refusal };
    const revision = ticket.revision + 1;
    tickets.push(
      parsePreparationTicket({
        ...ticket,
        provenance: { ...ticket.provenance, revision },
        revision,
        lifecycle: { state: cancel.to, cancelledAt },
      }),
    );
  }
  return { kind: "planned", tickets };
}

export function cancelledTicketObservation(
  ticket: CommercePreparationTicketV1,
): CommerceAggregateObservationV1 {
  return foodServiceObservation({
    kind: "preparation_ticket",
    resource: ticket,
  });
}

/** Appends the cancelled revision; a second write of it fails. */
export function writeCancelledTicket(
  database: CommerceDatabase,
  merchantId: string,
  ticket: CommercePreparationTicketV1,
): void {
  writeFoodServiceResource(
    database,
    merchantId,
    { kind: "preparation_ticket", resource: ticket },
    projectFoodServiceEntity,
  );
}

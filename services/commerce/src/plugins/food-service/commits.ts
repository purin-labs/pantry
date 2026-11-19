// The mutations of the kitchen commands, as the core commits them: the
// observations of the signed delivery, the receipt's resource, and the rows
// that the commit transaction writes.
import type { CommerceAggregateObservationV1 } from "@purin-labs/commerce-client";

import {
  foodServiceObservation,
  foodServiceResourceId,
  foodServiceResourceRevision,
  writeFoodServiceResource,
} from "./food-service-store.ts";
import { findPositionForMovement } from "../../commerce-authority/inventory-planning.ts";
import { writeInventoryAllocation } from "../../checkout-persistence.ts";
import { projectFoodServiceEntity } from "../../entity-plane/food-service-integration.ts";
import type {
  ExtensionMutation,
  FoodServiceMutationCommand,
} from "../built-in-ports.ts";
import {
  insertInventoryLot,
  updateInventoryLot,
  updateInventoryPosition,
} from "../../inventory-persistence.ts";
import {
  insertPreparationMovement,
  insertProductionMovement,
} from "./movements.ts";
import { writeSoldOutMark } from "./sold-out-marks.ts";
import type { FoodServiceCommitRequest } from "./food-service-commands.ts";
import type { ProductionCommitRequest } from "./production-commands.ts";
import type { Variant } from "@purin-labs/type-utils";

export function foodServiceMutation(
  request: FoodServiceCommitRequest | ProductionCommitRequest,
): ExtensionMutation<FoodServiceMutationCommand> {
  switch (request.kind) {
    case "preparation_ticket":
      return preparationTicketMutation(request);
    case "sold_out_mark":
      return {
        command: request.command,
        merchant: request.merchant,
        commandKind: "mark_sold_out",
        resource: {
          kind: "sold_out_mark",
          id: `${request.mark.locationId}:${request.mark.variantId}`,
          revision: request.mark.revision,
        },
        observations: [],
        write: (database) =>
          writeSoldOutMark(database, request.command.merchantId, request.mark),
      };
    case "production_batch":
      return productionBatchMutation(request);
    case "resource": {
      const input = request.resource;
      return {
        command: request.command,
        merchant: request.merchant,
        commandKind: request.commandKind,
        resource: {
          kind: input.kind,
          id: foodServiceResourceId(input),
          revision: foodServiceResourceRevision(input),
        },
        observations: [foodServiceObservation(input)],
        write: (database) =>
          writeFoodServiceResource(
            database,
            request.command.merchantId,
            input,
            projectFoodServiceEntity,
          ),
      };
    }
  }
}

function productionBatchMutation(
  request: ProductionCommitRequest,
): ExtensionMutation<FoodServiceMutationCommand> {
  const { command, plan } = request;
  const observations: CommerceAggregateObservationV1[] = [
    foodServiceObservation({ kind: "production_batch", resource: plan.batch }),
  ];
  for (const movement of [...plan.inputMovements, plan.outputMovement])
    observations.push({ kind: "inventory_movement", resource: movement });
  for (const lot of plan.lots)
    observations.push({ kind: "inventory_lot", resource: lot });
  observations.push({ kind: "inventory_lot", resource: plan.outputLot });
  for (const position of plan.positions)
    observations.push({ kind: "inventory_position", resource: position });
  return {
    command,
    merchant: request.merchant,
    commandKind: "complete_production_batch",
    resource: {
      kind: "production_batch",
      id: plan.batch.productionBatchId,
      revision: plan.batch.revision,
    },
    observations,
    write: (database) => {
      for (const movement of plan.inputMovements)
        insertProductionMovement(
          database,
          command.merchantId,
          findPositionForMovement(plan.positions, movement).id,
          movement,
        );
      insertProductionMovement(
        database,
        command.merchantId,
        findPositionForMovement(plan.positions, plan.outputMovement).id,
        plan.outputMovement,
      );
      for (const lot of plan.lots)
        updateInventoryLot(database, command.merchantId, lot.revision - 1, lot);
      insertInventoryLot(
        database,
        command.merchantId,
        findPositionForMovement(plan.positions, plan.outputMovement).id,
        plan.outputLot,
      );
      for (const position of plan.positions)
        updateInventoryPosition(
          database,
          command.merchantId,
          position.revision - 1,
          position,
        );
      writeFoodServiceResource(
        database,
        command.merchantId,
        { kind: "production_batch", resource: plan.batch },
        projectFoodServiceEntity,
      );
    },
  };
}

function preparationTicketMutation(
  request: Variant<FoodServiceCommitRequest, "preparation_ticket">,
): ExtensionMutation<FoodServiceMutationCommand> {
  const { command, plan } = request;
  const observations: CommerceAggregateObservationV1[] = [
    foodServiceObservation({
      kind: "preparation_ticket",
      resource: plan.ticket,
    }),
  ];
  for (const movement of plan.movements)
    observations.push({ kind: "inventory_movement", resource: movement });
  for (const lot of plan.lots)
    observations.push({ kind: "inventory_lot", resource: lot });
  for (const position of plan.positions)
    observations.push({ kind: "inventory_position", resource: position });
  return {
    command,
    merchant: request.merchant,
    commandKind: "manage_preparation_ticket",
    resource: {
      kind: "preparation_ticket",
      id: plan.ticket.ticketId,
      revision: plan.ticket.revision,
    },
    observations,
    write: (database) => {
      for (const allocation of plan.allocations)
        writeInventoryAllocation(
          database,
          command.merchantId,
          "commit",
          allocation,
        );
      for (const movement of plan.movements)
        insertPreparationMovement(
          database,
          command.merchantId,
          findPositionForMovement(plan.positions, movement).id,
          movement,
        );
      for (const lot of plan.lots)
        updateInventoryLot(database, command.merchantId, lot.revision - 1, lot);
      for (const position of plan.positions)
        updateInventoryPosition(
          database,
          command.merchantId,
          position.revision - 1,
          position,
        );
      writeFoodServiceResource(
        database,
        command.merchantId,
        { kind: "preparation_ticket", resource: plan.ticket },
        projectFoodServiceEntity,
      );
    },
  };
}

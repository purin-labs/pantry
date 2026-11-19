// Food service and production of a café or pâtisserie (Plan 76 phase 5):
// preparation stations, modifier groups, recipes, stock policies, menus,
// preparation tickets and production batches. The core commits each
// command's mutation through the context it lends.
import type {
  CreatePreparationStationCommand,
  CreateModifierGroupRevisionCommand,
  CreateRecipeRevisionCommand,
  ConfigureStockPolicyCommand,
  PublishMenuCommand,
  MarkSoldOutCommand,
  ManagePreparationTicketCommand,
  CompleteProductionBatchCommand,
} from "@purin-labs/commerce-client";
import type { FoodServiceExtension } from "../built-in-ports.ts";
import { CafeScenarioProvisioning } from "./cafe-scenario.ts";
import { foodServiceMutation } from "./commits.ts";
import { foodServiceMenus } from "./menus.ts";
import { FoodServiceCommandAuthority } from "./food-service-commands.ts";
import { ProductionCommandAuthority } from "./production-commands.ts";

export const foodServiceExtension: FoodServiceExtension = {
  menus: foodServiceMenus,
  provisionCafeDemo: (context, command) =>
    new CafeScenarioProvisioning(context).provision(command),
  commands: (context) => {
    const commit = (
      request: Parameters<typeof foodServiceMutation>[0],
    ): ReturnType<typeof context.commit> =>
      context.commit(foodServiceMutation(request));
    const kitchen = new FoodServiceCommandAuthority({ ...context, commit });
    const production = new ProductionCommandAuthority({ ...context, commit });
    return {
      createPreparationStation: (raw) => kitchen.createPreparationStation(raw),
      createModifierGroupRevision: (raw) =>
        kitchen.createModifierGroupRevision(raw),
      createRecipeRevision: (raw) => kitchen.createRecipeRevision(raw),
      configureStockPolicy: (raw) => kitchen.configureStockPolicy(raw),
      publishMenu: (raw) => kitchen.publishMenu(raw),
      markSoldOut: (raw) => kitchen.markSoldOut(raw),
      managePreparationTicket: (raw) => kitchen.managePreparationTicket(raw),
      completeProductionBatch: (raw) => production.completeProductionBatch(raw),
    };
  },
};
export * from "./food-service-store.ts";
export { readPickupQueue } from "./pickup-queue.ts";
export {
  cancelledTicketObservation,
  planOrderTicketCancellation,
  writeCancelledTicket,
} from "./ticket-cancellation.ts";
export {
  deleteVariantSoldOutMarks,
  readSoldOutMarks,
} from "./sold-out-marks.ts";
export * from "./entity-plane.ts";
export { FOOD_SERVICE_SCHEMA } from "./schema.ts";
export {
  FOOD_SERVICE_BUYER_ROUTE_KINDS,
  FOOD_SERVICE_ROUTE_ACCESS,
  FOOD_SERVICE_ROUTES,
  type FoodServiceRoute,
} from "./routes.ts";

/** The commands that this plugin commits through the ledger. */
export type FoodServiceCommand =
  | CreatePreparationStationCommand
  | CreateModifierGroupRevisionCommand
  | CreateRecipeRevisionCommand
  | ConfigureStockPolicyCommand
  | PublishMenuCommand
  | MarkSoldOutCommand
  | ManagePreparationTicketCommand
  | CompleteProductionBatchCommand;

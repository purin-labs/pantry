// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiFoodService from "@seams/commerce-contracts/records/api-food-service";
import type {
  QuantityInput,
  CompleteProductionBatchCommand,
  StockPolicyInput,
  ConfigureStockPolicyCommand,
  ModifierOptionInput,
  ModifierGroupRevisionInput,
  CreateModifierGroupRevisionCommand,
  CreatePreparationStationCommand,
  RecipeRevisionInput,
  CreateRecipeRevisionCommand,
  ManagePreparationTicketCommand,
  MenuEntryInput,
  MenuSectionInput,
  MenuInput,
  PublishMenuCommand,
  CommerceFoodServiceObservationV1,
  CommerceFoodServiceResourcesV1,
  CommerceFoodServiceSnapshotV1,
} from "./food-service.ts";
export type QuantityInputParity = Assert<
  Equal<QuantityInput, apiFoodService.QuantityInput>
>;
export type CompleteProductionBatchCommandParity = Assert<
  Equal<
    CompleteProductionBatchCommand,
    apiFoodService.CompleteProductionBatchCommand
  >
>;
export type StockPolicyInputParity = Assert<
  Equal<StockPolicyInput, apiFoodService.StockPolicyInput>
>;
export type ConfigureStockPolicyCommandParity = Assert<
  Equal<ConfigureStockPolicyCommand, apiFoodService.ConfigureStockPolicyCommand>
>;
export type ModifierOptionInputParity = Assert<
  Equal<ModifierOptionInput, apiFoodService.ModifierOptionInput>
>;
export type ModifierGroupRevisionInputParity = Assert<
  Equal<ModifierGroupRevisionInput, apiFoodService.ModifierGroupRevisionInput>
>;
export type CreateModifierGroupRevisionCommandParity = Assert<
  Equal<
    CreateModifierGroupRevisionCommand,
    apiFoodService.CreateModifierGroupRevisionCommand
  >
>;
export type CreatePreparationStationCommandParity = Assert<
  Equal<
    CreatePreparationStationCommand,
    apiFoodService.CreatePreparationStationCommand
  >
>;
export type RecipeRevisionInputParity = Assert<
  Equal<RecipeRevisionInput, apiFoodService.RecipeRevisionInput>
>;
export type CreateRecipeRevisionCommandParity = Assert<
  Equal<CreateRecipeRevisionCommand, apiFoodService.CreateRecipeRevisionCommand>
>;
export type ManagePreparationTicketCommandParity = Assert<
  Equal<
    ManagePreparationTicketCommand,
    apiFoodService.ManagePreparationTicketCommand
  >
>;
export type MenuEntryInputParity = Assert<
  Equal<MenuEntryInput, apiFoodService.MenuEntryInput>
>;
export type MenuSectionInputParity = Assert<
  Equal<MenuSectionInput, apiFoodService.MenuSectionInput>
>;
export type MenuInputParity = Assert<
  Equal<MenuInput, apiFoodService.MenuInput>
>;
export type PublishMenuCommandParity = Assert<
  Equal<PublishMenuCommand, apiFoodService.PublishMenuCommand>
>;
export type CommerceFoodServiceObservationV1Parity = Assert<
  Equal<
    CommerceFoodServiceObservationV1,
    apiFoodService.CommerceFoodServiceObservationV1
  >
>;
export type CommerceFoodServiceResourcesV1Parity = Assert<
  Equal<
    CommerceFoodServiceResourcesV1,
    apiFoodService.CommerceFoodServiceResourcesV1
  >
>;
export type CommerceFoodServiceSnapshotV1Parity = Assert<
  Equal<
    CommerceFoodServiceSnapshotV1,
    apiFoodService.CommerceFoodServiceSnapshotV1
  >
>;

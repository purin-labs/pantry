// Plan 78 step 2: the food-service records that packages/commerce-client
// reads in src/food-service.ts. Each schema follows its hand-written reader:
// the readers keep the fields they know and drop the rest, write each
// timestamp as `Date.toISOString` writes it, and check that a resource's
// provenance names the resource itself.
import { Type, type Static, type TSchema } from "typebox";
import { NonNegativeInteger, PositiveInteger } from "../schema.ts";
import type {
  InventoryRequirementAdjustment,
  MenuScope,
  MenuValidity,
  RecipeOutput,
} from "../commerce-domain.ts";
import type {
  InventoryReplenishmentPolicy,
  InventoryRequirement,
  Menu,
  ModifierGroupRevision,
  PreparationStation,
  PreparationTicket,
  ProductionBatch,
  ProductionBatchDemand,
  QuantityUnit,
  RecipeRevision,
  StockPolicy,
} from "./commerce-records.ts";
import type { ShipmentEntityId } from "./identifiers.ts";
import { normalizedTextSchema } from "./fields.ts";
import {
  ImmutableArray,
  ReadonlyOpenObject,
  wireRecordParser,
} from "./wire-objects.ts";

const text = normalizedTextSchema;

/** `timestamp`: RFC 3339 text, written as `new Date(value).toISOString()`. */
const timestampSchema = Type.Codec(
  Type.Refine(text, isRfc3339Timestamp, timestampError),
)
  .Decode(isoTimestamp)
  .Encode(sameText);

function isRfc3339Timestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && Number.isFinite(Date.parse(value))
  );
}

function timestampError(): string {
  return "must be an RFC3339 timestamp";
}

function isoTimestamp(value: string): string {
  return new Date(Date.parse(value)).toISOString();
}

function sameText(value: string): string {
  return value;
}

/** A contracts type whose rules this schema writes. */
function As<T>(schema: TSchema) {
  return Type.Unsafe<T>(schema);
}

const quantityUnitSchema = As<QuantityUnit>(
  Type.Union([
    Type.Literal("each"),
    Type.Literal("gram"),
    Type.Literal("kilogram"),
    Type.Literal("milliliter"),
    Type.Literal("liter"),
  ]),
);

export const quantityInputSchema = ReadonlyOpenObject({
  amount: PositiveInteger,
  scale: NonNegativeInteger,
  unit: quantityUnitSchema,
});
export type QuantityInput = Static<typeof quantityInputSchema>;

const moneySchema = ReadonlyOpenObject({
  amountMinor: NonNegativeInteger,
  currency: text,
});

const requirementSchema = As<InventoryRequirement>(
  ReadonlyOpenObject({ inventoryItemId: text, quantity: quantityInputSchema }),
);

const adjustmentSchema = As<InventoryRequirementAdjustment>(
  ReadonlyOpenObject({
    kind: Type.Union([Type.Literal("add"), Type.Literal("reduce")]),
    inventoryItemId: text,
    quantity: quantityInputSchema,
  }),
);

const recipeOutputSchema = As<RecipeOutput>(
  Type.Union([
    ReadonlyOpenObject({ kind: Type.Literal("immediate") }),
    ReadonlyOpenObject({
      kind: Type.Literal("stocked"),
      inventoryItemId: text,
      yieldQuantity: quantityInputSchema,
    }),
  ]),
);

const replenishmentSchema = As<InventoryReplenishmentPolicy>(
  Type.Union([
    ReadonlyOpenObject({ kind: Type.Literal("none") }),
    ReadonlyOpenObject({
      kind: Type.Literal("threshold"),
      reorderPoint: quantityInputSchema,
      targetQuantity: quantityInputSchema,
    }),
  ]),
);

const menuScopeSchema = As<MenuScope>(
  Type.Union([
    ReadonlyOpenObject({ kind: Type.Literal("location"), locationId: text }),
    ReadonlyOpenObject({
      kind: Type.Literal("location_group"),
      locationIds: ImmutableArray(text),
    }),
  ]),
);

const menuValiditySchema = As<MenuValidity>(
  Type.Union([
    ReadonlyOpenObject({ kind: Type.Literal("always") }),
    ReadonlyOpenObject({
      kind: Type.Literal("window"),
      startsAt: timestampSchema,
      endsAt: timestampSchema,
    }),
    ReadonlyOpenObject({
      kind: Type.Literal("schedule"),
      timeZone: text,
      slots: ImmutableArray(
        ReadonlyOpenObject({
          days: ImmutableArray(
            Type.Union([
              Type.Literal("mon"), Type.Literal("tue"), Type.Literal("wed"), Type.Literal("thu"), Type.Literal("fri"), Type.Literal("sat"), Type.Literal("sun"),
            ]),
          ),
          startsAt: text,
          endsAt: text,
        }),
      ),
    }),
  ]),
);

const productionBatchDemandSchema = As<ProductionBatchDemand>(
  Type.Union([
    ReadonlyOpenObject({
      kind: Type.Literal("request"),
      requestId: text,
      requestRevision: PositiveInteger,
    }),
    ReadonlyOpenObject({ kind: Type.Literal("stock") }),
    ReadonlyOpenObject({ kind: Type.Literal("shipment"), shipmentId: text }),
  ]),
);

/** `parseShipmentEntityId`: normalized text. */
export const shipmentEntityIdSchema = As<ShipmentEntityId>(text);

const commandBase = {
  merchantId: text,
  expectedMerchantRevision: NonNegativeInteger,
  idempotencyKey: text,
  requestedAt: timestampSchema,
};

export const commandBaseSchema = ReadonlyOpenObject(commandBase);
export type CommandBase = Static<typeof commandBaseSchema>;

/** A command: the base fields and its own, read as `command` and `base`. */
function foodServiceCommand<Properties extends Record<string, TSchema>>(
  properties: Properties,
) {
  return Type.Intersect([commandBaseSchema, ReadonlyOpenObject(properties)]);
}

export const createPreparationStationCommandSchema = foodServiceCommand({
  schemaVersion: Type.Literal("underclerk.create-preparation-station.v1"),
  station: ReadonlyOpenObject({
    stationId: text,
    locationId: text,
    name: text,
  }),
});
export type CreatePreparationStationCommand = Static<
  typeof createPreparationStationCommandSchema
>;

export const modifierOptionInputSchema = ReadonlyOpenObject({
  modifierOptionId: text,
  name: text,
  priceDelta: moneySchema,
  requirementAdjustments: ImmutableArray(adjustmentSchema),
});
export type ModifierOptionInput = Static<typeof modifierOptionInputSchema>;

export const modifierGroupRevisionInputSchema = ReadonlyOpenObject({
  modifierGroupId: text,
  name: text,
  minimumSelections: NonNegativeInteger,
  maximumSelections: PositiveInteger,
  options: ImmutableArray(modifierOptionInputSchema),
});
export type ModifierGroupRevisionInput = Static<
  typeof modifierGroupRevisionInputSchema
>;

export const createModifierGroupRevisionCommandSchema = foodServiceCommand({
  schemaVersion: Type.Literal("underclerk.create-modifier-group-revision.v1"),
  modifierGroupRevision: modifierGroupRevisionInputSchema,
});
export type CreateModifierGroupRevisionCommand = Static<
  typeof createModifierGroupRevisionCommandSchema
>;

export const recipeRevisionInputSchema = ReadonlyOpenObject({
  recipeId: text,
  name: text,
  inputs: ImmutableArray(requirementSchema),
  output: recipeOutputSchema,
});
export type RecipeRevisionInput = Static<typeof recipeRevisionInputSchema>;

export const createRecipeRevisionCommandSchema = foodServiceCommand({
  schemaVersion: Type.Literal("underclerk.create-recipe-revision.v1"),
  recipeRevision: recipeRevisionInputSchema,
});
export type CreateRecipeRevisionCommand = Static<
  typeof createRecipeRevisionCommandSchema
>;

export const stockPolicyInputSchema = ReadonlyOpenObject({
  stockPolicyId: text,
  inventoryItemId: text,
  locationId: text,
  replenishment: replenishmentSchema,
});
export type StockPolicyInput = Static<typeof stockPolicyInputSchema>;

export const configureStockPolicyCommandSchema = foodServiceCommand({
  schemaVersion: Type.Literal("underclerk.configure-stock-policy.v1"),
  stockPolicy: stockPolicyInputSchema,
});
export type ConfigureStockPolicyCommand = Static<
  typeof configureStockPolicyCommandSchema
>;

export const menuSectionInputSchema = ReadonlyOpenObject({
  sectionId: text,
  name: text,
  position: NonNegativeInteger,
});
export type MenuSectionInput = Static<typeof menuSectionInputSchema>;

const modifierGroupReferenceSchema = ReadonlyOpenObject({
  modifierGroupId: text,
  revision: PositiveInteger,
});

export const menuEntryInputSchema = ReadonlyOpenObject({
  menuEntryId: text,
  sectionId: text,
  offerId: text,
  offerRevision: PositiveInteger,
  consumptionPlanId: text,
  consumptionPlanRevision: PositiveInteger,
  modifierGroupRevisions: ImmutableArray(modifierGroupReferenceSchema),
});
export type MenuEntryInput = Static<typeof menuEntryInputSchema>;

export const menuInputSchema = ReadonlyOpenObject({
  menuId: text,
  name: text,
  salesChannelId: text,
  scope: menuScopeSchema,
  validity: menuValiditySchema,
  sections: ImmutableArray(menuSectionInputSchema),
  entries: ImmutableArray(menuEntryInputSchema),
});
export type MenuInput = Static<typeof menuInputSchema>;

/**
 * Publishes a menu, or replaces the published menu of that id: a replacement
 * names the revision it replaces and becomes the next revision.
 */
export const publishMenuCommandSchema = foodServiceCommand({
  schemaVersion: Type.Literal("underclerk.publish-menu.v1"),
  menu: menuInputSchema,
  expectedMenuRevision: Type.Optional(PositiveInteger),
});
export type PublishMenuCommand = Static<typeof publishMenuCommandSchema>;

/**
 * Marks one variant sold out at one location until the shop's next midnight,
 * or clears the mark. It holds on every menu of that location.
 */
export const markSoldOutCommandSchema = foodServiceCommand({
  schemaVersion: Type.Literal("underclerk.mark-sold-out.v1"),
  locationId: text,
  variantId: text,
  mark: Type.Union([
    ReadonlyOpenObject({ kind: Type.Literal("today"), timeZone: text }),
    ReadonlyOpenObject({ kind: Type.Literal("cleared") }),
  ]),
});
export type MarkSoldOutCommand = Static<typeof markSoldOutCommandSchema>;

export const commerceSoldOutMarksV1Schema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.sold-out-marks.v1"),
  merchantId: text,
  merchantRevision: NonNegativeInteger,
  marks: ImmutableArray(
    ReadonlyOpenObject({
      locationId: text,
      variantId: text,
      revision: PositiveInteger,
      until: text,
    }),
  ),
});
export type CommerceSoldOutMarksV1 = Static<
  typeof commerceSoldOutMarksV1Schema
>;

export const managePreparationTicketCommandSchema = foodServiceCommand({
  schemaVersion: Type.Literal("underclerk.manage-preparation-ticket.v1"),
  operation: Type.Union([
    ReadonlyOpenObject({
      kind: Type.Literal("create"),
      ticketId: text,
      orderId: text,
      fulfillmentId: text,
      stationId: text,
    }),
    ReadonlyOpenObject({
      kind: Type.Union([Type.Literal("start"), Type.Literal("complete")]),
      ticketId: text,
      expectedTicketRevision: PositiveInteger,
    }),
  ]),
});
export type ManagePreparationTicketCommand = Static<
  typeof managePreparationTicketCommandSchema
>;

export const completeProductionBatchCommandSchema = foodServiceCommand({
  schemaVersion: Type.Literal("underclerk.complete-production-batch.v1"),
  productionBatchId: text,
  demand: productionBatchDemandSchema,
  outputLotId: text,
  outputInventoryPositionId: text,
  recipeId: text,
  recipeRevision: PositiveInteger,
  stationId: text,
  locationId: text,
  plannedYield: quantityInputSchema,
  actualYield: quantityInputSchema,
  outputLotCode: text,
  outputExpiresAt: timestampSchema,
  expectedInputPositionRevisions: ImmutableArray(
    ReadonlyOpenObject({
      inventoryPositionId: text,
      revision: PositiveInteger,
    }),
  ),
  expectedOutputPositionRevision: PositiveInteger,
});
export type CompleteProductionBatchCommand = Static<
  typeof completeProductionBatchCommandSchema
>;

type FoodServiceResourceType =
  | "menu"
  | "modifier_group_revision"
  | "recipe_revision"
  | "preparation_station"
  | "preparation_ticket"
  | "production_batch"
  | "stock_policy";

function provenanceSchema<Kind extends FoodServiceResourceType>(kind: Kind) {
  return ReadonlyOpenObject({
    organisationId: text,
    integrationAccountId: text,
    source: Type.Union([
      Type.Literal("shopify"),
      Type.Literal("stripe"),
      Type.Literal("lab"),
      Type.Literal("underclerk"),
    ]),
    resourceType: Type.Literal(kind),
    resourceId: text,
    revision: PositiveInteger,
    occurredAt: timestampSchema,
    observedAt: timestampSchema,
  });
}

/** `parseProvenance`: the provenance names this resource and revision. */
function namedResource<Resource>(idField: string, schema: TSchema) {
  return As<Resource>(
    Type.Refine(schema, namesItself.bind(null, idField), provenanceMismatch),
  );
}

type ProvenanceIdentity = Readonly<
  Record<string, unknown> & {
    revision: number;
    provenance: Readonly<{ resourceId: string; revision: number }>;
  }
>;

function namesItself(idField: string, value: unknown): boolean {
  const resource = value as ProvenanceIdentity;
  return (
    resource.provenance.resourceId === resource[idField] &&
    resource.provenance.revision === resource.revision
  );
}

function provenanceMismatch(): string {
  return "provenance does not match resource identity";
}

const revisionLifecycleSchema = Type.Union([
  ReadonlyOpenObject({ state: Type.Literal("draft") }),
  ReadonlyOpenObject({
    state: Type.Literal("active"),
    activeAt: timestampSchema,
  }),
  ReadonlyOpenObject({
    state: Type.Literal("retired"),
    retiredAt: timestampSchema,
  }),
]);

const activeOrInactive = Type.Union([
  Type.Literal("active"),
  Type.Literal("inactive"),
]);

export const menuResourceSchema = namedResource<Menu>(
  "menuId",
  ReadonlyOpenObject({
    provenance: provenanceSchema("menu"),
    menuId: text,
    revision: PositiveInteger,
    name: text,
    salesChannelId: text,
    scope: menuScopeSchema,
    validity: menuValiditySchema,
    sections: ImmutableArray(
      ReadonlyOpenObject({
        sectionId: text,
        name: text,
        position: NonNegativeInteger,
        menuId: text,
        revision: PositiveInteger,
      }),
    ),
    entries: ImmutableArray(
      ReadonlyOpenObject({
        menuEntryId: text,
        sectionId: text,
        offerId: text,
        offerRevision: PositiveInteger,
        consumptionPlanId: text,
        consumptionPlanRevision: PositiveInteger,
        modifierGroupRevisions: ImmutableArray(modifierGroupReferenceSchema),
        revision: PositiveInteger,
        lifecycle: activeOrInactive,
      }),
    ),
    lifecycle: Type.Union([
      ReadonlyOpenObject({ state: Type.Literal("draft") }),
      ReadonlyOpenObject({
        state: Type.Literal("published"),
        publishedAt: timestampSchema,
      }),
      ReadonlyOpenObject({
        state: Type.Literal("archived"),
        archivedAt: timestampSchema,
      }),
    ]),
  }),
);

export const modifierGroupRevisionResourceSchema =
  namedResource<ModifierGroupRevision>(
    "modifierGroupId",
    ReadonlyOpenObject({
      provenance: provenanceSchema("modifier_group_revision"),
      modifierGroupId: text,
      revision: PositiveInteger,
      name: text,
      minimumSelections: NonNegativeInteger,
      maximumSelections: PositiveInteger,
      options: ImmutableArray(modifierOptionInputSchema),
      lifecycle: revisionLifecycleSchema,
    }),
  );

export const recipeRevisionResourceSchema = namedResource<RecipeRevision>(
  "recipeId",
  ReadonlyOpenObject({
    provenance: provenanceSchema("recipe_revision"),
    recipeId: text,
    revision: PositiveInteger,
    name: text,
    inputs: ImmutableArray(requirementSchema),
    output: recipeOutputSchema,
    lifecycle: revisionLifecycleSchema,
  }),
);

export const preparationStationResourceSchema =
  namedResource<PreparationStation>(
    "stationId",
    ReadonlyOpenObject({
      provenance: provenanceSchema("preparation_station"),
      stationId: text,
      locationId: text,
      revision: PositiveInteger,
      name: text,
      lifecycle: activeOrInactive,
    }),
  );

export const preparationTicketResourceSchema = namedResource<PreparationTicket>(
  "ticketId",
  ReadonlyOpenObject({
    provenance: provenanceSchema("preparation_ticket"),
    ticketId: text,
    orderId: text,
    fulfillmentId: text,
    locationId: text,
    stationId: text,
    revision: PositiveInteger,
    lineSnapshots: ImmutableArray(
      ReadonlyOpenObject({
        orderLineId: text,
        menuEntryId: text,
        menuEntryRevision: PositiveInteger,
        recipeId: text,
        recipeRevision: PositiveInteger,
        modifiers: ImmutableArray(
          ReadonlyOpenObject({
            modifierGroupId: text,
            modifierGroupRevision: PositiveInteger,
            modifierOptionId: text,
            name: text,
            priceDelta: moneySchema,
            requirementAdjustments: ImmutableArray(adjustmentSchema),
          }),
        ),
        requirements: ImmutableArray(requirementSchema),
      }),
    ),
    lifecycle: Type.Union([
      ReadonlyOpenObject({
        state: Type.Literal("queued"),
        queuedAt: timestampSchema,
      }),
      ReadonlyOpenObject({
        state: Type.Literal("preparing"),
        startedAt: timestampSchema,
      }),
      ReadonlyOpenObject({
        state: Type.Literal("completed"),
        completedAt: timestampSchema,
        movementIds: ImmutableArray(text),
      }),
      ReadonlyOpenObject({
        state: Type.Literal("cancelled"),
        cancelledAt: timestampSchema,
      }),
    ]),
  }),
);

export const productionBatchResourceSchema = namedResource<ProductionBatch>(
  "productionBatchId",
  ReadonlyOpenObject({
    provenance: provenanceSchema("production_batch"),
    productionBatchId: text,
    demand: productionBatchDemandSchema,
    recipeId: text,
    recipeRevision: PositiveInteger,
    locationId: text,
    stationId: text,
    revision: PositiveInteger,
    plannedYield: quantityInputSchema,
    actualYield: quantityInputSchema,
    completedAt: timestampSchema,
    inputMovementIds: ImmutableArray(text),
    outputMovementId: text,
    outputLotId: text,
  }),
);

export const stockPolicyResourceSchema = namedResource<StockPolicy>(
  "stockPolicyId",
  ReadonlyOpenObject({
    provenance: provenanceSchema("stock_policy"),
    stockPolicyId: text,
    inventoryItemId: text,
    locationId: text,
    revision: PositiveInteger,
    replenishment: replenishmentSchema,
    lifecycle: activeOrInactive,
  }),
);

export const commerceFoodServiceObservationV1Schema = Type.Union([
  ReadonlyOpenObject({
    kind: Type.Literal("menu"),
    resource: menuResourceSchema,
  }),
  ReadonlyOpenObject({
    kind: Type.Literal("modifier_group_revision"),
    resource: modifierGroupRevisionResourceSchema,
  }),
  ReadonlyOpenObject({
    kind: Type.Literal("recipe_revision"),
    resource: recipeRevisionResourceSchema,
  }),
  ReadonlyOpenObject({
    kind: Type.Literal("preparation_station"),
    resource: preparationStationResourceSchema,
  }),
  ReadonlyOpenObject({
    kind: Type.Literal("preparation_ticket"),
    resource: preparationTicketResourceSchema,
  }),
  ReadonlyOpenObject({
    kind: Type.Literal("production_batch"),
    resource: productionBatchResourceSchema,
  }),
  ReadonlyOpenObject({
    kind: Type.Literal("stock_policy"),
    resource: stockPolicyResourceSchema,
  }),
]);
export type CommerceFoodServiceObservationV1 = Static<
  typeof commerceFoodServiceObservationV1Schema
>;

export const commerceFoodServiceResourcesV1Schema = ReadonlyOpenObject({
  menus: ImmutableArray(menuResourceSchema),
  modifierGroupRevisions: ImmutableArray(modifierGroupRevisionResourceSchema),
  recipeRevisions: ImmutableArray(recipeRevisionResourceSchema),
  preparationStations: ImmutableArray(preparationStationResourceSchema),
  preparationTickets: ImmutableArray(preparationTicketResourceSchema),
  productionBatches: ImmutableArray(productionBatchResourceSchema),
  stockPolicies: ImmutableArray(stockPolicyResourceSchema),
});
export type CommerceFoodServiceResourcesV1 = Static<
  typeof commerceFoodServiceResourcesV1Schema
>;

export const commerceFoodServiceSnapshotV1Schema = ReadonlyOpenObject({
  schemaVersion: Type.Literal("underclerk.food-service-snapshot.v2"),
  merchantId: text,
  merchantRevision: PositiveInteger,
  deliverySigner: ReadonlyOpenObject({
    keyId: text,
    algorithm: Type.Literal("ed25519"),
    publicKeyB64: text,
  }),
  resources: commerceFoodServiceResourcesV1Schema,
});
export type CommerceFoodServiceSnapshotV1 = Static<
  typeof commerceFoodServiceSnapshotV1Schema
>;

// Parsers of the client API types (Plan 78 step 2).
export const parseCompleteProductionBatchCommand = wireRecordParser(
  completeProductionBatchCommandSchema,
);
export const parseConfigureStockPolicyCommand = wireRecordParser(
  configureStockPolicyCommandSchema,
);
export const parseCreateModifierGroupRevisionCommand = wireRecordParser(
  createModifierGroupRevisionCommandSchema,
);
export const parseCreatePreparationStationCommand = wireRecordParser(
  createPreparationStationCommandSchema,
);
export const parseCreateRecipeRevisionCommand = wireRecordParser(
  createRecipeRevisionCommandSchema,
);
export const parseManagePreparationTicketCommand = wireRecordParser(
  managePreparationTicketCommandSchema,
);
export const parsePublishMenuCommand = wireRecordParser(
  publishMenuCommandSchema,
);
export const parseMarkSoldOutCommand = wireRecordParser(
  markSoldOutCommandSchema,
);
export const parseCommerceSoldOutMarksV1 = wireRecordParser(
  commerceSoldOutMarksV1Schema,
);
export const parseCommerceFoodServiceObservationV1 = wireRecordParser(
  commerceFoodServiceObservationV1Schema,
);
export const parseCommerceFoodServiceSnapshotV1 = wireRecordParser(
  commerceFoodServiceSnapshotV1Schema,
);
export const parseFoodServiceMenu = wireRecordParser(menuResourceSchema);
export const parseFoodServiceRecipeRevision = wireRecordParser(
  recipeRevisionResourceSchema,
);
export const parseFoodServicePreparationTicket = wireRecordParser(
  preparationTicketResourceSchema,
);
export const parseShipmentEntityId = wireRecordParser(shipmentEntityIdSchema);

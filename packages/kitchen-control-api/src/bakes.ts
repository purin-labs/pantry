import { Type, type Static } from "typebox";
import { recordParser } from "@purin-labs/contract-schema";

/**
 * Plan 24 S1: the stock levels of fresh products and the bake proposals that
 * a fall of the counter stock opens. The Bakes page and the platform share
 * these shapes.
 */

const id = Type.String({ minLength: 1, maxLength: 255 });
const name = Type.String({ minLength: 1, maxLength: 120 });
const workflowId = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,127}$" });
const kitchenLocation = Type.String({
  pattern: "^[\\p{L}\\p{N}][\\p{L}\\p{N} _-]{0,63}$",
});
const pieces = Type.Integer({ minimum: 1, maximum: 10_000 });
const time = Type.Integer({ minimum: 0 });
const role = Type.Union([
  Type.Literal("owner"),
  Type.Literal("admin"),
  Type.Literal("operator"),
]);

const stockLevelInputSchema = Type.Object(
  {
    inventoryItemId: id,
    productName: name,
    levelPieces: pieces,
    piecesPerGroup: Type.Integer({ minimum: 1, maximum: 1_000 }),
    workflowId,
    kitchenLocation,
    /** The revision that the person saw, or null for a new level. */
    expectedRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type BakeStockLevelInput = Static<typeof stockLevelInputSchema>;

const decisionInputSchema = Type.Union([
  Type.Object(
    { decision: Type.Literal("approve") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      decision: Type.Literal("reject"),
      reason: Type.String({ minLength: 1, maxLength: 500 }),
    },
    { additionalProperties: false },
  ),
]);
export type BakeDecisionInput = Static<typeof decisionInputSchema>;

const stockLevelSchema = Type.Object({
  inventoryItemId: id,
  productName: name,
  levelPieces: pieces,
  piecesPerGroup: Type.Integer({ minimum: 1 }),
  workflowId,
  kitchenLocation: Type.String({ minLength: 1 }),
  revision: Type.Integer({ minimum: 1 }),
  setBy: Type.String({ minLength: 1 }),
  setAt: time,
  /** The counter stock now, or null when Pantry has no position for it. */
  counterPieces: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  /** The recipe's applied revision, or null when it has none. */
  recipe: Type.Union([
    Type.Object({
      title: Type.String({ minLength: 1 }),
      revision: Type.Integer({ minimum: 1 }),
    }),
    Type.Null(),
  ]),
});
export type BakeStockLevelView = Static<typeof stockLevelSchema>;

const proposalSchema = Type.Object({
  proposalId: Type.String({ pattern: "^bake_[a-f0-9]{24}$" }),
  inventoryItemId: id,
  productName: name,
  state: Type.Union([
    Type.Literal("waiting"),
    Type.Literal("open"),
    Type.Literal("approved"),
    Type.Literal("rejected"),
    Type.Literal("ended"),
  ]),
  origin: Type.Union([Type.Literal("stock"), Type.Literal("agent")]),
  caseId: Type.String({ minLength: 1 }),
  workflowId,
  workflowRevision: Type.Integer({ minimum: 1 }),
  workflowDigest: Type.String({ minLength: 64, maxLength: 64 }),
  quantityPieces: Type.Integer({ minimum: 1 }),
  mouldGroups: Type.Integer({ minimum: 1 }),
  piecesPerGroup: Type.Integer({ minimum: 1 }),
  kitchenLocation: Type.String({ minLength: 1 }),
  oven: Type.Union([
    Type.Object({
      deviceId: Type.String({ minLength: 1 }),
      name: Type.String({ minLength: 1 }),
    }),
    Type.Null(),
  ]),
  stockLocationId: Type.Union([Type.String(), Type.Null()]),
  stockAvailable: Type.Integer({ minimum: 0 }),
  stockLevel: Type.Integer({ minimum: 1 }),
  proposedBy: Type.String({ minLength: 1 }),
  proposedAt: time,
  openedAt: Type.Union([time, Type.Null()]),
  announcedAt: Type.Union([time, Type.Null()]),
  decision: Type.Union([
    Type.Object({
      by: Type.String({ minLength: 1 }),
      role,
      via: Type.Union([Type.Literal("portal"), Type.Literal("slack")]),
      at: time,
      reason: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    }),
    Type.Null(),
  ]),
  endedAt: Type.Union([time, Type.Null()]),
  endReason: Type.Union([Type.String(), Type.Null()]),
});
export type BakeProposalView = Static<typeof proposalSchema>;

const boardSchema = Type.Object({
  ok: Type.Literal(true),
  levels: Type.Array(stockLevelSchema),
  proposals: Type.Array(proposalSchema),
  /** The bake run of each approved proposal (Plan 24 S4), newest first. */
  runs: Type.Array(
    Type.Object({
      runId: Type.String({ minLength: 1 }),
      proposalId: Type.String({ pattern: "^bake_[a-f0-9]{24}$" }),
      state: Type.Union([
        Type.Literal("not_started"),
        Type.Literal("running"),
        Type.Literal("paused"),
        Type.Literal("held"),
        Type.Literal("completed"),
        Type.Literal("stopped"),
        Type.Literal("checked"),
      ]),
      problem: Type.Union([
        Type.Object({
          code: Type.String({ minLength: 1 }),
          message: Type.String({ minLength: 1 }),
        }),
        Type.Null(),
      ]),
      holdCode: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      startedAt: Type.Union([time, Type.Null()]),
      endedAt: Type.Union([time, Type.Null()]),
      goodPieces: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    }),
  ),
  /** The counted products that a level may name. */
  products: Type.Array(
    Type.Object({
      inventoryItemId: id,
      name: Type.String({ minLength: 1 }),
      counterPieces: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    }),
  ),
  workflows: Type.Array(
    Type.Object({
      workflowId,
      title: Type.String({ minLength: 1 }),
      revision: Type.Integer({ minimum: 1 }),
    }),
  ),
  /** The locations of the shop's gateways on the Devices page. */
  kitchenLocations: Type.Array(Type.String({ minLength: 1 })),
  /** What the reader may do: an admin edits a level, an operator decides. */
  access: Type.Object({
    mayEditLevels: Type.Boolean(),
    mayDecide: Type.Boolean(),
  }),
});
export type BakeBoard = Static<typeof boardSchema>;
/** The board without the reader's access, as the Organisation Actor reads it. */
export type BakeBoardRecords = Omit<BakeBoard, "access">;

const decodeLevelInput = recordParser(stockLevelInputSchema);
const decodeDecisionInput = recordParser(decisionInputSchema);
const decodeBoard = recordParser(boardSchema);

/** Null when the body is not a stock level. */
export function parseBakeStockLevelInput(
  value: unknown,
): BakeStockLevelInput | null {
  const result = decodeLevelInput(value);
  return result.ok ? result.value : null;
}

/** Null when the body is not a decision. */
export function parseBakeDecisionInput(
  value: unknown,
): BakeDecisionInput | null {
  const result = decodeDecisionInput(value);
  if (!result.ok) return null;
  return result.value.decision === "reject" &&
    result.value.reason.trim().length === 0
    ? null
    : result.value;
}

export function parseBakeBoard(value: unknown): BakeBoard {
  const result = decodeBoard(value);
  if (!result.ok) throw new Error("The bakes answer is not valid.");
  return result.value;
}

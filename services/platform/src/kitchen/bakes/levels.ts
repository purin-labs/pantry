import type { BakeStockLevelInput } from "@purin-labs/kitchen-control-api";
import { readAppliedWorkflowHead } from "../../commerce/bakery/workflow-revisions";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { writeBakeStockLevel, type BakeStockLevel } from "./records";

/**
 * Sets the stock level of one fresh product (Plan 24 S1, decision D2): one
 * level for the whole day. The caller checks that the person is an admin or
 * the owner; an agent proposes a level as a configuration draft that such a
 * person confirms. The level's recipe workflow needs an applied revision, so
 * that every proposal names one.
 */

export type BakeStockLevelError = Readonly<{
  code: "bake_level_invalid" | "bake_recipe_missing" | "bake_level_stale";
  message: string;
}>;

export async function setBakeStockLevel(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  input: BakeStockLevelInput,
  setBy: string,
  now: number,
): Promise<
  Result<
    Readonly<{ kind: "written" | "unchanged"; level: BakeStockLevel }>,
    BakeStockLevelError
  >
> {
  if (input.piecesPerGroup > input.levelPieces)
    return {
      ok: false,
      error: {
        code: "bake_level_invalid",
        message: "One mould group cannot hold more pieces than the level.",
      },
    };
  const recipe = await readAppliedWorkflowHead(
    db,
    organisationId,
    input.workflowId,
  );
  if (recipe === null)
    return {
      ok: false,
      error: {
        code: "bake_recipe_missing",
        message: `The recipe workflow ${input.workflowId} has no applied revision. Apply it in Kitchen first.`,
      },
    };
  const written = await writeBakeStockLevel(
    db,
    organisationId,
    {
      inventoryItemId: input.inventoryItemId,
      productName: input.productName.trim(),
      levelPieces: input.levelPieces,
      piecesPerGroup: input.piecesPerGroup,
      workflowId: input.workflowId,
      kitchenLocation: input.kitchenLocation.trim(),
    },
    input.expectedRevision,
    setBy,
    now,
  );
  return written.kind === "stale"
    ? {
        ok: false,
        error: {
          code: "bake_level_stale",
          message:
            "Someone changed this level after you read it. Read it again.",
        },
      }
    : { ok: true, value: written };
}

/**
 * The conditions of a placement move that read the records of other modules
 * (Refactor 17). Tenancy owns the placement and the journal of a move. The
 * Actor runtime owns the Actor registry and the item and copy rows of a
 * relocation, and Integrations gives the provider work. Each owner writes
 * its condition, and tenancy puts the text into its own statement, so one
 * statement stays one statement. The Worker registers the conditions
 * (`worker-ports.ts`).
 */
import { definePort } from "@purin-labs/kernel/port";

export type PlacementMoveConditions = Readonly<{
  /**
   * The work that holds the regional freeze of a placement. Each text is a
   * condition on the row of `organisation_placement` that the statement
   * updates: true while that work is open.
   */
  freezeHolds: readonly string[];
  /** True while an item of the relocation has a source that is not cleaned. */
  relocationHasUncleanedItemSql(relocationIdSql: string): string;
  /** The count of the verified table copies of the relocation, in brackets. */
  verifiedCopyCountSql(relocationIdSql: string): string;
  /** True while a table copy of the relocation is not verified. */
  relocationHasUnverifiedCopySql(relocationIdSql: string): string;
}>;

export const placementMoveConditions = definePort<PlacementMoveConditions>(
  "placement_move_conditions",
);

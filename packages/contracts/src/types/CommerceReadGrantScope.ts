import type { ContractCommercePart } from "../commerce-parts.ts";

/** The read scope of a commerce grant: a record type, a list or a saved selector. */
export type CommerceReadGrantScope = ContractCommercePart<
  "readGrantScope",
  | { kind: "entity_type"; entityTypeId: unknown }
  | { kind: "commerce_list"; listId: unknown }
  | { kind: "saved_selector"; selector: unknown }
>;

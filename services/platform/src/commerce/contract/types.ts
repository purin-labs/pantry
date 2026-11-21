// The commerce types that other areas name. A type that the inside of
// commerce defines is exported here with `export type`, so the contract
// pulls in no implementation.
import type { RequestId } from "../../ids";

export type { CommerceActionPath } from "../action-model";

/** The price change that the agent proposes for a menu item. */
export type MenuPriceProposalRequest = Readonly<{
  itemId: string;
  priceMinor: number;
  /** True keeps the current price on the boards as the earlier price. */
  deal: boolean;
}>;

export type { PublishedResourceBoundaryError } from "../../data/agent-operations/scope-commerce";

/** The armed fault of the Café commerce acceptance journey. */
export type CafeCommerceAcceptanceFaultRecord = Readonly<{
  schemaVersion: 1;
  requestId: RequestId;
  merchantId: string;
  armedAt: number;
  queueConsumedAt: number | null;
}>;

// The commerce types that the records of `@purin-labs/contracts` carry.
declare module "@purin-labs/contracts/commerce-parts" {
  interface ContractCommerceParts {
    /** The scope of a commerce command grant. */
    authorityScope: import("@purin-labs/commerce-contracts").CommerceAuthorityScope;
    /** The scope of a commerce read grant. */
    readGrantScope: import("@purin-labs/type-utils").Variant<
      import("@purin-labs/commerce-contracts").CommerceAuthorityScope,
      "entity_type" | "commerce_list" | "saved_selector"
    >;
    /** The target of a commerce command grant. */
    mutationTarget: import("@purin-labs/commerce-contracts").CommerceMutationTarget;
    /** The commerce proposal of a Case. */
    entityPlaneProposal: import("@purin-labs/commerce-contracts").CommerceEntityPlaneProposal;
    /** The provenance of a commerce record in a Case. */
    sourceProvenance: import("@purin-labs/commerce-contracts").SourceProvenance;
  }
}

// The commerce types that foundation records carry (`commerce-type-parts.ts`).
declare module "../../commerce-type-parts" {
  interface CommerceTypeParts {
    /** The commerce effect of an action ledger entry. */
    entityPlaneEffect: import("@purin-labs/commerce-contracts").CommerceEntityPlaneEffect;
    /** A relationship that a scope or a cue selector names. */
    relationshipRef: import("@purin-labs/commerce-contracts").CommerceRelationshipRef;
    /** A list entry that a scope or a cue selector names. */
    listEntryRef: import("@purin-labs/commerce-contracts").CommerceListEntryRef;
    /** The graph query of a saved selector. */
    graphQuery: import("@purin-labs/commerce-contracts").CommerceGraphQuery;
    /** A record type of a cue selector. */
    entityTypeId: import("@purin-labs/commerce-contracts").CommerceEntityTypeId;
    /** A list of a cue selector. */
    listId: import("@purin-labs/commerce-contracts").CommerceListId;
    /** A published saved selector of a cue selector. */
    publishedSelector: import("@purin-labs/commerce-contracts").PublishedCommerceSelector;
    /** The observation of an entity plane cue. */
    entityPlaneObservation: import("@purin-labs/commerce-client").CommerceEntityPlaneObservationV1;
    /** The published resource evidence of a responsibility scope. */
    publishedResourceMetadata: import("@purin-labs/commerce-client").CommerceEntityPlanePublishedResourceMetadataResponse;
  }
}

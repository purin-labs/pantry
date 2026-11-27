// The graph reads of commerce: the sources of the graph, the reader that
// joins them, and the service interface that another area uses. Commerce owns
// the graph, its sources and its authority.
import type { RequestAuthority } from "@purin-labs/contracts";
import type {
  CommerceEntityPlaneClient,
  CommerceEntityPlanePlannedQueryResponse,
} from "@purin-labs/commerce-client";
import type {
  AttributeValueAssignment,
  CommerceEntityPlaneError,
  CommerceEntityRef,
  CommerceGraphQuery,
  CommerceGraphQueryPlanRequest,
  CommerceGraphQueryResult,
  CommerceQueryCapabilityProfile,
  CommerceQueryProjection,
  CommerceReadWatermark,
  CommerceSensitivity,
  CommerceSnapshotRevision,
  MerchantExtensionSchemaRevision,
  PantryCommerceReadAuthority,
  SystemCommerceEntityRef,
} from "@purin-labs/commerce-contracts";
import type { AccessGrant } from "@purin-labs/authority/authorization/access-grants/types";
import type {
  CommerceSystem,
  CommerceSystemError,
} from "@purin-labs/connections/data/organisation-commerce-system";
import type { AuthorizedOrganisationRequest } from "@purin-labs/control/worker/authorization";
import type { Env } from "@purin-labs/kernel/env";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationStateError } from "@purin-labs/tenancy/actors/organisation/types";
import type {
  CommerceProjectionError,
  CommerceProjectionRecord,
  CommerceQueryPlanReadError,
  CommerceRelationshipRelationRow,
  ReadCommerceQueryPlanInput,
  ReadCommerceQueryPlanValue,
  ReadCommerceRelationshipStepInput,
  ReadExactCommerceProjectionReferenceInput,
} from "./commerce-projection";
import type {
  CommerceContextAssemblyError,
  CommerceGraphReaderError,
  CommerceGraphSourceError,
} from "./read-errors";

export type CommerceGraphSourceValue = Omit<
  CommerceGraphQueryResult,
  "merchantRevision"
> &
  Readonly<{
    /** Commerce owns this cursor. Blotter deliberately returns null. */
    merchantRevision: CommerceSnapshotRevision | null;
  }>;

export type CommerceGraphCapabilityMetadata = Readonly<{
  organisationId: string;
  merchantId: string;
  merchantRevision: CommerceSnapshotRevision;
  watermark: CommerceReadWatermark;
  capabilities: CommerceQueryCapabilityProfile;
  projection: CommerceQueryProjection;
}>;

export type CommerceGraphSourceResult = Result<
  CommerceGraphSourceValue,
  CommerceGraphSourceError
>;

export type CommerceGraphRelationshipStepInput = Readonly<{
  planRequest: CommerceGraphQueryPlanRequest;
  plan: import("@purin-labs/commerce-contracts").CommerceQueryPlan;
  frontier: readonly CommerceEntityRef[];
  remaining: number;
}>;

export type CommerceGraphRelationshipStepError =
  | CommerceGraphSourceError
  | Readonly<{
      code: "commerce_cursor_mismatch";
      reason: import("@purin-labs/commerce-contracts").CommerceCursorMismatchReason;
    }>
  | Readonly<{
      code: "commerce_cursor_stale";
      expected: CommerceReadWatermark;
      received: CommerceReadWatermark;
    }>
  | Readonly<{
      code: "commerce_query_unsupported";
      capability: import("@purin-labs/commerce-contracts").CommerceQueryPlanErrorCapability;
    }>
  | Readonly<{ code: "invalid_query" }>;

export type CommerceGraphRelationshipStepResult = Result<
  CommerceGraphSourceValue,
  CommerceGraphRelationshipStepError
>;

export type CommerceGraphPlannedSourceResult = Result<
  CommerceEntityPlanePlannedQueryResponse,
  CommerceGraphSourceError
>;

export type CommerceGraphSourceQueryOptions = Readonly<{
  sensitivityCeiling: CommerceSensitivity;
}>;

export type CommerceGraphHydrationResult = Readonly<{
  merchantRevision: CommerceSnapshotRevision;
  sidecars: readonly CommerceGraphEntityExtensionSidecar[];
}>;

export type CommerceGraphEntityExtensionSidecar = Readonly<{
  entityRef: SystemCommerceEntityRef;
  attributes: readonly AttributeValueAssignment[];
  extensionSchemaRevision: MerchantExtensionSchemaRevision | null;
}>;

export type CommerceGraphSource = Readonly<{
  readonly source: "commerce" | "blotter";
  readonly readRelationshipStep?: (
    input: CommerceGraphRelationshipStepInput,
    options?: CommerceGraphSourceQueryOptions,
  ) => Promise<CommerceGraphRelationshipStepResult>;
  readonly hydrateEntityExtensions?: (
    references: readonly CommerceEntityRef[],
    options?: CommerceGraphSourceQueryOptions,
  ) => Promise<Result<CommerceGraphHydrationResult, CommerceGraphSourceError>>;
  readonly readSnapshotRevision?: () => Promise<
    Result<CommerceSnapshotRevision, CommerceGraphSourceError>
  >;
  readonly readCapabilityMetadata?: (
    query: CommerceGraphQuery,
  ) => Promise<
    Result<CommerceGraphCapabilityMetadata, CommerceGraphSourceError>
  >;
}>;

export type CommerceSourceOptions = Readonly<{
  organisationId: string;
  merchantId: string;
  integrationAccountId: string;
  client: CommerceEntityPlaneClient;
}>;

/**
 * The source of the commerce engine (`CommerceEngineSource`): it reads the
 * graph of one merchant binding through the Commerce client.
 */
export interface CommerceEngineGraphSource {
  readonly source: "commerce";
  queryPlanned(
    request: CommerceGraphQueryPlanRequest,
  ): Promise<CommerceGraphPlannedSourceResult>;
  readCapabilityMetadata(
    query: CommerceGraphQuery,
  ): Promise<Result<CommerceGraphCapabilityMetadata, CommerceGraphSourceError>>;
  readRelationshipStep(
    input: CommerceGraphRelationshipStepInput,
    options?: CommerceGraphSourceQueryOptions,
  ): Promise<CommerceGraphRelationshipStepResult>;
  hydrateEntityExtensions(
    references: readonly CommerceEntityRef[],
    options?: CommerceGraphSourceQueryOptions,
  ): Promise<Result<CommerceGraphHydrationResult, CommerceGraphSourceError>>;
  readSnapshotRevision(): Promise<
    Result<CommerceSnapshotRevision, CommerceGraphSourceError>
  >;
}

export type CommerceGraphReadAuthority = PantryCommerceReadAuthority;

export type CommerceGraphReadInput = Readonly<{
  query: CommerceGraphQuery;
  authority: CommerceGraphReadAuthority;
  now: string;
}>;

/**
 * The reader of the commerce graph (`CommerceGraphReader`): it runs one graph
 * query under its read authority over the sources of the commerce system.
 */
export interface CommerceGraphQueryReader {
  query(
    input: CommerceGraphReadInput,
  ): Promise<Result<CommerceGraphQueryResult, CommerceGraphReaderError>>;
  read(
    input: CommerceGraphReadInput,
  ): Promise<Result<CommerceGraphQueryResult, CommerceGraphReaderError>>;
}

type OrganisationPlacementConflict = Readonly<{
  readonly code: "organisation_placement_conflict";
}>;

/**
 * The reads of the Organisation actor that the blotter source of a
 * provider-backed system uses (`OrganisationCommerce`).
 */
export interface CommerceGraphOrganisationReader {
  readCommerceQueryPlan(
    input: ReadCommerceQueryPlanInput,
  ): Promise<
    Result<
      ReadCommerceQueryPlanValue,
      | OrganisationStateError
      | OrganisationPlacementConflict
      | CommerceQueryPlanReadError
    >
  >;
  readAcceptedCommerceProjectionSequence(
    input: Readonly<{
      organisationId: OrganisationId;
      integrationAccountId: IntegrationAccountId;
    }>,
  ): Promise<
    Result<
      number,
      | OrganisationStateError
      | OrganisationPlacementConflict
      | CommerceProjectionError
    >
  >;
  readCommerceRelationshipStep(
    input: ReadCommerceRelationshipStepInput,
  ): Promise<
    Result<
      readonly CommerceRelationshipRelationRow[],
      | OrganisationStateError
      | OrganisationPlacementConflict
      | CommerceQueryPlanReadError
    >
  >;
  readExactCommerceProjectionReference(
    input: ReadExactCommerceProjectionReferenceInput,
  ): Promise<
    Result<
      CommerceProjectionRecord | null,
      | OrganisationStateError
      | OrganisationPlacementConflict
      | CommerceProjectionError
    >
  >;
}

/** The graph reader of a control request, with its merchant. */
export type ControlCommerceGraph = Readonly<{
  reader: CommerceGraphQueryReader;
  merchantId: string;
}>;

export type ControlCommerceGraphError = Readonly<{
  code:
    | CommerceSystemError["code"]
    | "organisation_not_found"
    | "commerce_binding_missing"
    | "commerce_binding_mismatch"
    | "commerce_unavailable";
  status: 404 | 503;
}>;

/** Selects the source grant of one named graph query. */
type SelectNamedCommerceQuerySourceGrant = (
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    grants: readonly AccessGrant[];
    requestAuthority: RequestAuthority;
    causationId: string;
    query: CommerceGraphQuery;
    allowedSensitivity: CommerceSensitivity;
    now: string;
  }>,
) => Result<AccessGrant, CommerceContextAssemblyError>;

/** Runs one named graph query under the grant that it selects. */
export type ReadNamedCommerceQuery = (
  input: Readonly<{
    readonly organisationId: string;
    readonly merchantId: string;
    readonly grants: readonly AccessGrant[];
    readonly requestAuthority: RequestAuthority;
    readonly causationId: string;
    readonly query: CommerceGraphQuery;
    readonly allowedSensitivity: CommerceSensitivity;
    readonly reader: CommerceGraphQueryReader;
    readonly now: string;
  }>,
) => Promise<Result<CommerceGraphQueryResult, CommerceContextAssemblyError>>;

/** The graph reader of the selected commerce system. */
type CreateCommerceGraphReader = (
  input: Readonly<{
    commerceSystem: CommerceSystem;
    organisationId: OrganisationId;
    merchantId: string;
    commerce: CommerceEngineGraphSource;
    /** The Organisation actor; read only for a provider-backed system. */
    organisation: () => Promise<CommerceGraphOrganisationReader>;
  }>,
) => Promise<CommerceGraphQueryReader>;

/** The read authority of one graph query that a person's request asks. */
type CommerceGraphControlAuthority = (
  input: Readonly<{
    organisationId: OrganisationId;
    merchantId: string;
    principalId: string;
    sensitivityCeiling: CommerceSensitivity;
    query: CommerceGraphQuery;
    now: number;
  }>,
) => Result<CommerceGraphReadAuthority, CommerceEntityPlaneError>;

/** The read authority of a saved selector that a cue resolves. */
type SavedSelectorCommerceReadAuthority = (
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    principalId: string;
    sensitivityCeiling: CommerceSensitivity;
    expiresAt: string;
    commandId: string;
    selectorId: string;
    selectorRevision: number;
    query: CommerceGraphQuery;
  }>,
) => Result<CommerceGraphReadAuthority, CommerceEntityPlaneError>;

/**
 * The graph reads of commerce, as a service interface of its contract. The
 * Inbox reads the supplier records of a mail under the grant of the reader,
 * the sender links route reads one supplier under the person's control
 * authority, and the cue delivery of the webhook surface reads a saved
 * selector. Commerce owns the graph, its sources and its authority. The
 * Worker registers the implementation (`worker-ports.ts`).
 */
export type CommerceGraphReads = Readonly<{
  /** Selects the source grant of one named graph query. */
  selectNamedCommerceQuerySourceGrant: SelectNamedCommerceQuerySourceGrant;
  /** Runs one named graph query under the grant that it selects. */
  readNamedCommerceQuery: ReadNamedCommerceQuery;
  /** The commerce engine source of one merchant binding. */
  createCommerceEngineSource(
    options: CommerceSourceOptions,
  ): CommerceEngineGraphSource;
  /** The graph reader of the selected commerce system. */
  createCommerceGraphReader: CreateCommerceGraphReader;
  /** The graph reader of a control request, with its merchant. */
  openControlCommerceGraph(
    env: Env,
    authorized: AuthorizedOrganisationRequest,
  ): Promise<Result<ControlCommerceGraph, ControlCommerceGraphError>>;
  /** The read authority of a control request for one query. */
  commerceGraphControlAuthority: CommerceGraphControlAuthority;
  /** The read authority of a saved selector. */
  buildSavedSelectorCommerceReadAuthority: SavedSelectorCommerceReadAuthority;
  /** The sensitivity ceiling of a control request. */
  controlCommerceSensitivityCeiling(
    authorized: AuthorizedOrganisationRequest,
  ): CommerceSensitivity;
}>;

export const commerceGraphReads = definePort<CommerceGraphReads>(
  "commerce_graph_reads",
);

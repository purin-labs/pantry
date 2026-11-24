import type { CommerceObservationEntity } from "@purin-labs/agent/actors/agent-session-information-flow";
import type { SessionExecutionAdmission } from "@purin-labs/agent/actors/session-execution-admission";
import type { AccessGrant } from "@purin-labs/authority/authorization/access-grants/types";
import type { FlowLabel } from "@purin-labs/authority/policy/index";
import type { CommerceAdminClient } from "@purin-labs/commerce-client";
import type {
  CommerceEntityPlaneError,
  CommerceGraphQuery,
  SystemCommerceEntityKind,
} from "@purin-labs/commerce-contracts";
import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import type { Env } from "@purin-labs/kernel/env";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationMember } from "@purin-labs/tenancy/data/control-plane";
import type {
  CommerceGraphQueryReader,
  ReadNamedCommerceQuery,
} from "./graph-reads";
import type { CommerceContextAssemblyError } from "./read-errors";

/**
 * The authorized commerce read boundary one turn shares.
 *
 * Every commerce read the harness performs needs the same preparation: an
 * unexpired turn lease, the organisation's commerce system and merchant binding, the
 * grant that covers the request, the flow label for that grant, an admission
 * decision, and a reader over the selected source. Preparing it once keeps a
 * new read tool from acquiring a weaker boundary than the existing one.
 */
export type PreparedCommerceRead = Readonly<{
  execution: SessionExecutionAdmission;
  merchantId: string;
  integrationAccountId: string;
  resourceScope: string;
  grants: readonly AccessGrant[];
  label: FlowLabel;
  reader: CommerceGraphQueryReader;
  now: string;
}>;

/** What the staff page tools need before they read or change anything. */
export type StaffPageWork = Readonly<{
  member: OrganisationMember;
  prepared: PreparedCommerceRead;
  /** The commerce engine client of the person, for the merchant of the page. */
  context: Readonly<{ client: CommerceAdminClient; merchantId: string }>;
}>;

/** The grants of a turn that one commerce read may select from. */
type CommerceReadGrantScope = Readonly<{
  organisationId: string;
  merchantId: string;
  grants: readonly AccessGrant[];
  now: string;
}>;

/** The grant that one commerce read of a turn selects. */
type CommerceReadGrantSelection = Result<
  AccessGrant,
  CommerceContextAssemblyError
>;

/** Prepares one commerce read of a turn for the grant that is selected. */
type PrepareCommerceRead = (
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
  selectGrant: (input: CommerceReadGrantScope) => CommerceReadGrantSelection,
  label: string,
) => Promise<PreparedCommerceRead>;

/** Records one commerce read as observation evidence of the turn. */
type AdmitCommerceReadObservation = (
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  prepared: PreparedCommerceRead,
  value: unknown,
  sourceRevision: number,
  label: string,
  observedEntities?: readonly CommerceObservationEntity[],
) => Promise<void>;

/** The member, the read and the client of a tool that acts as a staff page. */
type PrepareStaffPageWork = (
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
  read: "order" | "product" | "recipe_revision" | "supplier_directory",
  label: string,
) => Promise<StaffPageWork>;

/** Selects the grant of a merchant report for one entity type. */
type SelectMerchantReportSourceGrant = (
  lease: HarnessTurnLease,
  typeId: SystemCommerceEntityKind,
  allowedSensitivity: "internal" | "restricted",
  input: CommerceReadGrantScope,
) => CommerceReadGrantSelection;

/** Selects the grant of the turn for one graph query, at the internal level. */
type SelectInternalQuerySourceGrant = (
  lease: HarnessTurnLease,
  query: Result<CommerceGraphQuery, CommerceEntityPlaneError>,
  input: CommerceReadGrantScope,
) => CommerceReadGrantSelection;

/** A commerce graph query, or why the value is not one. */
type CommerceGraphQueryParse = Result<
  CommerceGraphQuery,
  CommerceEntityPlaneError
>;

/**
 * The governed commerce reads of a tool handler, as a service interface of
 * the commerce contract. A handler of another area, for example a Kitchen
 * tool, reads commerce records through it: the grant of the turn, the flow
 * label, the observation and the staff page work. Commerce implements it,
 * and the Worker gives the implementation to the area that asks.
 */
export type CommerceToolReads = Readonly<{
  /** Prepares one commerce read of a turn for the grant that is selected. */
  prepareCommerceRead: PrepareCommerceRead;
  /** A prepared read whose label a shared document may show. */
  prepareSharedCommerceObservation: (
    prepared: PreparedCommerceRead,
  ) => Promise<PreparedCommerceRead>;
  /** Records one commerce read as observation evidence of the turn. */
  admitCommerceReadObservation: AdmitCommerceReadObservation;
  /** Turns a denied read into a request that a person can allow. */
  requestableReportRead: (typeId: unknown, error: unknown) => never;
  /** The member, the read and the client of a tool that acts as a staff page. */
  prepareStaffPageWork: PrepareStaffPageWork;
  /** Asks the commerce projection to read a saved recipe now. */
  refreshRecipeProjection: (
    env: Env,
    execution: SessionExecutionAdmission,
    work: StaffPageWork,
  ) => Promise<void>;
  /** Selects the grant of a merchant report for one entity type. */
  selectMerchantReportSourceGrant: SelectMerchantReportSourceGrant;
  /** Selects the grant of the turn for one graph query, at the internal level. */
  selectInternalQuerySourceGrant: SelectInternalQuerySourceGrant;
  /** The graph query of the supplier directory. */
  supplierDirectoryQuery: (limit: number) => CommerceGraphQueryParse;
  /** Runs one named graph query under the grant that the turn selects. */
  readNamedCommerceQuery: ReadNamedCommerceQuery;
  /** Parses a commerce graph query. */
  parseCommerceGraphQuery: (value: unknown) => CommerceGraphQueryParse;
}>;

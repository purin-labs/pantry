import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { StaffPageRequestError } from "@purin-labs/agent-tools/errors";
import { SUPPLIER_DIRECTORY_LIST_ID } from "@purin-labs/commerce-client";
import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseIntegrationAccountId,
  newRequestId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
  admittedSessionOperation,
} from "@purin-labs/agent/actors/session-execution-admission";
import { parseCommerceGraphQuery } from "../../commerce/entity-plane/routes";
import {
  recordCommerceObservationEntities,
  type CommerceObservationEntity,
} from "@purin-labs/agent/actors/agent-session-information-flow";
import { createCommerceOutboxReconcileQueueMessage } from "../../commerce/contract/queue-messages";
import { createCommerceClient } from "../../commerce/contract/client";
import { productSalesGrantProbe } from "../../commerce/entity-plane/product-sales-report";
import { isRequestableEntityTypeRead } from "@purin-labs/authority/authorization/requestable-capabilities";
import { admitSessionInformationFlowObservation } from "@purin-labs/agent/actors/agent-session-information-flow";
import {
  createCurrentObservedSourceFlowLabel,
  ObservationEvidence,
  type FlowLabel,
} from "@purin-labs/authority/policy/index";
import { digestCanonical } from "@purin-labs/authority/policy/index";
import type { AccessGrant } from "@purin-labs/authority/authorization/access-grants/types";
import {
  listOrganisationMembers,
  roleMayOperate,
  type OrganisationMember,
} from "@purin-labs/tenancy/data/control-plane";
import { CommerceGraphReader } from "../../commerce/entity-plane/graph-reader";
import { CommerceReadRequestError } from "../../commerce/contract/read-errors";
import { selectNamedCommerceQuerySourceGrant } from "../../commerce/entity-plane/context-read";
import { prepareCommerceReadForEmbeddedHarness } from "./handlers";
import type { CommerceAdminClient } from "@purin-labs/commerce-client";

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
  grants: readonly import("@purin-labs/authority/authorization/access-grants/types").AccessGrant[];
  label: FlowLabel;
  reader: CommerceGraphReader;
  now: string;
}>;

/**
 * Records one commerce read as trusted observation evidence for this turn, so
 * a later proposal can only target a resource this session actually observed.
 *
 * Each commerce read names no buyer today, so its label states no writer. A
 * read that returns a buyer's name or a customer's note gives this function
 * `outsideWrittenFlowLabel(prepared.label)` as its label (Plan 89).
 */
export async function admitCommerceReadObservation(
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  prepared: PreparedCommerceRead,
  value: unknown,
  sourceRevision: number,
  label: string,
  observedEntities: readonly CommerceObservationEntity[] = [],
): Promise<void> {
  const organisationId = prepared.execution.scope.organisationId;
  await requireSessionExecution(prepared.execution, lease);
  const contentDigest = await digestCanonical(value);
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "integration_resource",
      organisationId: String(organisationId),
      integrationAccountId: prepared.integrationAccountId,
      resourceScope: prepared.resourceScope,
    },
    sourceRevision,
    contentDigest,
    inputLabel: prepared.label,
    observedAt: Date.now(),
  });
  if (!evidence.ok) {
    throw new Error(`${label} observation invalid: ${evidence.error.code}`);
  }
  const observed = await admitSessionInformationFlowObservation({
    authorizeCommit: requireSessionExecution.bind(
      null,
      prepared.execution,
      lease,
    ),
    sql: storage.sql,
    transactionSync: storage.transactionSync.bind(storage),
    organisationId: String(organisationId),
    sessionId: String(lease.session.sessionId),
    turnId: String(lease.turn.turnId),
    authorityPartitionDigest: String(lease.authorityPartitionDigest),
    inputLabel: prepared.label,
    observation: evidence.value,
    observedAt: evidence.value.observedAt,
  });
  if (!observed.ok) {
    throw new Error(
      `${label} information-flow commit failed: ${observed.error.code}`,
    );
  }
  await requireSessionExecution(prepared.execution, lease);
  // Only records returned by a committed observation become proposable.
  recordCommerceObservationEntities({
    sql: storage.sql,
    organisationId: String(organisationId),
    sessionId: String(lease.session.sessionId),
    evidenceDigest: evidence.value.evidenceDigest,
    entities: observedEntities,
    observedAt: evidence.value.observedAt,
  });
}

/**
 * A merchant report reads one record type. When no grant admits that read, a
 * permission request may ask for that grant.
 */
export function requestableReportRead(typeId: unknown, error: unknown): never {
  if (
    error instanceof CommerceReadRequestError &&
    error.failure.code === "commerce_context_authority_denied" &&
    isRequestableEntityTypeRead(typeId)
  ) {
    throw new CommerceReadRequestError(error.failure, typeId);
  }
  throw error;
}

export async function prepareSharedCommerceObservation(
  prepared: PreparedCommerceRead,
): Promise<PreparedCommerceRead> {
  const { execution } = prepared;
  const organisationId = execution.scope.organisationId;
  // Admission uses the caller's grant. The new observation retains all current
  // readers of this exact source, using the existing policy-owned matcher.
  const label = await createCurrentObservedSourceFlowLabel(
    execution.scope.database,
    {
      kind: "integration_resource",
      organisationId,
      integrationAccountId: prepared.integrationAccountId,
      resourceScope: prepared.resourceScope,
    },
  );
  if (!label.ok) {
    throw new Error(
      `Shared workspace source policy unavailable: ${label.error.code}`,
    );
  }
  return {
    execution,
    merchantId: prepared.merchantId,
    integrationAccountId: prepared.integrationAccountId,
    resourceScope: prepared.resourceScope,
    grants: prepared.grants,
    label: label.value,
    reader: prepared.reader,
    now: prepared.now,
  };
}

/** What the staff page tools need before they read or change anything. */
export type StaffPageWork = Readonly<{
  member: OrganisationMember;
  prepared: PreparedCommerceRead;
  /** The commerce engine client of the person, for the merchant of the page. */
  context: Readonly<{ client: CommerceAdminClient; merchantId: string }>;
}>;

/**
 * The staff page tools (the order queue, sold out today, recipes and suppliers)
 * do what the person's own page does, so they ask what the page asks: a current
 * member with the staff role or higher. A turn with no
 * person cannot use them. Under that, the turn must hold the read of the
 * records that the page shows. When no grant admits it, a direct call raises the
 * person's Allow prompt. The Commerce receipts name the person, as the page's
 * do.
 */
export async function prepareStaffPageWork(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
  read: "order" | "product" | "recipe_revision" | "supplier_directory",
  label: string,
): Promise<StaffPageWork> {
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  const member = await liveStaffMember(
    execution.scope.database,
    organisationId,
    lease,
  );
  if (member === null) {
    throw new StaffPageRequestError(
      `This ${label} step needs a person with the staff role or higher, and the person who asked does not have it now. Nothing changed. Tell the person. Do not ask for a permission or retry.`,
    );
  }
  const prepared = await prepareCommerceReadForEmbeddedHarness(
    env,
    execution,
    lease,
    assignment,
    read === "supplier_directory"
      ? selectSupplierDirectorySourceGrant.bind(null, lease)
      : selectMerchantReportSourceGrant.bind(null, lease, read, "internal"),
    label,
  ).catch(requestableReportRead.bind(null, read));
  const client = createCommerceClient(
    env,
    admittedSessionOperation(
      execution,
      lease,
      env.COMMERCE.fetch.bind(env.COMMERCE),
    ),
    {
      kind: "organisation",
      organisationId: String(organisationId),
      actor: String(member.personId),
    },
  );
  if (client === null) {
    throw new Error(`${label} Commerce unavailable`);
  }
  return {
    member,
    prepared,
    context: { client, merchantId: prepared.merchantId },
  };
}

/** The person's role now, as the page reads it, and not as the turn began. */
async function liveStaffMember(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  lease: HarnessTurnLease,
): Promise<OrganisationMember | null> {
  const authority = lease.requestAuthority;
  if (
    authority.kind !== "control" &&
    authority.kind !== "direct_conversation" &&
    authority.kind !== "shared_conversation"
  ) {
    return null;
  }
  const members = await listOrganisationMembers({ db, organisationId });
  for (const member of members) {
    if (
      member.personId === authority.requesterPersonId &&
      (authority.kind !== "control" || member.userId === authority.userId)
    ) {
      return roleMayOperate(member.role) ? member : null;
    }
  }
  return null;
}

/** The commerce projection reads the saved recipe now, as after the page's save. */
export async function refreshRecipeProjection(
  env: Env,
  execution: SessionExecutionAdmission,
  work: StaffPageWork,
): Promise<void> {
  const integrationAccountId = parseIntegrationAccountId(
    work.prepared.integrationAccountId,
  );
  if (!integrationAccountId.ok) {
    return;
  }
  // Scheduled recovery drains the durable native outbox without this message.
  await env.EVENT_Q.send(
    createCommerceOutboxReconcileQueueMessage({
      requestId: newRequestId(),
      receivedAt: Date.now(),
      organisationId: execution.scope.organisationId,
      integrationAccountId: integrationAccountId.value,
    }),
    { contentType: "json" },
  ).catch(() => undefined);
}

/**
 * Selects the grant of the turn for one commerce graph query, at the
 * internal level. An invalid query comes back as it is.
 */
export function selectInternalQuerySourceGrant(
  lease: HarnessTurnLease,
  query: ReturnType<typeof parseCommerceGraphQuery>,
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    grants: readonly AccessGrant[];
    now: string;
  }>,
) {
  if (!query.ok) {
    return query;
  }
  return selectNamedCommerceQuerySourceGrant({
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    grants: input.grants,
    now: input.now,
    requestAuthority: lease.requestAuthority,
    causationId: String(lease.turn.turnId),
    query: query.value,
    allowedSensitivity: "internal",
  });
}

function selectSupplierDirectorySourceGrant(
  lease: HarnessTurnLease,
  input: Parameters<typeof selectInternalQuerySourceGrant>[2],
) {
  return selectInternalQuerySourceGrant(
    lease,
    supplierDirectoryQuery(1),
    input,
  );
}

export function supplierDirectoryQuery(limit: number) {
  return parseCommerceGraphQuery({
    kind: "commerce_list_page",
    listId: SUPPLIER_DIRECTORY_LIST_ID,
    filter: { kind: "all" },
    sorts: [],
    pagination: { limit, cursor: null },
  });
}

export function selectMerchantReportSourceGrant(
  lease: HarnessTurnLease,
  typeId: import("@purin-labs/commerce-contracts").SystemCommerceEntityKind,
  allowedSensitivity: "internal" | "restricted",
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    grants: readonly AccessGrant[];
    now: string;
  }>,
) {
  return selectNamedCommerceQuerySourceGrant({
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    grants: input.grants,
    requestAuthority: lease.requestAuthority,
    causationId: String(lease.turn.turnId),
    query: productSalesGrantProbe(typeId),
    allowedSensitivity,
    now: input.now,
  });
}

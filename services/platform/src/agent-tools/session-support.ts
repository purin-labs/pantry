import type { OrganisationDatabase } from "../database-handles";
import { normalizeUntrustedCommerceText } from "../context/untrusted-commerce-text";
import { acceptedExecutionAccountAuthority } from "../account-platform/access";
import { evaluateChatFlowLabelSink } from "../chat/information-flow";
import { isConversationId, isProjectId } from "@seams/control-api";
import { validateLiveRequestAuthority } from "../request-authority";
import {
  exitApprovalPassReady,
  passOrAskForExitApproval,
} from "../actors/harness-follow-up";
import type { HeldOutputReason } from "../data/held-output-request";
import type { EffectAction } from "./effect-action";
import {
  StaffPageRequestError,
  type StaffPageToolReceipt,
} from "./catalog/types";
import type { DraftSharedThread } from "../actors/product-description-draft";
import {
  currentFlowSinkCheck,
  evaluateFlowLabelSink,
  emptyFlowLabel,
  FlowLabel as StoredFlowLabel,
  toolEffectAsksAfterOutsideText,
} from "../policy/information-flow";
import { buildControlAuthority } from "../request-authority";
import { SUPPLIER_DIRECTORY_LIST_ID } from "@seams/commerce-client";
import type { CaseAssignment, HarnessTurnLease } from "@seams/contracts";
import type { Env } from "../env";
import {
  parseCaseId,
  parseIntegrationAccountId,
  newRequestId,
  type CaseId,
  type OrganisationId,
} from "../ids";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
  admittedSessionOperation,
} from "../actors/session-execution-admission";
import { preflightHarnessTurnLease } from "../actors/agent-session-harness-authority";
import { CODE_MODE_PILOT_BUDGET } from "../actors/code-mode-budget";
import { admittedExecutionDeadline } from "../actors/code-mode-admission";
import type { CatalogExecutionContext } from "./catalog/execute";
import { parseCommerceGraphQuery } from "../commerce/entity-plane/routes";
import {
  recordCommerceObservationEntities,
  type CommerceObservationEntity,
} from "../actors/agent-session-information-flow";
import { createCommerceOutboxReconcileQueueMessage } from "../ingress-queue";
import { createCommerceClient } from "../commerce/outbox-worker";
import type { OrderQueueContext } from "../commerce/order-queue-commands";
import {
  readControlMutationReplay,
  recordOrganisationCommerceMutationReceipt,
} from "../data/control-mutation";
import { productSalesGrantProbe } from "../commerce/entity-plane/product-sales-report";
import { isRequestableEntityTypeRead } from "../authorization/requestable-capabilities";
import type { CapabilityDefinition } from "../authorization/access-grants/capability-key";
import {
  admitSessionInformationFlowObservation,
  readSessionTurnFlowBinding as readPersistedSessionTurnFlowBinding,
} from "../actors/agent-session-information-flow";
import {
  createCurrentObservedSourceFlowLabel,
  labelAllowsAudiences,
  ObservationEvidence,
  type FlowLabel,
} from "../policy";
import { digestCanonical } from "../policy";
import type { AccessGrant } from "../authorization/access-grants/types";
import {
  listOrganisationMembers,
  readActiveOrganisationMembershipRevision,
  resolveUser,
  roleMayOperate,
  type OrganisationMember,
} from "../data/control-plane";
import { CAPABILITY_KEYS } from "../authorization/capability-catalogue";
import { heldEffectCoversRequest } from "../data/held-output-request";
import { CommerceGraphReader } from "../commerce/entity-plane/graph-reader";
import { CommerceReadRequestError } from "../context/assembly/commerce";
import { selectNamedCommerceQuerySourceGrant } from "../context/assembly";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";
import { prepareCommerceReadForEmbeddedHarness } from "./commerce/handlers";

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
  grants: readonly import("../authorization/access-grants/types").AccessGrant[];
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

export async function collaborationMember(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  lease: HarnessTurnLease,
  access: "read" | "edit",
): Promise<OrganisationMember> {
  const authority = lease.requestAuthority;
  if (
    (authority.kind !== "control" &&
      authority.kind !== "direct_conversation" &&
      authority.kind !== "shared_conversation") ||
    (access === "edit" && authority.role === "viewer")
  ) {
    throw new Error(
      "Shared workspace access requires a current organisation member with the requested access",
    );
  }
  const members = await listOrganisationMembers({ db, organisationId });
  for (const member of members) {
    if (
      member.personId === authority.requesterPersonId &&
      (authority.kind !== "control" || member.userId === authority.userId) &&
      member.role === authority.role
    ) {
      return member;
    }
  }
  throw new Error("Shared workspace membership changed");
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

export function collaborationEditDeadline(
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  boundary: CatalogExecutionContext,
  startedAt: number,
): number {
  switch (boundary.kind) {
    case "direct":
      return Math.min(
        lease.expiresAt,
        startedAt + CODE_MODE_PILOT_BUDGET.maxDurationMs,
      );
    case "code_mode":
      // An edit of a script ends with the script. The turn lease is older than
      // a script that starts late in the turn, so it cannot give this deadline.
      return admittedExecutionDeadline(storage.sql, boundary.executionLease);
    default:
      return assertNever(boundary);
  }
}

/** What the staff page tools need before they read or change anything. */
export type StaffPageWork = Readonly<{
  member: OrganisationMember;
  prepared: PreparedCommerceRead;
  context: OrderQueueContext;
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
      env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
    ),
    {
      kind: "organisation",
      organisationId: String(organisationId),
      actor: String(member.personId),
    },
  );
  if (client === null) {
    throw new Error(`${label} Underclerk unavailable`);
  }
  return {
    member,
    prepared,
    context: { client, merchantId: prepared.merchantId },
  };
}

/** The person's role now, as the page reads it, and not as the turn began. */
export async function liveStaffMember(
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

/** The person's membership now, as the Devices page reads it. */
export async function liveDeviceMember(
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
  return (
    members.find(
      (member) =>
        member.personId === authority.requesterPersonId &&
        (authority.kind !== "control" || member.userId === authority.userId),
    ) ?? null
  );
}

export function untrustedDeviceText(value: string): string {
  return normalizeUntrustedCommerceText(value, "display_name").text;
}

export async function currentTurnFlowLabel(
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  label: string,
): Promise<StoredFlowLabel> {
  const current = await readPersistedSessionTurnFlowBinding(storage.sql, {
    organisationId: execution.scope.organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
  });
  if (
    !current.ok ||
    current.value === null ||
    current.value.authorityPartitionDigest !== lease.authorityPartitionDigest
  ) {
    throw new Error(`${label} information-flow authority unavailable`);
  }
  return current.value.binding.flowLabel;
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
 * Runs one step that staff also take on the page, with the page's receipt: the
 * same route and operation, a key from this tool call. A repeated call gets the
 * first receipt and runs nothing. A step that the receipt missed meets the
 * queue's stage, which refuses a step that already happened. A refusal runs no
 * command and stores no receipt, so the agent can read and try again.
 */
export async function settleStaffPageEffect(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  work: StaffPageWork,
  effect: Readonly<{
    flowLabel: StoredFlowLabel;
    sink: import("../policy/information-flow").ToolEffectSink;
    route: string;
    operation: string;
    body: unknown;
    operationId: string;
    result: string;
    /**
     * The check of content that the page's readers will see, if it has one.
     * The effect's own check asks the writer question, with the action.
     */
    exit?: (mode: "pass_or_ask", writerRule: "asked") => Promise<void>;
    run: (key: string) => Promise<string | null>;
    /** What must see the step at once, after its receipt. */
    settled: () => Promise<void>;
  }>,
): Promise<StaffPageToolReceipt> {
  const decision = await evaluateHarnessFlowSink(
    execution.scope.database,
    execution.scope.accountAccess,
    acceptedExecutionAccountAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    { flowLabel: effect.flowLabel, sink: effect.sink },
  );
  const exit = {
    decision,
    flowLabel: effect.flowLabel,
    sink: effect.sink,
    action: {
      operation: effect.operation,
      arguments: { route: effect.route, body: effect.body },
    },
  };
  // The effect has two checks: this one and the content check below. Neither
  // uses a pass until this one has its approval, so a pass that one check
  // used is not lost when the other one asks.
  let passed = false;
  if (!(await toolEffectPassesExit(env, execution, lease, exit, "check"))) {
    if (!(await toolEffectPassesExit(env, execution, lease, exit)))
      throw new Error(`Staff page effect is not authorized: ${decision.kind}`);
    passed = true;
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: work.member.userId,
  });
  if (identity === null) {
    throw new Error("Staff page member has no user");
  }
  const digest = await digestCanonical({
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
    operationId: effect.operationId,
    operation: effect.operation,
    route: effect.route,
  });
  const receiptId = `agent_${digest.replace(/[^0-9a-f]/gu, "").slice(-40)}`;
  const scope = {
    userId: identity.userId,
    organisationScope: execution.scope.organisationId,
    route: effect.route,
    operation: effect.operation,
  };
  const boundary = {
    kind: "unversioned" as const,
    idempotencyKey: receiptId,
    requestHash: await digestCanonical(effect.body),
  };
  const replay = await readControlMutationReplay({
    db: execution.scope.database,
    scope,
    boundary,
  });
  await requireSessionExecution(execution, lease);
  if (replay.kind === "replay") {
    return { receiptId, result: effect.result };
  }
  if (replay.kind === "conflict") {
    throw new Error("Staff page receipt conflict");
  }
  await effect.exit?.("pass_or_ask", "asked");
  if (!passed && !(await toolEffectPassesExit(env, execution, lease, exit)))
    throw new Error(`Staff page effect is not authorized: ${decision.kind}`);
  const refusal = await effect.run(receiptId);
  if (refusal !== null) {
    throw new StaffPageRequestError(refusal);
  }
  const receipt = await recordOrganisationCommerceMutationReceipt({
    executionScope: execution.scope,
    identity,
    scope,
    boundary,
    causationId: String(lease.turn.turnId),
    responseBody: { ok: true, operation: effect.operation },
    now: Date.now(),
  });
  if (!receipt.ok) {
    throw new Error(`Staff page receipt: ${receipt.error.code}`);
  }
  await effect.settled();
  return { receiptId, result: effect.result };
}

export function selectSupplierDirectorySourceGrant(
  lease: HarnessTurnLease,
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    grants: readonly AccessGrant[];
    now: string;
  }>,
) {
  const query = supplierDirectoryQuery(1);
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

export function supplierDirectoryQuery(limit: number) {
  return parseCommerceGraphQuery({
    kind: "commerce_list_page",
    listId: SUPPLIER_DIRECTORY_LIST_ID,
    filter: { kind: "all" },
    sorts: [],
    pagination: { limit, cursor: null },
  });
}

/** The Slack thread that an owner or admin connected to a shared draft. */
export type DraftThreadLink = Pick<
  DraftSharedThread,
  "caseId" | "integrationAccountId" | "conversationId"
>;

/** An agent edit of a draft that every organisation role reads. */
export type SharedDraftEdit = Readonly<{
  /** The draft's name in a refusal, such as "Email draft". */
  draft: string;
  caseId: string;
  capabilityId:
    | typeof CAPABILITY_KEYS.commerceProductDescriptionDraftEdit
    | typeof CAPABILITY_KEYS.marketingEmailDraftEdit
    | typeof CAPABILITY_KEYS.commerceProductionPlanEdit
    | typeof CAPABILITY_KEYS.commerceMenuDraftEdit
    | typeof CAPABILITY_KEYS.commerceRecipeSave
    | typeof CAPABILITY_KEYS.commerceSupplyCostSave
    | typeof CAPABILITY_KEYS.commerceSupplierCreate;
  integrationAccountId: string;
  resourceScope: string;
  readSharedThread: () => Promise<DraftThreadLink | null>;
  /**
   * The shared Portal chat of a draft that a Portal chat may edit. Only the
   * production plan has one.
   */
  readSharedChat?: () => Promise<SharedDraftChat | null>;
  notConnected: string;
}>;

/**
 * The readers that an owner or admin added to the draft's audience when they
 * shared the Slack thread or Portal chat of this turn with it, or null when
 * they did not. A shared chat brings its Project and the person who shared it,
 * whose chat it was while it was private. A Portal chat matches by its Case.
 */
export async function draftSharedReaders(
  organisationId: OrganisationId,
  lease: HarnessTurnLease,
  edit: SharedDraftEdit,
): Promise<
  readonly import("../policy/information-flow").FlowAudience[] | null
> {
  const authority = lease.requestAuthority;
  if (authority.kind === "shared_conversation") {
    const sharing = await edit.readSharedThread();
    return sharing !== null &&
      sharing.caseId === edit.caseId &&
      sharing.integrationAccountId === authority.integrationAccountId &&
      sharing.conversationId === authority.conversationId
      ? [
          {
            kind: "conversation",
            integrationAccountId: sharing.integrationAccountId,
            conversationId: sharing.conversationId,
          },
        ]
      : null;
  }
  if (authority.kind !== "control" || edit.readSharedChat === undefined) {
    return null;
  }
  const chat = await edit.readSharedChat();
  return chat !== null &&
    chat.caseId === edit.caseId &&
    isConversationId(chat.conversationId) &&
    isProjectId(chat.projectId)
    ? [
        {
          kind: "chat_conversation",
          organisationId,
          conversationId: chat.conversationId,
        },
        { kind: "project", organisationId, projectId: chat.projectId },
        { kind: "person", personId: chat.approverPersonId },
      ]
    : null;
}

/** A Portal chat that an owner or admin shared with a draft. */
export type SharedDraftChat = Readonly<{
  caseId: string;
  conversationId: string;
  projectId: string;
  approverPersonId: string;
}>;

/**
 * Whether the turn's work may enter a draft that every organisation role
 * reads. Work that some role may not read comes from a conversation, and an
 * owner or admin must have shared that conversation with the draft. The share
 * adds that conversation to the draft's audience, and the turn's label stays as
 * it is. Internal content enters. Other private content asks a person (Plan 27C).
 */
export async function authorizeSharedDraftEdit(
  env: Env,
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  member: OrganisationMember,
  edit: SharedDraftEdit,
): Promise<void> {
  const organisationId = execution.scope.organisationId;
  const current = await readPersistedSessionTurnFlowBinding(storage.sql, {
    organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
  });
  if (
    !current.ok ||
    current.value === null ||
    current.value.authorityPartitionDigest !== lease.authorityPartitionDigest
  ) {
    throw new Error(`${edit.draft} information-flow authority unavailable`);
  }
  const flowLabel = current.value.binding.flowLabel;
  const everyRoleReads = (
    ["owner", "admin", "operator", "viewer"] as const
  ).every((role) =>
    labelAllowsAudiences(flowLabel, [{ kind: "organisation_role", role }]),
  );
  const sharedWith = everyRoleReads
    ? []
    : await draftSharedReaders(organisationId, lease, edit);
  if (sharedWith === null) {
    throw new Error(edit.notConnected);
  }
  await passSharedDraftExit(
    env,
    execution,
    lease,
    member,
    edit,
    flowLabel,
    sharedWith,
  );
}

/**
 * The exit check of content that goes into a draft that every member reads.
 * Content that a member may not read raises the approval prompt.
 */
export async function passSharedDraftExit(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  member: OrganisationMember,
  edit: Pick<
    SharedDraftEdit,
    "draft" | "capabilityId" | "integrationAccountId" | "resourceScope"
  >,
  flowLabel: StoredFlowLabel,
  sharedWith: readonly import("../policy/information-flow").FlowAudience[],
  /**
   * `check` asks nobody and takes no approval pass: a draft preview (Plan
   * 40B phase 7) shows only an edit that would pass the exit now.
   */
  mode: "pass_or_ask" | "check" = "pass_or_ask",
  /**
   * `asked`: this check is the second check of one effect, and the effect's
   * own check asks the writer question with its action (Plan 89).
   */
  writerRule: "ask" | "asked" = "ask",
): Promise<void> {
  const organisationId = execution.scope.organisationId;
  const revision = await readActiveOrganisationMembershipRevision({
    db: execution.scope.database,
    organisationId,
  });
  if (revision === null) {
    throw new Error(`${edit.draft} membership unavailable`);
  }
  const destination = buildControlAuthority({
    organisationId,
    requesterPersonId: member.personId,
    userId: member.userId,
    membershipRevision: revision,
    role: member.role,
  });
  const sink = {
    kind: "tool_effect" as const,
    destinationAuthority: destination.requestAuthority,
    capabilityId: edit.capabilityId,
    integrationAccountId: edit.integrationAccountId,
    resourceScope: edit.resourceScope,
    approvalSatisfied: false,
    readByEveryMember: { sharedWith },
  };
  const decision = await evaluateHarnessFlowSink(
    execution.scope.database,
    execution.scope.accountAccess,
    acceptedExecutionAccountAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    { flowLabel, sink },
  );
  if (
    !(await toolEffectPassesExit(
      env,
      execution,
      lease,
      {
        decision,
        flowLabel,
        sink,
        // A board edit: one Allow covers the later edits of the same
        // request, while their content stays within what was allowed.
        repeatInRequest: heldEffectCoversRequest(edit.resourceScope),
        writerRule,
      },
      mode,
    ))
  ) {
    throw new Error(`${edit.draft} disclosure is not authorized`);
  }
}

export function selectMerchantReportSourceGrant(
  lease: HarnessTurnLease,
  typeId: import("@seams/contracts").SystemCommerceEntityKind,
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

export type EmailMailboxReadScope = Readonly<{
  capability: Variant<CapabilityDefinition, "provider_resource">;
  inputLabel: FlowLabel;
}>;

export function requireCurrentEmailToolLease(
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
): CaseId {
  const authorized = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!authorized.ok) {
    throw new Error(`Email authority unavailable: ${authorized.error.code}`);
  }
  if (assignment.sessionId !== lease.session.sessionId) {
    throw new Error("Email session binding invalid");
  }
  const caseId = parseCaseId(assignment.caseId);
  if (!caseId.ok) {
    throw new Error("Email Case identity is invalid");
  }
  return caseId.value;
}

export function selectProviderResourceGrants(
  grants: readonly AccessGrant[],
  capability: Variant<CapabilityDefinition, "provider_resource">,
): readonly AccessGrant[] {
  const matches: AccessGrant[] = [];
  for (const grant of grants) {
    if (
      grant.target.kind === "provider_resource" &&
      grant.target.capabilityId === capability.capabilityId &&
      grant.target.capabilityVersion === capability.capabilityVersion &&
      grant.target.integrationAccountId === capability.integrationAccountId &&
      grant.target.resourceScope === capability.resourceScope
    ) {
      matches.push(grant);
    }
  }
  return matches;
}

export function readAccessGrantId(grant: AccessGrant): string {
  return grant.grantId;
}

export async function requireLiveBakeryReadAuthority(
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
): Promise<void> {
  await requireSessionExecution(execution, lease);
  const live = await validateLiveRequestAuthority({
    db: execution.scope.database,
    accountAccess: execution.scope.accountAccess,
    userAuthority: acceptedExecutionAccountAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    action: "execute",
    authority: lease.requestAuthority,
  });
  if (!live.ok) {
    throw new Error("Saved bakery authority has changed");
  }
  await requireSessionExecution(execution, lease);
}

/**
 * Whether a tool effect may go on after its exit decision (Plan 27C). A level
 * block asks a person. A pass from an earlier approval lets this one effect
 * through, and the Organisation's capability rules still apply to it. A
 * first block raises `ExitApprovalRequestedError`, which the agent reads.
 */
export async function toolEffectPassesExit(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  input: {
    decision: Awaited<ReturnType<typeof evaluateHarnessFlowSink>>;
    flowLabel: import("../policy/information-flow").FlowLabel;
    sink: import("../policy/information-flow").ToolEffectSink;
    repeatInRequest?: boolean;
    /**
     * The operation and its arguments. A Session that read outside-written
     * text shows them to the person, and the Allow covers them only (Plan
     * 89). Without them the Allow covers one step of this capability.
     */
    action?: EffectAction;
    /** `asked`: another check of the same effect asks the writer question. */
    writerRule?: "ask" | "asked";
  },
  mode: "pass_or_ask" | "check" = "pass_or_ask",
): Promise<boolean> {
  const { decision } = input;
  if (decision.kind === "allow") {
    return true;
  }
  if (
    (decision.kind !== "deny" && decision.kind !== "approval_required") ||
    (decision.reason.code !== "audience_not_permitted" &&
      decision.reason.code !== "outside_written")
  ) {
    return false;
  }
  const writerAsked = input.writerRule === "asked";
  // The writer rule is the last rule, so nothing else stops this check.
  if (writerAsked && decision.reason.code === "outside_written") return true;
  const rules = await evaluateHarnessFlowSink(
    execution.scope.database,
    execution.scope.accountAccess,
    acceptedExecutionAccountAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    { flowLabel: await emptyFlowLabel(), sink: input.sink },
  );
  if (rules.kind !== "allow") {
    return false;
  }
  const reason: HeldOutputReason =
    decision.reason.code === "outside_written"
      ? "outside_written"
      : decision.reason.reasonCode === "aifc.outside_organisation" ||
          decision.reason.reasonCode === "aifc.other_recipient"
        ? "outside_organisation"
        : "private_source";
  // A pass for a reader block did not show the action. So an effect that the
  // writer rule also stops needs its own pass after that one.
  const reasons: readonly HeldOutputReason[] =
    reason !== "outside_written" &&
    !writerAsked &&
    toolEffectAsksAfterOutsideText(input.flowLabel, input.sink)
      ? [reason, "outside_written"]
      : [reason];
  const request = (each: HeldOutputReason) => ({
    execution,
    lease,
    effect: input.sink,
    flowLabel: input.flowLabel,
    repeatInRequest: input.repeatInRequest === true,
    reason: each,
    action: input.action ?? null,
  });
  // No pass is used until each one waits: a pass that this call used before
  // the other rule stopped it would be lost, and the person would be asked
  // for it again.
  const missing: HeldOutputReason[] = [];
  for (const each of reasons)
    if (reasons.length > 1 || mode === "check")
      if (!(await exitApprovalPassReady(request(each)))) missing.push(each);
  if (mode === "check") return missing.length === 0;
  const first = missing[0];
  if (first !== undefined)
    return passOrAskForExitApproval({ env, ...request(first) });
  for (const each of reasons)
    if (!(await passOrAskForExitApproval({ env, ...request(each) })))
      return false;
  return true;
}

export async function evaluateHarnessFlowSink(
  db: OrganisationDatabase,
  accountAccess: import("../account-platform/access").AccountPlatformAccess,
  userAuthority: import("../account-platform/access").AccountUserAuthority,
  input: {
    flowLabel: import("../policy/information-flow").FlowLabel;
    sink: import("../policy/information-flow").ToolEffectSink;
  },
) {
  const authority = input.sink.destinationAuthority;
  if (authority.kind === "control") {
    return evaluateChatFlowLabelSink(
      db,
      accountAccess,
      input.flowLabel,
      authority,
      input.sink,
    );
  }
  const current = await validateLiveRequestAuthority({
    db,
    accountAccess,
    userAuthority,
    authority,
    action: "execute",
  });
  if (!current.ok) {
    return { kind: "unavailable" as const };
  }
  const check = await currentFlowSinkCheck({
    db,
    flowLabel: input.flowLabel,
    sink: input.sink,
  });
  if (!check.ok) {
    return { kind: "unavailable" as const };
  }
  return evaluateFlowLabelSink(check.value);
}

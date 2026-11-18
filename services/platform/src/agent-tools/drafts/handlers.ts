import {
  resolveCanvasCollaborationAgent,
  resolveCollaborationAgent,
} from "../../actors/collaboration-agent";
import { acceptedExecutionAccountAuthority } from "../../account-platform/access";
import { workflowCanvasDocumentId } from "@seams/bakery-model/bakery-canvas-source";
import type {
  WorkflowCanvasReadRequest,
  WorkflowCanvasMoveRequest,
} from "../../actors/workflow-canvas-tools";
import {
  authorizeCanvasTurnDocument,
  sessionTurnExecution,
} from "../../chat/turn-access";
import type {
  DraftAgentEditRequest,
  DraftAgentReadArgs,
  DraftAgentSnapshot,
} from "../../actors/product-description-draft";
import type {
  EmailDraftEditRequest,
  EmailDraftRead,
} from "../../actors/email-draft";
import {
  MenuDraftRequestError,
  type MenuDraftEdit,
  type MenuDraftRead,
} from "../../actors/menu-draft";
import {
  MenuBoardRequestError,
  type MenuBoardEdit,
  type MenuBoardEditResult,
} from "../../actors/menu-boards";
import { readCafeImages } from "../../commerce/cafe-media";
import { readPublishedCafeMenu } from "../../control/routes/menu-screens";
import { buildControlAuthority } from "../../request-authority";
import type { CaseAssignment, HarnessTurnLease } from "@seams/contracts";
import type { Env } from "../../env";
import { newRequestId, type OrganisationId } from "../../ids";
import { traceWarn } from "../../observability";
import { requireActiveOrganisationActorAtPlacement } from "../../actors/actor-router";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
} from "../../actors/session-execution-admission";
import { preflightHarnessTurnLease } from "../../actors/agent-session-harness-authority";
import type { CatalogExecutionContext } from "../catalog/execute";
import { DescriptionDraftRequestError } from "../catalog/types";
import type {
  MenuBoardArchiveRequest,
  MenuBoardCreateRequest,
} from "../catalog/types";
import { parseCommerceGraphQuery } from "../../commerce/entity-plane/routes";
import { authorizeCapabilityUse } from "../../authorization/access-grants/turn-authority";
import {
  admitSessionInformationFlowObservation,
  readSessionTurnFlowBinding as readPersistedSessionTurnFlowBinding,
} from "../../actors/agent-session-information-flow";
import {
  createCurrentSourceFlowLabel,
  decideContextAdmission,
  ObservationEvidence,
  type FlowLabel,
} from "../../policy";
import { digestCanonical } from "../../policy";
import type { AccessGrant } from "../../authorization/access-grants/types";
import {
  listOrganisationMembers,
  readActiveOrganisationMembershipRevision,
  type OrganisationMember,
} from "../../data/control-plane";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import { CommerceReadRequestError } from "../../context/assembly/commerce";
import { selectNamedCommerceQuerySourceGrant } from "../../context/assembly";
import { assertNever, sha256Hex } from "@seams/std";
import {
  MENU_BOARD_LAYOUTS,
  MENU_BOARD_SCREEN_SIZES,
  menuBoardCanvasRects,
} from "@seams/menu-board-crdt/board";
import {
  type DraftThreadLink,
  type PreparedCommerceRead,
  admitCommerceReadObservation,
  authorizeSharedDraftEdit,
  collaborationEditDeadline,
  collaborationMember,
  evaluateHarnessFlowSink,
  passSharedDraftExit,
  prepareSharedCommerceObservation,
  requireLiveBakeryReadAuthority,
  toolEffectPassesExit,
} from "../session-support";
import { prepareCommerceReadForEmbeddedHarness } from "../commerce/handlers";
import type { SessionToolContext } from "../context";

/**
 * A draft tool reads its product under a product read grant. When no grant
 * admits the read, a permission request may ask for that grant.
 */
export function requestableProductRead(error: unknown): never {
  if (
    error instanceof CommerceReadRequestError &&
    error.failure.code === "commerce_context_authority_denied"
  ) {
    throw new CommerceReadRequestError(error.failure, "product");
  }
  throw error;
}

export function selectDescriptionDraftSourceGrant(
  lease: HarnessTurnLease,
  productId: string,
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    grants: readonly AccessGrant[];
    now: string;
  }>,
) {
  const query = parseCommerceGraphQuery({
    kind: "entity_by_ref",
    reference: { origin: "system", typeId: "product", entityId: productId },
    traversal: { maxDepth: 0, resultLimit: 1 },
    filter: null,
  });
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

export type PreparedWorkflowCanvasRead = Readonly<{
  kind: "saved-run";
  snapshotId: string;
  label: FlowLabel;
  execution: SessionExecutionAdmission;
}>;

export async function prepareWorkflowCanvasRead(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
  request: WorkflowCanvasReadRequest,
): Promise<PreparedWorkflowCanvasRead> {
  if (
    !(await authorizeCanvasTurnDocument(
      execution.scope.database,
      execution.scope.organisationId,
      sessionTurnExecution(lease),
      workflowCanvasDocumentId(request.reference),
    ))
  ) {
    throw new Error(
      "Workflow canvas is outside this conversation's document scope",
    );
  }
  await requireLiveBakeryReadAuthority(execution, lease);
  if (
    assignment.sessionId !== lease.session.sessionId ||
    assignment.caseId.length === 0
  ) {
    throw new Error("Workflow canvas information-flow identity unavailable");
  }
  const allowed = await authorizeCapabilityUse({
    db: execution.scope.database,
    accountAccess: execution.scope.accountAccess,
    userAuthority: acceptedExecutionAccountAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    action: "execute",
    organisationId: execution.scope.organisationId,
    authority: lease.requestAuthority,
    authorityPartition: assignment.authorityPartition,
    request: {
      capabilities: [
        {
          kind: "platform_capability",
          capabilityId: CAPABILITY_KEYS.commerceEntityPlaneContext,
          capabilityVersion: 1,
        },
      ],
    },
  });
  if (!allowed.ok) {
    throw new Error(`Workflow canvas read denied: ${allowed.error.code}`);
  }
  const label = await createCurrentSourceFlowLabel({
    kind: "saved_bakery_run",
    db: execution.scope.database,
    authority: lease.requestAuthority,
  });
  if (!label.ok) {
    throw new Error("Saved-run canvas source policy unavailable");
  }
  const admission = await decideContextAdmission({
    subject: {
      kind: "authority_derived",
      requestAuthority: lease.requestAuthority,
      caseId: String(assignment.caseId),
    },
    inputLabel: label.value,
  });
  if (admission.kind !== "admit") {
    throw new Error("Saved-run canvas context admission denied");
  }
  await requireLiveBakeryReadAuthority(execution, lease);
  return {
    kind: "saved-run",
    snapshotId: request.reference.snapshotId,
    label: label.value,
    execution,
  };
}

export async function admitWorkflowCanvasObservation(
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  prepared: PreparedWorkflowCanvasRead,
  value: unknown,
  revision: number,
  description: string,
): Promise<void> {
  const { execution } = prepared;
  await requireLiveBakeryReadAuthority(execution, lease);
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "organisation_record",
      organisationId: execution.scope.organisationId,
      recordId: `bakery-run:${prepared.snapshotId}:canvas`,
    },
    sourceRevision: revision,
    contentDigest: await digestCanonical(value),
    inputLabel: prepared.label,
    observedAt: Date.now(),
  });
  if (!evidence.ok) {
    throw new Error("Saved-run canvas observation is invalid");
  }
  const admitted = await admitSessionInformationFlowObservation({
    authorizeCommit: requireLiveBakeryReadAuthority.bind(
      null,
      execution,
      lease,
    ),
    sql: storage.sql,
    transactionSync: storage.transactionSync.bind(storage),
    organisationId: execution.scope.organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
    authorityPartitionDigest: lease.authorityPartitionDigest,
    inputLabel: prepared.label,
    observation: evidence.value,
    observedAt: evidence.value.observedAt,
  });
  if (!admitted.ok) {
    throw new Error("Saved-run canvas observation admission failed");
  }
  await requireLiveBakeryReadAuthority(execution, lease);
}

export async function readWorkflowCanvasForEmbeddedHarness(
  context: SessionToolContext,
  request: WorkflowCanvasReadRequest,
) {
  const { env, storage, execution, lease, assignment } = context;
  const organisationId = execution.scope.organisationId;
  const prepared = await prepareWorkflowCanvasRead(
    env,
    execution,
    lease,
    assignment,
    request,
  );
  const member = await collaborationMember(
    execution.scope.database,
    organisationId,
    lease,
    "read",
  );
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const result = await organisation.readWorkflowCanvas({
    organisationId,
    reference: request.reference,
    userId: member.userId,
    agentRequest: {
      sessionId: lease.session.sessionId,
      turnId: lease.turn.turnId,
    },
  });
  if (!result.ok) {
    throw new Error(`Workflow canvas unavailable: ${result.error.code}`);
  }
  await admitWorkflowCanvasObservation(
    storage,
    lease,
    prepared,
    result.value,
    result.value.documentRevision,
    "workflow canvas",
  );
  return result.value;
}

export async function moveWorkflowCanvasForEmbeddedHarness(
  context: SessionToolContext,
  request: WorkflowCanvasMoveRequest,
  operationId: string,
  boundary: CatalogExecutionContext,
) {
  const { env, storage, execution, lease, assignment } = context;
  const deadlineAt = collaborationEditDeadline(
    storage,
    lease,
    boundary,
    Date.now(),
  );
  const organisationId = execution.scope.organisationId;
  const prepared = await prepareWorkflowCanvasRead(
    env,
    execution,
    lease,
    assignment,
    request,
  );
  const member = await collaborationMember(
    execution.scope.database,
    organisationId,
    lease,
    "edit",
  );
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const before = await organisation.readWorkflowCanvas({
    organisationId,
    reference: request.reference,
    userId: member.userId,
    agentRequest: {
      sessionId: lease.session.sessionId,
      turnId: lease.turn.turnId,
    },
  });
  if (!before.ok) {
    throw new Error(`Workflow canvas unavailable: ${before.error.code}`);
  }
  await admitWorkflowCanvasObservation(
    storage,
    lease,
    prepared,
    before.value,
    before.value.documentRevision,
    "workflow canvas move",
  );
  await authorizeWorkflowCanvasDisclosure(
    env,
    storage,
    organisationId,
    lease,
    member,
    prepared,
  );
  const logicalOperationId = await sha256Hex(
    JSON.stringify([lease.session.sessionId, lease.turn.turnId, operationId]),
  );
  const active = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!active.ok) {
    throw new Error(
      `Workflow canvas move authority expired: ${active.error.code}`,
    );
  }
  await requireSessionExecution(execution, lease);
  const result = await organisation.moveWorkflowCanvasObject({
    agent: await resolveCollaborationAgent(execution.scope, assignment),
    organisationId,
    reference: request.reference,
    userId: member.userId,
    deadlineAt,
    execution: sessionTurnExecution(lease),
    request: {
      documentId: workflowCanvasDocumentId(request.reference),
      operationId: logicalOperationId,
      expectedRevision: request.expectedRevision,
      objectId: request.destination.objectId,
      x: request.destination.x,
      y: request.destination.y,
    },
  });
  if (!result.ok) {
    throw new Error(`Workflow canvas move denied: ${result.error.code}`);
  }
  const revision =
    result.value.kind === "accepted"
      ? result.value.receipt.documentRevision
      : before.value.documentRevision;
  await admitWorkflowCanvasObservation(
    storage,
    lease,
    prepared,
    result.value,
    revision,
    "workflow canvas move",
  );
  return result.value;
}

export async function authorizeWorkflowCanvasDisclosure(
  env: Env,
  storage: DurableObjectStorage,
  organisationId: OrganisationId,
  lease: HarnessTurnLease,
  member: OrganisationMember,
  prepared: PreparedWorkflowCanvasRead,
): Promise<void> {
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
    throw new Error("Workflow canvas information-flow authority unavailable");
  }
  const flowLabel = current.value.binding.flowLabel;
  const revision = await readActiveOrganisationMembershipRevision({
    db: prepared.execution.scope.database,
    organisationId,
  });
  if (revision === null) {
    throw new Error("Workflow canvas membership unavailable");
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
    capabilityId: CAPABILITY_KEYS.commerceWorkflowCanvasMove,
    integrationAccountId: "platform",
    resourceScope: `bakery-run:${prepared.snapshotId}:canvas`,
    approvalSatisfied: false,
    readByEveryMember: { sharedWith: [] },
  };
  const decision = await evaluateHarnessFlowSink(
    prepared.execution.scope.database,
    prepared.execution.scope.accountAccess,
    acceptedExecutionAccountAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    { flowLabel, sink },
  );
  if (
    !(await toolEffectPassesExit(env, prepared.execution, lease, {
      decision,
      flowLabel,
      sink,
    }))
  ) {
    traceWarn("session.workflow_canvas_disclosure_denied", {
      requestId: newRequestId(),
      organisation_id: organisationId,
      session_id: lease.session.sessionId,
      turn_id: lease.turn.turnId,
      decision_kind: decision.kind,
      reason_code: "reason" in decision ? decision.reason.code : null,
      restriction_rule_id: "reason" in decision ? decision.reason.ruleId : null,
    });
    throw new Error("Workflow canvas disclosure is not authorized");
  }
}

export async function readProductDescriptionDraftForEmbeddedHarness(
  context: SessionToolContext,
  args: DraftAgentReadArgs,
): Promise<DraftAgentSnapshot> {
  const { env, storage, execution, lease, assignment } = context;
  const organisationId = execution.scope.organisationId;
  const request = {
    productId:
      args.productId ??
      (await connectedDraftProduct(env, execution, lease, assignment)),
  };
  const source = await prepareCommerceReadForEmbeddedHarness(
    env,
    execution,
    lease,
    assignment,
    selectDescriptionDraftSourceGrant.bind(null, lease, request.productId),
    "description draft",
  ).catch(requestableProductRead);
  const prepared = await prepareSharedCommerceObservation(source);
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const result = await organisation.readProductDescriptionDraft({
    organisationId,
    request,
  });
  if (!result.ok) {
    throw draftReadFailure(request.productId, result.error.code);
  }
  await admitCommerceReadObservation(
    storage,
    lease,
    prepared,
    result.value,
    result.value.product.revision,
    "description draft",
  );
  return result.value;
}

/**
 * The product of the description draft that an owner connected to this
 * turn's Slack thread. The model may correct each refusal.
 */
export async function connectedDraftProduct(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
): Promise<string> {
  const organisationId = execution.scope.organisationId;
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const products = await organisation.readConnectedProductDescriptionDrafts({
    organisationId,
    caseId: assignment.caseId,
  });
  if (products === null) {
    throw new Error("Connected description drafts are unavailable");
  }
  const [only, ...others] = products;
  if (only === undefined) {
    throw new DescriptionDraftRequestError(
      "This conversation is not connected to a product description draft. Ask which product to use, or an owner or admin connects this Slack thread on the product page.",
    );
  }
  if (others.length > 0) {
    throw new DescriptionDraftRequestError(
      "This thread is connected to the drafts of several products. Ask which product to use, then pass its productId.",
    );
  }
  return only;
}

/** A refusal the model can correct, or the generic failure. */
export function draftReadFailure(productId: string, code: string): Error {
  return code === "product_not_found"
    ? new DescriptionDraftRequestError(
        `No product has the id ${productId}. Use the shop's plain product id, without an "underclerk:" prefix, or pass productId null to read the draft connected to this Slack thread.`,
      )
    : new Error(`Description draft unavailable: ${code}`);
}

export async function editProductDescriptionDraftForEmbeddedHarness(
  context: SessionToolContext,
  request: DraftAgentEditRequest,
  operationId: string,
  boundary: CatalogExecutionContext,
): Promise<DraftAgentSnapshot> {
  const { env, storage, execution, lease, assignment } = context;
  const deadlineAt = collaborationEditDeadline(
    storage,
    lease,
    boundary,
    Date.now(),
  );
  const organisationId = execution.scope.organisationId;
  const source = await prepareCommerceReadForEmbeddedHarness(
    env,
    execution,
    lease,
    assignment,
    selectDescriptionDraftSourceGrant.bind(null, lease, request.productId),
    "description draft edit",
  ).catch(requestableProductRead);
  const prepared = await prepareSharedCommerceObservation(source);
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const before = await organisation.readProductDescriptionDraft({
    organisationId,
    request: { productId: request.productId },
  });
  if (!before.ok) {
    throw draftReadFailure(request.productId, before.error.code);
  }
  await admitCommerceReadObservation(
    storage,
    lease,
    prepared,
    before.value,
    before.value.product.revision,
    "description draft edit",
  );
  const member = await collaborationMember(
    execution.scope.database,
    organisationId,
    lease,
    "edit",
  );
  await authorizeDescriptionDraftDisclosure(
    env,
    storage,
    lease,
    member,
    prepared,
    assignment.caseId,
    request.productId,
  );
  const active = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!active.ok) {
    throw new Error(
      `Description draft edit authority expired: ${active.error.code}`,
    );
  }
  await requireSessionExecution(execution, lease);
  const result = await organisation.editProductDescriptionDraft({
    agent: await resolveCollaborationAgent(execution.scope, assignment),
    execution: sessionTurnExecution(lease),
    organisationId,
    request,
    operationId: JSON.stringify([
      lease.session.sessionId,
      lease.turn.turnId,
      operationId,
    ]),
    userId: member.userId,
    deadlineAt,
  });
  if (!result.ok) {
    throw new Error(
      `Description draft edit failed: ${result.error.code}. Read the draft again before choosing a new edit.`,
    );
  }
  await admitCommerceReadObservation(
    storage,
    lease,
    prepared,
    result.value,
    result.value.product.revision,
    "description draft edit",
  );
  return result.value;
}

export async function readMenuDraftForEmbeddedHarness(
  context: SessionToolContext,
): Promise<MenuDraftRead> {
  const { env, storage, execution, lease } = context;
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const result = await organisation.readMenuDraft({ organisationId });
  if (!result.ok) {
    throw new Error(`Menu draft unavailable: ${result.error.code}`);
  }
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  return result.value;
}

/**
 * An agent's change of the shared menu. It passes the check of a person who
 * can edit, and the exit check for content that goes into a shared draft. It
 * has no commerce effect: publication is a separate approved action.
 */
export async function editMenuDraftForEmbeddedHarness(
  context: SessionToolContext,
  edit: MenuDraftEdit,
  operationId: string,
  boundary: CatalogExecutionContext,
): Promise<MenuDraftRead> {
  const { env, storage, execution, lease, assignment } = context;
  const deadlineAt = collaborationEditDeadline(
    storage,
    lease,
    boundary,
    Date.now(),
  );
  const organisationId = execution.scope.organisationId;
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  const member = await collaborationMember(
    execution.scope.database,
    organisationId,
    lease,
    "edit",
  );
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
    throw new Error("Menu draft information-flow authority unavailable");
  }
  await passSharedDraftExit(
    env,
    execution,
    lease,
    member,
    {
      draft: "Menu draft",
      capabilityId: CAPABILITY_KEYS.commerceMenuDraftEdit,
      integrationAccountId: "platform",
      resourceScope: "menu-draft:cafe-menu",
    },
    current.value.binding.flowLabel,
    [],
  );
  const active = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!active.ok) {
    throw new Error(`Menu draft edit authority expired: ${active.error.code}`);
  }
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const result = await organisation.editMenuDraft({
    agent: await resolveCollaborationAgent(execution.scope, assignment),
    execution: sessionTurnExecution(lease),
    organisationId,
    edit,
    operationId: JSON.stringify([
      lease.session.sessionId,
      lease.turn.turnId,
      operationId,
    ]),
    userId: member.userId,
    deadlineAt,
  });
  if (!result.ok) {
    if (result.error.code === "record_conflict") {
      throw new MenuDraftRequestError(
        "That section or item is not in the menu now. Read the menu again before you choose a new edit.",
      );
    }
    throw new Error(`Menu draft edit failed: ${result.error.code}`);
  }
  await requireSessionExecution(execution, lease);
  return result.value;
}

/**
 * Plan 40B phase 4: the shop's menu boards for an agent, with the menu items
 * that they name and each item's live price, deal and availability. A board
 * holds no price; the prices here are the ones that the screens show now.
 */
export async function readMenuBoardsForEmbeddedHarness(
  context: SessionToolContext,
  request: Readonly<{ boardId: string | null }>,
): Promise<unknown> {
  const { env, storage, execution, lease } = context;
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const [result, published, images] = await Promise.all([
    organisation.readMenuBoards({ organisationId, boardId: request.boardId }),
    readPublishedCafeMenu(env, organisationId),
    readCafeImages(env, organisationId),
  ]);
  const facts = published?.facts ?? null;
  if (!result.ok) {
    if (result.error.code === "menu_board_missing") {
      throw new MenuBoardRequestError(
        "That board does not exist. Call menu_board_read with boardId null to list the boards.",
      );
    }
    throw new Error(`Menu boards unavailable: ${result.error.code}`);
  }
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  const live = new Map(
    (facts?.entries ?? []).map((entry) => [entry.menuEntryId, entry]),
  );
  return {
    boards: result.value.boards.map((board) => ({
      boardId: board.boardId,
      documentRevision: board.documentRevision,
      title: board.board.title,
      layout: board.board.layout,
      style: board.board.style,
      elements: board.board.elements,
      unplaced: board.board.unplaced,
      // Plan 40B phase 5, slice 8: where each element of a free canvas
      // shows, with the elements of each stack placed.
      canvasRects: MENU_BOARD_LAYOUTS[board.board.layout].canvas
        ? Object.fromEntries(
            menuBoardCanvasRects(
              [...board.board.elements, ...board.board.unplaced],
              MENU_BOARD_SCREEN_SIZES[
                MENU_BOARD_LAYOUTS[board.board.layout].shape
              ],
              MENU_BOARD_SCREEN_SIZES[
                MENU_BOARD_LAYOUTS[board.board.layout].shape
              ],
            ),
          )
        : null,
      comments: board.comments,
      versions: board.versions.slice(0, 20),
      release: board.release,
      screens: board.screens,
    })),
    // Plan 40B, board removal: boards that menu_board_archive can restore.
    archivedBoards: result.value.archivedBoards,
    sections: result.value.menu.sections.map((section) => ({
      sectionId: section.id,
      title: section.title,
    })),
    items: [
      ...result.value.menu.items.map((item) => {
        const entry = live.get(item.id);
        return {
          itemId: item.id,
          name: item.displayName,
          sectionId: item.placement.sectionId,
          onPublishedMenu: entry !== undefined,
          price: entry?.price ?? null,
          wasPrice: entry?.compareAtPrice ?? null,
          availability: entry?.availability ?? null,
        };
      }),
      // Plan 40B phase 5: the published menu can hold items that the menu
      // draft does not, for example a menu that a shop set up through the
      // Commerce API. Their itemId is the menu entry, so that a price
      // proposal works with no board and no draft.
      ...(published?.names ?? [])
        .filter(
          (name) =>
            !result.value.menu.items.some(
              (item) => item.id === name.menuEntryId,
            ),
        )
        .map((name) => {
          const entry = live.get(name.menuEntryId);
          return {
            itemId: name.menuEntryId,
            name: name.name,
            sectionId: null,
            publishedSection: name.sectionName,
            onPublishedMenu: true,
            price: entry?.price ?? null,
            wasPrice: entry?.compareAtPrice ?? null,
            availability: entry?.availability ?? null,
          };
        }),
    ],
    // Plan 40B, the image element: the shop's images that add_image can
    // place on a free canvas, by mediaId.
    images: images ?? [],
    pricesVerified: facts !== null,
    observedAt: facts?.observedAt ?? Date.now(),
  };
}

/**
 * An agent's change of one board's draft (Plan 40B phase 4). It passes the
 * check of a person who can edit, and the exit check for content that goes
 * into a shared draft. It has no commerce effect: a person publishes the
 * board, and a price is an approved action.
 */
export async function editMenuBoardForEmbeddedHarness(
  context: SessionToolContext,
  request: Readonly<{ boardId: string; edit: MenuBoardEdit }>,
  operationId: string,
  boundary: CatalogExecutionContext,
): Promise<MenuBoardEditResult> {
  const { env, storage, execution, lease, assignment } = context;
  const deadlineAt = collaborationEditDeadline(
    storage,
    lease,
    boundary,
    Date.now(),
  );
  const organisationId = execution.scope.organisationId;
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  const member = await collaborationMember(
    execution.scope.database,
    organisationId,
    lease,
    "edit",
  );
  // An image comes from the shop's library: the person sees the same list
  // in the board editor's Images panel.
  if (request.edit.kind === "add_image") {
    const mediaId = request.edit.mediaId;
    const images = await readCafeImages(env, organisationId);
    if (images === null)
      throw new Error("The shop's images could not be read. Try again later.");
    if (!images.some((image) => image.mediaId === mediaId))
      throw new MenuBoardRequestError(
        "That image is not in the shop's library. Call menu_board_read and use a mediaId from its images.",
      );
  }
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
    throw new Error("Menu board information-flow authority unavailable");
  }
  await passSharedDraftExit(
    env,
    execution,
    lease,
    member,
    {
      draft: "Menu board",
      capabilityId: CAPABILITY_KEYS.commerceMenuDraftEdit,
      integrationAccountId: "platform",
      resourceScope: `menu-board:${request.boardId}`,
    },
    current.value.binding.flowLabel,
    [],
  );
  const active = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!active.ok) {
    throw new Error(`Menu board edit authority expired: ${active.error.code}`);
  }
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const result = await organisation.editMenuBoard({
    agent: await resolveCanvasCollaborationAgent(execution.scope, assignment),
    execution: sessionTurnExecution(lease),
    organisationId,
    boardId: request.boardId,
    edit: request.edit,
    operationId: JSON.stringify([
      lease.session.sessionId,
      lease.turn.turnId,
      operationId,
    ]),
    userId: member.userId,
    deadlineAt,
  });
  if (!result.ok) {
    switch (result.error.code) {
      case "menu_board_missing":
        throw new MenuBoardRequestError(
          "That board does not exist. Call menu_board_read with boardId null to list the boards.",
        );
      case "menu_board_element_missing":
        throw new MenuBoardRequestError(
          "That element is not on the board now. Read the board again before you choose a new edit.",
        );
      case "menu_board_text_changed":
        throw new MenuBoardRequestError(
          `Someone changed that text since your read. It is now ${JSON.stringify(result.error.current ?? "")}. Read the board again and check with the person before you change it.`,
        );
      case "menu_board_edit_invalid":
        throw new MenuBoardRequestError(
          "The board cannot take that edit: check the element kind, the prop, the frame of the layout, the item and the text length (280 characters).",
        );
      case "menu_board_comment_missing":
        throw new MenuBoardRequestError(
          "That comment is not on the board now. Call menu_board_read for the board's comment threads.",
        );
      case "menu_board_comment_limit":
        throw new MenuBoardRequestError(
          "This board has 300 comments. Ask a person to delete old ones before you add another.",
        );
      case "menu_board_comment_invalid":
        throw new MenuBoardRequestError(
          "A comment needs 1 to 1000 characters of text.",
        );
      case "menu_board_version_missing":
        throw new MenuBoardRequestError(
          "That version is not in the board's history. Call menu_board_read for the board's versions.",
        );
      case "menu_board_version_invalid":
        throw new MenuBoardRequestError(
          "A version name needs 1 to 80 characters.",
        );
      default:
        throw new Error(`Menu board edit failed: ${result.error.code}`);
    }
  }
  await requireSessionExecution(execution, lease);
  return result.value;
}

/**
 * An agent's new board (Plan 40B, the start screen): a layout's template, a
 * blank free canvas or a designed menu. It passes the same checks as an
 * agent's board edit: the person can edit menu boards, and the chat's
 * content may enter a shared draft. It has no commerce effect: a person
 * publishes the board.
 */
export async function createMenuBoardForEmbeddedHarness(
  context: SessionToolContext,
  request: MenuBoardCreateRequest,
  _operationId: string,
  _boundary: CatalogExecutionContext,
): Promise<unknown> {
  const { env, storage, execution, lease } = context;
  const organisationId = execution.scope.organisationId;
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  const member = await collaborationMember(
    execution.scope.database,
    organisationId,
    lease,
    "edit",
  );
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
    throw new Error("Menu board information-flow authority unavailable");
  }
  await passSharedDraftExit(
    env,
    execution,
    lease,
    member,
    {
      draft: "Menu board",
      capabilityId: CAPABILITY_KEYS.commerceMenuDraftEdit,
      integrationAccountId: "platform",
      resourceScope: "menu-board:new",
    },
    current.value.binding.flowLabel,
    [],
  );
  const active = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!active.ok) {
    throw new Error(`Menu board edit authority expired: ${active.error.code}`);
  }
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const created = await organisation.menuBoardCommand({
    organisationId,
    command: {
      kind: "create_board",
      title: request.title,
      layout: request.layout,
      start: request.start,
      userId: member.userId,
    },
  });
  if (!created.ok) {
    if (created.error.code === "menu_board_limit")
      throw new MenuBoardRequestError(
        "This shop has 12 boards. Ask a person to remove one before you make another.",
      );
    throw new Error(`Menu board create failed: ${created.error.code}`);
  }
  await requireSessionExecution(execution, lease);
  return { board: created.value };
}

/**
 * An agent archives a board that no screen shows, or restores an archived
 * board (Plan 40B, board removal), as an owner or admin does from the
 * board menu. The person who asked must be an owner or admin. An archive
 * deletes nothing, so a restore undoes it.
 */
export async function archiveMenuBoardForEmbeddedHarness(
  context: SessionToolContext,
  request: MenuBoardArchiveRequest,
  _operationId: string,
  _boundary: CatalogExecutionContext,
): Promise<unknown> {
  const { env, storage, execution, lease } = context;
  const organisationId = execution.scope.organisationId;
  await requireLiveMenuDraftAuthority(execution, storage, lease);
  const member = await collaborationMember(
    execution.scope.database,
    organisationId,
    lease,
    "edit",
  );
  if (member.role !== "owner" && member.role !== "admin")
    throw new MenuBoardRequestError(
      "Only an owner or admin can archive or restore a board. Tell the person to ask one.",
    );
  const active = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!active.ok) {
    throw new Error(
      `Menu board archive authority expired: ${active.error.code}`,
    );
  }
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const changed = await organisation.menuBoardCommand({
    organisationId,
    command: {
      kind: "set_board_archived",
      boardId: request.boardId,
      archived: request.archived,
      userId: member.userId,
    },
  });
  if (!changed.ok) {
    switch (changed.error.code) {
      case "menu_board_missing":
        throw new MenuBoardRequestError(
          "That board does not exist. Call menu_board_read with boardId null: it lists the boards and the archived boards.",
        );
      case "menu_board_on_screen":
        throw new MenuBoardRequestError(
          "A screen shows this board. Ask the person to show another board on that screen, or to end its pairing, before you archive it.",
        );
      case "menu_board_limit":
        throw new MenuBoardRequestError(
          "This shop has 12 boards. Ask a person to archive one before you restore another.",
        );
      default:
        throw new Error(`Menu board archive failed: ${changed.error.code}`);
    }
  }
  await requireSessionExecution(execution, lease);
  return changed.value;
}

export async function requireLiveMenuDraftAuthority(
  execution: SessionExecutionAdmission,
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
): Promise<void> {
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  switch (lease.requestAuthority.kind) {
    case "control":
    case "direct_conversation":
    case "shared_conversation":
      break;
    case "workflow":
    case "agent_mailbox":
    case "whatsapp_support":
      throw new Error("Menu draft read requires a current organisation member");
    default:
      return assertNever(lease.requestAuthority);
  }
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
    throw new Error("Menu draft information-flow authority unavailable");
  }
  await requireSessionExecution(execution, lease);
}

export async function readEmailDraftForEmbeddedHarness(
  context: SessionToolContext,
): Promise<EmailDraftRead> {
  const { env, storage, execution, lease, assignment } = context;
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  await authorizeEmailDraftThreadAccess(
    env,
    storage,
    execution,
    lease,
    assignment,
    "read",
  );
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const result = await organisation.readEmailDraft({ organisationId });
  await requireSessionExecution(execution, lease);
  if (!result.ok) {
    throw new Error(`Email draft unavailable: ${result.error.code}`);
  }
  return result.value;
}

export async function editEmailDraftForEmbeddedHarness(
  context: SessionToolContext,
  request: EmailDraftEditRequest,
  operationId: string,
  boundary: CatalogExecutionContext,
): Promise<EmailDraftRead> {
  const { env, storage, execution, lease, assignment } = context;
  const deadlineAt = collaborationEditDeadline(
    storage,
    lease,
    boundary,
    Date.now(),
  );
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  const access = await authorizeEmailDraftThreadAccess(
    env,
    storage,
    execution,
    lease,
    assignment,
    "edit",
  );
  await authorizeSharedDraftEdit(
    env,
    storage,
    execution,
    lease,
    access.member,
    {
      draft: "Email draft",
      caseId: assignment.caseId,
      capabilityId: CAPABILITY_KEYS.marketingEmailDraftEdit,
      integrationAccountId: "platform",
      resourceScope: "email-draft",
      readSharedThread: checkedDraftThread.bind(null, access.sharing),
      notConnected:
        "Connect this Slack thread from the email draft before reading or editing it",
    },
  );
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const result = await organisation.editEmailDraft({
    agent: await resolveCollaborationAgent(execution.scope, assignment),
    organisationId,
    execution: sessionTurnExecution(lease),
    request,
    operationId: JSON.stringify([
      lease.session.sessionId,
      lease.turn.turnId,
      operationId,
    ]),
    userId: access.member.userId,
    deadlineAt,
  });
  await requireSessionExecution(execution, lease);
  if (!result.ok) {
    throw new Error(
      `Email draft edit failed: ${result.error.code}. Read the draft again before choosing a new edit.`,
    );
  }
  return result.value;
}

/** A thread link that the caller has already read and checked. */
export function checkedDraftThread(
  link: DraftThreadLink,
): Promise<DraftThreadLink> {
  return Promise.resolve(link);
}

export async function authorizeEmailDraftThreadAccess(
  env: Env,
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
  access: "read" | "edit",
): Promise<Readonly<{ member: OrganisationMember; sharing: DraftThreadLink }>> {
  await requireSessionExecution(execution, lease);
  const organisationId = execution.scope.organisationId;
  if (assignment.sessionId !== lease.session.sessionId) {
    throw new Error(`Email draft ${access} authority unavailable`);
  }
  const authority = lease.requestAuthority;
  if (
    authority.kind !== "shared_conversation" ||
    (access === "edit" && authority.role === "viewer")
  ) {
    throw new Error(
      `Email draft ${access} requires its connected Slack thread`,
    );
  }
  const members = await listOrganisationMembers({
    db: execution.scope.database,
    organisationId,
  });
  let member: OrganisationMember | null = null;
  for (const candidate of members) {
    if (
      candidate.personId === authority.requesterPersonId &&
      candidate.role === authority.role
    ) {
      member = candidate;
    }
  }
  if (member === null) {
    throw new Error(
      `Email draft ${access} requester is no longer an organisation member`,
    );
  }
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const sharing = await organisation.readEmailDraftThread({
    organisationId,
    caseId: assignment.caseId,
  });
  if (
    sharing === null ||
    sharing.caseId !== assignment.caseId ||
    sharing.integrationAccountId !== authority.integrationAccountId ||
    sharing.conversationId !== authority.conversationId
  ) {
    throw new Error(
      "Connect this Slack thread from the email draft before reading or editing it",
    );
  }
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
    throw new Error("Email draft information-flow authority unavailable");
  }
  await requireSessionExecution(execution, lease);
  return { member, sharing };
}

export function authorizeDescriptionDraftDisclosure(
  env: Env,
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
  member: OrganisationMember,
  prepared: PreparedCommerceRead,
  caseId: string,
  productId: string,
): Promise<void> {
  return authorizeSharedDraftEdit(
    env,
    storage,
    prepared.execution,
    lease,
    member,
    {
      draft: "Description draft",
      caseId,
      capabilityId: CAPABILITY_KEYS.commerceProductDescriptionDraftEdit,
      integrationAccountId: prepared.integrationAccountId,
      resourceScope: prepared.resourceScope,
      readSharedThread: readProductDescriptionDraftThread.bind(
        null,
        env,
        prepared.execution,
        lease,
        productId,
        caseId,
      ),
      notConnected:
        "Connect this Slack thread from the product draft before editing with its context",
    },
  );
}

export async function readProductDescriptionDraftThread(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  productId: string,
  caseId: string,
): Promise<DraftThreadLink | null> {
  const organisationId = execution.scope.organisationId;
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  return organisation.readProductDescriptionDraftThread({
    organisationId,
    productId,
    caseId,
  });
}

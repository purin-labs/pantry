import { resolveCollaborationAgent } from "../../actors/collaboration-agent";
import { sessionTurnExecution } from "../../chat/turn-access";
import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import type { Env } from "../../env";
import { parseCaseId, parseIntegrationAccountId } from "../../ids";
import {
  requireActiveOrganisationActorAtPlacement,
} from "../../actors/actor-router";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
} from "../../actors/session-execution-admission";
import {
  preflightHarnessTurnLease,
} from "../../actors/agent-session-harness-authority";
import type { CatalogExecutionContext } from "../catalog/execute";
import {
  ProductionPlanRequestError,
  type HarnessProductionPlan,
  type HarnessProductionPlanEdit,
  type HarnessProductionPlanRead,
} from "./services";
import { parseCommerceGraphQuery } from "../../commerce/entity-plane/routes";
import type { AccessGrant } from "../../authorization/access-grants/types";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import {
  CommerceReadRequestError,
  readNamedCommerceQuery,
} from "../../context/assembly/commerce";
import { parseProductionRequestFields } from "@purin-labs/commerce-client";
import { selectNamedCommerceQuerySourceGrant } from "../../context/assembly";
import {
  type DraftThreadLink,
  type PreparedCommerceRead,
  type SharedDraftChat,
  admitCommerceReadObservation,
  authorizeSharedDraftEdit,
  collaborationEditDeadline,
  collaborationMember,
  prepareSharedCommerceObservation,
} from "../session-support";
import { prepareCommerceReadForEmbeddedHarness } from "../commerce/handlers";
import type { SessionToolContext } from "../context";

/**
 * Plan 40D: the production requests of a location, read under a read grant
 * for the `production_requests` list. When no grant admits the read, a
 * permission request may ask for that grant.
 */
function requestableProductionRead(error: unknown): never {
  if (
    error instanceof CommerceReadRequestError &&
    error.failure.code === "commerce_context_authority_denied"
  ) {
    throw new CommerceReadRequestError(error.failure, "production_requests");
  }
  throw error;
}

function productionRequestsQuery(locationId: string) {
  return parseCommerceGraphQuery({
    kind: "commerce_list_page",
    listId: "production_requests",
    filter: {
      kind: "attribute",
      filter: {
        operator: "equals",
        attributeId: "location_id",
        value: { kind: "short_text", value: locationId },
      },
    },
    sorts: [],
    pagination: { limit: 100, cursor: null },
  });
}

function selectProductionRequestsSourceGrant(
  lease: HarnessTurnLease,
  locationId: string,
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    grants: readonly AccessGrant[];
    now: string;
  }>,
) {
  const query = productionRequestsQuery(locationId);
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

type ProductionPlanSources = Readonly<{
  prepared: PreparedCommerceRead;
  plan: HarnessProductionPlan;
  merchantRevision: number;
}>;

/**
 * Reads the location's waiting requests from Commerce and the shared
 * plan's draft quantities. The plan is an edit of those requests, so the read
 * carries the requests' label: a person who may read the requests may read
 * the plan.
 */
async function readProductionPlanSources(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
  locationId: string,
  label: string,
): Promise<ProductionPlanSources> {
  const organisationId = execution.scope.organisationId;
  const source = await prepareCommerceReadForEmbeddedHarness(
    env,
    execution,
    lease,
    assignment,
    selectProductionRequestsSourceGrant.bind(null, lease, locationId),
    label,
  ).catch(requestableProductionRead);
  const prepared = await prepareSharedCommerceObservation(source);
  const query = productionRequestsQuery(locationId);
  if (!query.ok) {
    throw new Error(`${label} query invalid`);
  }
  const read = await readNamedCommerceQuery({
    organisationId: String(organisationId),
    merchantId: prepared.merchantId,
    grants: prepared.grants,
    requestAuthority: lease.requestAuthority,
    causationId: String(lease.turn.turnId),
    query: query.value,
    allowedSensitivity: "internal",
    reader: prepared.reader,
    now: prepared.now,
  });
  if (!read.ok) {
    requestableProductionRead(new CommerceReadRequestError(read.error));
  }
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const stored = await organisation.readProductionPlan({
    organisationId,
    locationId,
  });
  if (!stored.ok) {
    throw new Error(`${label} unavailable: ${stored.error.code}`);
  }
  const planned = new Map<string, string>();
  for (const line of stored.value.lines) {
    planned.set(line.requestId, line.quantity);
  }
  // The read returns each entry's item with the entries, under the same grant.
  const itemNames = new Map<string, string>();
  for (const entity of read.value.entities) {
    if (
      entity.reference.origin === "system" &&
      entity.reference.typeId === "inventory_item"
    ) {
      itemNames.set(String(entity.reference.entityId), entity.displayName);
    }
  }
  const requests: HarnessProductionPlan["requests"][number][] = [];
  for (const entry of read.value.listEntries) {
    let fields: ReturnType<typeof parseProductionRequestFields>;
    try {
      fields = parseProductionRequestFields(entry.attributeValues);
    } catch {
      continue;
    }
    if (fields.status !== "requested" || fields.locationId !== locationId) {
      continue;
    }
    const requestId = String(entry.entryId);
    requests.push({
      requestId,
      inventoryItemId: String(entry.entityRef.entityId),
      itemName: itemNames.get(String(entry.entityRef.entityId)) ?? null,
      recipeId: fields.recipeId,
      requestedQuantity: quantityText(fields.quantity),
      unit: fields.quantity.unit,
      neededBy: fields.neededBy,
      plannedQuantity: planned.get(requestId) ?? null,
    });
  }
  return {
    prepared,
    plan: {
      locationId,
      requests,
      truncated: read.value.nextCursor !== null,
    },
    merchantRevision: Number(read.value.merchantRevision),
  };
}

/** The exact decimal text of a quantity, without trailing zeros. */
function quantityText(
  quantity: Readonly<{ amount: number; scale: number }>,
): string {
  const digits = String(quantity.amount).padStart(quantity.scale + 1, "0");
  const whole = digits.slice(0, digits.length - quantity.scale);
  const fraction = digits
    .slice(digits.length - quantity.scale)
    .replace(/0+$/u, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

export async function readProductionPlanForEmbeddedHarness(
  context: SessionToolContext,
  request: HarnessProductionPlanRead,
): Promise<HarnessProductionPlan> {
  const { env, storage, execution, lease, assignment } = context;
  const read = await readProductionPlanSources(
    env,
    execution,
    lease,
    assignment,
    request.locationId,
    "production plan",
  );
  await admitCommerceReadObservation(
    storage,
    lease,
    read.prepared,
    read.plan,
    read.merchantRevision,
    "production plan",
  );
  return read.plan;
}

export async function editProductionPlanForEmbeddedHarness(
  context: SessionToolContext,
  request: HarnessProductionPlanEdit,
  operationId: string,
  boundary: CatalogExecutionContext,
): Promise<HarnessProductionPlan> {
  const { env, storage, execution, lease, assignment } = context;
  const deadlineAt = collaborationEditDeadline(
    storage,
    lease,
    boundary,
    Date.now(),
  );
  const organisationId = execution.scope.organisationId;
  const before = await readProductionPlanSources(
    env,
    execution,
    lease,
    assignment,
    request.locationId,
    "production plan edit",
  );
  await admitCommerceReadObservation(
    storage,
    lease,
    before.prepared,
    before.plan,
    before.merchantRevision,
    "production plan edit",
  );
  const target = before.plan.requests.find(
    (candidate) => candidate.requestId === request.requestId,
  );
  if (target === undefined) {
    throw new ProductionPlanRequestError(
      "That request does not wait for acceptance at this location. Read the plan again before choosing a new edit.",
    );
  }
  if (target.unit === "each" && request.quantity.includes(".")) {
    throw new ProductionPlanRequestError(
      "This request counts whole pieces. Use a whole number.",
    );
  }
  const member = await collaborationMember(
    execution.scope.database,
    organisationId,
    lease,
    "edit",
  );
  const prepared = before.prepared;
  await authorizeSharedDraftEdit(env, storage, execution, lease, member, {
    draft: PLAN_DRAFT,
    caseId: assignment.caseId,
    capabilityId: CAPABILITY_KEYS.commerceProductionPlanEdit,
    integrationAccountId: prepared.integrationAccountId,
    resourceScope: prepared.resourceScope,
    readSharedThread: readProductionPlanThread.bind(
      null,
      env,
      execution,
      lease,
      request.locationId,
    ),
    readSharedChat: readProductionPlanChat.bind(
      null,
      env,
      execution,
      lease,
      request.locationId,
    ),
    notConnected: PLAN_NOT_SHARED,
  }).catch(correctablePlanRefusal);
  const active = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!active.ok) {
    throw new Error(
      `Production plan edit authority expired: ${active.error.code}`,
    );
  }
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const result = await organisation.editProductionPlan({
    agent: await resolveCollaborationAgent(execution.scope, assignment),
    execution: sessionTurnExecution(lease),
    organisationId,
    locationId: request.locationId,
    requestId: request.requestId,
    quantity: request.quantity,
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
      `Production plan edit failed: ${result.error.code}. Read the plan again before choosing a new edit.`,
    );
  }
  const planned = new Map<string, string>();
  for (const line of result.value.lines) {
    planned.set(line.requestId, line.quantity);
  }
  return {
    ...before.plan,
    requests: before.plan.requests.map((line) => ({
      ...line,
      plannedQuantity: planned.get(line.requestId) ?? null,
    })),
  };
}

const PLAN_DRAFT = "Production plan";

const PLAN_NOT_SHARED =
  "This conversation is not shared with this location's plan. An owner or admin shares a Slack thread or a Project chat with the plan before an agent may change it from there.";

/**
 * The refusal that the agent can explain to the person: the conversation is
 * not shared with the plan. It names no source. Other failures stay generic.
 */
function correctablePlanRefusal(error: unknown): never {
  if (error instanceof Error && error.message === PLAN_NOT_SHARED) {
    throw new ProductionPlanRequestError(error.message);
  }
  throw error;
}

async function readProductionPlanShare(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  locationId: string,
) {
  const organisationId = execution.scope.organisationId;
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  });
  await requireSessionExecution(execution, lease);
  const share = await organisation.readProductionPlanShare({
    organisationId,
    locationId,
  });
  return share.ok ? share.value : null;
}

async function readProductionPlanThread(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  locationId: string,
): Promise<DraftThreadLink | null> {
  const share = await readProductionPlanShare(
    env,
    execution,
    lease,
    locationId,
  );
  if (share === null || share.kind !== "slack_thread") {
    return null;
  }
  const caseId = parseCaseId(share.caseId);
  const account = parseIntegrationAccountId(share.integrationAccountId);
  return caseId.ok && account.ok
    ? {
        caseId: caseId.value,
        integrationAccountId: account.value,
        conversationId: share.conversationId,
      }
    : null;
}

async function readProductionPlanChat(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  locationId: string,
): Promise<SharedDraftChat | null> {
  const share = await readProductionPlanShare(
    env,
    execution,
    lease,
    locationId,
  );
  return share !== null && share.kind === "portal_chat"
    ? {
        caseId: share.caseId,
        conversationId: share.conversationId,
        projectId: share.projectId,
        approverPersonId: share.approverPersonId,
      }
    : null;
}

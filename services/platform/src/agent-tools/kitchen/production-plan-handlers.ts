import { resolveCollaborationAgent } from "../../actors/collaboration-agent";
import { sessionTurnExecution } from "../../chat/turn-access";
import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import type { Env } from "../../env";
import { parseCaseId, parseIntegrationAccountId } from "../../ids";
import { requireActiveOrganisationActorAtPlacement } from "../../actors/actor-router";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
} from "../../actors/session-execution-admission";
import { preflightHarnessTurnLease } from "../../actors/agent-session-harness-authority";
import type { CatalogExecutionContext } from "../catalog/execute";
import {
  ProductionPlanRequestError,
  type HarnessProductionPlan,
  type HarnessProductionPlanEdit,
  type HarnessProductionPlanRead,
} from "./services";
import type { AccessGrant } from "../../authorization/access-grants/types";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import { CommerceReadRequestError } from "../../commerce/contract/read-errors";
import { parseProductionRequestFields } from "@purin-labs/commerce-client";
import {
  type DraftThreadLink,
  type SharedDraftChat,
  collaborationEditDeadline,
  collaborationMember,
  type ToolEffect,
} from "../session-support";
import type {
  CommerceToolReads,
  PreparedCommerceRead,
} from "../../commerce/contract/tool-reads";
import type { KitchenToolContext } from "./services";

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

function productionRequestsQuery(
  commerce: CommerceToolReads,
  locationId: string,
) {
  return commerce.parseCommerceGraphQuery({
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
  commerce: CommerceToolReads,
  lease: HarnessTurnLease,
  locationId: string,
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    grants: readonly AccessGrant[];
    now: string;
  }>,
) {
  return commerce.selectInternalQuerySourceGrant(
    lease,
    productionRequestsQuery(commerce, locationId),
    input,
  );
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
  commerce: CommerceToolReads,
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
  locationId: string,
  label: string,
): Promise<ProductionPlanSources> {
  const organisationId = execution.scope.organisationId;
  const source = await commerce
    .prepareCommerceRead(
      env,
      execution,
      lease,
      assignment,
      selectProductionRequestsSourceGrant.bind(
        null,
        commerce,
        lease,
        locationId,
      ),
      label,
    )
    .catch(requestableProductionRead);
  const prepared = await commerce.prepareSharedCommerceObservation(source);
  const query = productionRequestsQuery(commerce, locationId);
  if (!query.ok) {
    throw new Error(`${label} query invalid`);
  }
  const read = await commerce.readNamedCommerceQuery({
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
  context: KitchenToolContext,
  request: HarnessProductionPlanRead,
): Promise<HarnessProductionPlan> {
  const { env, storage, execution, lease, assignment } = context;
  const read = await readProductionPlanSources(
    context.commerce,
    env,
    execution,
    lease,
    assignment,
    request.locationId,
    "production plan",
  );
  await context.commerce.admitCommerceReadObservation(
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
  context: KitchenToolContext,
  request: HarnessProductionPlanEdit,
  operationId: string,
  boundary: CatalogExecutionContext,
): Promise<ToolEffect<HarnessProductionPlan>> {
  const { env, storage, execution, lease, assignment } = context;
  const deadlineAt = collaborationEditDeadline(
    storage,
    lease,
    boundary,
    Date.now(),
  );
  const organisationId = execution.scope.organisationId;
  const before = await readProductionPlanSources(
    context.commerce,
    env,
    execution,
    lease,
    assignment,
    request.locationId,
    "production plan edit",
  );
  await context.commerce.admitCommerceReadObservation(
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
  return {
    kind: "shared_draft",
    member,
    unavailable: `${PLAN_DRAFT} information-flow authority unavailable`,
    draft: {
      shared: "lookup",
      edit: {
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
      },
      // The agent can explain this refusal to the person. It names no source.
      notShared: (message) => new ProductionPlanRequestError(message),
    },
    run: async () => {
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
    },
  };
}

const PLAN_DRAFT = "Production plan";

const PLAN_NOT_SHARED =
  "This conversation is not shared with this location's plan. An owner or admin shares a Slack thread or a Project chat with the plan before an agent may change it from there.";

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

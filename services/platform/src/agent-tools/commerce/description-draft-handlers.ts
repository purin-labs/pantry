import { resolveCollaborationAgent } from "../../actors/collaboration-agent";
import { sessionTurnExecution } from "../../chat/turn-access";
import type {
  DraftAgentEditRequest,
  DraftAgentReadArgs,
  DraftAgentSnapshot,
} from "../../actors/product-description-draft";
import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import type { Env } from "@purin-labs/kernel/env";
import { requireActiveOrganisationActorAtPlacement } from "@purin-labs/actor-runtime/actors/actor-router";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
} from "../../actors/session-execution-admission";
import { preflightHarnessTurnLease } from "../../actors/agent-session-harness-authority";
import type { CatalogExecutionContext } from "../catalog/execute";
import { DescriptionDraftRequestError } from "./services";
import { parseCommerceGraphQuery } from "../../commerce/entity-plane/routes";
import type { AccessGrant } from "@purin-labs/authority/authorization/access-grants/types";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { CommerceReadRequestError } from "../../commerce/contract/read-errors";
import {
  type DraftThreadLink,
  collaborationEditDeadline,
  collaborationMember,
  type ToolEffect,
} from "../session-support";
import { prepareCommerceReadForEmbeddedHarness } from "./handlers";
import type { SessionToolContext } from "../context";
import {
  admitCommerceReadObservation,
  prepareSharedCommerceObservation,
  selectInternalQuerySourceGrant,
} from "./read-support";

/**
 * A draft tool reads its product under a product read grant. When no grant
 * admits the read, a permission request may ask for that grant.
 */
function requestableProductRead(error: unknown): never {
  if (
    error instanceof CommerceReadRequestError &&
    error.failure.code === "commerce_context_authority_denied"
  ) {
    throw new CommerceReadRequestError(error.failure, "product");
  }
  throw error;
}

function selectDescriptionDraftSourceGrant(
  lease: HarnessTurnLease,
  productId: string,
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    grants: readonly AccessGrant[];
    now: string;
  }>,
) {
  return selectInternalQuerySourceGrant(
    lease,
    parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: { origin: "system", typeId: "product", entityId: productId },
      traversal: { maxDepth: 0, resultLimit: 1 },
      filter: null,
    }),
    input,
  );
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
async function connectedDraftProduct(
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
function draftReadFailure(productId: string, code: string): Error {
  return code === "product_not_found"
    ? new DescriptionDraftRequestError(
        `No product has the id ${productId}. Use the shop's plain product id, without an "commerce:" prefix, or pass productId null to read the draft connected to this Slack thread.`,
      )
    : new Error(`Description draft unavailable: ${code}`);
}

export async function editProductDescriptionDraftForEmbeddedHarness(
  context: SessionToolContext,
  request: DraftAgentEditRequest,
  operationId: string,
  boundary: CatalogExecutionContext,
): Promise<ToolEffect<DraftAgentSnapshot>> {
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
  const caseId = assignment.caseId;
  const productId = request.productId;
  return {
    kind: "shared_draft",
    member,
    unavailable: "Description draft information-flow authority unavailable",
    draft: {
      shared: "lookup",
      edit: {
        draft: "Description draft",
        caseId,
        capabilityId: CAPABILITY_KEYS.commerceProductDescriptionDraftEdit,
        integrationAccountId: prepared.integrationAccountId,
        resourceScope: prepared.resourceScope,
        readSharedThread: readProductDescriptionDraftThread.bind(
          null,
          env,
          execution,
          lease,
          productId,
          caseId,
        ),
        notConnected:
          "Connect this Slack thread from the product draft before editing with its context",
      },
    },
    run: async () => {
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
    },
  };
}

async function readProductDescriptionDraftThread(
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

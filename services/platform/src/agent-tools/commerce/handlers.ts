import { pantryCommerceAccess } from "../../commerce/app-access";
import { isSystemCommerceEntity } from "@purin-labs/commerce-contracts";
import type {
  PaymentsReadRequest,
} from "./services";
import type {
  StaffPageToolReceipt,
} from "../catalog/types";
import { CommerceEntityPlaneClient } from "@purin-labs/commerce-client";
import type { CaseAssignment, HarnessTurnLease } from "@purin-labs/contracts";
import type { Env } from "../../env";
import type { Result } from "../../result";
import { requireActiveOrganisationActorAtPlacement } from "../../actors/actor-router";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
  admittedSessionOperation,
} from "../../actors/session-execution-admission";
import { commerceGraphResponseBody } from "../../commerce/entity-plane/routes";
import { merchantReportDefinition } from "../../commerce/entity-plane/merchant-reports";
import type { CommerceObservationEntity } from "../../actors/agent-session-information-flow";
import { runMerchantReport } from "../../commerce/entity-plane/merchant-report-runner";
import { resolveOrganisationCommerceSystemAuthority } from "../../data/organisation-commerce-system";
import { resolveCurrentOrganisationCommerceMerchantBinding } from "../../data/commerce-merchant-binding";
import { createCommerceClient } from "../../commerce/outbox-worker";
import {
  advanceOrderQueueEntry,
  presentOrderQueueEntry,
  readCafeSoldOutMenu,
  setSoldOutMark,
  type CounterSaleReadRequest,
  type CounterSaleToolRead,
  type OrderQueueAdvanceRequest,
  type OrderQueueAdvanceResult,
  type OrderQueueToolRead,
  type SoldOutMarkRequest,
  type SoldOutMarkResult,
  type SoldOutToolRead,
} from "../../commerce/order-queue-commands";
import {
  presentPayments,
  type PaymentsToolRead,
} from "../../commerce/payments-read";
import { readCounterSaleView } from "../../commerce/counter-register";
import {
  PRODUCT_SALES_SOURCE_TYPES,
  readBoundProductSales,
} from "../../commerce/entity-plane/product-sales-report";
import {
  STOCK_SHORTAGE_SOURCE_TYPE,
  readBoundStockShortages,
} from "../../commerce/entity-plane/stock-shortage-report";
import {
  isRequestableEntityTypeRead,
  readNeedsPrivateChat,
  type RequestableEntityTypeRead,
} from "../../authorization/requestable-capabilities";
import { commerceCanonicalResourceId } from "../../commerce/provider";
import {
  createCurrentSourceFlowLabel,
  decideContextAdmission,
  integrationResourceScopeForGrant,
} from "../../policy";
import { listAccessGrants } from "../../data/access-grants";
import type { AccessGrant } from "../../authorization/access-grants/types";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import { CommerceEngineSource } from "../../commerce/entity-plane/commerce-source";
import {
  BlotterSource,
  type BlotterOrganisationReader,
} from "../../commerce/entity-plane/blotter-source";
import { CommerceGraphReader } from "../../commerce/entity-plane/graph-reader";
import {
  CommerceReadRequestError,
  type CommerceContextAssemblyError,
} from "../../context/assembly/commerce";
import {
  assembleCommerceContext,
  selectCommerceContextSourceGrant,
} from "../../context/assembly";
import { assertNever } from "@purin-labs/std";
import {
  type PreparedCommerceRead,
  admitCommerceReadObservation,
  prepareStaffPageWork,
  requestableReportRead,
  selectMerchantReportSourceGrant,
  type ToolEffect,
} from "../session-support";
import type { SessionToolContext } from "../context";

export async function prepareCommerceReadForEmbeddedHarness(
  env: Env,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
  selectGrant: (
    input: Readonly<{
      organisationId: string;
      merchantId: string;
      grants: readonly import("../../authorization/access-grants/types").AccessGrant[];
      now: string;
    }>,
  ) => Result<
    import("../../authorization/access-grants/types").AccessGrant,
    CommerceContextAssemblyError
  >,
  label: string,
): Promise<PreparedCommerceRead> {
  const organisationId = execution.scope.organisationId;
  await requireSessionExecution(execution, lease);
  if (
    assignment.sessionId !== lease.session.sessionId ||
    assignment.caseId.length === 0
  ) {
    throw new Error(`${label} information-flow identity unavailable`);
  }
  const [commerceAuthority, binding, grants] = await Promise.all([
    resolveOrganisationCommerceSystemAuthority({
      db: execution.scope.database,
      organisationId,
    }),
    resolveCurrentOrganisationCommerceMerchantBinding({
      db: execution.scope.database,
      organisationId,
    }),
    listAccessGrants({
      db: execution.scope.database,
      organisationId,
      lifecycle: "active",
    }),
  ]);
  if (!commerceAuthority.ok) {
    throw new Error(`${label} provider authority unavailable`);
  }
  if (!binding.ok) {
    throw new Error(`${label} Underclerk binding unavailable`);
  }
  if (!grants.ok) {
    throw new Error(`${label} source policy unavailable`);
  }
  const now = new Date().toISOString();
  const merchantId = String(binding.value.merchantId);
  const sourceGrant = selectGrant({
    organisationId: String(organisationId),
    merchantId,
    grants: grants.value,
    now,
  });
  if (!sourceGrant.ok) {
    throw new CommerceReadRequestError(sourceGrant.error);
  }
  const resourceScope = integrationResourceScopeForGrant(sourceGrant.value);
  if (resourceScope === null) {
    throw new Error(`${label} source scope unavailable`);
  }
  const flowLabel = await createCurrentSourceFlowLabel({
    kind: "integration_resource",
    db: execution.scope.database,
    organisationId,
    integrationAccountId: String(commerceAuthority.value.integrationAccountId),
    resourceScope,
    capabilityId: sourceGrant.value.target.capabilityId,
    grantIds: [sourceGrant.value.grantId],
  });
  if (!flowLabel.ok) {
    throw new Error(`${label} flow label invalid: ${flowLabel.error.code}`);
  }
  const admission = await decideContextAdmission({
    subject: {
      kind: "authority_derived",
      requestAuthority: lease.requestAuthority,
      caseId: String(assignment.caseId),
    },
    inputLabel: flowLabel.value,
  });
  if (admission.kind !== "admit") {
    throw new Error(`${label} information-flow admission denied`);
  }
  if (
    env.UNDERCLERK_BASE_URL === undefined ||
    env.UNDERCLERK_SERVICE_TOKEN === undefined
  ) {
    throw new Error(`${label} Underclerk unavailable`);
  }
  let client: CommerceEntityPlaneClient;
  try {
    client = new CommerceEntityPlaneClient({
      baseUrl: env.UNDERCLERK_BASE_URL,
      ...pantryCommerceAccess(
        env.UNDERCLERK_SERVICE_TOKEN,
        String(organisationId),
        admittedSessionOperation(
          execution,
          lease,
          env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
        ),
      ),
    });
  } catch {
    throw new Error(`${label} Underclerk unavailable`);
  }
  const commerceEngine = new CommerceEngineSource({
    organisationId: String(organisationId),
    merchantId,
    integrationAccountId: String(binding.value.integrationAccountId),
    client,
  });
  const reader =
    commerceAuthority.value.commerceSystem.kind === "shopify"
      ? new CommerceGraphReader({
          organisationId: String(organisationId),
          merchantId,
          commerceSystem: commerceAuthority.value.commerceSystem,
          underclerk: commerceEngine,
          blotter: new BlotterSource({
            organisation: admittedBlotterReader(
              execution,
              lease,
              await requireActiveOrganisationActorAtPlacement({
                env,
                organisationId,
                placement: execution.scope.placement,
                now: Date.now(),
              }),
            ),
            organisationId,
            merchantId,
            integrationAccountId: commerceAuthority.value.integrationAccountId,
          }),
        })
      : new CommerceGraphReader({
          organisationId: String(organisationId),
          merchantId,
          commerceSystem: commerceAuthority.value.commerceSystem,
          underclerk: commerceEngine,
        });
  await requireSessionExecution(execution, lease);
  return {
    execution,
    merchantId,
    integrationAccountId: String(commerceAuthority.value.integrationAccountId),
    resourceScope,
    grants: grants.value,
    label: flowLabel.value,
    reader,
    now,
  };
}

/** The commerce records one graph read returned, at the revisions it saw. */
function observedCommerceEntities(
  result: import("@purin-labs/commerce-contracts").CommerceGraphQueryResult,
  merchantId: string,
): readonly CommerceObservationEntity[] {
  const observed: CommerceObservationEntity[] = [];
  for (const entity of result.entities) {
    // Commerce graph references use provider IDs; actions use canonical IDs.
    const entityId =
      isSystemCommerceEntity(entity) &&
      entity.provenance.source === "underclerk"
        ? commerceCanonicalResourceId(merchantId, entity.reference.entityId)
        : entity.reference.entityId;
    observed.push({
      entityType: entity.reference.typeId,
      entityId,
      revision: Number(entity.revision),
    });
  }
  // A proposal names a list entry that the session read, as for an entity.
  for (const entry of result.listEntries) {
    observed.push({
      entityType: `list_entry:${String(entry.listId)}`,
      entityId: String(entry.entryId),
      revision: Number(entry.revision),
    });
  }
  return observed;
}

export async function readEntityContextForEmbeddedHarness(
  context: SessionToolContext,
  request: import("@purin-labs/commerce-contracts").CommerceContextRequest,
): Promise<import("@purin-labs/commerce-contracts").CommerceGraphQueryResult> {
  const { env, storage, execution, lease, assignment } = context;
  const prepared = await prepareCommerceReadForEmbeddedHarness(
    env,
    execution,
    lease,
    assignment,
    selectEntityContextSourceGrant.bind(null, lease, request),
    "commerce entity context",
  ).catch(requestableRecordRead.bind(null, request));
  const read = await assembleCommerceContext({
    organisationId: String(execution.scope.organisationId),
    merchantId: prepared.merchantId,
    grants: prepared.grants,
    requestAuthority: lease.requestAuthority,
    causationId: String(lease.turn.turnId),
    request,
    reader: prepared.reader,
    now: prepared.now,
  });
  if (!read.ok) {
    requestableRecordRead(request, new CommerceReadRequestError(read.error));
  }
  const result = commerceGraphResponseBody(read.value).result;
  await admitCommerceReadObservation(
    storage,
    lease,
    prepared,
    result,
    Number(read.value.merchantRevision),
    "commerce entity context",
    observedCommerceEntities(read.value, prepared.merchantId),
  );
  return read.value;
}

function selectEntityContextSourceGrant(
  lease: HarnessTurnLease,
  request: import("@purin-labs/commerce-contracts").CommerceContextRequest,
  input: Readonly<{
    organisationId: string;
    merchantId: string;
    grants: readonly AccessGrant[];
    now: string;
  }>,
) {
  return selectCommerceContextSourceGrant({
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    grants: input.grants,
    now: input.now,
    requestAuthority: lease.requestAuthority,
    causationId: String(lease.turn.turnId),
    request,
  });
}

/**
 * A stock proposal starts from a read of the shelf or the list, and order work
 * from a read of the record. When no grant admits that read, a permission
 * request may ask for that grant.
 */
function requestableRecordRead(
  request: import("@purin-labs/commerce-contracts").CommerceContextRequest,
  error: unknown,
): never {
  const read = recordReadOfRequest(request);
  if (
    read !== null &&
    error instanceof CommerceReadRequestError &&
    error.failure.code === "commerce_context_authority_denied"
  ) {
    throw new CommerceReadRequestError(error.failure, read);
  }
  throw error;
}

function recordReadOfRequest(
  request: import("@purin-labs/commerce-contracts").CommerceContextRequest,
): RequestableEntityTypeRead | null {
  if (request.selection.kind === "entity_seeds") {
    const typeId = request.selection.seeds[0]?.typeId;
    return request.selection.seeds.every(
      (seed) => seed.origin === "system" && seed.typeId === typeId,
    )
      ? recordReadOfType(typeId)
      : null;
  }
  const query = request.selection.selector.query;
  if (query.kind === "entity_type_page") {
    return query.entityTypeId.origin === "system"
      ? recordReadOfType(query.entityTypeId.typeId)
      : null;
  }
  if (query.kind !== "commerce_list_page") {
    return null;
  }
  const listId = String(query.listId);
  return listId === "production_requests" || listId === "replenishment_queue"
    ? listId
    : null;
}

/** The read that a page or seeds of this one record type may ask for. */
function recordReadOfType(typeId: unknown): RequestableEntityTypeRead | null {
  return typeId === "inventory_position" ||
    (isRequestableEntityTypeRead(typeId) && readNeedsPrivateChat(typeId))
    ? typeId
    : null;
}

export async function readOrderQueueForEmbeddedHarness(
  context: SessionToolContext,
): Promise<OrderQueueToolRead> {
  const { env, storage, execution, lease, assignment } = context;
  const work = await prepareStaffPageWork(
    env,
    execution,
    lease,
    assignment,
    "order",
    "order queue",
  );
  await requireSessionExecution(execution, lease);
  const queue = await work.context.client.readPickupQueue(
    work.context.merchantId,
  );
  await requireSessionExecution(execution, lease);
  if (!queue.ok) {
    throw new Error("order queue unavailable");
  }
  const value = { entries: queue.value.entries.map(presentOrderQueueEntry) };
  await admitCommerceReadObservation(
    storage,
    lease,
    work.prepared,
    value,
    Number(queue.value.merchantRevision),
    "order queue",
  );
  return value;
}

export async function readCounterSaleForEmbeddedHarness(
  context: SessionToolContext,
  request: CounterSaleReadRequest,
): Promise<CounterSaleToolRead> {
  const { env, storage, execution, lease, assignment } = context;
  const work = await prepareStaffPageWork(
    env,
    execution,
    lease,
    assignment,
    "order",
    "counter sale",
  );
  await requireSessionExecution(execution, lease);
  const loaded = await readCounterSaleView(
    {
      env,
      scope: execution.scope,
      organisationId: execution.scope.organisationId,
      merchantId: work.context.merchantId,
      client: work.context.client,
    },
    request.checkoutId,
  );
  await requireSessionExecution(execution, lease);
  if (!loaded.ok) {
    throw new Error("counter sale unavailable");
  }
  const view = loaded.value;
  const value: CounterSaleToolRead = {
    checkoutId: view.checkoutId,
    satyrLocationId: view.satyrLocationId,
    state: view.state,
    collectable: view.collectable,
    orderId: view.orderId,
    pickupCode: view.pickupCode ?? null,
    paymentMethod: view.paymentMethod ?? null,
    tenderBrand: view.tenderBrand ?? null,
    providerRefundable: view.providerRefundable ?? null,
    amountMinor: view.quote?.amount.amountMinor ?? null,
    currency: view.quote?.amount.currency ?? null,
    cashReceivedMinor: view.manualTender?.cashReceivedMinor ?? null,
    changeDueMinor: view.manualTender?.changeDueMinor ?? null,
    afterSale:
      view.afterSale === null
        ? null
        : {
            orderState: view.afterSale.order.state,
            paymentState: view.afterSale.payment.state,
            fulfillmentState: view.afterSale.fulfillment.state,
            refundState: view.afterSale.refundState,
          },
  };
  await admitCommerceReadObservation(
    storage,
    lease,
    work.prepared,
    value,
    view.revision,
    "counter sale",
  );
  return value;
}

export async function readPaymentsForEmbeddedHarness(
  context: SessionToolContext,
  request: PaymentsReadRequest,
): Promise<PaymentsToolRead> {
  const { env, storage, execution, lease, assignment } = context;
  const work = await prepareStaffPageWork(
    env,
    execution,
    lease,
    assignment,
    "order",
    "payments",
  );
  await requireSessionExecution(execution, lease);
  const payments = await work.context.client.readPayments(
    work.context.merchantId,
    request,
  );
  await requireSessionExecution(execution, lease);
  if (!payments.ok) {
    throw new Error("payments unavailable");
  }
  const value = presentPayments(payments.value);
  await admitCommerceReadObservation(
    storage,
    lease,
    work.prepared,
    value,
    Number(payments.value.merchantRevision),
    "payments",
  );
  return value;
}

export async function readSoldOutForEmbeddedHarness(
  context: SessionToolContext,
): Promise<SoldOutToolRead> {
  const { env, storage, execution, lease, assignment } = context;
  const work = await prepareStaffPageWork(
    env,
    execution,
    lease,
    assignment,
    "product",
    "sold out",
  );
  await requireSessionExecution(execution, lease);
  const menu = await readCafeSoldOutMenu(work.context);
  await requireSessionExecution(execution, lease);
  if (menu === null) {
    throw new Error("sold out items unavailable");
  }
  const value = { items: menu.items };
  await admitCommerceReadObservation(
    storage,
    lease,
    work.prepared,
    value,
    menu.merchantRevision,
    "sold out",
  );
  return value;
}

export async function advanceOrderQueueForEmbeddedHarness(
  context: SessionToolContext,
  request: OrderQueueAdvanceRequest,
  operationId: string,
): Promise<ToolEffect<StaffPageToolReceipt>> {
  const { env, execution, lease, assignment } = context;
  const work = await prepareStaffPageWork(
    env,
    execution,
    lease,
    assignment,
    "order",
    "order queue",
  );
  const sink = {
    kind: "tool_effect" as const,
    destinationAuthority: lease.requestAuthority,
    capabilityId: CAPABILITY_KEYS.commerceOrderQueueAdvance,
    integrationAccountId: "platform",
    resourceScope: "order-queue:cafe",
    approvalSatisfied: false,
  };
  return {
    kind: "staff_page",
    work,
    unavailable: "order queue information-flow authority unavailable",
    effect: {
      sink,
      route: `/v1/control/organisations/${execution.scope.organisationId}/commerce/order-queue/${request.fulfillmentId}/advance`,
      operation: `order_queue.${request.action}`,
      body: { action: request.action },
      operationId,
      result: `The order moved: ${request.action}. Call order_queue_read to see the queue now.`,
      run: async (key) =>
        orderQueueAdvanceRefusal(
          await advanceOrderQueueEntry(
            work.context,
            request.fulfillmentId,
            request.action,
            key,
          ),
        ),
      settled: signalShopScreens.bind(null, env, execution),
    },
  };
}

export async function markSoldOutForEmbeddedHarness(
  context: SessionToolContext,
  request: SoldOutMarkRequest,
  operationId: string,
): Promise<ToolEffect<StaffPageToolReceipt>> {
  const { env, execution, lease, assignment } = context;
  const work = await prepareStaffPageWork(
    env,
    execution,
    lease,
    assignment,
    "product",
    "sold out",
  );
  const sink = {
    kind: "tool_effect" as const,
    destinationAuthority: lease.requestAuthority,
    capabilityId: CAPABILITY_KEYS.commerceSoldOutMark,
    integrationAccountId: "platform",
    resourceScope: "sold-out:cafe",
    approvalSatisfied: false,
  };
  const soldOut = request.mark.kind === "today";
  return {
    kind: "staff_page",
    work,
    unavailable: "sold out information-flow authority unavailable",
    effect: {
      sink,
      route: `/v1/control/organisations/${execution.scope.organisationId}/commerce/sold-out/${request.variantId}`,
      operation: soldOut ? "sold_out.mark" : "sold_out.clear",
      body: { soldOut, mark: request.mark },
      operationId,
      result: soldOut
        ? "The item is sold out until the shop's next midnight. Screens show it, and checkout refuses it."
        : "The sold out mark is gone. The item is on sale again.",
      run: async (key) =>
        soldOutMarkRefusal(
          await setSoldOutMark(
            work.context,
            request.variantId,
            request.mark,
            key,
          ),
        ),
      settled: signalShopScreens.bind(null, env, execution),
    },
  };
}

/** The pickup board and the menu screens show the step now. */
async function signalShopScreens(
  env: Env,
  execution: SessionExecutionAdmission,
): Promise<void> {
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId: execution.scope.organisationId,
    placement: execution.scope.placement,
    now: Date.now(),
  }).catch(() => null);
  await organisation
    ?.signalMenuScreens({ organisationId: execution.scope.organisationId })
    .catch(() => null);
}

/** What the agent reads about a move that did not happen, or null if it did. */
function orderQueueAdvanceRefusal(
  moved: OrderQueueAdvanceResult,
): string | null {
  if (moved.ok) {
    return null;
  }
  switch (moved.code) {
    case "underclerk_unavailable":
      throw new Error("order queue unavailable");
    case "order_queue_changed":
      return "That order is not at that step now, or it left the queue. An order must be ready before it is handed over. Nothing changed. Call order_queue_read, and tell the person what you see.";
    case "order_queue_payment_missing":
      return "That order has no payment, so it cannot be handed over. Nothing changed. Tell the person.";
    case "order_queue_busy":
      return "The shop is too busy to finish this move now. Call order_queue_read before you try again.";
    case "order_queue_refused":
      return moved.field === "pickupCompletion.lotAvailability"
        ? "The shop refused the hand-over because this order's stock has expired. Nothing changed. Tell the person to receive fresh stock or to cancel the order in Orders. Do not retry."
        : `The shop refused this step (${moved.step}: ${moved.detail}). Tell the person. Do not retry.`;
    default:
      return assertNever(moved);
  }
}

function soldOutMarkRefusal(marked: SoldOutMarkResult): string | null {
  if (marked.ok) {
    return null;
  }
  switch (marked.code) {
    case "underclerk_unavailable":
      throw new Error("sold out marks unavailable");
    case "sold_out_item_not_on_menu":
      return "That item is not on the published café menu. Nothing changed. Call sold_out_read for the items on the menu.";
    case "sold_out_refused":
      return "The shop refused this mark. Check the time zone, and tell the person. Nothing changed.";
    case "sold_out_busy":
      return "The shop is too busy to take this mark now. Try again in a moment.";
    default:
      return assertNever(marked.code);
  }
}

/**
 * Runs one named merchant report for the harness.
 *
 * The report names a fixed metric, source, and filter. The agent selects which
 * report to run and never supplies a query, so the returned number always
 * traces to a declared definition. The read is admitted as observation
 * evidence like any other commerce read.
 */
export async function readMerchantReportForEmbeddedHarness(
  context: SessionToolContext,
  request: import("./services").HarnessMerchantReportRequest,
): Promise<
  import("../../commerce/entity-plane/merchant-reports").MerchantReportResult
> {
  const { env, storage, execution, lease, assignment } = context;
  const organisationId = execution.scope.organisationId;
  if (request.name === "product_sales") {
    return readProductSalesForEmbeddedHarness(
      env,
      storage,
      execution,
      lease,
      assignment,
    );
  }
  if (request.name === "low_stock_exposure") {
    return readStockShortagesForEmbeddedHarness(
      env,
      storage,
      execution,
      lease,
      assignment,
    );
  }
  const definition = merchantReportDefinition(request.name);
  const prepared = await prepareCommerceReadForEmbeddedHarness(
    env,
    execution,
    lease,
    assignment,
    selectMerchantReportSourceGrant.bind(
      null,
      lease,
      definition.entityType,
      "internal",
    ),
    "merchant report",
  ).catch(requestableReportRead.bind(null, definition.entityType));
  const report = await runMerchantReport({
    organisationId: String(organisationId),
    merchantId: prepared.merchantId,
    grants: prepared.grants,
    requestAuthority: lease.requestAuthority,
    causationId: String(lease.turn.turnId),
    reader: prepared.reader,
    allowedSensitivity: "internal",
    name: request.name,
    now: prepared.now,
  });
  if (!report.ok) {
    requestableReportRead(
      definition.entityType,
      new CommerceReadRequestError(report.error),
    );
  }
  if (report.value.kind === "reported") {
    const entities: CommerceObservationEntity[] = [];
    for (const record of report.value.population) {
      entities.push({
        entityType: record.entityType,
        entityId: record.entityId,
        revision: record.revision,
      });
    }
    await admitCommerceReadObservation(
      storage,
      lease,
      prepared,
      report.value,
      Number(report.value.merchantRevision),
      "merchant report",
      entities,
    );
  }
  return report.value;
}

/**
 * The narrowest context request that proves a grant covers this report's
 * entity type. Grant selection is expressed in context-request terms, so the
 * report asks the same question the context tool would.
 */
async function readProductSalesForEmbeddedHarness(
  env: Env,
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
): Promise<
  import("../../commerce/entity-plane/merchant-reports").MerchantReportResult
> {
  const organisationId = execution.scope.organisationId;
  await requireSessionExecution(execution, lease);
  const unavailable = {
    kind: "unavailable" as const,
    name: "product_sales" as const,
    metric: "Seven-day booked merchandise before refunds by product.",
    reason:
      "This report requires a Seams Checkout merchant and restricted reads of orders, variants, and products in an authorized operator conversation.",
    dependency: "authorized_product_sales_read",
  };
  const authority = await resolveOrganisationCommerceSystemAuthority({
    db: execution.scope.database,
    organisationId,
  });
  if (
    !authority.ok ||
    authority.value.commerceSystem.kind !== "satyr_commerce"
  ) {
    return unavailable;
  }
  const sources: PreparedCommerceRead[] = [];
  for (const typeId of PRODUCT_SALES_SOURCE_TYPES) {
    sources.push(
      await prepareCommerceReadForEmbeddedHarness(
        env,
        execution,
        lease,
        assignment,
        selectMerchantReportSourceGrant.bind(null, lease, typeId, "restricted"),
        "product sales",
      ),
    );
  }
  const source = sources[0];
  if (source === undefined) {
    throw new Error("product sales sources missing");
  }
  for (const prepared of sources) {
    if (
      prepared.merchantId !== source.merchantId ||
      prepared.integrationAccountId !== source.integrationAccountId ||
      prepared.integrationAccountId !==
        String(authority.value.integrationAccountId)
    ) {
      throw new Error("product sales binding changed during authorization");
    }
  }
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
    },
  );
  if (client === null) {
    return unavailable;
  }
  const value = await readBoundProductSales({
    client,
    organisationId: String(organisationId),
    merchantId: source.merchantId,
    now: source.now,
  });
  // Record all source labels before returning any report data. Report IDs do
  // not become writable targets; a proposal still needs its exact record read.
  for (const prepared of sources) {
    await admitCommerceReadObservation(
      storage,
      lease,
      prepared,
      value,
      value.report.merchantRevision,
      "product sales",
    );
  }
  return value;
}

/**
 * Stock shortages read the same Commerce stock snapshot as the stock pages,
 * after the read grant for stock positions passes, so the agent and the pages
 * count the same rows.
 */
async function readStockShortagesForEmbeddedHarness(
  env: Env,
  storage: DurableObjectStorage,
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
): Promise<
  import("../../commerce/entity-plane/merchant-reports").MerchantReportResult
> {
  const organisationId = execution.scope.organisationId;
  await requireSessionExecution(execution, lease);
  const unavailable = {
    kind: "unavailable" as const,
    name: "low_stock_exposure" as const,
    metric: merchantReportDefinition("low_stock_exposure").metric,
    reason:
      "Stock shortages need a Seams Checkout shop and a read of its stock positions.",
    dependency: "authorized_stock_snapshot_read",
  };
  const authority = await resolveOrganisationCommerceSystemAuthority({
    db: execution.scope.database,
    organisationId,
  });
  if (
    !authority.ok ||
    authority.value.commerceSystem.kind !== "satyr_commerce"
  ) {
    return unavailable;
  }
  const prepared = await prepareCommerceReadForEmbeddedHarness(
    env,
    execution,
    lease,
    assignment,
    selectMerchantReportSourceGrant.bind(
      null,
      lease,
      STOCK_SHORTAGE_SOURCE_TYPE,
      "internal",
    ),
    "stock shortages",
  ).catch(requestableReportRead.bind(null, STOCK_SHORTAGE_SOURCE_TYPE));
  if (
    prepared.integrationAccountId !==
    String(authority.value.integrationAccountId)
  ) {
    throw new Error("stock shortage binding changed during authorization");
  }
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
    },
  );
  if (client === null) {
    return unavailable;
  }
  const value = await readBoundStockShortages({
    client,
    merchantId: prepared.merchantId,
    now: prepared.now,
  });
  // Report rows do not become writable targets; a proposal still needs its
  // exact record read.
  await admitCommerceReadObservation(
    storage,
    lease,
    prepared,
    value,
    Number(value.merchantRevision),
    "stock shortages",
  );
  return value;
}

function admittedBlotterReader(
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  organisation: BlotterOrganisationReader,
): BlotterOrganisationReader {
  return {
    readCommerceQueryPlan: admittedSessionOperation(
      execution,
      lease,
      organisation.readCommerceQueryPlan.bind(organisation),
    ),
    readAcceptedCommerceProjectionSequence: admittedSessionOperation(
      execution,
      lease,
      organisation.readAcceptedCommerceProjectionSequence.bind(organisation),
    ),
    readCommerceRelationshipStep: admittedSessionOperation(
      execution,
      lease,
      organisation.readCommerceRelationshipStep.bind(organisation),
    ),
    readExactCommerceProjectionReference: admittedSessionOperation(
      execution,
      lease,
      organisation.readExactCommerceProjectionReference.bind(organisation),
    ),
  };
}

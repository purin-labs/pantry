import {
  proposeCafeMenuPublicationForHarness,
  proposeCommerceActionForHarness,
  proposeMenuPriceForHarness,
  proposeMerchantPluginForHarness,
  proposeOrderRefundForHarness,
  proposeStockActionForHarness,
} from "../../actors/harness-commerce-proposal";
import {
  beginProposalStaging,
  type StageConfigurationDraft,
} from "@purin-labs/agent/actors/session/proposal-staging";
import type { ToolTurnContext } from "@purin-labs/agent/actors/session/tool-wiring";
import {
  admittedSessionOperation,
  requireSessionExecution,
} from "@purin-labs/agent/actors/session-execution-admission";
import {
  createCommerceClient,
  createCommerceEntityPlaneClient,
} from "../../contract/client";
import { readOfferPriceAllowanceView } from "../../contract/offer-price-allowance";
import {
  withToolContext,
  type SessionToolContext,
} from "@purin-labs/agent/agent-tools/context";
import {
  editProductDescriptionDraftForEmbeddedHarness,
  readProductDescriptionDraftForEmbeddedHarness,
} from "./description-draft-handlers";
import {
  advanceOrderQueueForEmbeddedHarness,
  markSoldOutForEmbeddedHarness,
  prepareCommerceReadForEmbeddedHarness,
  readCounterSaleForEmbeddedHarness,
  readEntityContextForEmbeddedHarness,
  readMerchantReportForEmbeddedHarness,
  readOrderQueueForEmbeddedHarness,
  readPaymentsForEmbeddedHarness,
  readSoldOutForEmbeddedHarness,
} from "./handlers";
import type {
  CommerceToolServices,
  HarnessConfigurationProposalRequest,
} from "./services";
import type { CommerceToolReads } from "@purin-labs/area-commerce-contract/server/tool-reads";
import { readNamedCommerceQuery } from "../../entity-plane/context-read";
import { parseCommerceGraphQuery } from "../../entity-plane/routes";
import {
  admitCommerceReadObservation,
  prepareSharedCommerceObservation,
  prepareStaffPageWork,
  refreshRecipeProjection,
  requestableReportRead,
  selectInternalQuerySourceGrant,
  selectMerchantReportSourceGrant,
  supplierDirectoryQuery,
} from "./read-support";

/**
 * What commerce gives to one turn: the services of the commerce tools, the
 * order queue and sold-out services of the Café tools, and the price proposal
 * of the menu tools.
 */
export function commerceToolServices(
  turn: ToolTurnContext,
  stageConfigurationDraft: StageConfigurationDraft,
) {
  const tool = withToolContext(turn);
  const commerce: CommerceToolServices = {
    readProductDescriptionDraft: tool(
      readProductDescriptionDraftForEmbeddedHarness,
    ),
    editProductDescriptionDraft: tool(
      editProductDescriptionDraftForEmbeddedHarness,
    ),
    readEntityContext: tool(readEntityContextForEmbeddedHarness),
    readMerchantReport: tool(readMerchantReportForEmbeddedHarness),
    readPayments: tool(readPaymentsForEmbeddedHarness),
    proposeCommerceAction: tool(proposeCommerceActionForHarness),
    proposeMerchantPlugin: tool(proposeMerchantPluginForHarness),
    proposeOrderRefund: tool(proposeOrderRefundForHarness),
    proposeStockAction: tool(proposeStockActionForHarness),
    proposeCafeMenuPublication: tool(proposeCafeMenuPublicationForHarness),
    proposeConfiguration: proposeConfigurationForEmbeddedHarness.bind(
      null,
      turn,
      stageConfigurationDraft,
    ),
  };
  return {
    commerce,
    orderQueue: {
      readOrderQueue: tool(readOrderQueueForEmbeddedHarness),
      readCounterSale: tool(readCounterSaleForEmbeddedHarness),
      advanceOrderQueue: tool(advanceOrderQueueForEmbeddedHarness),
      readSoldOut: tool(readSoldOutForEmbeddedHarness),
      markSoldOut: tool(markSoldOutForEmbeddedHarness),
    },
    proposeMenuPrice: tool(proposeMenuPriceForHarness),
    costs: costsCommerce(turn),
  };
}

/** The commerce reads and the Commerce clients of the Kitchen costs tools. */
function costsCommerce(turn: ToolTurnContext) {
  const { env, execution, lease, assignment } = turn;
  const admittedCommerceFetch = admittedSessionOperation(
    execution,
    lease,
    env.COMMERCE.fetch.bind(env.COMMERCE),
  );
  const caller = (actor: string) =>
    ({
      kind: "organisation",
      organisationId: String(execution.scope.organisationId),
      actor,
    }) as const;
  return {
    ...COMMERCE_TOOL_READS,
    prepareRead: prepareCommerceReadForEmbeddedHarness.bind(
      null,
      env,
      execution,
      lease,
      assignment,
    ),
    adminClient: (actor: string) =>
      createCommerceClient(env, admittedCommerceFetch, caller(actor)),
    entityPlaneClient: (actor: string) =>
      createCommerceEntityPlaneClient(
        env,
        admittedCommerceFetch,
        caller(actor),
      ),
  };
}

/**
 * Stages one setup change for a person to confirm.
 *
 * The command body goes through the same parse a Portal form submission
 * uses, so this cannot express a change the Portal could not.
 */
async function proposeConfigurationForEmbeddedHarness(
  context: SessionToolContext,
  stageConfigurationDraft: StageConfigurationDraft,
  request: HarnessConfigurationProposalRequest,
): Promise<unknown> {
  const staging = await beginProposalStaging(
    context,
    "configuration proposal",
    { portalChat: true },
  );
  return stageConfigurationDraft(staging, request.command, {});
}

/**
 * Fills in the Offer revision and price an allowance is measured from, when
 * the command names an Offer and carries neither.
 */
export async function bindAllowanceReference(
  context: Pick<SessionToolContext, "env" | "execution" | "lease">,
  rawCommand: unknown,
): Promise<unknown> {
  const { env, execution, lease } = context;
  if (
    typeof rawCommand !== "object" ||
    rawCommand === null ||
    Array.isArray(rawCommand)
  ) {
    return rawCommand;
  }
  const body = rawCommand as Readonly<Record<string, unknown>>;
  if (
    body.kind !== "set_offer_price_allowance" ||
    typeof body.offerId !== "string" ||
    body.expectedOfferRevision !== undefined
  ) {
    return rawCommand;
  }
  const view = await readOfferPriceAllowanceView(
    env,
    execution.scope,
    requireSessionExecution.bind(null, execution, lease),
    admittedSessionOperation(
      execution,
      lease,
      env.COMMERCE.fetch.bind(env.COMMERCE),
    ),
    body.offerId,
  );
  if (view === null) return rawCommand;
  return {
    ...body,
    expectedOfferRevision: view.currentOfferRevision,
    referencePriceMinor: view.currentPriceMinor,
    currency: view.currency,
  };
}

/** The commerce reads of a tool handler, for the area that the Worker gives them to. */
const COMMERCE_TOOL_READS: CommerceToolReads = {
  prepareCommerceRead: prepareCommerceReadForEmbeddedHarness,
  prepareSharedCommerceObservation,
  admitCommerceReadObservation,
  requestableReportRead,
  prepareStaffPageWork,
  refreshRecipeProjection,
  selectInternalQuerySourceGrant,
  selectMerchantReportSourceGrant,
  supplierDirectoryQuery,
  readNamedCommerceQuery,
  parseCommerceGraphQuery,
};

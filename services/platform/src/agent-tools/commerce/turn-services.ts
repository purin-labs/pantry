import { sha256Hex } from "@purin-labs/std";
import { sessionObservedCommerceEntity } from "../../actors/agent-session-information-flow";
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
  OPERATOR_DRAFT_TTL_MS,
  type StageConfigurationDraft,
} from "../../actors/session/proposal-staging";
import type { ToolTurnContext } from "../../actors/session/tool-wiring";
import {
  admittedSessionOperation,
  requireSessionExecution,
} from "../../actors/session-execution-admission";
import {
  createCommerceClient,
  createCommerceEntityPlaneClient,
} from "../../commerce/outbox-worker";
import { proposeCampaignBrief } from "../../data/campaign-brief";
import { readOfferPriceAllowanceView } from "../../data/offer-price-allowance";
import { withToolContext, type SessionToolContext } from "../context";
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
  HarnessCampaignBriefRequest,
  HarnessConfigurationProposalRequest,
} from "./services";

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
    proposeCampaignBrief: tool(proposeCampaignBriefForEmbeddedHarness),
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

/** The commerce reads and the Underclerk clients of the Kitchen costs tools. */
function costsCommerce(turn: ToolTurnContext) {
  const { env, execution, lease, assignment } = turn;
  const admittedUnderclerkFetch = admittedSessionOperation(
    execution,
    lease,
    env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  );
  const caller = (actor: string) =>
    ({
      kind: "organisation",
      organisationId: String(execution.scope.organisationId),
      actor,
    }) as const;
  return {
    prepareRead: prepareCommerceReadForEmbeddedHarness.bind(
      null,
      env,
      execution,
      lease,
      assignment,
    ),
    adminClient: (actor: string) =>
      createCommerceClient(env, admittedUnderclerkFetch, caller(actor)),
    entityPlaneClient: (actor: string) =>
      createCommerceEntityPlaneClient(
        env,
        admittedUnderclerkFetch,
        caller(actor),
      ),
  };
}

/**
 * Stages one campaign brief for a person to decide on.
 *
 * The brief names commerce records, so every one it names must be a record
 * this Case actually read, at the revision it read. Without that check a
 * plausible-looking identifier the model invented would enter a brief that
 * an operator then approves on the strength of its detail.
 */
async function proposeCampaignBriefForEmbeddedHarness(
  context: SessionToolContext,
  request: HarnessCampaignBriefRequest,
): Promise<unknown> {
  const staging = await beginProposalStaging(context, "campaign brief");
  // A brief spends a merchant's budget against a merchant's catalogue; with
  // no merchant bound there is nothing for it to be a brief about.
  if (staging.merchantId === null) {
    throw new Error("campaign brief has no bound merchant");
  }
  for (const target of request.targets) {
    if (
      !sessionObservedCommerceEntity({
        sql: context.storage.sql,
        organisationId: String(context.execution.scope.organisationId),
        sessionId: String(context.assignment.sessionId),
        entityType: target.entityType,
        entityId: target.entityId,
        revision: target.revision,
      })
    ) {
      throw new Error("campaign brief target was not observed in this Case");
    }
  }
  const digest = await sha256Hex(JSON.stringify(request));
  const briefId = `brief_agent_${context.assignment.assignmentId}_${digest.slice(0, 24)}`;
  const proposed = await proposeCampaignBrief({
    scope: context.execution.scope,
    authorizeCommit: requireSessionExecution.bind(
      null,
      context.execution,
      context.lease,
    ),
    briefId,
    merchantId: staging.merchantId,
    caseId: staging.caseId,
    objective: request.objective,
    targets: request.targets,
    channel: request.channel,
    audienceDescription: request.audienceDescription,
    messageVariants: request.messageVariants,
    requestedBudgetMinor: request.requestedBudgetMinor,
    currency: request.currency,
    windowStart: request.windowStart,
    windowEnd: request.windowEnd,
    disclosures: request.disclosures,
    supportingEvidence: request.supportingEvidence,
    expiresAt: staging.now + OPERATOR_DRAFT_TTL_MS,
    now: staging.now,
  });
  if (!proposed.ok)
    throw new Error(`campaign brief refused: ${proposed.error.code}`);
  await requireSessionExecution(context.execution, context.lease);
  return { kind: "campaign_brief_drafted", briefId, caseId: staging.caseId };
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
      env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
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

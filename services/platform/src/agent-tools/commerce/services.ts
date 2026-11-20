import type {
  CommerceContextRequest,
  CommerceGraphQueryResult,
} from "@purin-labs/contracts";
import type { CommerceActionRequest } from "../../commerce/action-model";
import type {
  MerchantReportName,
  MerchantReportResult,
} from "../../commerce/entity-plane/merchant-reports";
import type { MerchantPluginDraft } from "../../commerce/merchant-plugin-action";
import type { OrderRefundLineRequest } from "../../commerce/order-refund-action";
import type { PaymentsToolRead } from "../../commerce/payments-read";
import type { CommerceActionProposalOrigin } from "../catalog/types";
import { defineToolFamily } from "../define-tool";
import type { StockActionProposal } from "./proposals";

type CommerceActionProposal = (
  request: CommerceActionRequest,
  origin?: CommerceActionProposalOrigin,
) => Promise<unknown>;

type MerchantPluginProposal = (
  draft: MerchantPluginDraft,
  origin?: CommerceActionProposalOrigin,
) => Promise<unknown>;

/** The window of a payments read: two UTC instants, the start first. */
export type PaymentsReadRequest = Readonly<{ start: string; end: string }>;

type PaymentsReadTool = (
  request: PaymentsReadRequest,
) => Promise<PaymentsToolRead>;

type CafeMenuPublicationProposal = (
  request: Readonly<{ documentRevision: number }>,
  origin?: CommerceActionProposalOrigin,
) => Promise<unknown>;

type OrderRefundProposal = (
  request: Readonly<{
    orderId: string;
    expectedRevision: number;
    reason: string;
    refundLines: readonly OrderRefundLineRequest[] | null;
  }>,
  origin?: CommerceActionProposalOrigin,
) => Promise<unknown>;

type EntityContextRead = (
  request: CommerceContextRequest,
) => Promise<CommerceGraphQueryResult>;

/** One drafted campaign, staged for review. Nothing here sends or spends. */
export type HarnessCampaignBriefRequest = Readonly<{
  objective: string;
  targets: readonly Readonly<{
    entityType: "product" | "sellable_variant" | "offer";
    entityId: string;
    revision: number;
  }>[];
  channel: string;
  audienceDescription: string;
  messageVariants: readonly Readonly<{
    variantId: string;
    headline: string;
    body: string;
  }>[];
  requestedBudgetMinor: number;
  currency: string;
  windowStart: string;
  windowEnd: string;
  disclosures: readonly string[];
  supportingEvidence: string;
}>;

type CampaignBriefPropose = (
  request: HarnessCampaignBriefRequest,
) => Promise<unknown>;

/** One proposed configuration change for operator confirmation. */
export type HarnessConfigurationProposalRequest = Readonly<{
  command: unknown;
}>;

type ConfigurationPropose = (
  request: HarnessConfigurationProposalRequest,
) => Promise<unknown>;

/** One named merchant report; the agent selects a name, never a query. */
export type HarnessMerchantReportRequest = Readonly<{
  name: MerchantReportName;
}>;

type MerchantReportRead = (
  request: HarnessMerchantReportRequest,
) => Promise<MerchantReportResult>;

/** What a turn gives to the commerce tools. */
export type CommerceToolServices = {
  readonly readEntityContext: EntityContextRead;
  readonly readMerchantReport: MerchantReportRead;
  readonly readPayments: PaymentsReadTool;
  readonly proposeCommerceAction: CommerceActionProposal;
  readonly proposeMerchantPlugin: MerchantPluginProposal;
  readonly proposeOrderRefund: OrderRefundProposal;
  readonly proposeStockAction: StockActionProposal;
  readonly proposeCafeMenuPublication: CafeMenuPublicationProposal;
  /**
   * The staging tools. Required on purpose: they shipped advertised to the
   * model but never wired, because an optional field lets a host omit one
   * with no error.
   */
  readonly proposeCampaignBrief: CampaignBriefPropose;
  readonly proposeConfiguration: ConfigurationPropose;
};

export const defineCommerceTool =
  defineToolFamily<CommerceToolServices>()("commerce");

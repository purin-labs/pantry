import type {
  ConnectorDelivery,
  ConnectorDeliveryReceipt,
  ConnectorIdentity,
  ConnectorIngress,
  StoredMessageAttachment,
} from "@purin-labs/contracts";
import type { EmailRuntimeSnapshot } from "../connector-email";
import type { GmailMessageContent } from "../../mail/gmail-adapter";
import type { EmailProposalDraftRecord } from "../email-case-processing";
import type { EmailDisposalOutcome } from "../connector-email-proposal";
import type { ConnectorCaseWorkEfficiency } from "../connector-case-work";

export type ConnectorResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string } };

export type ConnectorIngressRequest = {
  readonly identity: ConnectorIdentity;
  readonly ingress: ConnectorIngress;
  readonly attachments: readonly StoredMessageAttachment[];
};

export type ConnectorIngressRecord = ConnectorIngress & {
  readonly attachments: readonly StoredMessageAttachment[];
};

export type ConnectorDeliveryRequest = {
  readonly identity: ConnectorIdentity;
  readonly delivery: ConnectorDelivery;
  readonly requestedAt: number;
};

export type ConnectorDeliveryResult =
  | {
      readonly kind: "delivered" | "already_delivered";
      readonly receipt: ConnectorDeliveryReceipt;
    }
  | {
      readonly kind: "retry";
      readonly reason: string;
      readonly retryAt: number;
    }
  | { readonly kind: "rejected"; readonly reason: string };

export type ConnectorSnapshot = {
  readonly identity: ConnectorIdentity;
  readonly ingressCount: number;
  readonly deliveryCount: number;
  readonly caseWork: ConnectorCaseWorkEfficiency;
  readonly ingresses: readonly ConnectorIngressRecord[];
  readonly deliveries: readonly ConnectorDelivery[];
  readonly receipts: readonly ConnectorDeliveryReceipt[];
};

export type EmailMailboxDisposal = {
  readonly proposalId: string;
  readonly version: number;
  readonly kind: EmailDisposalOutcome["kind"];
};

export type EmailMailboxRevocation = {
  readonly watchStopped: boolean;
  readonly disposals: readonly EmailMailboxDisposal[];
};

export type EmailRuntimeStatus = EmailRuntimeSnapshot & {
  readonly usage: {
    readonly activeCases: number;
    readonly admittedLastHour: number;
    readonly tokens: { readonly reserved: number; readonly consumed: number };
    readonly nextEvaluationAt: number | null;
  };
};

export type ConnectorEmailMailboxSearch = Readonly<{
  integrationAccountId: string;
  messages: readonly GmailMessageContent[];
  truncated: boolean;
}>;

export type ConnectorEmailReplyProposal = Readonly<{
  record: EmailProposalDraftRecord;
}>;

export type MetaRow = Record<string, SqlStorageValue> & {
  organisation_id: string;
  connector_id: string;
};

export type JsonRow = Record<string, SqlStorageValue> & { payload: string };

export type DeliveryRow = Record<string, SqlStorageValue> & {
  payload: string;
  state_json: string;
};

export type ConnectorDeliveryState =
  | {
      readonly kind: "sending";
      readonly attempt: number;
      readonly leaseExpiresAt: number;
    }
  | {
      readonly kind: "retryable";
      readonly attempt: number;
      readonly reason: string;
      readonly retryAt: number;
    }
  | { readonly kind: "delivered"; readonly receipt: ConnectorDeliveryReceipt }
  | { readonly kind: "rejected"; readonly reason: string };

export type ConnectorDeliveryClaim =
  | ConnectorDeliveryResult
  | {
      readonly kind: "claimed";
      readonly attempt: number;
      readonly delivery: ConnectorDelivery;
    };

export type SlackDeliveryResponse =
  | { readonly kind: "delivered"; readonly timestamp: string }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "invalid" };

/** How long a Case waits before a turn that produced no outcome is retried. */
export const WHATSAPP_TURN_RETRY_MS = 60_000;

export const DELIVERY_LEASE_MS = 30_000;

export const DELIVERY_RETRY_MS = 5_000;

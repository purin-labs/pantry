import type { SqlStorage } from "@cloudflare/workers-types";
import type { Env } from "@purin-labs/kernel/env";
import { definePort } from "@purin-labs/kernel/port";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { IngressLimitPauseReason } from "./ingress-limits";

/** Why a WhatsApp number stopped taking agent work. */
export type WhatsAppPauseReason =
  | IngressLimitPauseReason
  | {
      readonly kind: "unsupported_message_type";
      readonly providerMessageId: string;
      readonly messageType: string;
    }
  | {
      readonly kind: "service_window_expired";
      readonly caseId: string;
      readonly expiredAt: number;
    }
  | {
      /** The agent's turns for the Case failed until no attempt was left. */
      readonly kind: "turn_attempts_exhausted";
      readonly caseId: string;
      readonly attempts: number;
    }
  | {
      readonly kind: "send_indeterminate";
      readonly proposalId: string;
      readonly caseId: string;
    };

/** One queued operator notice of the Connector. */
export type WhatsAppOperatorNotice = Readonly<{
  reason: WhatsAppPauseReason;
  policyVersion: number;
  deliveredAt: number | null;
}>;

/** What happened to one operator notice of a paused WhatsApp number. */
type WhatsAppOperatorNoticeOutcome =
  | { readonly kind: "delivered"; readonly channelId: string }
  | { readonly kind: "suppressed"; readonly reason: "already_notified" }
  | { readonly kind: "undeliverable"; readonly reason: string };

/** One queued notice of the Connector, and the number that it names. */
type WhatsAppOperatorNoticeDelivery = Readonly<{
  env: Env;
  sql: SqlStorage;
  scope: OrganisationExecutionScope;
  displayPhoneNumber: string;
  noticeKey: string;
  now: number;
  fetcher: typeof fetch;
}>;

/**
 * The delivery of the operator notice of a paused WhatsApp number. The
 * Inbox queues the notice in the Connector, and a surface posts it to the
 * operations destination of the Organisation. The Worker registers the
 * implementation (`worker-ports.ts`).
 */
export type WhatsAppOperatorNotices = Readonly<{
  deliver: (
    input: WhatsAppOperatorNoticeDelivery,
  ) => Promise<
    Result<WhatsAppOperatorNoticeOutcome, { readonly code: string }>
  >;
}>;

export const whatsAppOperatorNotices = definePort<WhatsAppOperatorNotices>(
  "whatsapp_operator_notices",
);

/**
 * The queued operator notices in the Connector storage. The Inbox owns the
 * notice table, and the surface that delivers a notice reads it and marks
 * it delivered. The Worker registers the implementation (`worker-ports.ts`).
 */
export type WhatsAppOperatorNoticeRecords = Readonly<{
  read(sql: SqlStorage, noticeKey: string): WhatsAppOperatorNotice | null;
  markDelivered(sql: SqlStorage, noticeKey: string, now: number): void;
}>;

export const whatsAppOperatorNoticeRecords =
  definePort<WhatsAppOperatorNoticeRecords>("whatsapp_operator_notice_records");

import type { SqlStorage } from "@cloudflare/workers-types";
import type { Env } from "@purin-labs/kernel/env";
import { definePort } from "@purin-labs/kernel/port";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

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

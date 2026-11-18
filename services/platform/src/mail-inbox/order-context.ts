import type {
  CommerceGraphQuery,
  CommerceGraphQueryResult,
  RequestAuthority,
} from "@seams/contracts";
import { parseCommerceGraphQuery } from "@seams/commerce-client";
import { isRecord, sameJson } from "@seams/std";
import type { Env } from "../env";
import type { GmailMessageContent } from "../mail/gmail-adapter";
import type { Result } from "../result";
import {
  MAX_EMAIL_ORDER_READS,
  readMailboxCommerceQuery,
  replyFactDisplay,
  validateEmailCommerceEvidence,
  type EmailCommerceEvidence,
} from "./supplier-context";
import type { Variant } from "@seams/type-utils";

type MailboxAuthority = Variant<RequestAuthority, "agent_mailbox">;
type CommerceEntity = CommerceGraphQueryResult["entities"][number];

type EmailOrderContextError = Readonly<{
  code:
    | "email_commerce_unavailable"
    | "email_commerce_changed"
    | "email_order_not_named"
    | "email_order_not_found"
    | "email_order_limit";
}>;

/** One order that a mailbox turn read, by identity, with its read evidence. */
type EmailOrderRead = Readonly<{
  orderId: string;
  evidence: readonly EmailCommerceEvidence[];
}>;

/**
 * The orders of one mailbox turn. The turn reads an order only when an
 * admitted message names it by its exact reference, and only under the
 * mailbox agent's own grant to orders. Every read of the turn must stand at
 * the same commerce revision.
 */
export class EmailOrderContext {
  private reads: EmailOrderRead[] = [];
  constructor(
    private readonly env: Env,
    private readonly authority: MailboxAuthority,
    private readonly caseId: string,
  ) {}

  orders(): readonly EmailOrderRead[] {
    return this.reads;
  }

  /** The evidence of every order read, each distinct receipt once. */
  receipts(): readonly EmailCommerceEvidence[] {
    const receipts: EmailCommerceEvidence[] = [];
    for (const read of this.reads)
      for (const receipt of read.evidence)
        if (!receipts.some(sameJson.bind(null, receipt)))
          receipts.push(receipt);
    return receipts;
  }

  async read(
    messages: readonly GmailMessageContent[],
    inputJson: string,
  ): Promise<Result<string, EmailOrderContextError>> {
    const orderId = orderArgument(inputJson);
    if (
      orderId === null ||
      !messages.some((message) => message.bodyText.includes(orderId))
    )
      return { ok: false, error: { code: "email_order_not_named" } };
    const query = orderQuery(orderId);
    if (query === null)
      return { ok: false, error: { code: "email_order_not_named" } };
    if (
      !this.reads.some((read) => read.orderId === orderId) &&
      this.reads.length >= MAX_EMAIL_ORDER_READS
    )
      return { ok: false, error: { code: "email_order_limit" } };
    const read = await readMailboxCommerceQuery(
      this.env,
      this.authority,
      this.caseId,
      query,
    );
    if (!read.ok)
      return {
        ok: false,
        error: {
          code:
            read.error.code === "email_commerce_changed"
              ? "email_commerce_changed"
              : "email_commerce_unavailable",
        },
      };
    const entity = read.value.value.entities.find(isOrder.bind(null, orderId));
    if (entity === undefined)
      return { ok: false, error: { code: "email_order_not_found" } };
    const evidence = [read.value.evidence];
    const all = [...this.receipts(), ...evidence];
    if (
      !(
        await validateEmailCommerceEvidence(
          this.env,
          this.authority.organisationId,
          all,
        )
      ).ok
    )
      return { ok: false, error: { code: "email_commerce_changed" } };
    this.reads = [
      ...this.reads.filter((earlier) => earlier.orderId !== orderId),
      { orderId, evidence },
    ];
    return {
      ok: true,
      value: JSON.stringify({
        kind: "order",
        source: `order:${orderId}`,
        order: {
          reference: entity.reference,
          displayName: entity.displayName,
          facts: entity.attributes.map(replyFactDisplay),
        },
      }),
    };
  }
}

/** The read of one order by its reference, or null for an invalid one. */
export function orderQuery(orderId: string): CommerceGraphQuery | null {
  try {
    const query = parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: { origin: "system", typeId: "order", entityId: orderId },
      filter: null,
      traversal: { maxDepth: 0, resultLimit: 1 },
    });
    return query.kind === "entity_by_ref" ? query : null;
  } catch {
    return null;
  }
}

export function isOrder(orderId: string, entity: CommerceEntity): boolean {
  return (
    entity.reference.origin === "system" &&
    entity.reference.typeId === "order" &&
    entity.reference.entityId === orderId
  );
}

/** How a person reads one order: its name, and its facts on one line. */
export function orderSummary(
  entity: CommerceEntity,
): Readonly<{ title: string; detail: string }> {
  // An order's lifecycle is what a person calls its status.
  const facts = entity.attributes
    .map(replyFactDisplay)
    .map(
      (fact) =>
        `${fact.label === "lifecycle" ? "Status" : capitalize(fact.label)}: ${fact.value.replaceAll("_", " ")}`,
    );
  return {
    title: `Order ${entity.displayName}`,
    detail: facts.join(" · "),
  };
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`;
}

function orderArgument(inputJson: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(inputJson);
  } catch {
    return null;
  }
  return isRecord(raw) &&
    Object.keys(raw).length === 1 &&
    typeof raw.orderId === "string" &&
    raw.orderId.trim() === raw.orderId &&
    raw.orderId.length > 0 &&
    raw.orderId.length <= 256
    ? raw.orderId
    : null;
}

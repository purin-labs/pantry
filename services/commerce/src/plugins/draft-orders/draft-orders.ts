import {
  parseCancelDraftOrderCommand,
  parseCreateDraftOrderCommand,
  parseDraftOrder,
  parseMarkDraftOrderPaidCommand,
  parsePlaceDraftOrderOnTermsCommand,
  parseSendDraftInvoiceCommand,
  parseUpdateDraftOrderCommand,
  type MarkCommerceDraftOrderPaidV1,
  type PlaceCommerceDraftOrderOnTermsV1,
  type CommerceBuyerQuotedCheckoutV1,
  type CommerceDraftOrderCommandV1,
  type CommerceDraftOrderLineV1,
  type CommerceDraftOrderV1,
  type CommerceDraftOrderViewV1,
  type CommerceMerchantSnapshotV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
} from "@seams/commerce-client";

import { commerceTransition } from "@seams/commerce-contracts";

import { readCheckout, readStorefront } from "../../checkout-persistence.ts";
import { readOfferRevision } from "../../commerce-persistence.ts";
import type { CommerceDatabase } from "../../database.ts";
import { listManualTendersForOrder } from "../../payments/manual-tender.ts";
import type { BuyerCheckoutProfileClaims } from "../../commerce-authority/buyer-checkout/types.ts";
import {
  findResource,
  sha256,
  variantIsSellable,
} from "../../commerce-authority/checkout-shared.ts";

export type DraftOrderMerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

export type DraftOrderCommitRequest = Readonly<{
  command: CommerceDraftOrderCommandV1;
  merchant: DraftOrderMerchantRow;
  draft: CommerceDraftOrderV1;
  /** A new buyer email, which the commit seals in a customer record. */
  buyerEmail: string | undefined;
}>;

/** The customer records that seal a draft's buyer. */
export type DraftOrderBuyers = Readonly<{
  sealsBuyers: boolean;
  customerEmail: (merchantId: string, customerId: string) => string | null;
}>;

export type DraftOrderCommandAuthorityOptions = Readonly<{
  database: CommerceDatabase;
  now: () => string;
  readMerchant: (merchantId: string) => DraftOrderMerchantRow | undefined;
  readSnapshot: (
    merchantId: string,
  ) => CommerceMerchantSnapshotV1 | undefined;
  readReplay: (
    merchantId: string,
    idempotencyKey: string,
    command:
      | CommerceDraftOrderCommandV1
      | MarkCommerceDraftOrderPaidV1
      | PlaceCommerceDraftOrderOnTermsV1,
  ) => CommerceMutationResultV1 | undefined;
  commit: (request: DraftOrderCommitRequest) => CommerceMutationResultV1;
  validateMerchant: (
    merchantId: string,
    merchant: DraftOrderMerchantRow | undefined,
  ) => CommerceMutationErrorV1 | undefined;
  rejected: (error: CommerceMutationErrorV1) => CommerceMutationResultV1;
  invalidCommand: (error: unknown) => CommerceMutationErrorV1;
  buyers: DraftOrderBuyers;
  createDraftCheckout: (
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      draft: CommerceDraftOrderV1;
      buyerEmail: string;
      checkoutId: string;
    }>,
  ) => DraftInvoiceCheckout;
  readBuyerQuotedCheckout: (
    merchantId: string,
    checkoutId: string,
    sessionId: string,
  ) => CommerceBuyerQuotedCheckoutV1 | undefined;
  /**
   * The checkout terms that a staff checkout of the storefront's draft uses,
   * or undefined while the storefront has no active checkout profile.
   */
  draftCheckoutClaims: (
    merchantId: string,
    storefrontId: string,
    sessionId: string,
  ) => BuyerCheckoutProfileClaims | undefined;
  /**
   * Places the draft's quoted checkout with the staff command's tender, or
   * on the company terms that a placement on terms names.
   */
  placeManually: (
    command:
      MarkCommerceDraftOrderPaidV1 | PlaceCommerceDraftOrderOnTermsV1,
    checkoutId: string,
    terms?: Readonly<{ companyId: string; netDays: number }>,
  ) => CommerceMutationResultV1;
  /** The invoice terms of the draft buyer's company, or undefined. */
  termsOf: (
    merchantId: string,
    customerId: string | null,
  ) => Readonly<{ companyId: string; netDays: number }> | undefined;
}>;

export type DraftInvoiceCheckout =
  | Readonly<{ kind: "created"; checkout: CommerceBuyerQuotedCheckoutV1 }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

/** The buyer of a new draft revision until the commit names its customer. */
const SEALED_BUYER = { customerId: null, email: null } as const;

/** An invoice link may stay open for at most thirty days. */
const MAXIMUM_INVOICE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

export class DraftOrderCommandAuthority {
  readonly #options: DraftOrderCommandAuthorityOptions;

  constructor(options: DraftOrderCommandAuthorityOptions) {
    this.#options = options;
  }

  createDraftOrder(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseCreateDraftOrderCommand, (command) => {
      if (this.#read(command.merchantId, command.draftOrderId) !== undefined)
        return {
          code: "resource_already_exists",
          kind: "draft_order",
          id: command.draftOrderId,
        };
      const draft: CommerceDraftOrderV1 = {
        id: command.draftOrderId,
        revision: 1,
        storefrontId: command.storefrontId,
        lines: command.lines,
        buyer: SEALED_BUYER,
        note: command.note,
        tags: command.tags,
        lifecycle: { state: "open" },
        occurredAt: command.requestedAt,
      };
      return this.#linesError(command.merchantId, draft) ?? draft;
    });
  }

  updateDraftOrder(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseUpdateDraftOrderCommand, (command) => {
      const current = this.#current(
        command.merchantId,
        command.draftOrderId,
        command.expectedDraftOrderRevision,
      );
      if (!("revision" in current)) return current;
      const move = commerceTransition(
        "draft_order",
        current.lifecycle,
        "update",
      );
      if (!move.allowed) return move.refusal;
      if (this.#completion(command.merchantId, current) !== null)
        return invalid("draftOrder.completed");
      // A change reopens the draft: the old invoice link no longer opens it.
      const draft: CommerceDraftOrderV1 = {
        ...current,
        revision: current.revision + 1,
        lines: command.lines,
        buyer: SEALED_BUYER,
        note: command.note,
        tags: command.tags,
        lifecycle: { state: move.to },
        occurredAt: command.requestedAt,
      };
      return this.#linesError(command.merchantId, draft) ?? draft;
    });
  }

  sendDraftInvoice(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseSendDraftInvoiceCommand, (command) => {
      const current = this.#current(
        command.merchantId,
        command.draftOrderId,
        command.expectedDraftOrderRevision,
      );
      if (!("revision" in current)) return current;
      const move = commerceTransition(
        "draft_order",
        current.lifecycle,
        "send_invoice",
      );
      if (!move.allowed) return move.refusal;
      if (this.#completion(command.merchantId, current) !== null)
        return invalid("draftOrder.completed");
      const lifetime =
        Date.parse(command.expiresAt) - Date.parse(command.requestedAt);
      if (lifetime <= 0 || lifetime > MAXIMUM_INVOICE_LIFETIME_MS)
        return invalid("draftOrder.invoice.expiresAt");
      const linesError = this.#linesError(command.merchantId, current);
      if (linesError !== undefined) return linesError;
      const revision = current.revision + 1;
      return {
        ...current,
        revision,
        lifecycle: {
          state: move.to,
          invoicedRevision: revision,
          expiresAt: command.expiresAt,
        },
        occurredAt: command.requestedAt,
      };
    });
  }

  cancelDraftOrder(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseCancelDraftOrderCommand, (command) => {
      const current = this.#current(
        command.merchantId,
        command.draftOrderId,
        command.expectedDraftOrderRevision,
      );
      if (!("revision" in current)) return current;
      const move = commerceTransition(
        "draft_order",
        current.lifecycle,
        "cancel",
      );
      if (!move.allowed) return move.refusal;
      if (this.#completion(command.merchantId, current) !== null)
        return invalid("draftOrder.completed");
      return {
        ...current,
        revision: current.revision + 1,
        lifecycle: { state: move.to, cancelledAt: command.requestedAt },
        occurredAt: command.requestedAt,
      };
    });
  }

  /**
   * Staff took the money in cash or by bank transfer. The draft's open
   * checkout, or a new one at the draft's prices, becomes the order.
   */
  markDraftOrderPaid(rawCommand: unknown): CommerceMutationResultV1 {
    let command: MarkCommerceDraftOrderPaidV1;
    try {
      command = parseMarkDraftOrderPaidCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    const checkoutId = this.#manualPaymentCheckout(command);
    return typeof checkoutId === "string"
      ? this.#options.placeManually(command, checkoutId)
      : this.#options.rejected(checkoutId);
  }

  /**
   * Staff place the draft for a company's buyer on the company's invoice
   * terms: the order is placed now and its invoice is due later.
   */
  placeDraftOrderOnTerms(rawCommand: unknown): CommerceMutationResultV1 {
    let command: PlaceCommerceDraftOrderOnTermsV1;
    try {
      command = parsePlaceDraftOrderOnTermsCommand(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    const draft = this.#read(command.merchantId, command.draftOrderId);
    const terms =
      draft === undefined
        ? undefined
        : this.#options.termsOf(command.merchantId, draft.buyer.customerId);
    if (draft !== undefined && terms === undefined)
      return this.#options.rejected(invalid("company.paymentTerms"));
    const checkoutId = this.#manualPaymentCheckout(command);
    return typeof checkoutId === "string"
      ? this.#options.placeManually(command, checkoutId, terms)
      : this.#options.rejected(checkoutId);
  }

  readDraftOrderView(
    merchantId: string,
    draftOrderId: string,
  ): CommerceDraftOrderViewV1 | undefined {
    const draft = this.#read(merchantId, draftOrderId);
    if (draft === undefined) return undefined;
    const completion = this.#completion(merchantId, draft);
    const tender =
      completion === null
        ? undefined
        : listManualTendersForOrder(
            this.#options.database,
            merchantId,
            completion.orderId,
          )[0];
    return {
      schemaVersion: "underclerk.draft-order.v1",
      draftOrder: {
        ...draft,
        buyer: {
          customerId: draft.buyer.customerId,
          email: this.#buyerEmail(merchantId, draft),
        },
      },
      checkoutIds: this.#checkoutIds(merchantId, draft).map(
        (checkout) => checkout.checkoutId,
      ),
      completion:
        completion === null || tender === undefined
          ? completion
          : {
              ...completion,
              manualTender: {
                ...(tender.method === "cash"
                  ? { method: tender.method }
                  : { method: tender.method, reference: tender.reference }),
                recordedAt: tender.recordedAt,
              },
            },
    };
  }

  /** The draft an invoice token may open: invoiced, unexpired, same revision. */
  readInvoicedDraft(
    merchantId: string,
    storefrontId: string,
    draftOrderId: string,
    draftRevision: number,
  ): CommerceDraftOrderV1 | undefined {
    const draft = this.#read(merchantId, draftOrderId);
    if (
      draft === undefined ||
      draft.storefrontId !== storefrontId ||
      draft.lifecycle.state !== "invoiced" ||
      draft.lifecycle.invoicedRevision !== draftRevision ||
      draft.revision !== draftRevision ||
      Date.parse(this.#options.now()) >= Date.parse(draft.lifecycle.expiresAt)
    )
      return undefined;
    return draft;
  }

  /**
   * Opens the invoice for the buyer session it created. An open checkout from
   * an earlier opening is returned again; after an expiry a new one is made.
   */
  openDraftInvoice(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      draft: CommerceDraftOrderV1;
    }>,
  ): DraftInvoiceCheckout {
    const { claims, draft } = input;
    if (this.#completion(claims.merchantId, draft) !== null)
      return { kind: "rejected", error: invalid("draftOrder.completed") };
    // An erased buyer leaves the draft with no one to send the order to.
    const buyerEmail = this.#buyerEmail(claims.merchantId, draft);
    if (buyerEmail === null)
      return { kind: "rejected", error: invalid("draftOrder.buyer.erased") };
    const attempts = this.#checkoutIds(claims.merchantId, draft);
    const latest = attempts.at(-1);
    // An open checkout is returned only while its catalog-priced lines still
    // match their offers; otherwise the buyer gets a new quote.
    if (
      latest?.open === true &&
      this.#quoteIsCurrent(claims.merchantId, latest.checkoutId)
    ) {
      const checkout = this.#options.readBuyerQuotedCheckout(
        claims.merchantId,
        latest.checkoutId,
        claims.sessionId,
      );
      if (checkout !== undefined) return { kind: "created", checkout };
    }
    return this.#options.createDraftCheckout({
      claims,
      draft,
      buyerEmail,
      checkoutId: draftCheckoutId(draft, attempts.length + 1),
    });
  }

  // The checkout that a manual payment places: the draft's open checkout
  // while its prices hold, or a new one. A checkout that a buyer is paying by
  // card is returned too, and the checkout machine refuses it.
  #manualPaymentCheckout(
    command:
      MarkCommerceDraftOrderPaidV1 | PlaceCommerceDraftOrderOnTermsV1,
  ): string | CommerceMutationErrorV1 {
    const { merchantId } = command;
    const draft = this.#current(
      merchantId,
      command.draftOrderId,
      command.expectedDraftOrderRevision,
    );
    if (!("revision" in draft)) return draft;
    const move = commerceTransition(
      "draft_order",
      draft.lifecycle,
      "mark_paid",
    );
    if (!move.allowed) return move.refusal;
    if (this.#completion(merchantId, draft) !== null)
      return invalid("draftOrder.completed");
    const linesError = this.#linesError(merchantId, draft);
    if (linesError !== undefined) return linesError;
    const buyerEmail = this.#buyerEmail(merchantId, draft);
    if (buyerEmail === null) return invalid("draftOrder.buyer.erased");
    const attempts = this.#checkoutIds(merchantId, draft);
    const latest = attempts.at(-1);
    if (
      latest?.open === true &&
      this.#quoteIsCurrent(merchantId, latest.checkoutId)
    )
      return latest.checkoutId;
    const claims = this.#options.draftCheckoutClaims(
      merchantId,
      draft.storefrontId,
      `draft_manual_${sha256(JSON.stringify([merchantId, draft.id, draft.revision]))}`,
    );
    if (claims === undefined) return invalid("draftOrder.checkoutProfile");
    const created = this.#options.createDraftCheckout({
      claims,
      draft,
      buyerEmail,
      checkoutId: draftCheckoutId(draft, attempts.length + 1),
    });
    return created.kind === "rejected"
      ? created.error
      : created.checkout.checkoutId;
  }

  #buyerEmail(
    merchantId: string,
    draft: CommerceDraftOrderV1,
  ): string | null {
    return draft.buyer.customerId === null
      ? draft.buyer.email
      : this.#options.buyers.customerEmail(merchantId, draft.buyer.customerId);
  }

  #quoteIsCurrent(merchantId: string, checkoutId: string): boolean {
    const checkout = readCheckout(
      this.#options.database,
      merchantId,
      checkoutId,
    );
    if (checkout === undefined || checkout.lifecycle.state === "expired")
      return false;
    if (checkout.lifecycle.state !== "quoted") return true;
    return checkout.lifecycle.quote.lines.every(
      (line) =>
        line.priceOverride !== undefined ||
        line.source.kind === "order_balance" ||
        readOfferRevision(
          this.#options.database,
          merchantId,
          line.source.offerId,
        ) === line.source.offerRevision,
    );
  }

  #run<TCommand extends CommerceDraftOrderCommandV1>(
    rawCommand: unknown,
    parse: (value: unknown) => TCommand,
    plan: (
      command: TCommand,
    ) => CommerceDraftOrderV1 | CommerceMutationErrorV1,
  ): CommerceMutationResultV1 {
    let command: TCommand;
    try {
      command = parse(rawCommand);
    } catch (error) {
      return this.#options.rejected(this.#options.invalidCommand(error));
    }
    const merchant = this.#options.readMerchant(command.merchantId);
    const merchantError = this.#options.validateMerchant(
      command.merchantId,
      merchant,
    );
    if (merchantError !== undefined)
      return this.#options.rejected(merchantError);
    const replay = this.#options.readReplay(
      command.merchantId,
      command.idempotencyKey,
      command,
    );
    if (replay !== undefined) return replay;
    if (merchant === undefined)
      return this.#options.rejected({
        code: "merchant_not_found",
        merchantId: command.merchantId,
      });
    const buyerEmail = "buyer" in command ? command.buyer.email : undefined;
    // The buyer's email lives only in a sealed customer record.
    if (buyerEmail !== undefined && !this.#options.buyers.sealsBuyers)
      return this.#options.rejected(
        invalid("draftOrder.buyer.customerAccounts"),
      );
    const planned = plan(command);
    if ("code" in planned) return this.#options.rejected(planned);
    return this.#options.commit({
      command,
      merchant,
      draft: planned,
      buyerEmail,
    });
  }

  #current(
    merchantId: string,
    draftOrderId: string,
    expectedRevision: number,
  ): CommerceDraftOrderV1 | CommerceMutationErrorV1 {
    const draft = this.#read(merchantId, draftOrderId);
    if (draft === undefined)
      return {
        code: "resource_not_found",
        kind: "draft_order",
        id: draftOrderId,
      };
    if (draft.revision !== expectedRevision)
      return {
        code: "stale_resource_revision",
        kind: "draft_order",
        id: draftOrderId,
        expected: expectedRevision,
        actual: draft.revision,
      };
    return draft;
  }

  // Every draft line must name a variant that the storefront sells now, and a
  // staff price must use the offer's currency.
  #linesError(
    merchantId: string,
    draft: CommerceDraftOrderV1,
  ): CommerceMutationErrorV1 | undefined {
    const storefront = readStorefront(
      this.#options.database,
      merchantId,
      draft.storefrontId,
    );
    if (storefront === undefined)
      return {
        code: "resource_not_found",
        kind: "storefront",
        id: draft.storefrontId,
      };
    if (
      storefront.lifecycle.state !== "active" ||
      storefront.fulfillment.kind !== "pickup"
    )
      return invalid("draftOrder.storefront");
    const resources = this.#options.readSnapshot(merchantId)?.resources;
    if (resources === undefined)
      return { code: "merchant_not_found", merchantId };
    for (const line of draft.lines) {
      const error = lineError(resources, storefront.salesChannelId, line);
      if (error !== undefined) return error;
    }
    return undefined;
  }

  #completion(
    merchantId: string,
    draft: CommerceDraftOrderV1,
  ): CommerceDraftOrderViewV1["completion"] {
    for (const attempt of this.#checkoutIds(merchantId, draft))
      if (attempt.orderId !== undefined)
        return { checkoutId: attempt.checkoutId, orderId: attempt.orderId };
    return null;
  }

  // The checkouts of a draft have ids made from the draft, its invoiced
  // revisions and an attempt number, so no draft write records them.
  #checkoutIds(
    merchantId: string,
    draft: CommerceDraftOrderV1,
  ): readonly Readonly<{
    checkoutId: string;
    open: boolean;
    orderId?: string;
  }>[] {
    const found: { checkoutId: string; open: boolean; orderId?: string }[] = [];
    const now = Date.parse(this.#options.now());
    for (let revision = 1; revision <= draft.revision; revision += 1) {
      for (let attempt = 1; ; attempt += 1) {
        const checkoutId = draftCheckoutId({ id: draft.id, revision }, attempt);
        const checkout = readCheckout(
          this.#options.database,
          merchantId,
          checkoutId,
        );
        if (checkout === undefined) break;
        const lifecycle = checkout.lifecycle;
        // Checkouts of an earlier revision count only when they made the order.
        if (revision !== draft.revision && lifecycle.state !== "accepted")
          continue;
        found.push({
          checkoutId,
          open:
            lifecycle.state === "payment_pending" ||
            (lifecycle.state === "quoted" &&
              now < Date.parse(lifecycle.quote.expiresAt)),
          ...(lifecycle.state === "accepted"
            ? { orderId: lifecycle.orderId }
            : {}),
        });
      }
    }
    return found;
  }

  #read(
    merchantId: string,
    draftOrderId: string,
  ): CommerceDraftOrderV1 | undefined {
    return readDraftOrder(this.#options.database, merchantId, draftOrderId);
  }
}

export function readDraftOrder(
  database: CommerceDatabase,
  merchantId: string,
  draftOrderId: string,
): CommerceDraftOrderV1 | undefined {
  const row = database
    .prepare(
      `SELECT draft_json AS draftJson FROM draft_order
       WHERE merchant_id = ? AND draft_order_id = ?`,
    )
    .get<Readonly<{ draftJson: string }>>(merchantId, draftOrderId);
  return row === undefined
    ? undefined
    : parseDraftOrder(JSON.parse(row.draftJson));
}

export function writeDraftOrder(
  database: CommerceDatabase,
  merchantId: string,
  draft: CommerceDraftOrderV1,
): void {
  const written = database
    .prepare(
      `INSERT INTO draft_order (
         merchant_id, draft_order_id, revision, storefront_id,
         lifecycle_state, draft_json, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (merchant_id, draft_order_id) DO UPDATE SET
         revision = excluded.revision,
         lifecycle_state = excluded.lifecycle_state,
         draft_json = excluded.draft_json,
         occurred_at = excluded.occurred_at
       WHERE draft_order.revision = excluded.revision - 1`,
    )
    .run(
      merchantId,
      draft.id,
      draft.revision,
      draft.storefrontId,
      draft.lifecycle.state,
      JSON.stringify(draft),
      draft.occurredAt,
    );
  if (written.changes !== 1)
    throw new Error(`Draft order ${draft.id} moved during the write`);
}

function draftCheckoutPrefix(
  draft: Readonly<{ id: string; revision: number }>,
): string {
  return `checkout_draft_${sha256(`${draft.id}:${draft.revision}`).slice(0, 32)}_`;
}

function draftCheckoutId(
  draft: Readonly<{ id: string; revision: number }>,
  attempt: number,
): string {
  return `${draftCheckoutPrefix(draft)}${attempt}`;
}

function lineError(
  resources: CommerceMerchantSnapshotV1["resources"],
  salesChannelId: string,
  line: CommerceDraftOrderLineV1,
): CommerceMutationErrorV1 | undefined {
  const variant = findResource(resources.variants, line.variantId);
  if (variant === undefined)
    return {
      code: "resource_not_found",
      kind: "sellable_variant",
      id: line.variantId,
    };
  const offer = resources.offers.find(
    (candidate) =>
      candidate.variantId === variant.id &&
      candidate.salesChannelId === salesChannelId &&
      candidate.lifecycle.state === "listed" &&
      candidate.availability.state === "available",
  );
  if (offer === undefined || !variantIsSellable(resources.products, variant))
    return invalid("draftOrder.lines.variant");
  if (
    line.priceOverride !== null &&
    line.priceOverride.unitPrice.currency !== offer.price.currency
  )
    return invalid("draftOrder.lines.priceOverride");
  return undefined;
}

function invalid(field: string): CommerceMutationErrorV1 {
  return { code: "resource_relationship_invalid", field };
}

/** Whether an open or invoiced draft holds this variant in a line. */
export function draftOrderCitesVariant(
  database: CommerceDatabase,
  merchantId: string,
  variantId: string,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 FROM draft_order
         WHERE merchant_id = ? AND instr(draft_json, ?) > 0
           AND lifecycle_state IN ('open', 'invoiced') LIMIT 1`,
      )
      .get(merchantId, variantId) !== undefined
  );
}

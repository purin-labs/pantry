// The commit port of the commerce core. A command plans its change against
// one merchant revision; the ledger signs the delivery and the receipt,
// writes the change, moves the merchant revision and records both in one
// transaction. Every core aggregate and every extension commits through it.
import { type CheckoutCommand } from "./checkout-commands.ts";
import { type PlaceCommerceStoredValueCheckoutV1 } from "./checkout-payment-planning.ts";
import { type OpenCommerceOrderBalanceInternalV1 } from "./order-edits.ts";
import {
  type AdjustCommerceOfferPriceV1,
  type AttachFulfillmentTrackingCommand,
  type BeginCommerceCheckoutPaymentV1,
  type CancelCommerceOrderV1,
  type CompleteCommercePickupV1,
  type ConfigureCommercePickupStorefrontV1,
  type ConfigureCommerceShippingStorefrontV1,
  type CreateCommerceInventoryItemV1,
  type CreateCommerceLocationV1,
  type CreateCommercePickupCheckoutV1,
  type CreateCommerceWebhookSubscriptionV1,
  type EditCommerceOrderV1,
  type RecordCommerceOrderManualPaymentV1,
  type ExpireCommerceCheckoutV1,
  type MarkCommercePickupReadyV1,
  type ObserveCommercePaymentDisputeV1,
  type OpenCommerceInventoryPositionV1,
  type PlaceCommerceChannelListingV1,
  type PlaceCommercePaidCheckoutV1,
  type PrepareCommerceCatalogListingV1,
  type PublishCommerceCatalogListingV1,
  type PurchaseShippingLabelCommand,
  type ReceiveCommerceInventoryV3,
  type ReconcileCommerceInventoryV1,
  type RecordShippingTrackingCommand,
  type RecordCommerceCheckoutPaymentCaptureV1,
  type RecordCommerceCounterManualCashRefundV1,
  type RefundCommerceOrderV1,
  type ResolveCommerceCheckoutPaymentV1,
  type CommerceWebhookSubscriptionCommandV1,
  type SetCommercePluginFieldValuesV1,
  type CommercePluginCommandV1,
  type ConfigureCommercePluginV1,
  type RunCommercePluginActionV1,
  type InstallCommerceMerchantPluginV1,
  type UpdateCommerceOfferV1,
  type UpdateCommerceStorefrontTaxV1,
  type UpdateCommerceProductDescriptionV1,
  type UpdateCommerceProductV1,
  type DeleteCommerceProductV1,
  type UpdateCommerceVariantV1,
} from "@seams/commerce-client";
import { createHash } from "node:crypto";
import { canonicalJson } from "@seams/std";

import { commandPrincipal } from "../plugins/command-principal.ts";
import { commandActor } from "../command-actor.ts";
import type { PluginFailureCommand } from "../plugins/plugin-authority.ts";
import type { BuiltInPluginCommand } from "../plugins/registry.ts";

import {
  parseMutationResult,
  commerceDeliverySignaturePayload,
  type CommerceAggregateObservationV1,
  type CommerceDeliveryV1,
  type CommerceMutationErrorV1,
  type CommerceMutationReceiptV1,
  type CommerceMutationResultV1,
} from "@seams/commerce-client";

import type { CommerceDatabase } from "../database.ts";
import { invalidCommand } from "./command-guards.ts";
import type { CommerceSigner } from "./contracts.ts";
import type { MerchantCommandPorts } from "./merchant-command.ts";

export type MerchantRow = Readonly<{
  merchantId: string;
  organisationId: string;
  revision: number;
}>;

/** Every command that the core commits. */
type MutationCommand =
  | BuiltInPluginCommand
  | AdjustCommerceOfferPriceV1
  | CreateCommerceLocationV1
  | PrepareCommerceCatalogListingV1
  | UpdateCommerceProductDescriptionV1
  | UpdateCommerceProductV1
  | DeleteCommerceProductV1
  | UpdateCommerceVariantV1
  | UpdateCommerceOfferV1
  | UpdateCommerceStorefrontTaxV1
  | EditCommerceOrderV1
  | RecordCommerceOrderManualPaymentV1
  | OpenCommerceOrderBalanceInternalV1
  | CreateCommerceWebhookSubscriptionV1
  | CommerceWebhookSubscriptionCommandV1
  | CommercePluginCommandV1
  | ConfigureCommercePluginV1
  | RunCommercePluginActionV1
  | InstallCommerceMerchantPluginV1
  | PluginFailureCommand
  | SetCommercePluginFieldValuesV1
  | PlaceCommerceChannelListingV1
  | ConfigureCommercePickupStorefrontV1
  | ConfigureCommerceShippingStorefrontV1
  | CheckoutCommand
  | CreateCommercePickupCheckoutV1
  | BeginCommerceCheckoutPaymentV1
  | RecordCommerceCheckoutPaymentCaptureV1
  | ObserveCommercePaymentDisputeV1
  | PlaceCommercePaidCheckoutV1
  | PlaceCommerceStoredValueCheckoutV1
  | MarkCommercePickupReadyV1
  | CompleteCommercePickupV1
  | ResolveCommerceCheckoutPaymentV1
  | ExpireCommerceCheckoutV1
  | PublishCommerceCatalogListingV1
  | CreateCommerceInventoryItemV1
  | OpenCommerceInventoryPositionV1
  | ReceiveCommerceInventoryV3
  | ReconcileCommerceInventoryV1
  | PurchaseShippingLabelCommand
  | AttachFulfillmentTrackingCommand
  | RecordShippingTrackingCommand
  | CancelCommerceOrderV1
  | RefundCommerceOrderV1
  | RecordCommerceCounterManualCashRefundV1;

/** A command that carries its own idempotency key. */
type CommittedCommand = MutationCommand & Readonly<{ idempotencyKey: string }>;

/** One planned change of one merchant, as the ledger commits it. */
export type CommerceMutation = Readonly<
  {
    merchant: MerchantRow;
    committedAt: string;
    commandKind: CommerceMutationReceiptV1["commandKind"];
    /** The effect name of the receipt's effect id, when it is not the command kind. */
    effectName?: string;
    resource: CommerceMutationReceiptV1["resource"];
    observations: readonly CommerceAggregateObservationV1[];
    /**
     * False while a refund stays processing or indeterminate: the command may
     * be retried, so no receipt answers it yet.
     */
    recordReceipt?: boolean;
    /**
     * The aggregate rows, written inside the commit transaction. A refusal
     * found under the transaction's read ends the commit with no change.
     */
    write: (database: CommerceDatabase) => CommerceMutationErrorV1 | void;
  } & (
    | Readonly<{ command: CommittedCommand; providerDeliveryId?: undefined }>
    // A provider event has no action nonce: its delivery id keys the
    // receipt and the effect.
    | Readonly<{
        command: ObserveCommercePaymentDisputeV1;
        providerDeliveryId: string;
      }>
  )
>;

/**
 * A change that holds a merchant revision and a delivery before an outside
 * effect, with no receipt yet: the receipt comes with the resolution.
 */
export type CommerceReservation = Readonly<{
  command: CommittedCommand;
  merchant: MerchantRow;
  committedAt: string;
  commandDigest: string;
  observations: readonly CommerceAggregateObservationV1[];
  write: (database: CommerceDatabase) => void;
}>;

type StoredCommandRow = Readonly<{
  commandDigest: string;
  receiptJson: string;
}>;

export class CommerceLedger {
  readonly #database: CommerceDatabase;
  readonly #signer: CommerceSigner;
  /** What every command authority takes from the ledger. */
  readonly commandPorts: MerchantCommandPorts<MutationCommand>;

  constructor(database: CommerceDatabase, signer: CommerceSigner) {
    this.#database = database;
    this.#signer = signer;
    this.commandPorts = {
      readMerchant: this.readMerchant.bind(this),
      readReplay: this.readReplay.bind(this),
      validateMerchant,
      rejected,
      invalidCommand,
    };
  }

  commit(mutation: CommerceMutation): CommerceMutationResultV1 {
    const { command, merchant, committedAt } = mutation;
    const key = receiptKey(mutation);
    const merchantRevision = merchant.revision + 1;
    // A merchant plugin's handler or action submits the command.
    const principal = commandPrincipal.getStore();
    // The request that committed it, when one did (Plan 80 step 3).
    const actor = commandActor.getStore();
    const delivery = signDelivery(
      buildDeliveryBase({
        merchantId: command.merchantId,
        merchantRevision,
        observedAt: committedAt,
        observations: [...mutation.observations],
        commandDigest: commandDigest(command),
      }),
      this.#signer,
    );
    const receipt = signReceipt(
      {
        schemaVersion: "underclerk.mutation-receipt.v2",
        receiptId: `receipt_${sha256(`${command.merchantId}:${key.idempotencyKey}`)}`,
        effectId: `effect_${sha256(`${command.merchantId}:${key.idempotencyKey}:${mutation.effectName ?? mutation.commandKind}`)}`,
        commandKind: mutation.commandKind,
        merchantId: command.merchantId,
        idempotencyKey: key.idempotencyKey,
        previousMerchantRevision: merchant.revision,
        merchantRevision,
        deliveryId: delivery.deliveryId,
        resource: mutation.resource,
        committedAt,
        ...(principal === undefined ? {} : { principal }),
        ...(actor === undefined ? {} : { actor }),
      },
      this.#signer,
    );
    try {
      return this.#database.transaction(() => {
        const refused = mutation.write(this.#database);
        // Throwing rolls back every row that the write wrote before it
        // refused.
        if (refused !== undefined) throw new RefusedWrite(refused);
        this.commitMerchantRevision(
          command.merchantId,
          merchant,
          merchantRevision,
          committedAt,
        );
        if (mutation.recordReceipt !== false)
          this.insertReceipt(
            command.merchantId,
            key.idempotencyKey,
            command,
            receipt,
          );
        this.insertDelivery(delivery);
        return { outcome: "applied", receipt };
      });
    } catch (error) {
      if (error instanceof RefusedWrite) return rejected(error.refusal);
      throw error;
    }
  }

  reserve(reservation: CommerceReservation): void {
    const { command, merchant, committedAt } = reservation;
    const merchantRevision = merchant.revision + 1;
    const delivery = signDelivery(
      buildDeliveryBase({
        merchantId: command.merchantId,
        merchantRevision,
        observedAt: committedAt,
        observations: [...reservation.observations],
        commandDigest: reservation.commandDigest,
      }),
      this.#signer,
    );
    this.#database.transaction(() => {
      reservation.write(this.#database);
      this.commitMerchantRevision(
        command.merchantId,
        merchant,
        merchantRevision,
        committedAt,
      );
      this.insertDelivery(delivery);
    });
  }

  readMerchant(merchantId: string): MerchantRow | undefined {
    return this.#database
      .prepare(
        `SELECT merchant_id AS merchantId, external_reference AS organisationId, revision
         FROM merchant WHERE merchant_id = ?`,
      )
      .get<MerchantRow>(merchantId);
  }

  readReplay(
    merchantId: string,
    idempotencyKey: string,
    command: MutationCommand,
  ): CommerceMutationResultV1 | undefined {
    const row = this.#database
      .prepare(
        `SELECT command_digest AS commandDigest, receipt_json AS receiptJson
         FROM command_receipt WHERE merchant_id = ? AND idempotency_key = ?`,
      )
      .get<StoredCommandRow>(merchantId, idempotencyKey);
    if (row === undefined) return undefined;
    if (row.commandDigest !== commandDigest(command)) {
      return rejected({ code: "idempotency_conflict", idempotencyKey });
    }
    return {
      outcome: "replayed",
      receipt: parseStoredReceipt(row.receiptJson),
    };
  }

  /**
   * The result stored under a key, whatever the command: a merchant plugin
   * handler's retry keeps its key while the record it read moved on.
   */
  readReceiptOfKey(
    merchantId: string,
    idempotencyKey: string,
  ): CommerceMutationResultV1 | undefined {
    const row = this.#database
      .prepare(
        `SELECT receipt_json AS receiptJson FROM command_receipt
         WHERE merchant_id = ? AND idempotency_key = ?`,
      )
      .get<Readonly<{ receiptJson: string }>>(merchantId, idempotencyKey);
    return row === undefined
      ? undefined
      : { outcome: "replayed", receipt: parseStoredReceipt(row.receiptJson) };
  }

  /** Moves the merchant revision; the caller holds the transaction. */
  commitMerchantRevision(
    merchantId: string,
    merchant: MerchantRow,
    merchantRevision: number,
    committedAt: string,
  ): void {
    const updated = this.#database
      .prepare(
        "UPDATE merchant SET revision = ?, updated_at = ? WHERE merchant_id = ? AND revision = ?",
      )
      .run(merchantRevision, committedAt, merchantId, merchant.revision);
    if (updated.changes !== 1)
      throw new Error("Merchant revision changed during commerce commit");
  }

  insertReceipt(
    merchantId: string,
    idempotencyKey: string,
    command: MutationCommand,
    receipt: CommerceMutationReceiptV1,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO command_receipt (
           merchant_id, idempotency_key, command_digest, receipt_json, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        idempotencyKey,
        commandDigest(command),
        JSON.stringify(receipt),
        receipt.committedAt,
      );
  }

  insertDelivery(delivery: CommerceDeliveryV1): void {
    this.#database
      .prepare(
        `INSERT INTO observation_outbox (
           delivery_id, merchant_id, merchant_revision, delivery_json, status, created_at
         ) VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        delivery.deliveryId,
        delivery.merchantId,
        delivery.merchantRevision,
        JSON.stringify(delivery),
        delivery.observedAt,
      );
  }
}

function receiptKey(mutation: CommerceMutation): Readonly<{
  idempotencyKey: string;
}> {
  return {
    idempotencyKey:
      mutation.providerDeliveryId ?? mutation.command.idempotencyKey,
  };
}

function buildDeliveryBase(
  input: Readonly<{
    merchantId: string;
    merchantRevision: number;
    observedAt: string;
    observations: readonly CommerceAggregateObservationV1[];
    commandDigest: string;
  }>,
): Omit<DeliveryV2, "signer"> {
  return {
    schemaVersion: "underclerk.commerce-delivery.v2",
    deliveryId: `delivery_${sha256(`${input.merchantId}:${input.merchantRevision}:${input.commandDigest}`)}`,
    merchantId: input.merchantId,
    merchantRevision: input.merchantRevision,
    observedAt: input.observedAt,
    observations: input.observations,
  };
}

/** What the ledger signs now (Plan 80 step 2); stored version 1 stays. */
type DeliveryV2 = Extract<
  CommerceDeliveryV1,
  { schemaVersion: "underclerk.commerce-delivery.v2" }
>;
type ReceiptV2 = Extract<
  CommerceMutationReceiptV1,
  { schemaVersion: "underclerk.mutation-receipt.v2" }
>;

function signDelivery(
  delivery: Omit<DeliveryV2, "signer">,
  signer: CommerceSigner,
): DeliveryV2 {
  const unsigned: DeliveryV2 = {
    ...delivery,
    signer: {
      keyId: signer.keyId,
      algorithm: "ed25519",
      signature: "pending",
    },
  };
  return {
    ...unsigned,
    signer: {
      ...unsigned.signer,
      signature: signer.sign(commerceDeliverySignaturePayload(unsigned)),
    },
  };
}

function signReceipt(
  receipt: Omit<ReceiptV2, "signer">,
  signer: CommerceSigner,
): ReceiptV2 {
  return {
    ...receipt,
    signer: {
      keyId: signer.keyId,
      algorithm: "ed25519",
      signature: signer.sign(Buffer.from(JSON.stringify(receipt))),
    },
  };
}

export function rejected(
  error: CommerceMutationErrorV1,
): CommerceMutationResultV1 {
  return { outcome: "rejected", error };
}

/** Carries a write's refusal out of the commit transaction, which rolls back. */
class RefusedWrite extends Error {
  readonly refusal: CommerceMutationErrorV1;

  constructor(refusal: CommerceMutationErrorV1) {
    super(`The commit write refused: ${refusal.code}`);
    this.refusal = refusal;
  }
}

export function validateMerchant(
  merchantId: string,
  merchant: MerchantRow | undefined,
): CommerceMutationErrorV1 | undefined {
  return merchant === undefined
    ? { code: "merchant_not_found", merchantId }
    : undefined;
}

export function commandDigest(command: MutationCommand): string {
  if (command.schemaVersion === "underclerk.create-pickup-checkout.v1") {
    return sha256(
      JSON.stringify({
        schemaVersion: command.schemaVersion,
        merchantId: command.merchantId,
        idempotencyKey: command.idempotencyKey,
        storefrontId: command.storefrontId,
        storefrontRevision: command.storefrontRevision,
        checkoutProfile: command.checkoutProfile,
        buyerSessionDigest: command.buyerSessionDigest,
        buyerAuthority: command.buyerAuthority,
        cartId: command.cartId,
        checkoutId: command.checkoutId,
        lines: command.lines,
      }),
    );
  }
  if (command.schemaVersion === "underclerk.submit-buyer-pickup-cart.v1") {
    return sha256(
      JSON.stringify({
        schemaVersion: command.schemaVersion,
        merchantId: command.merchantId,
        idempotencyKey: command.idempotencyKey,
        storefrontId: command.storefrontId,
        storefrontRevision: command.storefrontRevision,
        checkoutProfile: command.checkoutProfile,
        buyerSessionDigest: command.buyerSessionDigest,
        buyerAuthority: command.buyerAuthority,
        cartId: command.cartId,
        cartRevision: command.cartRevision,
        checkoutId: command.checkoutId,
        lines: command.lines,
        ...(command.priceOverrides === undefined
          ? {}
          : { priceOverrides: command.priceOverrides }),
        ...(command.discount === undefined
          ? {}
          : { discount: command.discount }),
        ...(command.marketId === undefined
          ? {}
          : { marketId: command.marketId }),
        ...(command.pickupAt === undefined
          ? {}
          : { pickupAt: command.pickupAt }),
      }),
    );
  }
  if (
    command.schemaVersion ===
    "underclerk.create-buyer-shipping-checkout.internal.v1"
  ) {
    return sha256(
      JSON.stringify({
        schemaVersion: command.schemaVersion,
        merchantId: command.merchantId,
        idempotencyKey: command.idempotencyKey,
        storefrontId: command.storefrontId,
        storefrontRevision: command.storefrontRevision,
        checkoutProfile: command.checkoutProfile,
        buyerSessionDigest: command.buyerSessionDigest,
        buyerAuthority: command.buyerAuthority,
        cartId: command.cartId,
        cartRevision: command.cartRevision,
        checkoutId: command.checkoutId,
        lines: command.lines,
        shippingServiceCode: command.shippingServiceCode,
        shippingDestination: command.shippingDestination,
        ...(command.marketId === undefined
          ? {}
          : { marketId: command.marketId }),
      }),
    );
  }
  return digestOfCommand(command);
}

/**
 * The digest that tells a replay from a new command under the same
 * idempotency key: the command without the time of the request, which the
 * server's clock gives (Plan 80 step 1), in canonical JSON, so that the
 * order of the fields does not matter.
 */
export function digestOfCommand(command: Readonly<object>): string {
  const fields: Record<string, unknown> = { ...command };
  delete fields.requestedAt;
  return sha256(canonicalJson(fields));
}

function parseStoredReceipt(value: string): CommerceMutationReceiptV1 {
  const result = parseMutationResult({
    outcome: "applied",
    receipt: JSON.parse(value),
  });
  if (result.outcome === "rejected")
    throw new Error("Stored receipt was rejected");
  return result.receipt;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

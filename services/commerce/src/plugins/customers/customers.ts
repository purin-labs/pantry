import { randomInt, timingSafeEqual } from "node:crypto";

import {
  parseCreateCustomerCommand,
  parseEraseCustomerCommand,
  parseUpdateCustomerCommand,
  type CommerceBuyerCustomerV1,
  type CommerceCustomerAddressInputV1,
  type CommerceCustomerAddressV1,
  type CommerceCustomerCommandV1,
  type CommerceCustomerV1,
  type CommerceMarketingConsentV1,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
  type CommerceNotificationV1,
  type CommerceOrderV1,
  type CommerceShipmentV1,
} from "@seams/commerce-client";

import {
  commerceTransition,
  type CommerceMachineEvent,
} from "@seams/commerce-contracts";

import { readRefundAttempt } from "../../payments/payment-records.ts";
import { listOrders, listShipments } from "../../commerce-persistence.ts";
import { refundAttemptMoney } from "../../payments/position.ts";
import type { CustomerVault, SealedCustomerKey } from "./customer-vault.ts";
import type { CommerceDatabase } from "../../database.ts";
import type { NotificationGateway } from "../../notification-gateway.ts";
import { sha256 } from "../../commerce-authority/checkout-shared.ts";
import type { MerchantRow } from "../../commerce-authority/ledger.ts";
import {
  beginMerchantCommand,
  type MerchantCommandPorts,
} from "../../commerce-authority/merchant-command.ts";

export type CustomerCommitRequest = Readonly<{
  command: CommerceCustomerCommandV1;
  merchant: MerchantRow;
  customerId: string;
  revision: number;
  /** The table writes, run inside the commit's transaction. */
  write: () => void;
}>;

type CustomerAuthorityOptions =
  MerchantCommandPorts<CommerceCustomerCommandV1> &
    Readonly<{
      database: CommerceDatabase;
      /** Absent when the Worker has no customer data secret: no accounts. */
      vault: CustomerVault | undefined;
      now: () => string;
      /** Removes what other plugins keep about the customer, in the erasure. */
      onErase?: (merchantId: string, customerId: string) => void;
      commit: (request: CustomerCommitRequest) => CommerceMutationResultV1;
    }>;

export type CheckoutBuyer =
  | Readonly<{ kind: "guest"; email: string }>
  | Readonly<{ kind: "customer"; customerId: string }>;

export type SignInVerification =
  | Readonly<{ kind: "verified"; customerId: string }>
  | Readonly<{ kind: "rejected"; reason: "expired" | "code" | "attempts" }>;

type Profile = Readonly<{
  email: string;
  name: string | null;
  phone: string | null;
  note: string | null;
  addresses: readonly CommerceCustomerAddressV1[];
}>;

type PublicFields = Readonly<{
  account: "none" | "enabled";
  tags: readonly string[];
  marketing: Readonly<{
    email: CommerceMarketingConsentV1;
    sms: CommerceMarketingConsentV1;
  }>;
}>;

type CustomerRow = Readonly<{
  customerId: string;
  revision: number;
  state: "active" | "erased";
  emailLookup: string | null;
  sealedProfile: string | null;
  publicJson: string;
  createdAt: string;
  occurredAt: string;
}>;

type OpenCustomer = Readonly<{
  row: CustomerRow;
  key: SealedCustomerKey;
  profile: Profile;
  fields: PublicFields;
}>;

const SIGN_IN_LIFETIME_MS = 10 * 60 * 1_000;
const SIGN_IN_ATTEMPTS = 5;
const SEND_ATTEMPTS = 5;
const PROFILE_FIELD = "profile";

const NO_CONSENT: CommerceMarketingConsentV1 = {
  state: "not_subscribed",
  updatedAt: null,
  source: null,
};

const ERASED_FIELDS: PublicFields = {
  account: "none",
  tags: [],
  marketing: { email: NO_CONSENT, sms: NO_CONSENT },
};

export class CustomerAuthority {
  readonly #options: CustomerAuthorityOptions;

  constructor(options: CustomerAuthorityOptions) {
    this.#options = options;
  }

  createCustomer(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(
      rawCommand,
      parseCreateCustomerCommand,
      (command, vault) => {
        const { merchantId } = command;
        if (this.#row(merchantId, command.customerId) !== undefined)
          return {
            code: "resource_already_exists",
            kind: "customer",
            id: command.customerId,
          };
        const lookup = vault.lookup(merchantId, "email", command.email);
        if (this.#rowByLookup(merchantId, lookup) !== undefined)
          return invalid("customer.email.taken");
        const key = vault.newCustomerKey(merchantId, command.customerId);
        return {
          customerId: command.customerId,
          revision: 1,
          write: () =>
            this.#insert(merchantId, command.customerId, lookup, key, {
              profile: {
                email: command.email,
                name: command.name,
                phone: command.phone,
                note: command.note,
                addresses: [],
              },
              fields: { ...ERASED_FIELDS, tags: command.tags },
              at: command.requestedAt,
            }),
        };
      },
    );
  }

  updateCustomer(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseUpdateCustomerCommand, (command) => {
      const current = this.#current(
        command.merchantId,
        command.customerId,
        command.expectedRevision,
        "update",
      );
      if ("code" in current) return current;
      const { changes } = command;
      const consent = (
        previous: CommerceMarketingConsentV1,
        state: CommerceMarketingConsentV1["state"] | undefined,
      ): CommerceMarketingConsentV1 =>
        state === undefined || state === previous.state
          ? previous
          : { state, updatedAt: command.requestedAt, source: "staff" };
      const profile: Profile = {
        ...current.profile,
        ...("name" in changes ? { name: changes.name ?? null } : {}),
        ...("phone" in changes ? { phone: changes.phone ?? null } : {}),
        ...("note" in changes ? { note: changes.note ?? null } : {}),
      };
      const fields: PublicFields = {
        ...current.fields,
        ...(changes.tags === undefined ? {} : { tags: changes.tags }),
        marketing: {
          email: consent(
            current.fields.marketing.email,
            changes.marketing?.email,
          ),
          sms: consent(current.fields.marketing.sms, changes.marketing?.sms),
        },
      };
      return {
        customerId: command.customerId,
        revision: current.row.revision + 1,
        write: () =>
          this.#rewrite(
            command.merchantId,
            current,
            profile,
            fields,
            command.requestedAt,
          ),
      };
    });
  }

  eraseCustomer(rawCommand: unknown): CommerceMutationResultV1 {
    return this.#run(rawCommand, parseEraseCustomerCommand, (command) => {
      const current = this.#current(
        command.merchantId,
        command.customerId,
        command.expectedRevision,
        "erase",
      );
      if ("code" in current) return current;
      return {
        customerId: command.customerId,
        revision: current.row.revision + 1,
        write: () =>
          this.#erase(command.merchantId, current, command.requestedAt),
      };
    });
  }

  readCustomer(
    merchantId: string,
    customerId: string,
  ): CommerceCustomerV1 | undefined {
    const row = this.#row(merchantId, customerId);
    if (row === undefined) return undefined;
    const orderIds = this.#linked(merchantId, customerId, "order").map(
      (link) => link.subjectId,
    );
    const opened =
      row.state === "active" ? this.#open(merchantId, row) : undefined;
    const fields = opened?.fields ?? ERASED_FIELDS;
    return {
      id: row.customerId,
      revision: row.revision,
      state: row.state,
      account: fields.account,
      email: opened?.profile.email ?? null,
      name: opened?.profile.name ?? null,
      phone: opened?.profile.phone ?? null,
      note: opened?.profile.note ?? null,
      addresses: opened?.profile.addresses ?? [],
      tags: fields.tags,
      marketing: fields.marketing,
      orderIds,
      createdAt: row.createdAt,
      occurredAt: row.occurredAt,
    };
  }

  /**
   * Links a checkout to its buyer's customer. A guest email finds the
   * merchant's customer for that email, or makes one, so a buyer who signs
   * in later sees the orders they placed as a guest.
   */
  recordCheckoutBuyer(
    merchantId: string,
    checkoutId: string,
    buyer: CheckoutBuyer,
  ): void {
    const vault = this.#options.vault;
    if (vault === undefined) return;
    const at = this.#options.now();
    const customerId =
      buyer.kind === "customer"
        ? buyer.customerId
        : this.#findOrCreate(merchantId, vault, buyer.email, "none", at);
    if (this.#row(merchantId, customerId)?.state !== "active") return;
    this.#options.database
      .prepare(
        `INSERT OR IGNORE INTO customer_link (
           merchant_id, subject_kind, subject_id, customer_id, linked_at
         ) VALUES (?, 'checkout', ?, ?, ?)`,
      )
      .run(merchantId, checkoutId, customerId, at);
  }

  /**
   * Inside the placement transaction: links the order to the checkout's
   * customer and queues the confirmation email.
   */
  linkPlacedOrder(
    merchantId: string,
    order: CommerceOrderV1,
    checkoutId: string,
    at: string,
  ): void {
    const fromBuyer =
      order.buyer.kind === "identified" &&
      this.#row(merchantId, order.buyer.customerReference)?.state === "active"
        ? order.buyer.customerReference
        : undefined;
    const customerId =
      fromBuyer ??
      this.#linkFor(merchantId, "checkout", checkoutId)?.customerId;
    if (customerId === undefined) return;
    this.#options.database
      .prepare(
        `INSERT OR IGNORE INTO customer_link (
           merchant_id, subject_kind, subject_id, customer_id, linked_at
         ) VALUES (?, 'order', ?, ?, ?)`,
      )
      .run(merchantId, order.id, customerId, at);
    this.#enqueue(merchantId, "order_confirmation", {
      orderId: order.id,
      customerId,
      at,
    });
  }

  /** Whether this merchant can seal buyer data in customer records. */
  get sealsBuyers(): boolean {
    return this.#options.vault !== undefined;
  }

  /**
   * Inside a commit: the customer that seals this buyer email, made when
   * none exists. A draft order keeps the customer instead of the email.
   */
  sealBuyerEmail(merchantId: string, email: string, at: string): string {
    return this.#findOrCreate(
      merchantId,
      this.#requireVault(),
      email,
      "none",
      at,
    );
  }

  /** The email of an active customer; null once the customer is erased. */
  customerEmail(merchantId: string, customerId: string): string | null {
    const row = this.#row(merchantId, customerId);
    if (row === undefined || row.state !== "active") return null;
    return this.#open(merchantId, row).profile.email;
  }

  /** The customer of an email, without making one. */
  findCustomerId(merchantId: string, email: string): string | null {
    const vault = this.#options.vault;
    if (vault === undefined) return null;
    return (
      this.#rowByLookup(merchantId, vault.lookup(merchantId, "email", email))
        ?.customerId ?? null
    );
  }

  /** The customer a placed order or a checkout belongs to. */
  customerIdFor(
    merchantId: string,
    subjectKind: "checkout" | "order",
    subjectId: string,
  ): string | null {
    return (
      this.#linkFor(merchantId, subjectKind, subjectId)?.customerId ?? null
    );
  }

  /** Inside a fulfilment transaction: tells the buyer the order is ready. */
  notifyOrderReady(merchantId: string, orderId: string, at: string): void {
    const link = this.#linkFor(merchantId, "order", orderId);
    if (link === undefined) return;
    this.#enqueue(merchantId, "ready_for_pickup", {
      orderId,
      customerId: link.customerId,
      at,
    });
  }

  /** Inside a shipping transaction: tells the buyer the order left. */
  notifyOrderShipped(merchantId: string, orderId: string, at: string): void {
    const link = this.#linkFor(merchantId, "order", orderId);
    if (link === undefined) return;
    this.#enqueue(merchantId, "order_shipped", {
      orderId,
      customerId: link.customerId,
      at,
    });
  }

  /** Inside a refund transaction: tells the buyer what came back. */
  notifyRefundIssued(
    merchantId: string,
    orderId: string,
    refundAttemptId: string,
    at: string,
  ): void {
    const link = this.#linkFor(merchantId, "order", orderId);
    if (link === undefined) return;
    this.#enqueue(merchantId, "refund_issued", {
      orderId,
      customerId: link.customerId,
      refundAttemptId,
      at,
    });
  }

  /** Sends a six-digit code to the email address; codes last ten minutes. */
  requestSignIn(
    merchantId: string,
    storefrontId: string,
    email: string,
  ): Readonly<{ challengeId: string; expiresAt: string }> | undefined {
    const vault = this.#options.vault;
    if (vault === undefined) return undefined;
    const at = this.#options.now();
    const lookup = vault.lookup(merchantId, "email", email);
    // Erasure deletes challenges, so the never-shrinking outbox numbers them.
    const count = this.#count("notification_outbox", merchantId);
    const challengeId = `sign_in_${sha256(`${merchantId}:${lookup}:${count}`).slice(0, 32)}`;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(
      Date.parse(at) + SIGN_IN_LIFETIME_MS,
    ).toISOString();
    this.#options.database.transaction(() => {
      this.#options.database
        .prepare(
          `INSERT INTO customer_sign_in (
             merchant_id, challenge_id, storefront_id, email_lookup, code_digest,
             sealed_message, attempts, expires_at, consumed_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)`,
        )
        .run(
          merchantId,
          challengeId,
          storefrontId,
          lookup,
          vault.codeDigest(merchantId, challengeId, code),
          vault.sealForMerchant(merchantId, `sign_in:${challengeId}`, {
            email,
            code,
          }),
          expiresAt,
          at,
        );
      this.#enqueue(merchantId, "sign_in_code", { challengeId, at });
    });
    return { challengeId, expiresAt };
  }

  verifySignIn(
    merchantId: string,
    storefrontId: string,
    challengeId: string,
    code: string,
  ): SignInVerification {
    const vault = this.#options.vault;
    const { database } = this.#options;
    const row = database
      .prepare(
        `SELECT email_lookup AS emailLookup, code_digest AS codeDigest,
                sealed_message AS sealedMessage, attempts,
                expires_at AS expiresAt, consumed_at AS consumedAt
         FROM customer_sign_in
         WHERE merchant_id = ? AND challenge_id = ? AND storefront_id = ?`,
      )
      .get<
        Readonly<{
          emailLookup: string;
          codeDigest: string;
          sealedMessage: string | null;
          attempts: number;
          expiresAt: string;
          consumedAt: string | null;
        }>
      >(merchantId, challengeId, storefrontId);
    const at = this.#options.now();
    if (
      vault === undefined ||
      row === undefined ||
      row.consumedAt !== null ||
      row.sealedMessage === null ||
      Date.parse(row.expiresAt) <= Date.parse(at)
    )
      return { kind: "rejected", reason: "expired" };
    if (row.attempts >= SIGN_IN_ATTEMPTS)
      return { kind: "rejected", reason: "attempts" };
    const expected = Buffer.from(row.codeDigest, "hex");
    const actual = Buffer.from(
      vault.codeDigest(merchantId, challengeId, code),
      "hex",
    );
    if (!timingSafeEqual(expected, actual)) {
      database
        .prepare(
          `UPDATE customer_sign_in SET attempts = attempts + 1
           WHERE merchant_id = ? AND challenge_id = ?`,
        )
        .run(merchantId, challengeId);
      return { kind: "rejected", reason: "code" };
    }
    const message = vault.openForMerchant(
      merchantId,
      `sign_in:${challengeId}`,
      row.sealedMessage,
    ) as Readonly<{ email: string }>;
    return database.transaction(() => {
      database
        .prepare(
          `UPDATE customer_sign_in
           SET consumed_at = ?, sealed_message = NULL
           WHERE merchant_id = ? AND challenge_id = ?`,
        )
        .run(at, merchantId, challengeId);
      const customerId = this.#findOrCreate(
        merchantId,
        vault,
        message.email,
        "enabled",
        at,
      );
      return { kind: "verified" as const, customerId };
    });
  }

  /** The signed-in buyer's email, or undefined once erased. */
  identifyCustomer(
    merchantId: string,
    customerId: string,
  ): Readonly<{ email: string }> | undefined {
    const row = this.#row(merchantId, customerId);
    if (row?.state !== "active") return undefined;
    return { email: this.#open(merchantId, row).profile.email };
  }

  /** One of the customer's saved addresses, or undefined once erased. */
  savedAddress(
    merchantId: string,
    customerId: string,
    addressId: string,
  ): CommerceCustomerAddressV1 | undefined {
    const row = this.#row(merchantId, customerId);
    if (row?.state !== "active") return undefined;
    return this.#open(merchantId, row).profile.addresses.find(
      (address) => address.addressId === addressId,
    );
  }

  buyerCustomer(
    merchantId: string,
    customerId: string,
  ): CommerceBuyerCustomerV1 | undefined {
    const row = this.#row(merchantId, customerId);
    if (row?.state !== "active") return undefined;
    const { profile } = this.#open(merchantId, row);
    const links = this.#linked(merchantId, customerId, "order");
    const orders = new Map(
      listOrders(this.#options.database, merchantId).map((order) => [
        order.id,
        order,
      ]),
    );
    return {
      schemaVersion: "underclerk.buyer-customer.v1",
      email: profile.email,
      name: profile.name,
      addresses: profile.addresses,
      orders: links.flatMap((link) => {
        const order = orders.get(link.subjectId);
        return order === undefined
          ? []
          : [
              {
                orderId: order.id,
                placedAt: link.linkedAt,
                total: order.totals.total,
                state: order.lifecycle.state,
              },
            ];
      }),
    };
  }

  saveAddress(
    merchantId: string,
    customerId: string,
    address: CommerceCustomerAddressInputV1,
  ): CommerceBuyerCustomerV1 | undefined {
    const row = this.#row(merchantId, customerId);
    if (row?.state !== "active") return undefined;
    const current = this.#open(merchantId, row);
    const profile: Profile = {
      ...current.profile,
      addresses: [
        ...current.profile.addresses,
        {
          addressId: `address_${current.profile.addresses.length + 1}`,
          ...address,
        },
      ],
    };
    this.#options.database.transaction(() =>
      this.#rewrite(
        merchantId,
        current,
        profile,
        current.fields,
        this.#options.now(),
      ),
    );
    return this.buyerCustomer(merchantId, customerId);
  }

  listNotifications(merchantId: string): readonly CommerceNotificationV1[] {
    return this.#options.database
      .prepare(
        `SELECT notification_id AS notificationId, kind, order_id AS orderId,
                customer_id AS customerId, status, attempts,
                provider_message_id AS providerMessageId,
                created_at AS createdAt, sent_at AS sentAt
         FROM notification_outbox WHERE merchant_id = ?
         ORDER BY created_at, rowid`,
      )
      .all<CommerceNotificationV1>(merchantId);
  }

  /**
   * Sends waiting notifications. The recipient is read at send time, so an
   * erased customer's waiting email is dropped, not sent.
   */
  async deliverNotifications(gateway: NotificationGateway): Promise<number> {
    const { database } = this.#options;
    const pending = database
      .prepare(
        `SELECT merchant_id AS merchantId, notification_id AS notificationId,
                kind, order_id AS orderId, customer_id AS customerId,
                challenge_id AS challengeId, refund_attempt_id AS refundAttemptId,
                attempts
         FROM notification_outbox WHERE status = 'pending'
         ORDER BY created_at, rowid LIMIT 25`,
      )
      .all<
        Readonly<{
          merchantId: string;
          notificationId: string;
          kind: CommerceNotificationV1["kind"];
          orderId: string | null;
          customerId: string | null;
          challengeId: string | null;
          refundAttemptId: string | null;
          attempts: number;
        }>
      >();
    let sent = 0;
    for (const item of pending) {
      const message = this.#compose(item);
      if (message === undefined) {
        this.#settle(
          item.merchantId,
          item.notificationId,
          "dropped",
          item.attempts,
          null,
        );
        continue;
      }
      const result = await gateway.send({
        notificationId: item.notificationId,
        ...message,
      });
      if (result.kind === "sent") {
        sent += 1;
        this.#settle(
          item.merchantId,
          item.notificationId,
          "sent",
          item.attempts + 1,
          result.providerMessageId,
        );
      } else {
        this.#settle(
          item.merchantId,
          item.notificationId,
          item.attempts + 1 >= SEND_ATTEMPTS ? "failed" : "pending",
          item.attempts + 1,
          null,
        );
      }
    }
    return sent;
  }

  #compose(
    item: Readonly<{
      merchantId: string;
      kind: CommerceNotificationV1["kind"];
      orderId: string | null;
      customerId: string | null;
      challengeId: string | null;
      refundAttemptId: string | null;
    }>,
  ): Readonly<{ to: string; subject: string; text: string }> | undefined {
    const vault = this.#options.vault;
    if (vault === undefined) return undefined;
    if (item.kind === "sign_in_code") {
      const row = this.#options.database
        .prepare(
          `SELECT sealed_message AS sealedMessage, expires_at AS expiresAt
           FROM customer_sign_in WHERE merchant_id = ? AND challenge_id = ?`,
        )
        .get<Readonly<{ sealedMessage: string | null; expiresAt: string }>>(
          item.merchantId,
          item.challengeId ?? "",
        );
      if (
        row?.sealedMessage == null ||
        Date.parse(row.expiresAt) <= Date.parse(this.#options.now())
      )
        return undefined;
      const message = vault.openForMerchant(
        item.merchantId,
        `sign_in:${item.challengeId}`,
        row.sealedMessage,
      ) as Readonly<{ email: string; code: string }>;
      return {
        to: message.email,
        subject: "Your sign-in code",
        text: `Your sign-in code is ${message.code}. It expires in 10 minutes.`,
      };
    }
    const row =
      item.customerId === null
        ? undefined
        : this.#row(item.merchantId, item.customerId);
    if (row?.state !== "active" || item.orderId === null) return undefined;
    const { profile } = this.#open(item.merchantId, row);
    const order = listOrders(this.#options.database, item.merchantId).find(
      (candidate) => candidate.id === item.orderId,
    );
    if (order === undefined) return undefined;
    const total = `${order.totals.total.amountMinor} ${order.totals.total.currency}`;
    switch (item.kind) {
      case "order_confirmation":
        return {
          to: profile.email,
          subject: "Order confirmed",
          text: `Your order ${order.id} is confirmed. Total: ${total}.`,
        };
      case "ready_for_pickup":
        return {
          to: profile.email,
          subject: "Your order is ready",
          text: `Your order ${order.id} is ready for pickup.`,
        };
      case "order_shipped": {
        const tracking = listShipments(this.#options.database, item.merchantId)
          .filter((shipment) => shipment.orderId === order.id)
          .map(trackingNumberOf)
          .find((number) => number !== null);
        return {
          to: profile.email,
          subject: "Your order is on its way",
          text:
            tracking === undefined
              ? `Your order ${order.id} has shipped.`
              : `Your order ${order.id} has shipped. Tracking number: ${tracking}.`,
        };
      }
      case "refund_issued": {
        const stored =
          item.refundAttemptId === null
            ? undefined
            : readRefundAttempt(
                this.#options.database,
                item.merchantId,
                item.refundAttemptId,
              );
        if (stored === undefined) return undefined;
        const amount = refundAttemptMoney(stored.attempt);
        return {
          to: profile.email,
          subject: "Your refund",
          text: `We refunded ${amount.amountMinor} ${amount.currency} for your order ${order.id}.`,
        };
      }
    }
  }

  #settle(
    merchantId: string,
    notificationId: string,
    status: CommerceNotificationV1["status"],
    attempts: number,
    providerMessageId: string | null,
  ): void {
    this.#options.database
      .prepare(
        `UPDATE notification_outbox
         SET status = ?, attempts = ?, provider_message_id = ?,
             sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END
         WHERE merchant_id = ? AND notification_id = ?`,
      )
      .run(
        status,
        attempts,
        providerMessageId,
        status,
        this.#options.now(),
        merchantId,
        notificationId,
      );
  }

  #enqueue(
    merchantId: string,
    kind: CommerceNotificationV1["kind"],
    input: Readonly<{
      orderId?: string;
      customerId?: string;
      challengeId?: string;
      refundAttemptId?: string;
      at: string;
    }>,
  ): void {
    // One message of each kind per order, but one per refund.
    const subject =
      input.challengeId ?? input.refundAttemptId ?? input.orderId ?? "";
    this.#options.database
      .prepare(
        `INSERT OR IGNORE INTO notification_outbox (
           merchant_id, notification_id, kind, order_id, customer_id,
           challenge_id, refund_attempt_id, status, attempts,
           provider_message_id, created_at, sent_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, NULL)`,
      )
      .run(
        merchantId,
        `notification_${sha256(`${merchantId}:${kind}:${subject}`).slice(0, 32)}`,
        kind,
        input.orderId ?? null,
        input.customerId ?? null,
        input.challengeId ?? null,
        input.refundAttemptId ?? null,
        input.at,
      );
  }

  #findOrCreate(
    merchantId: string,
    vault: CustomerVault,
    email: string,
    account: PublicFields["account"],
    at: string,
  ): string {
    const lookup = vault.lookup(merchantId, "email", email);
    const existing = this.#rowByLookup(merchantId, lookup);
    if (existing !== undefined) {
      if (account === "enabled") {
        const current = this.#open(merchantId, existing);
        if (current.fields.account !== "enabled")
          this.#rewrite(
            merchantId,
            current,
            current.profile,
            { ...current.fields, account },
            at,
          );
      }
      return existing.customerId;
    }
    const customerId = `customer_${sha256(
      `${merchantId}:${lookup}:${this.#count("customer", merchantId)}`,
    ).slice(0, 32)}`;
    this.#insert(
      merchantId,
      customerId,
      lookup,
      vault.newCustomerKey(merchantId, customerId),
      {
        profile: { email, name: null, phone: null, note: null, addresses: [] },
        fields: { ...ERASED_FIELDS, account },
        at,
      },
    );
    return customerId;
  }

  #insert(
    merchantId: string,
    customerId: string,
    lookup: string,
    key: SealedCustomerKey,
    input: Readonly<{ profile: Profile; fields: PublicFields; at: string }>,
  ): void {
    const vault = this.#requireVault();
    const { database } = this.#options;
    database
      .prepare(
        `INSERT INTO customer (
           merchant_id, customer_id, revision, state, email_lookup,
           sealed_profile, public_json, created_at, occurred_at
         ) VALUES (?, ?, 1, 'active', ?, ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        customerId,
        lookup,
        vault.sealForCustomer(
          merchantId,
          customerId,
          key,
          PROFILE_FIELD,
          input.profile,
        ),
        JSON.stringify(input.fields),
        input.at,
        input.at,
      );
    database
      .prepare(
        `INSERT INTO customer_key (merchant_id, customer_id, key_version, wrapped_key)
         VALUES (?, ?, ?, ?)`,
      )
      .run(merchantId, customerId, key.version, key.wrapped);
  }

  #rewrite(
    merchantId: string,
    current: OpenCustomer,
    profile: Profile,
    fields: PublicFields,
    at: string,
  ): void {
    const vault = this.#requireVault();
    const written = this.#options.database
      .prepare(
        `UPDATE customer
         SET revision = revision + 1, sealed_profile = ?, public_json = ?,
             occurred_at = ?
         WHERE merchant_id = ? AND customer_id = ? AND revision = ?
           AND state = 'active'`,
      )
      .run(
        vault.sealForCustomer(
          merchantId,
          current.row.customerId,
          current.key,
          PROFILE_FIELD,
          profile,
        ),
        JSON.stringify(fields),
        at,
        merchantId,
        current.row.customerId,
        current.row.revision,
      );
    if (written.changes !== 1)
      throw new Error(
        `Customer ${current.row.customerId} moved during the write`,
      );
  }

  // Erasure removes the key, the lookup value and the sealed profile. Links
  // keep only identifiers; a waiting email to the customer is dropped, and
  // other plugins drop what they keep about the customer.
  #erase(merchantId: string, current: OpenCustomer, at: string): void {
    const { database } = this.#options;
    const { customerId } = current.row;
    const written = database
      .prepare(
        `UPDATE customer
         SET revision = revision + 1, state = 'erased', email_lookup = NULL,
             sealed_profile = NULL, public_json = ?, occurred_at = ?
         WHERE merchant_id = ? AND customer_id = ? AND revision = ?`,
      )
      .run(
        JSON.stringify(ERASED_FIELDS),
        at,
        merchantId,
        customerId,
        current.row.revision,
      );
    if (written.changes !== 1)
      throw new Error(`Customer ${customerId} moved during erasure`);
    database
      .prepare(
        "DELETE FROM customer_key WHERE merchant_id = ? AND customer_id = ?",
      )
      .run(merchantId, customerId);
    if (current.row.emailLookup !== null)
      database
        .prepare(
          "DELETE FROM customer_sign_in WHERE merchant_id = ? AND email_lookup = ?",
        )
        .run(merchantId, current.row.emailLookup);
    database
      .prepare(
        `UPDATE notification_outbox SET status = 'dropped'
         WHERE merchant_id = ? AND customer_id = ? AND status = 'pending'`,
      )
      .run(merchantId, customerId);
    this.#options.onErase?.(merchantId, customerId);
  }

  #run<TCommand extends CommerceCustomerCommandV1>(
    rawCommand: unknown,
    parse: (value: unknown) => TCommand,
    plan: (
      command: TCommand,
      vault: CustomerVault,
    ) =>
      | Omit<CustomerCommitRequest, "command" | "merchant">
      | CommerceMutationErrorV1,
  ): CommerceMutationResultV1 {
    const start = beginMerchantCommand(this.#options, rawCommand, parse);
    if (start.kind !== "ready") return start.result;
    const { command, merchant } = start;
    const vault = this.#options.vault;
    if (vault === undefined)
      return this.#options.rejected(invalid("customer.accountsDisabled"));
    const planned = plan(command, vault);
    if ("code" in planned) return this.#options.rejected(planned);
    return this.#options.commit({ command, merchant, ...planned });
  }

  #current(
    merchantId: string,
    customerId: string,
    expectedRevision: number,
    event: CommerceMachineEvent<"customer">,
  ): OpenCustomer | CommerceMutationErrorV1 {
    const row = this.#row(merchantId, customerId);
    if (row === undefined)
      return { code: "resource_not_found", kind: "customer", id: customerId };
    if (row.revision !== expectedRevision)
      return {
        code: "stale_resource_revision",
        kind: "customer",
        id: customerId,
        expected: expectedRevision,
        actual: row.revision,
      };
    const move = commerceTransition("customer", { state: row.state }, event);
    if (!move.allowed) return move.refusal;
    return this.#open(merchantId, row);
  }

  #open(merchantId: string, row: CustomerRow): OpenCustomer {
    const vault = this.#requireVault();
    const keyRow = this.#options.database
      .prepare(
        `SELECT key_version AS version, wrapped_key AS wrapped FROM customer_key
         WHERE merchant_id = ? AND customer_id = ?`,
      )
      .get<SealedCustomerKey>(merchantId, row.customerId);
    if (keyRow === undefined || row.sealedProfile === null)
      throw new Error(`Customer ${row.customerId} lost its key`);
    return {
      row,
      key: keyRow,
      profile: vault.openForCustomer(
        merchantId,
        row.customerId,
        keyRow,
        PROFILE_FIELD,
        row.sealedProfile,
      ) as Profile,
      fields: JSON.parse(row.publicJson) as PublicFields,
    };
  }

  #row(merchantId: string, customerId: string): CustomerRow | undefined {
    return this.#options.database
      .prepare(`${CUSTOMER_COLUMNS} WHERE merchant_id = ? AND customer_id = ?`)
      .get<CustomerRow>(merchantId, customerId);
  }

  #rowByLookup(merchantId: string, lookup: string): CustomerRow | undefined {
    return this.#options.database
      .prepare(`${CUSTOMER_COLUMNS} WHERE merchant_id = ? AND email_lookup = ?`)
      .get<CustomerRow>(merchantId, lookup);
  }

  #linkFor(
    merchantId: string,
    subjectKind: "checkout" | "order",
    subjectId: string,
  ): Readonly<{ customerId: string }> | undefined {
    return this.#options.database
      .prepare(
        `SELECT customer_id AS customerId FROM customer_link
         WHERE merchant_id = ? AND subject_kind = ? AND subject_id = ?`,
      )
      .get<Readonly<{ customerId: string }>>(
        merchantId,
        subjectKind,
        subjectId,
      );
  }

  #linked(
    merchantId: string,
    customerId: string,
    subjectKind: "checkout" | "order",
  ): readonly Readonly<{ subjectId: string; linkedAt: string }>[] {
    return this.#options.database
      .prepare(
        `SELECT subject_id AS subjectId, linked_at AS linkedAt FROM customer_link
         WHERE merchant_id = ? AND customer_id = ? AND subject_kind = ?
         ORDER BY linked_at, rowid`,
      )
      .all<Readonly<{ subjectId: string; linkedAt: string }>>(
        merchantId,
        customerId,
        subjectKind,
      );
  }

  #count(
    table: "customer" | "notification_outbox",
    merchantId: string,
  ): number {
    return (
      this.#options.database
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE merchant_id = ?`)
        .get<Readonly<{ count: number }>>(merchantId)?.count ?? 0
    );
  }

  #requireVault(): CustomerVault {
    const vault = this.#options.vault;
    if (vault === undefined) throw new Error("Customer accounts are disabled");
    return vault;
  }
}

const CUSTOMER_COLUMNS = `SELECT customer_id AS customerId, revision, state,
  email_lookup AS emailLookup, sealed_profile AS sealedProfile,
  public_json AS publicJson, created_at AS createdAt, occurred_at AS occurredAt
  FROM customer`;

function invalid(field: string): CommerceMutationErrorV1 {
  return { code: "resource_relationship_invalid", field };
}

function trackingNumberOf(shipment: CommerceShipmentV1): string | null {
  if (shipment.kind === "external") return shipment.trackingNumber;
  return "trackingNumber" in shipment.lifecycle
    ? shipment.lifecycle.trackingNumber
    : null;
}

/** Whether the merchant has this customer, not erased. */
export function customerIsActive(
  database: CommerceDatabase,
  merchantId: string,
  customerId: string,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS found FROM customer
         WHERE merchant_id = ? AND customer_id = ? AND state = 'active'`,
      )
      .get<Readonly<{ found: number }>>(merchantId, customerId) !== undefined
  );
}

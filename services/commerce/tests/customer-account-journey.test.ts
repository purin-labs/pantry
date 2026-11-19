// Plan 76A step 3: a guest buys and gets a confirmation email; the same
// buyer signs in with an email code, sees the guest order, saves an address
// and buys again; staff update, export and erase the customer. After erasure
// no table and no database file byte holds the buyer's personal data, and a
// new sign-in starts a new customer. Set CUSTOMER_ARTIFACT_DIR to keep the
// run's evidence; the file repeats byte for byte for the same commit.
import { existsSync, readFileSync } from "node:fs";

import type {
  CommerceAdminClient,
  CommerceMutationResultV1,
  CommerceStorefrontClient,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  STOREFRONT,
  StaffDesk,
  catalogLine,
  merchantId,
  rejectedWith,
  rejectionOf,
  required,
  startBackend,
  writeEvidence,
  type EmailOutbox,
  type Evidence,
} from "./journey-support.ts";

const EMAIL = "ana@example.test";
const NAME = "Ana Tanaka";
const PHONE = "+81-90-1234-5678";
const STREET = "1-2-3 Kanda Jimbocho";

it(
  "signs a guest in, links their orders and erases them on request",
  { timeout: 60_000 },
  customerAccountLifecycle,
);

async function customerAccountLifecycle(): Promise<void> {
  const backend = await startBackend({ customers: true });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer, emails } = backend;
    const staff = new CustomerStaff(admin);
    await staff.createTea();

    // Ana buys as a guest and gets a confirmation email.
    const guest = await Buyer.start(buyer, "ana");
    const guestOrder = await guest.buyLines([
      catalogLine("variant_tea_small_sencha"),
    ]);
    expect(emails.sent.map((email) => [email.to, email.subject])).toEqual([
      [EMAIL, "Order confirmed"],
    ]);
    expect(emails.sent[0]?.text).toContain(guestOrder);

    // Ana signs in with the code from her email. A wrong code is refused.
    const firstAccess = await signIn(buyer, emails, " Ana@Example.test ", {
      wrongCodeFirst: true,
    });
    const account = await required(
      buyer.readCustomer(merchantId, STOREFRONT, firstAccess),
    );
    expect(account.email).toBe(EMAIL);
    expect(account.orders.map((order) => order.orderId)).toEqual([guestOrder]);

    // She saves an address and buys again while signed in.
    const saved = await required(
      buyer.saveCustomerAddress(merchantId, STOREFRONT, firstAccess, {
        schemaVersion: "underclerk.save-customer-address.v1",
        address: {
          recipient: NAME,
          line1: STREET,
          line2: null,
          locality: "Chiyoda",
          region: "Tokyo",
          postalCode: "101-0051",
          countryCode: "JP",
        },
      }),
    );
    expect(saved.addresses.map((address) => address.line1)).toEqual([STREET]);
    const signedIn = await Buyer.signedIn(buyer, "ana_account", firstAccess);
    const accountOrder = await signedIn.buyLines([
      catalogLine("variant_tea_large_sencha"),
    ]);
    expect(
      (await required(buyer.readCustomer(merchantId, STOREFRONT, firstAccess)))
        .orders.map((order) => order.orderId),
    ).toEqual([guestOrder, accountOrder]);
    expect(emails.sent.at(-1)).toMatchObject({
      to: EMAIL,
      subject: "Order confirmed",
    });

    // Staff find the customer from the order and complete the record.
    const customerId = await staff.customerOf(accountOrder);
    expect(
      await staff.update(customerId, 3, {
        name: NAME,
        phone: PHONE,
        tags: ["regular"],
        marketing: { email: "subscribed" },
      }),
    ).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "update_customer", resource: { revision: 4 } },
    });
    const exported = await required(admin.exportCustomer(merchantId, customerId));
    expect(exported.customer).toMatchObject({
      email: EMAIL,
      name: NAME,
      phone: PHONE,
      account: "enabled",
      tags: ["regular"],
      orderIds: [guestOrder, accountOrder],
    });
    expect(exported.customer.marketing.email).toMatchObject({
      state: "subscribed",
      source: "staff",
    });
    // A change from an old revision is refused.
    expect(await staff.update(customerId, 3, { note: "late" })).toMatchObject(
      rejectedWith({ code: "stale_resource_revision" }),
    );

    // Staff mark the second order ready; Ana gets that email too.
    await staff.markReady(accountOrder);
    expect(emails.sent.at(-1)).toMatchObject({
      to: EMAIL,
      subject: "Your order is ready",
    });
    const ordersBefore = await staff.orderTotals([guestOrder, accountOrder]);

    // Ana asks to be forgotten. Staff erase her.
    expect(await staff.erase(customerId, 4)).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "erase_customer", resource: { revision: 5 } },
    });
    const erased = await required(admin.readCustomer(merchantId, customerId));
    expect(erased).toMatchObject({
      state: "erased",
      email: null,
      name: null,
      phone: null,
      note: null,
      addresses: [],
      tags: [],
      orderIds: [guestOrder, accountOrder],
    });
    // Her old access token no longer works, for reads or new sessions.
    expect(
      await buyer.readCustomer(merchantId, STOREFRONT, firstAccess),
    ).toMatchObject({ ok: false, error: { kind: "http", status: 401 } });
    expect(
      await buyer.createSession(merchantId, STOREFRONT, {
        schemaVersion: "underclerk.create-buyer-session.v1",
        buyer: { kind: "identified_customer", customerAccessToken: firstAccess },
      }),
    ).toMatchObject({ ok: false, error: { kind: "http", status: 401 } });
    // No table row and no byte of the database files holds her data.
    for (const secret of [EMAIL, NAME, PHONE, STREET]) {
      expect(tableText(backend.database)).not.toContain(secret);
      expect(fileText(backend.databasePath)).not.toContain(secret);
    }
    // Orders and their totals do not change.
    expect(await staff.orderTotals([guestOrder, accountOrder])).toEqual(
      ordersBefore,
    );

    // A new sign-in with the same email starts a new, empty customer.
    const secondAccess = await signIn(buyer, emails, EMAIL);
    const fresh = await required(
      buyer.readCustomer(merchantId, STOREFRONT, secondAccess),
    );
    expect(fresh).toMatchObject({ email: EMAIL, addresses: [], orders: [] });
    const notifications = await required(admin.listNotifications(merchantId));
    expect(
      notifications.map((item) => [item.kind, item.status]),
    ).toEqual([
      ["order_confirmation", "sent"],
      ["sign_in_code", "sent"],
      ["order_confirmation", "sent"],
      ["ready_for_pickup", "sent"],
      ["sign_in_code", "sent"],
    ]);

    Object.assign(evidence, {
      receipts: staff.receipts,
      emails: emails.sent.map((email) => ({ to: email.to, subject: email.subject })),
      notifications,
      erased,
      ordersAfterErasure: await staff.orderTotals([guestOrder, accountOrder]),
    });
  } finally {
    writeEvidence("CUSTOMER_ARTIFACT_DIR", "customer-account", evidence);
    backend.close();
  }
}

async function signIn(
  buyer: CommerceStorefrontClient,
  emails: EmailOutbox,
  email: string,
  options: Readonly<{ wrongCodeFirst?: boolean }> = {},
): Promise<string> {
  const challenge = await required(
    buyer.requestCustomerSignIn(merchantId, STOREFRONT, {
      schemaVersion: "underclerk.request-customer-sign-in.v1",
      email,
    }),
  );
  const message = emails.sent.at(-1);
  expect(message).toMatchObject({ to: EMAIL, subject: "Your sign-in code" });
  const code = /\b(\d{6})\b/.exec(message?.text ?? "")?.[1];
  if (code === undefined) throw new Error("The sign-in email has no code");
  if (options.wrongCodeFirst === true) {
    const wrong = code === "000000" ? "000001" : "000000";
    expect(
      rejectionOf(
        await buyer.verifyCustomerSignIn(
          merchantId,
          STOREFRONT,
          challenge.challengeId,
          { schemaVersion: "underclerk.verify-customer-sign-in.v1", code: wrong },
        ),
      ),
    ).toMatchObject({ field: "customerSignIn.code" });
  }
  const access = await required(
    buyer.verifyCustomerSignIn(merchantId, STOREFRONT, challenge.challengeId, {
      schemaVersion: "underclerk.verify-customer-sign-in.v1",
      code,
    }),
  );
  // A code works once.
  expect(
    rejectionOf(
      await buyer.verifyCustomerSignIn(
        merchantId,
        STOREFRONT,
        challenge.challengeId,
        { schemaVersion: "underclerk.verify-customer-sign-in.v1", code },
      ),
    ),
  ).toMatchObject({ field: "customerSignIn.expired" });
  return access.customerAccessToken;
}

function tableText(database: Awaited<ReturnType<typeof startBackend>>["database"]) {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<Readonly<{ name: string }>>();
  return tables
    .map(({ name }) =>
      JSON.stringify(database.prepare(`SELECT * FROM "${name}"`).all()),
    )
    .join("\n");
}

function fileText(path: string): string {
  return [path, `${path}-wal`]
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file).toString("latin1"))
    .join("\n");
}

class CustomerStaff extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "customer");
  }

  async customerOf(orderId: string): Promise<string> {
    const order = (await this.snapshot()).orders.find((item) => item.id === orderId);
    if (order?.buyer.kind !== "identified")
      throw new Error(`${orderId} has no customer`);
    return order.buyer.customerReference;
  }

  update(
    customerId: string,
    expectedRevision: number,
    changes: Parameters<CommerceAdminClient["updateCustomer"]>[0]["changes"],
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.updateCustomer({
        ...this.editBase(`update_${customerId}_${this.step}`),
        customerId,
        expectedRevision,
        changes,
      }),
    );
  }

  erase(
    customerId: string,
    expectedRevision: number,
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.eraseCustomer({
        ...this.editBase(`erase_${customerId}`),
        customerId,
        expectedRevision,
        reason: "Customer asked to be forgotten",
      }),
    );
  }

  async markReady(orderId: string): Promise<void> {
    const resources = await this.snapshot();
    const order = resources.orders.find((item) => item.id === orderId);
    const fulfillment = resources.fulfillments.find(
      (item) => item.orderId === orderId,
    );
    if (order === undefined || fulfillment === undefined)
      throw new Error(`${orderId} is incomplete`);
    await this.apply(
      this.admin.markPickupReady({
        ...(await this.base("pickup_ready")),
        orderId,
        orderRevision: order.revision,
        fulfillmentId: fulfillment.id,
        fulfillmentRevision: fulfillment.revision,
      }),
    );
  }

  async orderTotals(orderIds: readonly string[]) {
    const orders = (await this.snapshot()).orders;
    return orderIds.map((id) => {
      const order = orders.find((item) => item.id === id);
      return [id, order?.totals.total, order?.lineItems.length];
    });
  }
}

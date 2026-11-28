// Plan 95 step 6, journey J6: paid Jev use through Pantry's own Stripe
// account (docs/plan-95-pantry-own-accounts.md). The fake Stripe only records
// each request and answers with an id or an address. The fake TypeSafe only
// records and answers. Product code makes the customer and the Checkout,
// keeps the billing account, admits or refuses each Jev call, counts the
// tokens above the free use and sends the meter event.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { expect, it } from "vitest";
import {
  parseBillingView,
  type BillingView,
} from "@purin-labs/control-api/portal/billing";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { bytesToHex, isRecord } from "@purin-labs/std";

import { controlFetch } from "./chat-journey-support";
import { commerceClient } from "./commerce-support";
import { runArmedAlarm } from "./durable-object-alarm-support";
import { PUBLIC_ORIGIN } from "./hibernatable-socket-support";
import {
  change,
  features,
  installFakes,
  PANTRY_KEY,
  preview,
  seedTokenUse,
  shop,
} from "./jev-journey-support";
import { installMemoryFixture } from "./memory-support";
import { network } from "./network";
import { fixtureDatabase } from "./organisation-database";
import { addOrganisationMember } from "./organisation-fixture";
import {
  installScriptedModel,
  lastScriptedOutput,
  scriptedChat,
} from "./scripted-agent-support";
import { WriteMeter } from "./write-meter";

// The values of vitest.e2e.config.ts.
const BILLING_KEY = "sk_test_pantry_billing_e2e";
const WEBHOOK_SECRET = "whsec_pantrybillinge2e";
const PRICE_ID = "price_pantryjeve2e";

const HOUR_MS = 3_600_000;
/** The input tokens that the free use of the month covers. */
const FREE_TOKENS = 23_809_523;
/** The measured input tokens of each mail call of the fake TypeSafe. */
const MAIL_TOKENS = 60_000;
const RETURN_PATH = "/portal/jev-billing/billing";

type StripeCall = Readonly<{
  key: string;
  path: string;
  form: Readonly<Record<string, string>>;
  idempotencyKey: string | null;
}>;

type FakeStripe = {
  readonly calls: StripeCall[];
  /** The customer ids that the fake gave. */
  readonly customers: string[];
};

it(
  "J6: the owner sets up payment and turns on paid use; a failed payment stops paid use and free use continues; the spending limit stops the next call; a replayed webhook writes nothing; the meter gets only the tokens above the free use; an admin cannot open Checkout",
  paidUseJourney,
  240_000,
);

async function paidUseJourney(): Promise<void> {
  const typeSafe = installFakes(Promise.resolve(), MAIL_TOKENS);
  const stripe = installFakeStripe();
  const { organisationId, owner, accountId } = await shop("p95-billing");
  const admin = await commerceClient("p95-billing-admin");
  await addOrganisationMember(organisationId, admin, "admin");
  await change(organisationId, owner.session, {
    feature: "mail_classification",
    enabled: true,
  });
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });

  // Before payment setup: the owner and the admin read the state, and the
  // Organisation has no billing account and no Stripe object.
  expect(await billing(organisationId, admin.session)).toEqual({
    plan: {
      id: "beta",
      name: "Beta",
      freeJevUseMicrousd: 1_000_000,
      highestSpendingLimitMinor: 1_000,
    },
    open: true,
    paymentState: "none",
    freeUse: {
      usedMicrousd: 0,
      limitMicrousd: 1_000_000,
      resetsAt: (await features(organisationId, owner.session)).allowance
        ?.resetsAt,
    },
    paidUse: {
      enabled: false,
      spentMinor: 0,
      spendingLimitMinor: 500,
      limitReached: false,
    },
  });
  expect(await billingAccountRows(organisationId)).toEqual([]);

  // Denied: the owner cannot turn paid use on before payment is set up.
  const early = await paidUse(organisationId, owner.session, true, 6);
  expect(early.status).toBe(409);
  expect(await early.text()).toContain("jev_payment_setup_required");
  // Denied: an admin cannot open Checkout or the payment page.
  for (const page of ["checkout", "portal"] as const)
    expect(
      (await paymentPage(organisationId, admin.session, page)).status,
    ).toBe(404);
  expect(stripe.calls).toEqual([]);
  expect(await billingAccountRows(organisationId)).toEqual([]);

  // The owner starts payment setup: one Stripe customer and one Checkout in
  // subscription mode with the metered price. Stripe returns to the Portal.
  const checkout = await paymentPage(organisationId, owner.session, "checkout");
  expect(checkout.status, await checkout.clone().text()).toBe(200);
  expect(await checkout.json()).toEqual({
    ok: true,
    url: "https://checkout.stripe.test/session/1",
  });
  const customerId = stripe.customers[0];
  if (customerId === undefined) throw new Error("No Stripe customer");
  expect(stripe.calls.map(pathOf)).toEqual([
    "/v1/customers",
    "/v1/checkout/sessions",
  ]);
  expect(stripe.calls[0]?.form).toMatchObject({
    "metadata[organisation_id]": organisationId,
  });
  expect(stripe.calls[1]?.form).toMatchObject({
    mode: "subscription",
    customer: customerId,
    client_reference_id: organisationId,
    "line_items[0][price]": PRICE_ID,
    success_url: `${PUBLIC_ORIGIN}${RETURN_PATH}`,
  });
  // A second click opens a new Checkout for the same customer.
  expect(
    (await paymentPage(organisationId, owner.session, "checkout")).status,
  ).toBe(200);
  expect(stripe.calls.map(pathOf)).toEqual([
    "/v1/customers",
    "/v1/checkout/sessions",
    "/v1/checkout/sessions",
  ]);
  expect(stripe.calls.every((call) => call.key === BILLING_KEY)).toBe(true);
  expect(await billingAccountRows(organisationId)).toEqual([
    { stripe_customer_id: customerId, payment_state: "none" },
  ]);

  // Denied: an event with a wrong signature changes nothing.
  const started = Math.floor(Date.now() / 1_000) - 100;
  const completed = await signedEvent("checkout.session.completed", started, {
    mode: "subscription",
    customer: customerId,
    subscription: "sub_p95e2e",
  });
  const forged = await sendEvent(
    completed.body,
    `t=${String(completed.timestamp)},v1=${"0".repeat(64)}`,
  );
  expect(forged.status).toBe(400);
  expect((await billing(organisationId, owner.session)).paymentState).toBe(
    "none",
  );
  // Stripe reports the finished Checkout: the payment state is active, and
  // the owner turns on paid use with a limit of 6 cents.
  expect((await sendEvent(completed.body, completed.signature)).status).toBe(
    200,
  );
  expect((await billing(organisationId, admin.session)).paymentState).toBe(
    "active",
  );
  const turnedOn = await paidUse(organisationId, owner.session, true, 6);
  expect(turnedOn.status, await turnedOn.clone().text()).toBe(200);
  // Denied: a limit above the highest limit of the plan.
  expect(
    (await paidUse(organisationId, owner.session, true, 1_001)).status,
  ).toBe(422);

  // A payment fails: the payment state is past_due. Free use continues: a
  // call inside the free use runs.
  const failed = await signedEvent("invoice.payment_failed", started + 10, {
    customer: customerId,
  });
  expect((await sendEvent(failed.body, failed.signature)).status).toBe(200);
  expect((await billing(organisationId, owner.session)).paymentState).toBe(
    "past_due",
  );
  const free = await preview(organisationId, owner.session, accountId, ["m1"]);
  expect(free.status, await free.clone().text()).toBe(200);
  expect(typeSafe).toEqual([{ key: PANTRY_KEY, purpose: "mail" }]);

  // Seed: other Jev use of this month. With the call above, the month is
  // 4,000 tokens under the free use, so the next call needs paid use.
  await runInDurableObject(
    organisation,
    seedTokenUse.bind(
      null,
      organisationId,
      "earlier-free",
      FREE_TOKENS - MAIL_TOKENS - 4_000,
    ),
  );
  // Paid use is stopped while the payment state is past_due: the call fails
  // before any TypeSafe request.
  const unfunded = await preview(organisationId, owner.session, accountId, [
    "m2",
  ]);
  expect(await unfunded.text()).toContain("paid_use_unfunded");
  expect(typeSafe).toHaveLength(1);

  // The invoice is paid: the payment state is active again, and the same
  // call runs as paid use.
  const paid = await signedEvent("invoice.paid", started + 20, {
    customer: customerId,
  });
  expect((await sendEvent(paid.body, paid.signature)).status).toBe(200);
  expect((await billing(organisationId, owner.session)).paymentState).toBe(
    "active",
  );
  const funded = await preview(organisationId, owner.session, accountId, [
    "m2",
  ]);
  expect(funded.status, await funded.clone().text()).toBe(200);
  expect(typeSafe).toHaveLength(2);

  // The month is now 56,000 tokens above the free use: a charge of 1 cent.
  // With the next call's reservation and the 5-cent hold, the charge passes
  // the limit of 6 cents: the call stops before TypeSafe.
  const limited = await preview(organisationId, owner.session, accountId, [
    "m3",
  ]);
  expect(await limited.text()).toContain("spending_limit_reached");
  expect(typeSafe).toHaveLength(2);
  expect((await billing(organisationId, owner.session)).paidUse).toEqual({
    enabled: true,
    spentMinor: 1,
    spendingLimitMinor: 6,
    limitReached: true,
  });

  // A replayed webhook writes nothing: not the newest event again, and not
  // an older event that arrives late.
  const meter = new WriteMeter();
  expect(
    await meter.during(async () => {
      expect((await sendEvent(paid.body, paid.signature)).status).toBe(200);
      expect((await sendEvent(failed.body, failed.signature)).status).toBe(200);
    }),
  ).toEqual({});
  expect((await billing(organisationId, owner.session)).paymentState).toBe(
    "active",
  );

  // The hour closes. The Actor seals it and sends one meter event: the
  // 56,000 mail tokens above the free use, not the 120,000 mail tokens of
  // the hour. No call so far sent a meter event.
  expect(meterEvents(stripe)).toEqual([]);
  const closedHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 3 * HOUR_MS;
  await runInDurableObject(organisation, theHourClosed.bind(null, closedHour));
  await runArmedAlarm(organisation);
  const events = meterEvents(stripe);
  expect(events).toHaveLength(1);
  expect(events[0]?.form).toMatchObject({
    event_name: "pantry_jev_input_tokens",
    "payload[stripe_customer_id]": customerId,
    "payload[value]": "56000",
    timestamp: String(Math.floor((closedHour + HOUR_MS - 1) / 1_000)),
  });
  expect(await runInDurableObject(organisation, readHours)).toEqual([
    { feature: "mail_classification", inputTokens: 120_000, state: "recorded" },
    {
      feature: "related_cases",
      inputTokens: FREE_TOKENS - MAIL_TOKENS - 4_000,
      state: "not_billed",
    },
  ]);

  // Fault: the Actor lost the receipt of its send and sends the hour again.
  // The event has the same identifier, so Stripe keeps one event.
  await runInDurableObject(organisation, sendTheHourAgain);
  await runArmedAlarm(organisation);
  const repeated = meterEvents(stripe);
  expect(repeated).toHaveLength(2);
  expect(repeated[1]?.form).toEqual(repeated[0]?.form);
  expect(repeated[1]?.idempotencyKey).toBe(repeated[0]?.idempotencyKey);
  expect(repeated[0]?.form.identifier).toMatch(/^jev_[a-f0-9]{64}$/u);

  // The owner opens the payment page for the card and the invoices.
  const portal = await paymentPage(organisationId, owner.session, "portal");
  expect(await portal.json()).toEqual({
    ok: true,
    url: "https://billing.stripe.test/session/1",
  });
  expect(stripe.calls.at(-1)?.form).toEqual({
    customer: customerId,
    return_url: `${PUBLIC_ORIGIN}${RETURN_PATH}`,
  });
}

it(
  "J6: the agent reads the billing state that the page shows, and no tool lets it change billing",
  { timeout: 300_000 },
  async (): Promise<void> => {
    const fixture = await installMemoryFixture();
    const journey = installScriptedModel({
      READBILLING: {
        tool: "billing_account_read",
        args: {},
        ask: ["billing.account.read"],
      },
      FINDBILLING: {
        tool: "tool_search",
        args: {
          query: "billing payment setup checkout spending limit paid use",
          limit: 20,
        },
        ask: [],
      },
    });

    // The read asks first. After the allow, the agent gets the view that
    // Settings › Billing shows to the owner.
    await scriptedChat(fixture, fixture.author, "READBILLING");
    const read = toolValue(lastScriptedOutput(journey, "READBILLING"));
    expect(read).toEqual(
      await billing(fixture.organisationId, fixture.author.session),
    );
    expect(read).toMatchObject({
      plan: { id: "beta" },
      paymentState: "none",
      paidUse: { enabled: false },
    });

    // The agent looks for a tool that changes billing. The search and every
    // turn offer only the read.
    await scriptedChat(fixture, fixture.author, "FINDBILLING");
    const found = lastScriptedOutput(journey, "FINDBILLING");
    // The search answers tool definitions; the model gets them as JSON text.
    const foundNames = [...found.matchAll(/name\\*":\\*"([a-z0-9_]+)/gu)].map(
      (match) => match[1] ?? "",
    );
    expect(foundNames).toContain("billing_account_read");
    const named = new Set(
      [...foundNames, ...journey.offered].filter((name) =>
        /billing|payment|checkout|paid_use|spending/u.test(name),
      ),
    );
    expect([...named]).toEqual(["billing_account_read"]);
  },
);

/** The tool's value, which the model receives as JSON inside JSON. */
function toolValue(raw: string): BillingView {
  const message = JSON.parse(JSON.parse(raw) as string) as { output: string };
  return parseBillingView(JSON.parse(message.output));
}

function pathOf(call: StripeCall): string {
  return call.path;
}

function meterEvents(stripe: FakeStripe): readonly StripeCall[] {
  return stripe.calls.filter(
    (call) => call.path === "/v1/billing/meter_events",
  );
}

/** The fake Stripe: it records each request, and answers an id or an address. */
function installFakeStripe(): FakeStripe {
  const stripe: FakeStripe = { calls: [], customers: [] };
  network.use(
    http.post("https://api.stripe.com/v1/*", async ({ request }) => {
      const path = new URL(request.url).pathname;
      stripe.calls.push({
        key: (request.headers.get("authorization") ?? "").replace(
          /^Bearer /u,
          "",
        ),
        path,
        form: Object.fromEntries(new URLSearchParams(await request.text())),
        idempotencyKey: request.headers.get("idempotency-key"),
      });
      switch (path) {
        case "/v1/customers": {
          const id = `cus_${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;
          stripe.customers.push(id);
          return HttpResponse.json({ id, object: "customer" });
        }
        case "/v1/checkout/sessions":
          return HttpResponse.json({
            id: "cs_test_1",
            url: "https://checkout.stripe.test/session/1",
          });
        case "/v1/billing_portal/sessions":
          return HttpResponse.json({
            id: "bps_1",
            url: "https://billing.stripe.test/session/1",
          });
        case "/v1/billing/meter_events":
          return HttpResponse.json({ object: "billing.meter_event" });
        default:
          return new Response("unknown", { status: 404 });
      }
    }),
  );
  return stripe;
}

/** One Stripe event with the signature of the billing webhook secret. */
async function signedEvent(
  type: string,
  created: number,
  object: Readonly<Record<string, unknown>>,
): Promise<Readonly<{ body: string; timestamp: number; signature: string }>> {
  const body = JSON.stringify({
    id: `evt_${crypto.randomUUID().replaceAll("-", "")}`,
    type,
    created,
    data: { object },
  });
  const timestamp = Math.floor(Date.now() / 1_000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${String(timestamp)}.${body}`),
  );
  return {
    body,
    timestamp,
    signature: `t=${String(timestamp)},v1=${bytesToHex(new Uint8Array(mac))}`,
  };
}

function sendEvent(body: string, signature: string): Promise<Response> {
  return exports.default.fetch(`${PUBLIC_ORIGIN}/webhooks/stripe-billing`, {
    method: "POST",
    headers: { "stripe-signature": signature },
    body,
  });
}

async function billing(
  organisationId: OrganisationId,
  session: IssuedControlSession,
): Promise<BillingView> {
  const response = await controlFetch(organisationId, session, "billing", null);
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  if (!isRecord(raw)) throw new Error("Invalid billing answer");
  return parseBillingView(raw.value);
}

function paymentPage(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  page: "checkout" | "portal",
): Promise<Response> {
  return controlFetch(organisationId, session, `billing/${page}`, {
    returnPath: RETURN_PATH,
  });
}

function paidUse(
  organisationId: OrganisationId,
  session: IssuedControlSession,
  enabled: boolean,
  spendingLimitMinor: number,
): Promise<Response> {
  return controlFetch(organisationId, session, "jev-features/paid-use", {
    enabled,
    spendingLimitMinor,
  });
}

async function billingAccountRows(
  organisationId: OrganisationId,
): Promise<readonly Record<string, unknown>[]> {
  const rows = await fixtureDatabase()
    .prepare(
      "SELECT stripe_customer_id, payment_state FROM organisation_billing_account WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .all<Record<string, unknown>>();
  return rows.results;
}

/**
 * Three hours pass for the Organisation Actor: the Jev use and the paid hold
 * of the journey are in a closed hour, and the alarm is set.
 */
async function theHourClosed(
  closedHour: number,
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  state.storage.sql.exec(
    "UPDATE typesafe_evaluation SET reserved_at = ?, expires_at = ?",
    closedHour + 60_000,
    closedHour + 70_000,
  );
  state.storage.sql.exec("UPDATE jev_paid_hold SET hour_start = ?", closedHour);
  await state.storage.setAlarm(Date.now() + HOUR_MS);
}

/** Fault: the Actor lost the receipt of its send, and the record is due again. */
async function sendTheHourAgain(
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  state.storage.sql.exec(
    "UPDATE jev_usage_hour SET state = 'pending', outcome = NULL, due_at = 0 WHERE state = 'recorded'",
  );
  await state.storage.setAlarm(Date.now() + HOUR_MS);
}

function readHours(
  _actor: unknown,
  state: DurableObjectState,
): readonly { feature: string; inputTokens: number; state: string }[] {
  return state.storage.sql
    .exec<{ feature: string; input_tokens: number; state: string }>(
      "SELECT feature, input_tokens, state FROM jev_usage_hour ORDER BY feature",
    )
    .toArray()
    .map((row) => ({
      feature: row.feature,
      inputTokens: row.input_tokens,
      state: row.state,
    }));
}

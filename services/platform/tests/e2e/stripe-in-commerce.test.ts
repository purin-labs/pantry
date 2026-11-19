import { env, exports } from "cloudflare:workers";
import { HttpResponse, http } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { parseOrganisationId } from "../../src/ids";
import { reconcileProviderManifestObservations } from "../../src/provider-lifecycle/observation";
import {
  commerceClient,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import { network } from "./network";
import { attachSharedAccountNativeOrganisation } from "./shared-account-platform-fixture";
import {
  commerceEngine,
  configurationHeaders,
} from "./commerce-journey-support";

declare module "vitest" {
  interface TaskMeta {
    stripeInUnderclerk?: Record<string, unknown>;
  }
}

const PUBLIC_ORIGIN = "https://localhost";
// Pantry's Connect application and Commerce's platform key are one
// Stripe platform; the fake tells their requests apart by key.
const SATYR_PLATFORM_KEY = "Bearer sk_test_satyr_platform_e2e";
const COMMERCE_PLATFORM_KEY = "Bearer sk_test_underclerk_e2e";
const CONNECTED_TOKEN = "sk_test_cafe_connected";
const CONNECTED_ACCOUNT = "acct_cafeconnected01";
const NEW_ACCOUNT = "acct_cafeonboarding01";

it(
  "opens Stripe onboarding through Underclerk, shows the account active when Stripe finishes it, connects an existing account on a test-mode platform for a production shop, and follows its state",
  { timeout: 180_000 },
  stripeInCommerceJourney,
);

/**
 * Plan 80 step 5. Commerce takes a Pantry shop's online payments with the
 * shop's own Stripe account. A new shop with no Stripe account opens
 * Stripe's hosted onboarding from the Portal: Commerce makes the account
 * once and gives a new link each time. A shop that already has a Stripe
 * account connects it through Stripe Connect; Pantry links that account in
 * Commerce under the shop's online payment binding, and each provider
 * check reads its state again. The shop is a production organisation while
 * Pantry runs on a test-mode Stripe platform, so the platform key decides the
 * Stripe mode. Stripe is a fake that only answers.
 */
async function stripeInCommerceJourney({ task }: TestContext): Promise<void> {
  const stripe = new FakeStripe();
  network.use(
    http.all("https://api.stripe.com/*", ({ request }) =>
      stripe.answer(request),
    ),
    http.post("https://connect.stripe.com/oauth/token", ({ request }) =>
      stripe.exchange(request),
    ),
  );
  const owner = await commerceClient(`stripe-cafe-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(
    owner,
    "Stripe café",
    "production",
  );
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_stripe_cafe_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
    { environment: "production" },
  );
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: {},
  });
  const returnPath = `/portal/${organisationId}/settings?tab=integrations`;

  // 0. The owner first tries Stripe Connect, and Stripe refuses the code.
  //    The Portal shows the failure's support reference.
  stripe.exchangeFailures = 1;
  await connectStripe(
    organisationId,
    owner.session,
    "stripe-cafe-connect-refused",
    "Connection not finished",
  );
  expect(await openSupportReference(organisationId, owner.session)).toEqual(
    expect.objectContaining({ kind: "available" }),
  );

  // 1. The shop has no Stripe account; the owner opens Stripe onboarding.
  const opened = await onboarding(organisationId, owner.session, {
    country: "JP",
    returnPath,
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  expect(record(opened.body).onboardingUrl).toBe(stripe.links[0]?.url);
  expect(stripe.links[0]).toMatchObject({
    account: NEW_ACCOUNT,
    returnUrl: `${PUBLIC_ORIGIN}${returnPath}`,
  });
  // A second visit gets a new link for the same account.
  const reopened = await onboarding(organisationId, owner.session, {
    country: "JP",
    returnPath,
  });
  expect(reopened.status).toBe(200);
  expect(record(reopened.body).onboardingUrl).not.toBe(
    record(opened.body).onboardingUrl,
  );
  expect(stripe.createdAccounts).toEqual([{ country: "jp" }]);
  expect(await paymentAccounts(organisationId, owner.session)).toEqual([
    { providerAccountId: NEW_ACCOUNT, state: "onboarding" },
  ]);

  // 1b. The owner finishes Stripe's form, and Stripe enables charges. The
  //     owner returns to the Portal, which shows the account active.
  stripe.finishOnboarding();
  expect(await paymentAccounts(organisationId, owner.session)).toEqual([
    { providerAccountId: NEW_ACCOUNT, state: "active" },
  ]);
  // The shop takes payments now, so the Portal stops showing the refused
  // Connect.
  expect(await openSupportReference(organisationId, owner.session)).toEqual({
    kind: "none",
  });

  // 2. A return address outside the Portal is refused before Stripe.
  const outside = await onboarding(organisationId, owner.session, {
    country: "JP",
    returnPath: "https://elsewhere.example/portal/",
  });
  expect(outside.status).toBe(422);
  expect(stripe.links).toHaveLength(2);

  // 3. The owner connects the café's existing Stripe account instead.
  //    Stripe has its details but does not take charges yet.
  await connectStripe(organisationId, owner.session);
  const afterConnect = await commerceEngine(merchantId, "payment-accounts");
  expect(
    (afterConnect.accounts as Record<string, unknown>[]).map((account) => ({
      binding: account.paymentProviderBindingId,
      account: account.providerAccountId,
      state: account.state,
    })),
  ).toEqual([
    {
      binding: "payment_binding_primary_online",
      account: CONNECTED_ACCOUNT,
      state: "restricted",
    },
  ]);

  // 4. Stripe enables charges; the next provider check reads the account.
  stripe.chargesEnabled = true;
  const organisation = parseOrganisationId(organisationId);
  if (!organisation.ok) throw new Error("Invalid organisation");
  await reconcileProviderManifestObservations({
    env,
    organisationId: organisation.value,
    now: Date.now(),
    fetcher: fetch,
  });
  expect(await paymentAccounts(organisationId, owner.session)).toEqual([
    { providerAccountId: CONNECTED_ACCOUNT, state: "active" },
  ]);

  task.meta.stripeInUnderclerk = {
    onboarding: {
      accountsCreated: stripe.createdAccounts.length,
      links: stripe.links.length,
      afterStripeForm: "active",
      refusedConnectReferenceAfterActive: "none",
      returnUrl: "<the Portal settings page>",
      outsideReturnPath: outside.status,
    },
    connected: {
      organisationEnvironment: "production",
      stripePlatformMode: "test",
      binding: "payment_binding_primary_online",
      afterConnect: "restricted",
      afterProviderCheck: "active",
      platformReads: stripe.platformReads.length,
    },
  };
}

type FakeRequest = Readonly<{
  url: string;
  method: string;
  headers: Headers;
  text(): Promise<string>;
}>;

/** Stripe as the platform and the café's connected account answer it. */
class FakeStripe {
  readonly createdAccounts: Record<string, unknown>[] = [];
  readonly links: { account: unknown; url: string; returnUrl: unknown }[] = [];
  readonly platformReads: string[] = [];
  chargesEnabled = false;
  exchangeFailures = 0;
  #onboardingFinished = false;

  finishOnboarding(): void {
    this.#onboardingFinished = true;
  }

  async exchange(request: FakeRequest): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    expect(form.get("client_secret")).toBe("sk_test_satyr_platform_e2e");
    if (this.exchangeFailures > 0) {
      this.exchangeFailures -= 1;
      return HttpResponse.json(
        { error: "invalid_grant", error_description: "Code expired" },
        { status: 400 },
      );
    }
    return HttpResponse.json({
      access_token: CONNECTED_TOKEN,
      stripe_user_id: CONNECTED_ACCOUNT,
      scope: "read_write",
    });
  }

  async answer(request: FakeRequest): Promise<Response> {
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");
    if (url.pathname === "/v1/webhook_endpoints/we_e2e") {
      expect(authorization).toBe(SATYR_PLATFORM_KEY);
      return HttpResponse.json({
        id: "we_e2e",
        status: "enabled",
        livemode: false,
        enabled_events: [
          "charge.failed",
          "invoice.payment_failed",
          "refund.failed",
          "customer.subscription.deleted",
          "account.application.deauthorized",
        ],
      });
    }
    const read = /^\/v1\/accounts\/(acct_[A-Za-z0-9]+)$/u.exec(url.pathname);
    if (read !== null && request.method === "GET") {
      const id = read[1] ?? "";
      if (authorization === COMMERCE_PLATFORM_KEY)
        this.platformReads.push(id);
      else expect(authorization).toBe(`Bearer ${CONNECTED_TOKEN}`);
      const onboarded =
        id === NEW_ACCOUNT && this.createdAccounts.length > 0
          ? this.#onboardingFinished
          : null;
      if (id !== CONNECTED_ACCOUNT && onboarded === null)
        return HttpResponse.json(
          { error: { code: "account_invalid" } },
          { status: 403 },
        );
      const chargesEnabled = onboarded ?? this.chargesEnabled;
      return HttpResponse.json({
        object: "account",
        id,
        country: "JP",
        default_currency: "jpy",
        charges_enabled: chargesEnabled,
        details_submitted: onboarded ?? true,
        capabilities: {
          card_payments: chargesEnabled ? "active" : "pending",
        },
        business_profile: { name: "Stripe café" },
      });
    }
    expect(authorization).toBe(COMMERCE_PLATFORM_KEY);
    if (url.pathname === "/v2/core/accounts" && request.method === "POST") {
      const body = record(JSON.parse(await request.text()));
      this.createdAccounts.push({ country: record(body.identity).country });
      return HttpResponse.json({
        object: "v2.core.account",
        id: NEW_ACCOUNT,
        defaults: { currency: "jpy" },
      });
    }
    if (
      url.pathname === "/v2/core/account_links" &&
      request.method === "POST"
    ) {
      const body = record(JSON.parse(await request.text()));
      const onboarding = record(record(body.use_case).account_onboarding);
      const link = {
        account: body.account,
        url: `https://connect.stripe.com/setup/e/${String(body.account)}/${this.links.length + 1}`,
        returnUrl: onboarding.return_url,
      };
      this.links.push(link);
      return HttpResponse.json({
        url: link.url,
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    return HttpResponse.json(
      { error: { code: "resource_missing" } },
      { status: 404 },
    );
  }
}

async function connectStripe(
  organisationId: string,
  session: IssuedControlSession,
  idempotencyKey = "stripe-cafe-connect",
  expectedPage = "satyr.provider-attempt.completed",
): Promise<void> {
  const started = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/providers/stripe/start`,
    {
      method: "POST",
      headers: configurationHeaders(session, idempotencyKey),
      body: JSON.stringify({ returnPath: `/portal/${organisationId}` }),
    },
  );
  expect(started.status, await started.clone().text()).toBe(201);
  const start = (await started.json()) as { authorization_url: string };
  const state = new URL(start.authorization_url).searchParams.get("state");
  if (state === null) throw new Error("The authorization has no state");
  const callback = new URL(
    `${PUBLIC_ORIGIN}/v1/control/providers/stripe/callback`,
  );
  callback.searchParams.set("code", "stripe-code-cafe");
  callback.searchParams.set("state", state);
  const completed = await exports.default.fetch(callback.toString());
  await expect(completed.text()).resolves.toContain(expectedPage);
}

/** The open support reference that the Portal shows, from its organisation read. */
async function openSupportReference(
  organisationId: string,
  session: IssuedControlSession,
): Promise<unknown> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}`,
    {
      headers: {
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        origin: PUBLIC_ORIGIN,
      },
    },
  );
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return record(JSON.parse(body)).support_reference;
}

async function onboarding(
  organisationId: string,
  session: IssuedControlSession,
  body: Record<string, unknown>,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/commerce/payment-accounts/stripe/onboarding`,
    {
      method: "POST",
      headers: configurationHeaders(session, crypto.randomUUID()),
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, body: await response.json() };
}

/** What the Portal's Stripe tile reads. */
async function paymentAccounts(
  organisationId: string,
  session: IssuedControlSession,
): Promise<Record<string, unknown>[]> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/organisations/${organisationId}/commerce/payment-accounts`,
    {
      headers: {
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        origin: PUBLIC_ORIGIN,
      },
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const accounts = record(await response.json()).accounts;
  if (!Array.isArray(accounts)) throw new Error("No accounts");
  return accounts.map((account: unknown) => ({
    providerAccountId: record(account).providerAccountId,
    state: record(account).state,
  }));
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Not a record: ${String(value)}`);
  return value;
}

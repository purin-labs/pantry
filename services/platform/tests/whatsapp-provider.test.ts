import { describe, expect, it, vi } from "vitest";

import {
  whatsappSubscriptionIsLive,
  whatsappExchangeFailure,
} from "../src/provider-workflows/whatsapp-connection";
import {
  resolveWhatsAppApplicationConfiguration,
  resolveWhatsAppEmbeddedSignupCredential,
} from "@purin-labs/connections/whatsapp/application";
import {
  exchangeWhatsAppSignupCode,
  listWhatsAppPhoneNumbers,
  sendWhatsAppText,
  subscribeWhatsAppApp,
  unsubscribeWhatsAppApp,
  WHATSAPP_GRAPH_API_VERSION,
} from "@purin-labs/connections/whatsapp/graph";
import { parseWhatsAppBusinessAccountId } from "@purin-labs/connections/whatsapp/identifiers";
import { createFakeGraph } from "./whatsapp/fake-graph";
import {
  FIXTURE_CUSTOMER_WA_ID,
  FIXTURE_PHONE_NUMBER_ID,
  FIXTURE_WABA_ID,
} from "./whatsapp/fixtures";
import {
  requireWhatsAppCustomerId,
  requireWhatsAppPhoneNumberId,
} from "./test-ids";

/**
 * The trusted provider boundary. These exercise the exact calls onboarding
 * and the send ladder make, at the same `fetcher` seam production uses, and
 * assert that the customer token is used as a credential and never
 * returned, embedded in an error, or placed in a query string.
 */

describe("whatsapp provider boundary", whatsappProviderSuite);

function whatsappProviderSuite(): void {
  it(
    "reads the granted business portfolio and WABA from the signup token",
    signupTest,
  );
  it(
    "accepts a provider-managed business token lifetime",
    providerManagedTokenTest,
  );
  it("refuses a signup that granted no WhatsApp business account", noGrantTest);
  it(
    "gives a signup without business assets its own failure reason",
    assetMissingTest,
  );
  it("discovers phone numbers and skips unusable entries", discoveryTest);
  it("reports subscription failures without throwing", subscriptionFailureTest);
  it("removes the app subscription on revoke", removalTest);
  it("classifies a send timeout as an indeterminate deadline", timeoutTest);
  it(
    "classifies a Graph request timeout separately from transport failure",
    graphTimeoutTest,
  );
  it("honors caller cancellation during a send", callerCancellationTest);
  it(
    "keeps the customer token out of URLs and error values",
    credentialHandlingTest,
  );
  it("reads application and Embedded Signup configuration", configurationTest);
  it(
    "calls the webhook healthy only when Meta reports the app subscribed",
    subscriptionVerificationCases,
  );
}

const CREDENTIAL = {
  appId: "1000000000000001",
  appSecret: "fixture-app-secret-not-a-real-credential",
  customerAccessToken: "fixture-customer-business-token",
} as const;

async function signupTest(): Promise<void> {
  const graph = createFakeGraph();
  const exchanged = await exchangeWhatsAppSignupCode({
    appId: CREDENTIAL.appId,
    appSecret: CREDENTIAL.appSecret,
    code: "signup-code",
    redirectUri: "https://edge.test/v1/control/providers/whatsapp/callback",
    fetcher: graph.fetcher,
  });
  expect(exchanged.ok).toBe(true);
  if (!exchanged.ok) return;
  expect(exchanged.value.assets).toEqual({
    businessPortfolioId: "310000000000001",
    wabaId: FIXTURE_WABA_ID,
    grantedScopes: [
      "whatsapp_business_management",
      "whatsapp_business_messaging",
      "business_management",
    ],
  });
  expect(exchanged.value.credential).toEqual({
    kind: "expiring_bearer",
    value: "fixture-signup-token",
    expiresAt: 1_800_000_000_000,
  });
  const paths = graph.calls().map((call) => call.path);
  expect(paths[0]).toBe(`/${WHATSAPP_GRAPH_API_VERSION}/oauth/access_token`);
  expect(paths[1]).toBe(`/${WHATSAPP_GRAPH_API_VERSION}/debug_token`);
}

async function providerManagedTokenTest(): Promise<void> {
  const exchanged = await exchangeWhatsAppSignupCode({
    appId: CREDENTIAL.appId,
    appSecret: CREDENTIAL.appSecret,
    code: "signup-code",
    redirectUri: "https://edge.test/v1/control/providers/whatsapp/callback",
    fetcher: createFakeGraph({ tokenExpiresAt: 0 }).fetcher,
  });
  expect(exchanged.ok).toBe(true);
  if (!exchanged.ok) return;
  expect(exchanged.value.credential).toEqual({
    kind: "bearer",
    value: "fixture-signup-token",
  });
}

async function noGrantTest(): Promise<void> {
  const graph = createFakeGraph({ grantedWabaId: "not-a-node-id" });
  const exchanged = await exchangeWhatsAppSignupCode({
    appId: CREDENTIAL.appId,
    appSecret: CREDENTIAL.appSecret,
    code: "signup-code",
    redirectUri: "https://edge.test/callback",
    fetcher: graph.fetcher,
  });
  expect(!exchanged.ok && exchanged.error.code).toBe(
    "whatsapp_signup_waba_missing",
  );

  const revoked = createFakeGraph({ tokenRevoked: true });
  const rejected = await exchangeWhatsAppSignupCode({
    appId: CREDENTIAL.appId,
    appSecret: CREDENTIAL.appSecret,
    code: "signup-code",
    redirectUri: "https://edge.test/callback",
    fetcher: revoked.fetcher,
  });
  expect(!rejected.ok && rejected.error.providerCode).toBe("190");
}

function assetMissingTest(): void {
  expect(
    whatsappExchangeFailure({
      code: "whatsapp_signup_waba_missing",
      providerCode: null,
    }),
  ).toEqual({ code: "provider_asset_missing" });
  expect(
    whatsappExchangeFailure({
      code: "whatsapp_signup_portfolio_missing",
      providerCode: null,
    }),
  ).toEqual({ code: "provider_asset_missing" });
  expect(
    whatsappExchangeFailure({
      code: "whatsapp_signup_token_invalid",
      providerCode: "190",
    }),
  ).toEqual({ code: "provider_oauth_response_invalid" });
}

async function discoveryTest(): Promise<void> {
  const graph = createFakeGraph({
    phoneNumbers: [
      {
        id: FIXTURE_PHONE_NUMBER_ID,
        display_phone_number: "+1 555 000-1111",
        verified_name: "Bakery",
      },
      {
        id: "106540352242923",
        display_phone_number: "+15550001112",
        verified_name: "",
      },
      {
        id: "not-a-node-id",
        display_phone_number: "+15550001113",
        verified_name: "Broken",
      },
    ],
  });
  const listed = await listWhatsAppPhoneNumbers({
    wabaId: requireWabaId(FIXTURE_WABA_ID),
    accessToken: CREDENTIAL.customerAccessToken,
    fetcher: graph.fetcher,
  });
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect(listed.value).toEqual([
    {
      phoneNumberId: FIXTURE_PHONE_NUMBER_ID,
      displayPhoneNumber: "+15550001111",
      verifiedName: "Bakery",
    },
    {
      phoneNumberId: "106540352242923",
      displayPhoneNumber: "+15550001112",
      verifiedName: "",
    },
  ]);
}

async function subscriptionFailureTest(): Promise<void> {
  const subscribeFails = createFakeGraph({ subscribeFails: true });
  const subscribed = await subscribeWhatsAppApp({
    wabaId: requireWabaId(FIXTURE_WABA_ID),
    accessToken: CREDENTIAL.customerAccessToken,
    fetcher: subscribeFails.fetcher,
  });
  expect(!subscribed.ok && subscribed.error.providerCode).toBe("100");
}

async function removalTest(): Promise<void> {
  const graph = createFakeGraph();
  const unsubscribed = await unsubscribeWhatsAppApp({
    wabaId: requireWabaId(FIXTURE_WABA_ID),
    accessToken: CREDENTIAL.customerAccessToken,
    fetcher: graph.fetcher,
  });
  expect(unsubscribed.ok).toBe(true);
  expect(graph.calls().map((call) => `${call.method} ${call.path}`)).toEqual([
    `DELETE /${WHATSAPP_GRAPH_API_VERSION}/${FIXTURE_WABA_ID}/subscribed_apps`,
  ]);
}

async function timeoutTest(): Promise<void> {
  const graph = createFakeGraph({ sendOutcomes: [{ kind: "timeout" }] });
  const outcome = await afterRequestDeadline(() =>
    sendWhatsAppText({
      phoneNumberId: requireWhatsAppPhoneNumberId(FIXTURE_PHONE_NUMBER_ID),
      recipientWaId: requireWhatsAppCustomerId(FIXTURE_CUSTOMER_WA_ID),
      body: "Anyone there?",
      accessToken: CREDENTIAL.customerAccessToken,
      fetcher: graph.fetcher,
    }),
  );
  expect(outcome).toEqual({
    kind: "indeterminate",
    reason: "whatsapp_send_timeout",
  });
}

async function graphTimeoutTest(): Promise<void> {
  const exchanged = await afterRequestDeadline(() =>
    exchangeWhatsAppSignupCode({
      appId: CREDENTIAL.appId,
      appSecret: CREDENTIAL.appSecret,
      code: "signup-code",
      redirectUri: "https://edge.test/callback",
      fetcher: timeoutGraphFetcher,
    }),
  );
  expect(exchanged).toEqual({
    ok: false,
    error: { code: "whatsapp_graph_timeout", providerCode: null },
  });
}

async function callerCancellationTest(): Promise<void> {
  const controller = new AbortController();
  const graph = createFakeGraph({ sendOutcomes: [{ kind: "timeout" }] });
  const pending = sendWhatsAppText({
    phoneNumberId: requireWhatsAppPhoneNumberId(FIXTURE_PHONE_NUMBER_ID),
    recipientWaId: requireWhatsAppCustomerId(FIXTURE_CUSTOMER_WA_ID),
    body: "Anyone there?",
    accessToken: CREDENTIAL.customerAccessToken,
    fetcher: graph.fetcher,
    signal: controller.signal,
  });
  controller.abort(new DOMException("cancelled", "AbortError"));
  await expect(pending).resolves.toEqual({
    kind: "indeterminate",
    reason: "whatsapp_send_transport_failed",
  });
}

async function credentialHandlingTest(): Promise<void> {
  const graph = createFakeGraph({
    sendOutcomes: [{ kind: "rejected", status: 400, providerCode: 131_026 }],
  });
  const outcome = await sendWhatsAppText({
    phoneNumberId: requireWhatsAppPhoneNumberId(FIXTURE_PHONE_NUMBER_ID),
    recipientWaId: requireWhatsAppCustomerId(FIXTURE_CUSTOMER_WA_ID),
    body: "Hello",
    accessToken: CREDENTIAL.customerAccessToken,
    fetcher: graph.fetcher,
  });
  expect(JSON.stringify(outcome)).not.toContain(CREDENTIAL.customerAccessToken);
  const sendCall = graph.calls().at(-1);
  // The send carries its credential in the Authorization header, never the URL.
  expect(sendCall?.path).not.toContain(CREDENTIAL.customerAccessToken);
  expect(sendCall?.authorization).toBe(
    `Bearer ${CREDENTIAL.customerAccessToken}`,
  );
  expect(sendCall?.body).not.toContain(CREDENTIAL.customerAccessToken);
}

function configurationTest(): void {
  const env = {
    WHATSAPP_APP_ID: CREDENTIAL.appId,
    WHATSAPP_APP_SECRET: CREDENTIAL.appSecret,
    WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: "3000000000000003",
  };
  const credential = resolveWhatsAppEmbeddedSignupCredential(env);
  expect(credential.ok && credential.value).toEqual({
    appId: CREDENTIAL.appId,
    appSecret: CREDENTIAL.appSecret,
  });
  const configuration = resolveWhatsAppApplicationConfiguration(env);
  expect(configuration.ok && configuration.value.embeddedSignupConfigId).toBe(
    "3000000000000003",
  );

  expect(
    resolveWhatsAppEmbeddedSignupCredential({
      ...env,
      WHATSAPP_APP_SECRET: "  ",
    }).ok,
  ).toBe(false);
  const missing = resolveWhatsAppEmbeddedSignupCredential({
    ...env,
    WHATSAPP_APP_SECRET: undefined,
  });
  expect(!missing.ok && missing.error.code).toBe(
    "whatsapp_application_not_configured",
  );
}

/** Runs the request until its deadline expires on a fake clock. */
async function afterRequestDeadline<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const request = start();
    await vi.runAllTimersAsync();
    return await request;
  } finally {
    vi.useRealTimers();
  }
}

/** A fetch that rejects as AbortError when its signal aborts, as some runtimes do. */
function timeoutGraphFetcher(
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

function requireWabaId(
  raw: string,
): Parameters<typeof listWhatsAppPhoneNumbers>[0]["wabaId"] {
  const parsed = parseWhatsAppBusinessAccountId(raw);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

/**
 * Subscribing and being subscribed are different facts, so onboarding reads
 * the WABA's subscribed-app list back before it calls the webhook healthy.
 */
async function subscriptionVerificationCases(): Promise<void> {
  const live = createFakeGraph({ subscribedAppIds: ["1000000000000001"] });
  expect(
    await whatsappSubscriptionIsLive({
      wabaId: requireWabaId(FIXTURE_WABA_ID),
      appId: "1000000000000001",
      accessToken: CREDENTIAL.customerAccessToken,
      fetcher: live.fetcher,
    }),
  ).toBe(true);

  const other = createFakeGraph({ subscribedAppIds: ["9000000000000009"] });
  expect(
    await whatsappSubscriptionIsLive({
      wabaId: requireWabaId(FIXTURE_WABA_ID),
      appId: "1000000000000001",
      accessToken: CREDENTIAL.customerAccessToken,
      fetcher: other.fetcher,
    }),
  ).toBe(false);

  const unreadable = createFakeGraph({ tokenRevoked: true });
  expect(
    await whatsappSubscriptionIsLive({
      wabaId: requireWabaId(FIXTURE_WABA_ID),
      appId: "1000000000000001",
      accessToken: CREDENTIAL.customerAccessToken,
      fetcher: unreadable.fetcher,
    }),
  ).toBe(false);
}

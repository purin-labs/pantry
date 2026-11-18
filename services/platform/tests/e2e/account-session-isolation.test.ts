import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { http, HttpResponse } from "msw";
import { isRecord } from "@seams/std";
import {
  readAccountOnboardingRequest,
  readAccountOnboardingResult,
} from "@seams/control-api";
import { SESSION_COOKIE, CSRF_COOKIE } from "../../src/control/authorization";
import { readPantryProvisionEnvelope } from "../../src/account-platform/provisioning-boundary";
import { commerceWorkspace } from "./commerce-support";
import { network } from "./network";
import {
  accountFixtureJson,
  accountFixtureRequest,
  applyAccountFixtureProvision,
  bootstrapSharedAccountNativeTenants,
  readSharedAccountFixture,
  type SharedAccountFixtureNativeMember,
} from "./shared-account-platform-fixture";

it(
  "signs in across broken organisations, returns partial authorised results, and preserves invitation and outage denials",
  accountSessionJourney,
  180000,
);

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected response object");
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Expected response text");
  return value;
}

function googleTokenReply(token: string): Response {
  return HttpResponse.json({ id_token: token });
}

function googleJwksReply(publicJwk: Record<string, unknown>): Response {
  return HttpResponse.json({
    keys: [
      {
        ...publicJwk,
        kid: "shared-account-google-e2e",
        alg: "RS256",
        use: "sig",
      },
    ],
  });
}

async function signIn(
  native: SharedAccountFixtureNativeMember,
  returnTo: string,
): Promise<Response> {
  const start = await exports.default.fetch(
    new Request(
      `https://localhost/v1/control/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`,
      { redirect: "manual" },
    ),
  );
  expect(start.status, await start.clone().text()).toBe(302);
  const google = new URL(text(start.headers.get("location")));
  const minted = await accountFixtureRequest("google-login", {
    version: 1,
    native,
    nonce: text(google.searchParams.get("nonce")),
  });
  expect(minted.status).toBe(200);
  const proof = record(await minted.json());
  network.use(
    http.post(
      "https://oauth2.googleapis.com/token",
      googleTokenReply.bind(null, text(proof.token)),
    ),
    http.get(
      "https://www.googleapis.com/oauth2/v3/certs",
      googleJwksReply.bind(null, record(proof.publicJwk)),
    ),
  );
  const callback = new URL("https://localhost/v1/control/auth/google/callback");
  callback.searchParams.set("state", text(google.searchParams.get("state")));
  callback.searchParams.set("code", "isolated-oidc-code");
  return exports.default.fetch(
    new Request(callback, {
      redirect: "manual",
      headers: {
        cookie: text(start.headers.get("set-cookie")).split(";")[0] ?? "",
      },
    }),
  );
}

function sessionCookies(response: Response): string {
  const cookies = text(response.headers.get("set-cookie"));
  const session = cookies.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  const csrf = cookies.match(new RegExp(`${CSRF_COOKIE}=([^;]+)`));
  if (session?.[1] === undefined || csrf?.[1] === undefined)
    throw new Error("Authentication cookies are missing");
  return `${SESSION_COOKIE}=${session[1]}; ${CSRF_COOKIE}=${csrf[1]}`;
}

function controlRead(cookie: string, path: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://localhost${path}`, { headers: { cookie } }),
  );
}

function controlWrite(
  cookie: string,
  path: string,
  body: unknown,
): Promise<Response> {
  const csrf = cookie.match(new RegExp(`${CSRF_COOKIE}=([^;]+)`));
  if (csrf?.[1] === undefined) throw new Error("CSRF cookie missing");
  return exports.default.fetch(
    new Request(`https://localhost${path}`, {
      method: "POST",
      headers: {
        cookie,
        origin: "https://localhost",
        "x-satyr-csrf": csrf[1],
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

function membershipIds(payload: Record<string, unknown>): readonly string[] {
  if (!Array.isArray(payload.memberships))
    throw new Error("Membership list missing");
  return payload.memberships.map(membershipId);
}

function membershipId(value: unknown): string {
  return text(record(value).organisationId);
}

async function accountSessionJourney(context: TestContext): Promise<void> {
  const native = await bootstrapSharedAccountNativeTenants();
  const setup = readSharedAccountFixture(
    await accountFixtureJson("setup", native.setup),
  );
  await applyAccountFixtureProvision(setup.provisionEnvelopes.primary);
  await applyAccountFixtureProvision(setup.provisionEnvelopes.foreign);
  const owner = native.primary.owner;
  const unbound = await commerceWorkspace(
    owner,
    "Unbound private organisation",
  );
  const login = await signIn(
    native.setup.organisations.primary.owner,
    "/portal",
  );
  expect(login.status, await login.clone().text()).toBe(302);
  expect(
    new URL(text(login.headers.get("location"))).searchParams.get(
      "accountLink",
    ),
  ).toBe("incomplete");
  const cookie = sessionCookies(login);
  const before = await controlRead(cookie, "/v1/control/session");
  expect(before.status).toBe(200);
  const session = record(await before.json());
  expect(membershipIds(session)).toEqual([native.primary.organisationId]);
  expect(JSON.stringify(session)).not.toContain("Unbound private organisation");
  expect(
    (await controlRead(cookie, `/v1/control/organisations/${unbound}`)).status,
  ).toBe(404);

  // Create another valid organisation for the same user through native onboarding.
  const request = readAccountOnboardingRequest({
    version: 1,
    operationId: "session-isolation-second-project",
    selection: {
      kind: "new_project",
      organizationId: setup.primary.scope.organizationId,
      projectName: "Independent session project",
    },
  });
  const started = await controlWrite(
    cookie,
    "/v1/control/account-onboarding",
    request,
  );
  expect(started.status, await started.clone().text()).toBe(200);
  const pending = readAccountOnboardingResult(
    record(await started.json()).value,
  );
  if (pending.kind !== "pending")
    throw new Error("Expected project provisioning");
  const delivery = await accountFixtureRequest("onboarding-delivery", {
    version: 1,
    operationId: pending.operationId,
  });
  const provision = await applyAccountFixtureProvision(
    readPantryProvisionEnvelope(await delivery.json()),
  );
  const second = provision.receipt.binding.nativeScope.nativeOrganizationId;
  const secondPage = await controlRead(
    cookie,
    `/v1/control/organisations/${second}`,
  );
  expect(secondPage.status, await secondPage.clone().text()).toBe(200);
  const ready = record(
    await (await controlRead(cookie, "/v1/control/session")).json(),
  );
  expect(membershipIds(ready)).toEqual(
    expect.arrayContaining([native.primary.organisationId, second]),
  );

  await accountFixtureJson("fault", {
    version: 1,
    kind: "primary_malformed_eligibility_reply",
  });
  const malformed = record(
    await (await controlRead(cookie, "/v1/control/session")).json(),
  );
  expect(malformed.membershipAvailability).toBe("incomplete");
  expect(membershipIds(malformed)).toEqual([second]);
  const malformedScope = await controlRead(
    cookie,
    `/v1/control/organisations/${native.primary.organisationId}`,
  );
  expect(malformedScope.status).toBe(503);
  await accountFixtureJson("fault", { version: 1, kind: "clear" });
  await accountFixtureJson("fault", {
    version: 1,
    kind: "primary_foreign_scope_reply",
  });
  const foreign = record(
    await (await controlRead(cookie, "/v1/control/session")).json(),
  );
  expect(membershipIds(foreign)).toEqual([second]);
  expect(JSON.stringify(foreign)).not.toContain(native.primary.organisationId);
  expect(
    (
      await controlRead(
        cookie,
        `/v1/control/organisations/${native.primary.organisationId}`,
      )
    ).status,
  ).toBe(404);
  await accountFixtureJson("fault", { version: 1, kind: "clear" });

  await accountFixtureJson("fault", {
    version: 1,
    kind: "primary_eligibility_outage",
  });
  const partialResponse = await controlRead(cookie, "/v1/control/session");
  expect(partialResponse.status).toBe(200);
  const partial = record(await partialResponse.json());
  expect(partial.membershipAvailability).toBe("incomplete");
  expect(membershipIds(partial)).toEqual([second]);
  expect(JSON.stringify(partial)).not.toContain(native.primary.organisationId);
  expect(
    (
      await controlRead(
        cookie,
        `/v1/control/organisations/${native.primary.organisationId}`,
      )
    ).status,
  ).toBe(503);
  await accountFixtureJson("fault", { version: 1, kind: "eligibility_outage" });
  const unavailable = record(
    await (await controlRead(cookie, "/v1/control/session")).json(),
  );
  expect(unavailable.membershipAvailability).toBe("incomplete");
  expect(membershipIds(unavailable)).toEqual([]);
  await accountFixtureJson("fault", { version: 1, kind: "clear" });
  const restored = record(
    await (await controlRead(cookie, "/v1/control/session")).json(),
  );
  expect(restored.membershipAvailability).toBe("complete");
  expect(membershipIds(restored)).toEqual(membershipIds(ready));

  const invited = await signIn(
    native.setup.organisations.primary.owner,
    `/portal?accountInvitationOrganisation=${unbound}&accountInvitationId=unlinked-invitation`,
  );
  expect(invited.status).toBe(302);
  expect(
    new URL(text(invited.headers.get("location"))).searchParams.get(
      "accountInvitationLink",
    ),
  ).toBe("failed");
  expect(
    (await controlRead(sessionCookies(invited), "/v1/control/session")).status,
  ).toBe(200);
  await accountFixtureJson("fault", { version: 1, kind: "onboarding_outage" });
  const globalFailure = await signIn(
    native.setup.organisations.primary.owner,
    "/portal",
  );
  expect(globalFailure.status).toBe(503);
  expect(globalFailure.headers.get("set-cookie")).not.toContain(
    `${SESSION_COOKIE}=`,
  );
  await accountFixtureJson("fault", { version: 1, kind: "clear" });
  Object.assign(context.task.meta, {
    accountSessionIsolation: {
      accountWorkerSha256: env.TEST_ACCOUNT_PLATFORM_WORKER_SHA256,
      checks: [
        "sign-in survives missing binding",
        "independent project remains accessible",
        "partial results hide denied scopes",
        "total outage is explicit",
        "stable restored order",
        "invitation retry is scoped",
        "global identity failure refuses session",
        "packed contract rejects malformed replies",
        "valid foreign scope cannot grant access",
      ],
    },
  });
}

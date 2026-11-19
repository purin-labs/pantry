// Plan 76 phase 2: the operator issues API keys and installs an app on one
// merchant. A partner's key sets up a product through the scopes it holds and
// is refused on a second merchant, on an operator route and on payment
// records; a read-only key cannot write; a revoked key and an uninstalled
// app stop working; the app's token is the one its operator derives again.
// After the operator token is rotated, the app's old token stops and the
// token derived from the new operator token works with no new install.
// Set API_ACCESS_ARTIFACT_DIR to keep the run's evidence; the file repeats
// byte for byte for the same commit.
import {
  CommerceAdminClient,
  commerceAppInstallationToken,
  type CommerceClientResult,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import { ApiAccess } from "../src/api-access.ts";
import {
  BASE_URL,
  NOW,
  SERVICE_TOKEN,
  StaffDesk,
  merchantId,
  organisationId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const SECOND_MERCHANT = "merchant_second_shop";
const SECOND_ORGANISATION = "organisation_second_shop";
const ROTATED_TOKEN = "catalog_editing_rotated_service_token";

type Backend = Awaited<ReturnType<typeof startBackend>>;

/** One raw admin call, as an outside client sends it. */
async function call(
  backend: Backend,
  token: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<Readonly<{ status: number; body: Record<string, unknown> }>> {
  const response = await backend.fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function admin(backend: Backend, token: string): CommerceAdminClient {
  return new CommerceAdminClient({
    baseUrl: BASE_URL,
    serviceToken: token,
    fetch: backend.fetch,
  });
}

function status(result: CommerceClientResult<unknown>): number | "ok" {
  if (result.ok) return "ok";
  return "status" in result.error ? result.error.status : 0;
}

const merchantPath = (id: string) => `/v1/admin/merchants/${id}`;

it("keeps each API key and app installation to its own merchant and scopes", async () => {
  const backend = await startBackend();
  try {
    const evidence: Evidence = {};
    await required(
      admin(backend, SERVICE_TOKEN).provisionMerchant({
        schemaVersion: "underclerk.provision-merchant.v2",
        externalReference: SECOND_ORGANISATION,
        merchantId: SECOND_MERCHANT,
        createdAt: NOW,
      }),
    );

    // The operator issues a partner key and a read-only reporting key.
    const partner = await call(
      backend,
      SERVICE_TOKEN,
      "POST",
      `${merchantPath(merchantId)}/api-keys`,
      {
        label: "Storefront partner",
        scopes: [
          "catalog:write",
          "inventory:write",
          "orders:read",
          "catalog:read",
        ],
      },
    );
    const reporting = await call(
      backend,
      SERVICE_TOKEN,
      "POST",
      `${merchantPath(merchantId)}/api-keys`,
      {
        label: "Reporting",
        scopes: ["catalog:read"],
      },
    );
    expect([partner.status, reporting.status]).toEqual([201, 201]);
    const partnerKey = String(partner.body.key);
    const reportingKey = String(reporting.body.key);
    expect(partnerKey).toMatch(/^uck_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$/u);
    // Scopes come back in one canonical order.
    expect(partner.body.scopes).toEqual([
      "catalog:read",
      "catalog:write",
      "inventory:write",
      "orders:read",
    ]);
    const paymentKey = await call(
      backend,
      SERVICE_TOKEN,
      "POST",
      `${merchantPath(merchantId)}/api-keys`,
      {
        label: "Payments",
        scopes: ["payments:record"],
      },
    );
    expect(paymentKey.status).toBe(422);

    // The partner sets up a product through its own scopes: the commands
    // apply and commit receipts like any staff command.
    const desk = new StaffDesk(admin(backend, partnerKey), "partner");
    await desk.createTea();
    const tea = (
      await required(admin(backend, SERVICE_TOKEN).readSnapshot(merchantId))
    ).resources.products.find(
      (product) => product.id === "product_loose_leaf_tea",
    );
    expect(tea?.title).toBe("Loose leaf tea");

    // The same key opens nothing on the second merchant.
    const crossMerchant = await call(
      backend,
      partnerKey,
      "GET",
      `${merchantPath(SECOND_MERCHANT)}/snapshot`,
    );
    expect(crossMerchant).toEqual({
      status: 401,
      body: { message: "Unauthorized", code: "unauthorized" },
    });

    // A read-only key reads what it may and cannot write.
    const reportingClient = admin(backend, reportingKey);
    const collections = await reportingClient.listCollections(merchantId);
    const write = await new StaffDesk(reportingClient, "reporting")
      .createTea()
      .then(
        () => "applied",
        (error: unknown) => String(error),
      );
    const reportingWrite = await call(
      backend,
      reportingKey,
      "POST",
      `${merchantPath(merchantId)}/locations`,
      {},
    );
    expect(status(collections)).toBe("ok");
    expect(write).toContain("does not allow this route");
    expect(reportingWrite.status).toBe(403);

    // Operator routes and unchecked payment records stay closed to keys.
    const keyIssue = await call(
      backend,
      partnerKey,
      "POST",
      `${merchantPath(merchantId)}/api-keys`,
      {
        label: "Escalation",
        scopes: ["orders:write"],
      },
    );
    const capture = await call(
      backend,
      partnerKey,
      "POST",
      `${merchantPath(merchantId)}/pickup-checkouts/checkout_any/payment-attempts/attempt_any/captures`,
      {},
    );
    const provision = await call(
      backend,
      partnerKey,
      "PUT",
      merchantPath(merchantId),
      {},
    );
    expect([keyIssue.status, capture.status, provision.status]).toEqual([
      403, 403, 403,
    ]);

    // A token with one changed character is refused.
    const last = partnerKey.at(-1) === "A" ? "B" : "A";
    const tampered = await call(
      backend,
      `${partnerKey.slice(0, -1)}${last}`,
      "GET",
      `${merchantPath(merchantId)}/snapshot`,
    );
    expect(tampered.status).toBe(401);

    // An app installation: its token is the one its operator derives, it
    // opens its scopes on this merchant only, and the external reference
    // must be this merchant's organisation.
    const wrongReference = await call(
      backend,
      SERVICE_TOKEN,
      "PUT",
      `${merchantPath(merchantId)}/app-installations/bookkeeper`,
      {
        scopes: ["orders:read"],
        externalReference: SECOND_ORGANISATION,
      },
    );
    const installed = await call(
      backend,
      SERVICE_TOKEN,
      "PUT",
      `${merchantPath(merchantId)}/app-installations/bookkeeper`,
      {
        scopes: ["orders:read"],
        externalReference: organisationId,
        label: "Bookkeeper",
      },
    );
    expect(wrongReference.status).toBe(409);
    expect(installed.status).toBe(200);
    const appToken = await commerceAppInstallationToken(SERVICE_TOKEN, {
      appId: "bookkeeper",
      merchantId,
      externalReference: organisationId,
    });
    expect(installed.body.token).toBe(appToken);
    const appRead = await admin(backend, appToken).readSnapshot(merchantId);
    const appWrite = await call(
      backend,
      appToken,
      "POST",
      `${merchantPath(merchantId)}/collections`,
      {},
    );
    const appElsewhere = await call(
      backend,
      appToken,
      "GET",
      `${merchantPath(SECOND_MERCHANT)}/snapshot`,
    );
    const secondShopToken = await commerceAppInstallationToken(
      SERVICE_TOKEN,
      {
        appId: "bookkeeper",
        merchantId: SECOND_MERCHANT,
        externalReference: SECOND_ORGANISATION,
      },
    );
    const notInstalled = await call(
      backend,
      secondShopToken,
      "GET",
      `${merchantPath(SECOND_MERCHANT)}/snapshot`,
    );
    expect(status(appRead)).toBe("ok");
    expect(appWrite.status).toBe(403);
    expect(appElsewhere.body.code).toBe("app_not_installed");
    expect(notInstalled.body.code).toBe("app_not_installed");

    // Revocation and uninstall stop the credentials at once.
    const revoked = await call(
      backend,
      SERVICE_TOKEN,
      "POST",
      `${merchantPath(merchantId)}/api-keys/${String(partner.body.credentialId)}/revocation`,
    );
    const afterRevocation = await call(
      backend,
      partnerKey,
      "GET",
      `${merchantPath(merchantId)}/snapshot`,
    );
    const uninstalled = await call(
      backend,
      SERVICE_TOKEN,
      "POST",
      `${merchantPath(merchantId)}/app-installations/bookkeeper/revocation`,
    );
    const afterUninstall = await call(
      backend,
      appToken,
      "GET",
      `${merchantPath(merchantId)}/snapshot`,
    );
    expect([
      revoked.status,
      afterRevocation.status,
      uninstalled.status,
      afterUninstall.status,
    ]).toEqual([200, 401, 200, 401]);
    expect(afterUninstall.body.code).toBe("unauthorized");

    // The operator token is rotated: Commerce restarts with a new one over
    // the same records. The old operator token and the app's old token stop
    // at once; the token that the app's operator derives from the new
    // operator token works with no new install. The uninstalled app stays
    // refused.
    await call(
      backend,
      SERVICE_TOKEN,
      "PUT",
      `${merchantPath(merchantId)}/app-installations/ledger`,
      {
        scopes: ["orders:read"],
        externalReference: organisationId,
        label: "Ledger",
      },
    );
    const rotated = new ApiAccess({
      database: backend.database,
      operatorToken: ROTATED_TOKEN,
      now: () => NOW,
    });
    const decision = (token: string) => {
      const decided = rotated.authorize(
        new Request(`${BASE_URL}${merchantPath(merchantId)}/snapshot`, {
          headers: { authorization: `Bearer ${token}` },
        }),
        merchantId,
        "orders:read",
      );
      return decided.kind === "allowed" ? "allowed" : decided.code;
    };
    const appTokenOf = (operatorToken: string, appId: string) =>
      commerceAppInstallationToken(operatorToken, {
        appId,
        merchantId,
        externalReference: organisationId,
      });
    const rotation = {
      oldOperatorToken: decision(SERVICE_TOKEN),
      oldAppToken: decision(await appTokenOf(SERVICE_TOKEN, "ledger")),
      newAppToken: decision(await appTokenOf(ROTATED_TOKEN, "ledger")),
      uninstalledApp: decision(await appTokenOf(ROTATED_TOKEN, "bookkeeper")),
    };
    expect(rotation).toEqual({
      oldOperatorToken: "unauthorized",
      oldAppToken: "unauthorized",
      newAppToken: "allowed",
      uninstalledApp: "unauthorized",
    });

    // The operator's list shows labels, scopes and states, never a secret.
    const listed = await call(
      backend,
      SERVICE_TOKEN,
      "GET",
      `${merchantPath(merchantId)}/api-credentials`,
    );
    const credentials = listed.body.credentials as readonly Record<
      string,
      unknown
    >[];
    expect(JSON.stringify(credentials)).not.toMatch(/uck_|uca_|secret/u);

    Object.assign(evidence, {
      issued: {
        partner: { status: partner.status, scopes: partner.body.scopes },
        reporting: { status: reporting.status, scopes: reporting.body.scopes },
        paymentsRecordRefused: paymentKey.status,
      },
      partnerSetUpProduct: {
        title: tea?.title,
        receipts: desk.receipts.length,
      },
      partnerOnSecondMerchant: crossMerchant,
      reportingKey: { read: status(collections), write: reportingWrite.status },
      closedToKeys: {
        issueKey: keyIssue.status,
        recordCapture: capture.status,
        provisionMerchant: provision.status,
      },
      tamperedKey: tampered.status,
      app: {
        wrongExternalReference: wrongReference.status,
        installed: installed.status,
        tokenIsDerived: installed.body.token === appToken,
        read: status(appRead),
        write: appWrite.status,
        otherMerchant: appElsewhere.body.code,
      },
      afterRevocation: afterRevocation.status,
      afterUninstall: afterUninstall.body.code,
      rotation,
      // Key ids are random, so the evidence lists the credentials by label.
      credentials: credentials
        .map((credential) => ({
          kind: credential.kind,
          appId: credential.appId,
          label: String(credential.label),
          scopes: credential.scopes,
          revoked: credential.revokedAt !== null,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    });
    writeEvidence("API_ACCESS_ARTIFACT_DIR", "api-access", evidence);
  } finally {
    backend.close();
  }
});

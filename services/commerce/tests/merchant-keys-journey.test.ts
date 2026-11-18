// Plan 80 step 3, keys that a merchant manages and receipts that name who
// acted: an operator's app, installed on the café with `credentials:write`,
// issues the café an API key for plugin settings. The key changes the return
// window, and the receipt names the key. The app changes it for Ana, a member
// of the operator, and the receipt names the app and Ana. The app cannot
// grant a scope it does not hold, `payments:record` or `credentials:write`;
// the key cannot issue a key, cannot name a person and opens nothing of
// another merchant. When the app revokes the key, the key stops at once.
// Set MERCHANT_KEYS_ARTIFACT_DIR to keep the run's evidence; the file
// repeats byte for byte for the same commit.
import {
  CommerceAdminClient,
  type CommerceMutationResultV1,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

import {
  BASE_URL,
  NOW,
  merchantId,
  organisationId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const APP = "partner_console";
const SECOND_MERCHANT = "merchant_second_shop";

type Backend = Awaited<ReturnType<typeof startBackend>>;

it(
  "lets a merchant's app issue scoped keys and names each actor on receipts",
  { timeout: 60_000 },
  merchantKeys,
);

async function merchantKeys(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin } = backend;
    await required(
      admin.provisionMerchant({
        schemaVersion: "underclerk.provision-merchant.v2",
        externalReference: "organisation_second_shop",
        merchantId: SECOND_MERCHANT,
        createdAt: NOW,
      }),
    );
    const installed = await required(
      admin.installApp(merchantId, APP, {
        scopes: ["settings:read", "settings:write", "credentials:write"],
        externalReference: organisationId,
        label: "Partner console",
      }),
    );
    const app = client(backend, installed.token);
    const forAna = client(backend, installed.token, "member_ana");

    // 1. The app issues the café a key for plugin settings.
    const issued = await required(
      app.issueApiKey(merchantId, {
        label: "Returns desk",
        scopes: ["settings:read", "settings:write"],
      }),
    );
    const key = client(backend, issued.key);

    // 2. The key and the app (for Ana) change the window; receipts name them.
    const byKey = await configure(key, 7, "window_by_key");
    const byApp = await configure(forAna, 14, "window_by_ana");
    const byOperator = await configure(admin, 30, "window_by_operator");
    const actors = {
      key: actorOf(byKey),
      app: actorOf(byApp),
      operator: actorOf(byOperator),
    };
    expect(actors).toEqual({
      key: { kind: "api_key", credentialId: issued.credentialId },
      app: { kind: "app", appId: APP, person: "member_ana" },
      operator: { kind: "operator" },
    });

    // 3. What neither may do.
    const wider = async (scopes: readonly string[]) =>
      status(
        call(backend, installed.token, "POST", `api-keys`, {
          label: "Too wide",
          scopes,
        }),
      );
    const refusals = {
      scopeTheAppLacks: await wider(["orders:write"]),
      paymentsRecord: await wider(["payments:record"]),
      credentialsWrite: await wider(["credentials:write"]),
      keyIssuesKey: await status(
        call(backend, issued.key, "POST", "api-keys", {
          label: "Copy",
          scopes: ["settings:read"],
        }),
      ),
      keyNamesPerson: await status(
        call(backend, issued.key, "GET", "plugins", undefined, "member_ben"),
      ),
      keyOnAnotherMerchant: await status(
        call(
          backend,
          issued.key,
          "GET",
          "plugins",
          undefined,
          undefined,
          SECOND_MERCHANT,
        ),
      ),
    };
    expect(refusals).toEqual({
      scopeTheAppLacks: 422,
      paymentsRecord: 422,
      credentialsWrite: 422,
      keyIssuesKey: 403,
      keyNamesPerson: 400,
      keyOnAnotherMerchant: 401,
    });

    // 4. The app revokes the key; the key stops at once.
    const revoked = await required(
      app.revokeApiKey(merchantId, issued.credentialId),
    );
    const afterRevoke = await status(
      call(backend, issued.key, "GET", "plugins"),
    );
    expect({ revoked: revoked.revokedAt !== null, afterRevoke }).toEqual({
      revoked: true,
      afterRevoke: 401,
    });
    const listed = await required(app.listApiCredentials(merchantId));

    // Key ids are random; the evidence names the issued key by role.
    Object.assign(evidence, {
      key: { scopes: issued.scopes },
      actors: {
        ...actors,
        key: { kind: "api_key", credentialId: "<the issued key>" },
      },
      refusals,
      afterRevoke,
      credentials: listed.credentials.map((credential) => ({
        kind: credential.kind,
        label: credential.label,
        revoked: credential.revokedAt !== null,
      })),
    });
  } finally {
    writeEvidence("MERCHANT_KEYS_ARTIFACT_DIR", "merchant-keys", evidence);
    backend.close();
  }
}

function client(backend: Backend, token: string, actor?: string) {
  return new CommerceAdminClient({
    baseUrl: BASE_URL,
    serviceToken: token,
    fetch: backend.fetch,
    ...(actor === undefined ? {} : { actor }),
  });
}

async function configure(
  admin: CommerceAdminClient,
  days: number,
  idempotencyKey: string,
): Promise<CommerceMutationResultV1> {
  const plugin = (await required(admin.listPlugins(merchantId))).plugins.find(
    (item) => item.pluginId === "returns",
  );
  if (plugin === undefined) throw new Error("The returns plugin is missing");
  return required(
    admin.configurePlugin({
      merchantId,
      idempotencyKey,
      pluginId: "returns",
      expectedRevision: plugin.revision,
      settings: { returnWindowDays: days },
    }),
  );
}

function actorOf(result: CommerceMutationResultV1) {
  if (result.outcome === "rejected") throw new Error(result.error.code);
  return result.receipt.schemaVersion === "underclerk.mutation-receipt.v2"
    ? result.receipt.actor
    : undefined;
}

async function call(
  backend: Backend,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  actor?: string,
  merchant: string = merchantId,
) {
  return backend.fetch(`${BASE_URL}/v1/admin/merchants/${merchant}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(actor === undefined ? {} : { "underclerk-actor": actor }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function status(pending: Promise<Response>): Promise<number> {
  return (await pending).status;
}

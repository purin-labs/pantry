// Refactor 15, refactor 11: the credentials of a merchant and its close.
//
// 1. A bookkeeping app is installed, gets a wider scope with the same token,
//    and issues a key for its own sync job. The operator uninstalls the app:
//    its token and the key it issued stop. The operator installs the app
//    again: the app gets a new token, the old token stays refused, and the
//    old key stays revoked.
// 2. The café's Organisation ends, and the operator closes its merchant. The
//    app's token and every key stop, the café's order webhook gets no more
//    posts though buyers still order, and no new key, installation or
//    subscription is made. A second close answers the first.
//
// Set CREDENTIAL_LIFECYCLE_ARTIFACT_DIR to keep the evidence; it repeats
// byte for byte.
import {
  commerceAppInstallationToken,
  type CommerceAdminClient,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

import type {
  WebhookPost,
  WebhookPostResult,
  WebhookSender,
} from "../src/webhooks.ts";
import {
  BASE_URL,
  Buyer,
  SERVICE_TOKEN,
  StaffDesk,
  catalogLine,
  merchantId,
  organisationId,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const APP = "bookkeeper";
const HOOK = "https://hooks.cafe.example/underclerk";

type Backend = Awaited<ReturnType<typeof startBackend>>;

/** A fake endpoint: it only records the posts and answers 200. */
class Endpoint implements WebhookSender {
  readonly kinds: string[] = [];

  async post(request: WebhookPost): Promise<WebhookPostResult> {
    const event = JSON.parse(request.body) as { kind: string };
    this.kinds.push(event.kind);
    return { kind: "response", status: 200 };
  }
}

it(
  "keeps a revoked app token refused when the app is installed again",
  { timeout: 60_000 },
  async () => {
    const backend = await startBackend();
    const evidence: Evidence = {};
    try {
      const first = await install(backend, ["orders:read"]);
      expect(first.status).toBe(200);
      const firstToken = String(first.body.token);
      // The app's first token is the one its operator derives.
      expect(firstToken).toBe(
        await commerceAppInstallationToken(SERVICE_TOKEN, {
          appId: APP,
          merchantId,
          externalReference: organisationId,
        }),
      );
      // A wider scope keeps the token.
      const widened = await install(backend, [
        "orders:read",
        "credentials:write",
      ]);
      expect(widened.body.token).toBe(firstToken);
      const issued = await call(backend, firstToken, "POST", "api-keys", {
        label: "Bookkeeper sync",
        scopes: ["orders:read"],
      });
      expect(issued.status).toBe(201);
      const syncKey = String(issued.body.key);
      expect(await snapshotStatus(backend, firstToken)).toBe(200);
      expect(await snapshotStatus(backend, syncKey)).toBe(200);

      // The operator uninstalls the app: its token and its key stop.
      const uninstalled = await call(
        backend,
        SERVICE_TOKEN,
        "POST",
        `app-installations/${APP}/revocation`,
      );
      expect(uninstalled.status).toBe(200);
      expect(await snapshotStatus(backend, firstToken)).toBe(401);
      expect(await snapshotStatus(backend, syncKey)).toBe(401);

      // The operator installs the app again. The app gets a new token; the
      // revoked token and the revoked key stay refused.
      const again = await install(backend, [
        "orders:read",
        "credentials:write",
      ]);
      expect(again.status).toBe(200);
      const newToken = String(again.body.token);
      expect(newToken).not.toBe(firstToken);
      expect(await snapshotStatus(backend, newToken)).toBe(200);
      expect(await snapshotStatus(backend, firstToken)).toBe(401);
      expect(await snapshotStatus(backend, syncKey)).toBe(401);

      const listed = await call(
        backend,
        SERVICE_TOKEN,
        "GET",
        "api-credentials",
      );
      const credentials = listed.body.credentials as readonly Record<
        string,
        unknown
      >[];
      // The list orders by creation time and then by id; both have the
      // journey's one clock time, so the journey orders by kind.
      const states = credentials
        .map((credential) => ({
          kind: String(credential.kind),
          state: credential.state,
          revokedBy: credential.revokedBy,
        }))
        .sort((left, right) => left.kind.localeCompare(right.kind));
      expect(states).toEqual([
        {
          kind: "api_key",
          state: "revoked",
          revokedBy: `parent:${String(first.body.credentialId)}`,
        },
        { kind: "app_installation", state: "active", revokedBy: null },
      ]);
      Object.assign(evidence, {
        firstInstall: "derived token",
        widenedScope: "same token",
        afterUninstall: { appToken: 401, issuedKey: 401 },
        afterReinstall: { newToken: 200, oldToken: 401, issuedKey: 401 },
        credentials: states,
      });
      writeEvidence(
        "CREDENTIAL_LIFECYCLE_ARTIFACT_DIR",
        "credential-reinstall",
        evidence,
      );
    } finally {
      backend.close();
    }
  },
);

it(
  "closes a merchant: every credential stops and no webhook reaches its endpoint",
  { timeout: 60_000 },
  async () => {
    const endpoint = new Endpoint();
    const backend = await startBackend({ webhooks: endpoint });
    const evidence: Evidence = {};
    try {
      await new StaffDesk(backend.admin, "closure").createTea();
      const app = await install(backend, ["orders:read", "credentials:write"]);
      const appToken = String(app.body.token);
      const appKey = String(
        (
          await call(backend, appToken, "POST", "api-keys", {
            label: "Bookkeeper sync",
            scopes: ["orders:read"],
          })
        ).body.key,
      );
      const operatorKey = String(
        (
          await call(backend, SERVICE_TOKEN, "POST", "api-keys", {
            label: "Till",
            scopes: ["orders:read", "webhooks:write"],
          })
        ).body.key,
      );
      await subscribe(backend.admin, "orders", "closure_subscribe");
      const ana = await Buyer.start(backend.buyer, "closure_ana");
      await ana.buyLines([catalogLine("variant_tea_small_sencha")]);
      await backend.dispatchWebhooks();
      const postsBefore = endpoint.kinds.length;
      expect(endpoint.kinds).toContain("order.created");

      // The Organisation ends, and the operator closes its merchant.
      const closed = await call(backend, SERVICE_TOKEN, "POST", "closure", {});
      expect(closed).toMatchObject({
        status: 200,
        body: {
          schemaVersion: "underclerk.merchant-closure.v1",
          merchantId,
          revokedCredentials: 3,
          removedWebhookSubscriptions: 1,
          square: "none",
        },
      });
      const statuses = {
        appToken: await snapshotStatus(backend, appToken),
        appKey: await snapshotStatus(backend, appKey),
        operatorKey: await snapshotStatus(backend, operatorKey),
      };
      expect(statuses).toEqual({
        appToken: 401,
        appKey: 401,
        operatorKey: 401,
      });

      // A buyer still orders, and the café's endpoint gets no post.
      const ben = await Buyer.start(backend.buyer, "closure_ben");
      await ben.buyLines([catalogLine("variant_tea_small_sencha")]);
      await backend.dispatchWebhooks();
      expect(endpoint.kinds).toHaveLength(postsBefore);

      // Nothing new is linked to the closed merchant.
      const refused = {
        apiKey: await call(backend, SERVICE_TOKEN, "POST", "api-keys", {
          label: "Late",
          scopes: ["orders:read"],
        }),
        install: await install(backend, ["orders:read"]),
        subscription: await subscribe(backend.admin, "late", "closure_late"),
      };
      expect(refused.apiKey).toMatchObject({
        status: 409,
        body: { code: "merchant_closed" },
      });
      expect(refused.install).toMatchObject({
        status: 409,
        body: { code: "merchant_closed" },
      });
      expect(refused.subscription.ok).toBe(false);
      const repeated = await call(
        backend,
        SERVICE_TOKEN,
        "POST",
        "closure",
        {},
      );
      expect(repeated.body).toEqual(closed.body);
      Object.assign(evidence, {
        closure: {
          revokedCredentials: 3,
          removedWebhookSubscriptions: 1,
        },
        afterClosure: statuses,
        webhookPosts: { before: postsBefore, after: endpoint.kinds.length },
        refusedAfterClosure: ["api_key", "app_installation", "subscription"],
        repeatedClose: "same closure",
      });
      writeEvidence(
        "CREDENTIAL_LIFECYCLE_ARTIFACT_DIR",
        "merchant-closure",
        evidence,
      );
    } finally {
      backend.close();
    }
  },
);

function install(
  backend: Backend,
  scopes: readonly string[],
): ReturnType<typeof call> {
  return call(backend, SERVICE_TOKEN, "PUT", `app-installations/${APP}`, {
    scopes,
    externalReference: organisationId,
    label: "Bookkeeper",
  });
}

function subscribe(
  admin: CommerceAdminClient,
  subscriptionId: string,
  idempotencyKey: string,
) {
  return admin.createWebhookSubscription({
    merchantId,
    idempotencyKey,
    subscriptionId,
    url: HOOK,
    topics: ["order.*"],
  });
}

async function snapshotStatus(
  backend: Backend,
  token: string,
): Promise<number> {
  return (await call(backend, token, "GET", "snapshot")).status;
}

async function call(
  backend: Backend,
  token: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<Readonly<{ status: number; body: Record<string, unknown> }>> {
  const response = await backend.fetch(
    `${BASE_URL}/v1/admin/merchants/${merchantId}/${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

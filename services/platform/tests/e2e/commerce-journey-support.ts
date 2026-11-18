// Steps that commerce journeys share: reads of the commerce engine's admin
// API, the trust of a shop's signed deliveries, and the headers of a
// configuration change.
import { env } from "cloudflare:workers";
import { isRecord } from "@seams/std";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { fixtureDatabase } from "./organisation-database";

const OPERATOR = "Bearer underclerk-e2e-token";

/** One admin read of a merchant in the commerce engine. */
export async function commerceEngine(
  merchantId: string,
  path: string,
): Promise<Record<string, unknown>> {
  const response = await env.UNDERCLERK.fetch(
    `http://underclerk.test/v1/admin/merchants/${merchantId}/${path}`,
    { headers: { authorization: OPERATOR } },
  );
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error(`Not a record: ${String(body)}`);
  return body;
}

/**
 * Binds the merchant's own delivery signing key. The shared fixture binds a
 * placeholder key; a journey that reads deliveries needs the real one.
 */
export async function trustShopDeliveries(merchantId: string): Promise<void> {
  const signing = await env.UNDERCLERK.fetch(
    `http://underclerk.test/v1/admin/merchants/${merchantId}/test-signing-key`,
    { headers: { authorization: OPERATOR } },
  );
  const key: unknown = await signing.json();
  if (!isRecord(key) || typeof key.publicKeyB64 !== "string")
    throw new Error("Fixture signing key missing");
  await fixtureDatabase()
    .prepare(
      "UPDATE underclerk_merchant_binding SET delivery_signing_key_id = 'key_bakery_e2e', delivery_signing_public_key_b64 = ? WHERE merchant_id = ?",
    )
    .bind(key.publicKeyB64, merchantId)
    .run();
}

/** The headers of one person's configuration change, with its key. */
export function configurationHeaders(
  session: IssuedControlSession,
  idempotencyKey: string,
): Record<string, string> {
  return {
    cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
    origin: "https://localhost",
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "x-satyr-configuration-version": "1",
    "x-satyr-csrf": session.csrfToken,
  };
}

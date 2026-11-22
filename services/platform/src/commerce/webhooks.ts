// Pantry as a webhook subscriber of each of its Commerce merchants (Plan 77
// step 8). The five-minute reconcile makes sure that each Pantry commerce
// merchant posts every event to /hook/commerce/:organisationId. A post with
// a valid signature queues a feed read; it replaced the merchant's wake-up
// call. The feed stays the truth: a post carries no change, so a lost post
// waits for the five-minute read and a forged one is refused before it costs
// a read.
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { CommerceAdminClient } from "@purin-labs/commerce-client";
import { decodeBase64, encodeBase64, isRecord } from "@purin-labs/std";

import type { CommerceMerchantBinding } from "../data/commerce-merchant-binding";
import type { Env } from "@purin-labs/kernel/env";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
} from "@purin-labs/kernel/http";
import {
  newRequestId,
  parseIntegrationAccountId,
  parseOrganisationId,
  type OrganisationId,
  type RequestId,
} from "@purin-labs/kernel/ids";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { createCommerceOutboxReconcileQueueMessage } from "./contract/queue-messages";
import { traceWarn } from "@purin-labs/kernel/observability";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

/** Pantry's subscription id on every merchant. */
const SUBSCRIPTION_ID = "pantry";
/** A post signed longer ago than this is refused, so a copy cannot replay. */
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1_000;
const MAXIMUM_BODY_BYTES = 64 * 1_024;
/** How long a queued feed read covers later posts. */
const QUEUED_READ_MS = 60_000;
const textEncoder = new TextEncoder();

type CommerceWebhookSubscriptionOutcome =
  "current" | "subscribed" | "rotated" | "restarted" | "unavailable";

/**
 * Makes the merchant post every event to Pantry: subscribes when there is no
 * subscription, takes a new secret when Pantry cannot open the one it keeps
 * (after an operator token rotation), and restarts a `failing` one.
 */
export async function ensureCommerceWebhookSubscription(
  input: Readonly<{
    env: Env;
    db: OrganisationDatabase;
    client: CommerceAdminClient;
    binding: Pick<
      CommerceMerchantBinding,
      "bindingId" | "organisationId" | "merchantId"
    >;
    now: number;
    requestId: RequestId;
  }>,
): Promise<CommerceWebhookSubscriptionOutcome> {
  const { env, db, client, binding, now } = input;
  const operatorToken = env.COMMERCE_SERVICE_TOKEN;
  if (operatorToken === undefined) return "unavailable";
  const url = `${env.PANTRY_PUBLIC_ORIGIN}/hook/commerce/${binding.organisationId}`;
  const listed = await client.listWebhookSubscriptions(binding.merchantId);
  if (!listed.ok) return "unavailable";
  let subscription = listed.value.find((item) => item.id === SUBSCRIPTION_ID);
  // An address from an earlier origin gets no more posts here.
  if (subscription !== undefined && subscription.url !== url) {
    const deleted = await client.deleteWebhookSubscription({
      ...commandBase(binding),
      subscriptionId: SUBSCRIPTION_ID,
      expectedRevision: subscription.revision,
    });
    if (!deleted.ok || deleted.value.outcome === "rejected")
      return "unavailable";
    subscription = undefined;
  }
  if (subscription === undefined) {
    const created = await client.createWebhookSubscription({
      ...commandBase(binding),
      subscriptionId: SUBSCRIPTION_ID,
      url,
      topics: ["*"],
    });
    if (!created.ok || created.value.secret === null) {
      traceWarn("commerce.webhook_subscription_refused", {
        requestId: input.requestId,
        organisation_id: binding.organisationId,
        outcome: created.ok ? created.value.mutation.outcome : "unreachable",
      });
      return "unavailable";
    }
    await keepSecret(db, operatorToken, binding, created.value.secret, now);
    return "subscribed";
  }
  const kept = await readKeptSecrets(db, operatorToken, binding.organisationId);
  if (!kept.some((secret) => secret.bindingId === binding.bindingId)) {
    const rotated = await client.rotateWebhookSecret({
      ...commandBase(binding),
      subscriptionId: SUBSCRIPTION_ID,
      expectedRevision: subscription.revision,
      keepPreviousSecretSeconds: 0,
    });
    if (!rotated.ok || rotated.value.secret === null) return "unavailable";
    await keepSecret(db, operatorToken, binding, rotated.value.secret, now);
    return "rotated";
  }
  if (subscription.state === "failing") {
    const restarted = await client.restartWebhookSubscription({
      ...commandBase(binding),
      subscriptionId: SUBSCRIPTION_ID,
      expectedRevision: subscription.revision,
    });
    return restarted.ok && restarted.value.outcome !== "rejected"
      ? "restarted"
      : "unavailable";
  }
  return "current";
}

/**
 * POST /hook/commerce/:organisationId. A post signed with a secret that
 * Pantry keeps for the organisation's merchant queues a feed read.
 */
export async function handleCommerceWebhook(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const organisationId = parseOrganisationId(organisationIdRaw);
  if (!organisationId.ok) return refused();
  const operatorToken = env.COMMERCE_SERVICE_TOKEN;
  if (operatorToken === undefined)
    return errorResponse(
      "commerce_webhook_unavailable",
      "Commerce webhooks are not configured.",
      503,
    );
  const body = await request.text();
  if (textEncoder.encode(body).byteLength > MAXIMUM_BODY_BYTES)
    return refused();
  const timestamp = request.headers.get("x-commerce-timestamp") ?? "";
  const signedAt = Date.parse(timestamp);
  if (
    !Number.isFinite(signedAt) ||
    Math.abs(Date.now() - signedAt) > SIGNATURE_TOLERANCE_MS
  )
    return refused();
  const signatures = (request.headers.get("x-commerce-signature") ?? "")
    .split(",")
    .flatMap((part) => {
      const hex = /^v1=([0-9a-f]{64})$/u.exec(part.trim())?.[1];
      return hex === undefined ? [] : [hexBytes(hex)];
    });
  if (signatures.length === 0) return refused();
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) return refused();
  const secrets = await readKeptSecrets(
    execution.value.database,
    operatorToken,
    organisationId.value,
  );
  const signed = textEncoder.encode(`${timestamp}.${body}`);
  let match: KeptSecret | undefined;
  for (const secret of secrets)
    for (const signature of signatures)
      if (
        match === undefined &&
        (await signedWith(secret.secret, signature, signed))
      )
        match = secret;
  if (match === undefined) return refused();
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return refused();
  }
  if (!isRecord(event) || event.merchantId !== match.merchantId)
    return refused();
  const integrationAccountId = parseIntegrationAccountId(
    match.integrationAccountId,
  );
  if (!integrationAccountId.ok) return refused();
  // A read that is queued and has not started yet will see this event too,
  // so a burst of posts queues one read. A mark older than a minute is taken
  // as a lost message.
  const now = Date.now();
  const marked = await execution.value.database
    .prepare(
      `UPDATE commerce_webhook_subscription SET read_queued_at = ?
       WHERE binding_id = ? AND (read_queued_at IS NULL OR read_queued_at < ?)`,
    )
    .bind(now, match.bindingId, now - QUEUED_READ_MS)
    .run();
  if (marked.meta.changes === 0)
    return jsonResponse({ ok: true, queued: false }, 202);
  if (await consumeAcceptanceFault(env, organisationId.value, match, now)) {
    // As a lost queue send: Commerce posts again later, and the
    // scheduled read stays the backstop.
    await startCommerceWebhookRead(execution.value.database, match.bindingId);
    return errorResponse(
      "commerce_webhook_queue_unavailable",
      "The feed read could not be queued.",
      503,
    );
  }
  await env.EVENT_Q.send(
    createCommerceOutboxReconcileQueueMessage({
      requestId: newRequestId(),
      receivedAt: Date.now(),
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
    }),
  );
  return jsonResponse({ ok: true, queued: true }, 202);
}

/**
 * The Café acceptance fault (development organisations only, with the
 * fault injection token): it fails the first queue step after it is armed.
 */
async function consumeAcceptanceFault(
  env: Env,
  organisationId: OrganisationId,
  secret: KeptSecret,
  now: number,
): Promise<boolean> {
  if (env.PANTRY_FAULT_INJECTION_TOKEN === undefined) return false;
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now,
  });
  const consumed = await organisation.consumeCafeCommerceAcceptanceFault({
    merchantId: secret.merchantId,
    consumedAt: now,
  });
  if (consumed.kind === "consumed")
    traceWarn("cafe.commerce_acceptance_fault_consumed", {
      requestId: consumed.fault.requestId,
      organisation_id: organisationId,
      merchant_id: secret.merchantId,
      stage: "queue",
    });
  return consumed.kind === "consumed";
}

function refused(): Response {
  return errorResponse(
    "commerce_webhook_refused",
    "The Commerce webhook was refused.",
    401,
  );
}

type KeptSecret = Readonly<{
  bindingId: string;
  merchantId: string;
  integrationAccountId: string;
  secret: string;
}>;

/** The secrets that Pantry keeps and can open for an organisation. */
async function readKeptSecrets(
  db: OrganisationDatabase,
  operatorToken: string,
  organisationId: OrganisationId,
): Promise<readonly KeptSecret[]> {
  const rows = await db
    .prepare(
      `SELECT s.binding_id AS bindingId, s.sealed_secret AS sealedSecret,
              b.merchant_id AS merchantId,
              b.integration_account_id AS integrationAccountId
       FROM commerce_webhook_subscription s
       JOIN commerce_merchant_binding b ON b.binding_id = s.binding_id
         AND b.organisation_id = s.organisation_id
       WHERE s.organisation_id = ?`,
    )
    .bind(organisationId)
    .all<Record<string, unknown>>();
  const kept: KeptSecret[] = [];
  for (const row of rows.results) {
    if (
      typeof row.bindingId !== "string" ||
      typeof row.sealedSecret !== "string" ||
      typeof row.merchantId !== "string" ||
      typeof row.integrationAccountId !== "string"
    )
      continue;
    const secret = await openSecret(
      operatorToken,
      row.bindingId,
      row.sealedSecret,
    );
    if (secret !== null)
      kept.push({
        bindingId: row.bindingId,
        merchantId: row.merchantId,
        integrationAccountId: row.integrationAccountId,
        secret,
      });
  }
  return kept;
}

async function keepSecret(
  db: OrganisationDatabase,
  operatorToken: string,
  binding: Pick<CommerceMerchantBinding, "bindingId" | "organisationId">,
  secret: string,
  now: number,
): Promise<void> {
  const sealed = await sealSecret(operatorToken, binding.bindingId, secret);
  await db
    .prepare(
      `INSERT INTO commerce_webhook_subscription (
         binding_id, organisation_id, subscription_id, sealed_secret,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (binding_id) DO UPDATE SET
         sealed_secret = excluded.sealed_secret,
         updated_at = excluded.updated_at`,
    )
    .bind(
      binding.bindingId,
      binding.organisationId,
      SUBSCRIPTION_ID,
      sealed,
      now,
      now,
    )
    .run();
}

function commandBase(binding: Pick<CommerceMerchantBinding, "merchantId">) {
  return {
    merchantId: binding.merchantId,
    idempotencyKey: `pantry_webhook_${crypto.randomUUID()}`,
  };
}

// The secret is sealed with a key derived from the operator token, bound to
// the binding id. A new operator token leaves the old secret unopenable, and
// the next reconcile takes a new one.
async function sealingKey(operatorToken: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(operatorToken),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: textEncoder.encode("pantry.commerce-webhook-secret.v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function sealSecret(
  operatorToken: string,
  bindingId: string,
  secret: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: textEncoder.encode(bindingId) },
    await sealingKey(operatorToken),
    textEncoder.encode(secret),
  );
  return `${encodeBase64(iv)}.${encodeBase64(new Uint8Array(sealed))}`;
}

async function openSecret(
  operatorToken: string,
  bindingId: string,
  sealed: string,
): Promise<string | null> {
  const [ivText, bodyText, ...rest] = sealed.split(".");
  const iv = decodeBase64(ivText ?? "");
  const body = decodeBase64(bodyText ?? "");
  if (iv === null || iv.length !== 12 || body === null || rest.length > 0)
    return null;
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: textEncoder.encode(bindingId) },
      await sealingKey(operatorToken),
      body,
    );
    return new TextDecoder().decode(opened);
  } catch {
    return null;
  }
}

async function signedWith(
  secret: string,
  signature: Uint8Array,
  signed: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, signed);
}

function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/**
 * Clears the queued-read mark of a merchant's subscription. The feed reader
 * calls it before it reads, so a post that arrives during the read queues
 * the next one.
 */
export async function startCommerceWebhookRead(
  db: OrganisationDatabase,
  bindingId: string,
): Promise<void> {
  await db
    .prepare(
      // A scheduled read with no post before it finds no mark and writes no row.
      "UPDATE commerce_webhook_subscription SET read_queued_at = NULL WHERE binding_id = ? AND read_queued_at IS NOT NULL",
    )
    .bind(bindingId)
    .run();
}

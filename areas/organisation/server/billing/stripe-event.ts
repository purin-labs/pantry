import type { BillingPaymentState } from "@purin-labs/control-api/portal/billing";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { stripeBillingConfig } from "@purin-labs/area-organisation-contract/server/billing/stripe-client";
import {
  verifyStripeWebhookSignature,
  type StripeSignatureError,
} from "@purin-labs/area-commerce-contract/server/stripe-webhook-signature";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { isRecord } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";
import {
  readBillingAccount,
  readBillingAccountOfStripeCustomer,
  updateBillingAccountFromStripeEvent,
  type BillingAccount,
} from "./billing-account";
import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
} from "@purin-labs/tenancy/organisation-execution-scope";

/**
 * One event of the billing webhook of Pantry's own Stripe account (Plan 95
 * step 6). Pantry compares the event with the billing account and writes
 * only on a change, so a repeated event writes nothing. `past_due` and
 * `canceled` stop new paid use; free use continues.
 *
 * The Organisation Actor keeps a copy of the payment state for its admission
 * of paid use. The Actor gets the change first and the row last, so an event
 * that failed between the two writes runs again in full at Stripe's retry.
 */
export type BillingEventError = Readonly<{
  code:
    | "billing_closed"
    | StripeSignatureError["code"]
    | "billing_event_invalid"
    /** A store did not take the change. Stripe sends the event again. */
    | "billing_unavailable";
}>;

export type BillingEventOutcome =
  | Readonly<{
      kind: "ignored";
      reason: "event_unsupported" | "account_unknown" | "event_older";
    }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{
      kind: "changed";
      organisationId: OrganisationId;
      paymentState: BillingPaymentState;
    }>;

/** What one event says, before the compare with the account. */
type BillingEvent = Readonly<{ created: number; customerId: string }> &
  (
    | Readonly<{ kind: "checkout_completed"; subscriptionId: string }>
    | Readonly<{
        kind: "subscription";
        subscriptionId: string;
        paymentState: BillingPaymentState;
      }>
    | Readonly<{ kind: "invoice_paid" | "invoice_payment_failed" }>
  );

export async function applyStripeBillingEvent(
  input: Readonly<{
    env: Env;
    rawBody: string;
    signatureHeader: string | null;
    now: number;
  }>,
): Promise<Result<BillingEventOutcome, BillingEventError>> {
  const config = stripeBillingConfig(input.env);
  if (config === null) return failure("billing_closed");
  const verified = await verifyStripeWebhookSignature({
    rawBody: input.rawBody,
    signatureHeader: input.signatureHeader,
    signingSecret: config.webhookSecret,
    nowMs: input.now,
  });
  if (!verified.ok) return verified;
  const event = parseBillingEvent(input.rawBody);
  if (event === "invalid") return failure("billing_event_invalid");
  if (event === "unsupported") return ignored("event_unsupported");

  const located = await locateBillingAccount(input.env, event.customerId);
  if (located === "unavailable") return failure("billing_unavailable");
  if (located === null) return ignored("account_unknown");
  const { account, scope } = located;
  const next = accountAfterEvent(account, event);
  if (
    next.paymentState === account.paymentState &&
    next.stripeSubscriptionId === account.stripeSubscriptionId
  )
    return { ok: true, value: { kind: "unchanged" } };
  if (event.created < account.lastStripeEventCreated)
    return ignored("event_older");

  try {
    await syncActor(input.env, account, next.paymentState, input.now);
    const stored = await updateBillingAccountFromStripeEvent(scope.database, {
      organisationId: account.organisationId,
      stripeSubscriptionId: next.stripeSubscriptionId,
      paymentState: next.paymentState,
      eventCreated: event.created,
      now: input.now,
    });
    if (!stored) {
      // A newer event took the row between the read and the write. The Actor
      // gets the state of the row again, and this event counts as older.
      const current = await readBillingAccount(
        scope.database,
        account.organisationId,
      );
      if (current !== null)
        await syncActor(input.env, current, current.paymentState, input.now);
      return ignored("event_older");
    }
  } catch {
    return failure("billing_unavailable");
  }
  return {
    ok: true,
    value: {
      kind: "changed",
      organisationId: account.organisationId,
      paymentState: next.paymentState,
    },
  };
}

/** Gives the Organisation Actor the payment state for its admission of paid use. */
async function syncActor(
  env: Env,
  account: BillingAccount,
  paymentState: BillingPaymentState,
  now: number,
): Promise<void> {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: account.organisationId,
    now,
  });
  const synced = await organisation.syncJevPaymentAccount({
    organisationId: account.organisationId,
    account: { paymentState, stripeCustomerId: account.stripeCustomerId },
  });
  if (!synced.ok) throw new Error(synced.error.code);
}

/**
 * The billing account of a Stripe customer. The event names no Organisation
 * that Pantry trusts, so each regional database is asked for the customer,
 * and the account counts only in the database of its Organisation's
 * placement.
 */
async function locateBillingAccount(
  env: Env,
  customerId: string,
): Promise<
  | Readonly<{ account: BillingAccount; scope: OrganisationExecutionScope }>
  | "unavailable"
  | null
> {
  try {
    for (const database of configuredOrganisationDatabases(env)) {
      const account = await readBillingAccountOfStripeCustomer(
        database,
        customerId,
      );
      if (account === null) continue;
      const scope = await OrganisationExecutionScope.resolve(
        env,
        account.organisationId,
      );
      if (!scope.ok) return "unavailable";
      if (scope.value.database === database)
        return { account, scope: scope.value };
    }
    return null;
  } catch {
    return "unavailable";
  }
}

/** The subscription and the payment state of the account after one event. */
function accountAfterEvent(
  account: BillingAccount,
  event: BillingEvent,
): Pick<BillingAccount, "paymentState" | "stripeSubscriptionId"> {
  const unchanged = {
    paymentState: account.paymentState,
    stripeSubscriptionId: account.stripeSubscriptionId,
  };
  switch (event.kind) {
    case "checkout_completed":
      // A completed Checkout starts the subscription, also after a cancel.
      return {
        paymentState: "active",
        stripeSubscriptionId: event.subscriptionId,
      };
    case "subscription":
      // An event of an earlier subscription says nothing about this one.
      return account.stripeSubscriptionId !== null &&
        account.stripeSubscriptionId !== event.subscriptionId
        ? unchanged
        : {
            paymentState: event.paymentState,
            stripeSubscriptionId: event.subscriptionId,
          };
    case "invoice_payment_failed":
      return account.paymentState === "active"
        ? { ...unchanged, paymentState: "past_due" }
        : unchanged;
    case "invoice_paid":
      // A paid invoice repairs a failed payment. It does not start a
      // subscription and does not bring back a canceled one.
      return account.paymentState === "past_due"
        ? { ...unchanged, paymentState: "active" }
        : unchanged;
  }
}

function parseBillingEvent(
  rawBody: string,
): BillingEvent | "invalid" | "unsupported" {
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return "invalid";
  }
  if (
    !isRecord(raw) ||
    typeof raw.type !== "string" ||
    typeof raw.created !== "number" ||
    !Number.isSafeInteger(raw.created) ||
    raw.created < 0 ||
    !isRecord(raw.data) ||
    !isRecord(raw.data.object)
  )
    return "invalid";
  const object = raw.data.object;
  const customerId = object.customer;
  const base = { created: raw.created };
  switch (raw.type) {
    case "checkout.session.completed":
      // Another Checkout of the account (a one-time payment) is not billing.
      if (object.mode !== "subscription") return "unsupported";
      return stripeId(customerId, "cus_") &&
        stripeId(object.subscription, "sub_")
        ? {
            ...base,
            kind: "checkout_completed",
            customerId,
            subscriptionId: object.subscription,
          }
        : "invalid";
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const paymentState =
        raw.type === "customer.subscription.deleted"
          ? "canceled"
          : subscriptionPaymentState(object.status);
      return stripeId(customerId, "cus_") &&
        stripeId(object.id, "sub_") &&
        paymentState !== null
        ? {
            ...base,
            kind: "subscription",
            customerId,
            subscriptionId: object.id,
            paymentState,
          }
        : "invalid";
    }
    case "invoice.paid":
    case "invoice.payment_failed":
      return stripeId(customerId, "cus_")
        ? {
            ...base,
            kind:
              raw.type === "invoice.paid"
                ? "invoice_paid"
                : "invoice_payment_failed",
            customerId,
          }
        : "invalid";
    default:
      return "unsupported";
  }
}

/** Stripe's subscription status as the payment state of the account. */
function subscriptionPaymentState(status: unknown): BillingPaymentState | null {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
    case "incomplete":
    case "paused":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return null;
  }
}

function stripeId(value: unknown, prefix: "cus_" | "sub_"): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(prefix) &&
    /^[A-Za-z0-9_]{5,255}$/u.test(value)
  );
}

function ignored(
  reason: Variant<BillingEventOutcome, "ignored">["reason"],
): Result<BillingEventOutcome, BillingEventError> {
  return { ok: true, value: { kind: "ignored", reason } };
}

function failure(
  code: BillingEventError["code"],
): Result<never, BillingEventError> {
  return { ok: false, error: { code } };
}

import {
  isBillingPaymentState,
  type BillingPaymentState,
} from "@purin-labs/control-api/portal/billing";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  parseOrganisationPlan,
  type OrganisationPlan,
} from "@purin-labs/tenancy/plans";
import type { OrganisationQuerySource } from "@purin-labs/tenancy/data/query-source";

/**
 * The organisation_billing_account row (Plan 95, "Billing"): the Stripe
 * customer and subscription of one Organisation in Pantry's own Stripe
 * account, and the payment state. Pantry makes the row only when the owner
 * starts payment setup. An Organisation with no paid use has no row. Pantry
 * keeps no card data: Stripe holds each card.
 */
export type BillingAccount = Readonly<{
  organisationId: OrganisationId;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  paymentState: BillingPaymentState;
  /** The `created` time, in seconds, of the last Stripe event that changed the row. */
  lastStripeEventCreated: number;
}>;

type BillingAccountRow = Readonly<{
  organisation_id: unknown;
  stripe_customer_id: unknown;
  stripe_subscription_id: unknown;
  payment_state: unknown;
  last_stripe_event_created: unknown;
}>;

const COLUMNS =
  "organisation_id, stripe_customer_id, stripe_subscription_id, payment_state, last_stripe_event_created";

export async function readBillingAccount(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<BillingAccount | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM organisation_billing_account WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<BillingAccountRow>();
  return row === null ? null : billingAccountFromRow(row);
}

/** The billing account of a Stripe customer in one regional database, or null. */
export async function readBillingAccountOfStripeCustomer(
  db: OrganisationQuerySource,
  stripeCustomerId: string,
): Promise<BillingAccount | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM organisation_billing_account WHERE stripe_customer_id = ?`,
    )
    .bind(stripeCustomerId)
    .first<BillingAccountRow>();
  return row === null ? null : billingAccountFromRow(row);
}

/**
 * Makes the row when the owner starts payment setup, with the payment state
 * `none`. A second start keeps the first row and its customer.
 */
export async function createBillingAccount(
  db: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    stripeCustomerId: string;
    now: number;
  }>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO organisation_billing_account
        (organisation_id, stripe_customer_id, stripe_subscription_id, payment_state, last_stripe_event_created, updated_at)
       VALUES (?, ?, NULL, 'none', 0, ?) ON CONFLICT (organisation_id) DO NOTHING`,
    )
    .bind(input.organisationId, input.stripeCustomerId, input.now)
    .run();
}

/**
 * Stores what a Stripe event changed. The statement changes no row when a
 * newer event came first; the answer is then false.
 */
export async function updateBillingAccountFromStripeEvent(
  db: OrganisationQuerySource,
  input: Readonly<{
    organisationId: OrganisationId;
    stripeSubscriptionId: string | null;
    paymentState: BillingPaymentState;
    eventCreated: number;
    now: number;
  }>,
): Promise<boolean> {
  const updated = await db
    .prepare(
      `UPDATE organisation_billing_account
       SET stripe_subscription_id = ?, payment_state = ?, last_stripe_event_created = ?, updated_at = ?
       WHERE organisation_id = ? AND last_stripe_event_created <= ?`,
    )
    .bind(
      input.stripeSubscriptionId,
      input.paymentState,
      input.eventCreated,
      input.now,
      input.organisationId,
      input.eventCreated,
    )
    .run();
  return updated.meta.changes > 0;
}

function billingAccountFromRow(row: BillingAccountRow): BillingAccount {
  const organisationId =
    typeof row.organisation_id === "string"
      ? parseOrganisationId(row.organisation_id)
      : null;
  if (
    organisationId === null ||
    !organisationId.ok ||
    typeof row.stripe_customer_id !== "string" ||
    (row.stripe_subscription_id !== null &&
      typeof row.stripe_subscription_id !== "string") ||
    !isBillingPaymentState(row.payment_state) ||
    typeof row.last_stripe_event_created !== "number"
  )
    throw new Error("organisation_billing_account_invalid");
  return {
    organisationId: organisationId.value,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    paymentState: row.payment_state,
    lastStripeEventCreated: row.last_stripe_event_created,
  };
}

/**
 * The name and the plan of an Organisation: the name of its Stripe customer,
 * and the catalog entry of its plan. Null when the Organisation is gone or
 * its plan is not in the catalog.
 */
export async function readOrganisationBillingProfile(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
): Promise<Readonly<{ name: string; plan: OrganisationPlan }> | null> {
  const row = await db
    .prepare("SELECT name, plan FROM organisation WHERE organisation_id = ?")
    .bind(organisationId)
    .first<{ name: unknown; plan: unknown }>();
  const plan = parseOrganisationPlan(row?.plan);
  return row === null || typeof row.name !== "string" || plan === null
    ? null
    : { name: row.name, plan };
}

-- Plan 95 step 6: Pantry bills paid Jev use through its own Stripe account.
-- Adds the table organisation_billing_account (the Stripe customer, the
-- subscription and the payment state of one Organisation) and its index
-- organisation_billing_account_customer (one billing account for each Stripe
-- customer; the billing webhook finds the account by the customer). Pantry
-- makes a row only when an owner starts payment setup. Apply once to each
-- deployed regional database before the release that writes the table.
CREATE TABLE organisation_billing_account (
  organisation_id TEXT PRIMARY KEY REFERENCES organisation(organisation_id),
  stripe_customer_id TEXT NOT NULL CHECK (stripe_customer_id LIKE 'cus_%'),
  stripe_subscription_id TEXT CHECK (stripe_subscription_id IS NULL OR stripe_subscription_id LIKE 'sub_%'),
  payment_state TEXT NOT NULL CHECK (payment_state IN ('none', 'active', 'past_due', 'canceled')),
  last_stripe_event_created INTEGER NOT NULL DEFAULT 0 CHECK (last_stripe_event_created >= 0),
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX organisation_billing_account_customer
  ON organisation_billing_account (stripe_customer_id);

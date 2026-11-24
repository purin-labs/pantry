-- Regional database patch, data only: no table, index or trigger changes.
-- Touches organisation_capability_policy and access_grant.
--
-- The eight Stripe write capabilities had no tool that ran them, and the
-- capability catalogue no longer has them. A policy row or a grant that names
-- a capability outside the catalogue makes the policy snapshot and the Access
-- read of its Organisation fail, so the rows of the eight capabilities go.
-- Only file grants have dependent rows, so no other table changes.
--
-- Apply to each deployed REGIONAL database just BEFORE the Worker upload. The
-- new Worker refuses these rows in each policy snapshot, so an agent turn
-- would fail. The Worker before this release refuses only the Access read of
-- an Organisation that lacks a row, until the upload a moment later.
--   wrangler d1 execute <regional database> --env production --remote --file workers/platform/scripts/stripe-actions-d1-data-patch.sql
-- A second run changes nothing.
DELETE FROM organisation_capability_policy
WHERE capability_id IN (
  'stripe.charge.create',
  'stripe.refund.create',
  'stripe.subscription.cancel',
  'stripe.payout.create',
  'stripe.transfer.create',
  'stripe.payment_intent.capture',
  'stripe.payment_intent.confirm',
  'stripe.subscription.update'
);

DELETE FROM access_grant
WHERE json_extract(target_json, '$.capabilityId') IN (
  'stripe.charge.create',
  'stripe.refund.create',
  'stripe.subscription.cancel',
  'stripe.payout.create',
  'stripe.transfer.create',
  'stripe.payment_intent.capture',
  'stripe.payment_intent.confirm',
  'stripe.subscription.update'
);

import React from "react";
import { Link } from "react-router";
import type { BillingView } from "@purin-labs/control-api/portal/billing";
import {
  JevFacts,
  type JevFact,
} from "@purin-labs/area-integrations-contract/ui/features/jev-features/facts";
import {
  JEV_PAID_USE_ID,
  cents,
  microDollars,
} from "@purin-labs/area-integrations-contract/ui/features/jev-features/paid-use";
import "@purin-labs/area-integrations-contract/ui/features/jev-features/styles.css";
import { Button } from "@purin-labs/ui/index";
import { billingErrorMessage, openBillingPayment, readBilling } from "./api";
import "./billing.css";

/**
 * Settings › Billing (Plan 95 step 6): the plan, the payment state, the free
 * and paid Jev use of the month and the spending limit. The owner opens
 * Stripe Checkout with "Set up payment" and the Stripe Customer Portal with
 * "Manage payment". Pantry shows no card form and keeps no card data. The
 * owner and an admin read the page.
 */
type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; view: BillingView }>;

export function BillingRoute(props: {
  readonly organisationId: string;
  readonly isOwner: boolean;
  /** The owner or an admin. Another member cannot read billing. */
  readonly canRead: boolean;
  /** Settings › Jev, where the owner turns paid use on. */
  readonly jevHref: string;
}): React.ReactNode {
  const { organisationId, canRead } = props;
  const [load, setLoad] = React.useState<LoadState>({ kind: "loading" });

  const reload = React.useCallback(async () => {
    if (!canRead) return;
    setLoad({ kind: "loading" });
    try {
      setLoad({ kind: "ready", view: await readBilling(organisationId) });
    } catch (error) {
      setLoad({ kind: "failed", message: billingErrorMessage(error) });
    }
  }, [organisationId, canRead]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  if (!canRead)
    return (
      <div className="jev-page">
        <p className="jev-muted">Only the owner or an admin can see billing.</p>
      </div>
    );
  if (load.kind === "loading")
    return (
      <div className="jev-page">
        <p className="jev-muted" role="status">
          Loading billing…
        </p>
      </div>
    );
  if (load.kind === "failed")
    return (
      <div className="jev-page">
        <p role="alert">
          {load.message} <Button onClick={() => void reload()}>Retry</Button>
        </p>
      </div>
    );

  const { view } = load;
  return (
    <div className="jev-page billing-page">
      <JevFacts label="Billing" rows={billingRows(view)} />
      {/* An Organisation on its own key pays TypeSafe, and needs no payment here. */}
      {view.freeUse === null && view.paymentState === "none" ? null : (
        <PaymentAction
          organisationId={organisationId}
          view={view}
          isOwner={props.isOwner}
        />
      )}
      {view.freeUse === null ? null : (
        <p className="jev-muted">
          <Link to={`${props.jevHref}#${JEV_PAID_USE_ID}`}>
            Change paid use in Jev
          </Link>
        </p>
      )}
    </div>
  );
}

/**
 * "Set up payment" before payment is set up, and "Manage payment" after it.
 * Each one opens a Stripe page in this tab; Stripe returns the owner here.
 */
function PaymentAction(props: {
  readonly organisationId: string;
  readonly view: BillingView;
  readonly isOwner: boolean;
}): React.ReactNode {
  const { view } = props;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const page =
    view.paymentState === "active" || view.paymentState === "past_due"
      ? "portal"
      : "checkout";

  if (!view.open)
    return (
      <p className="jev-muted">
        Payment setup is not open yet. It opens when Purin Pantry billing
        starts.
      </p>
    );
  if (!props.isOwner)
    return (
      <p className="jev-muted">Only the owner can set up or manage payment.</p>
    );

  const open = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      window.location.assign(
        await openBillingPayment(
          props.organisationId,
          page,
          `${window.location.pathname}${window.location.search}`,
        ),
      );
    } catch (caught) {
      setError(billingErrorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <div className="billing-action">
      <Button
        variant={page === "checkout" ? "primary" : "secondary"}
        disabled={busy}
        onClick={() => void open()}
      >
        {page === "checkout" ? "Set up payment" : "Manage payment"}
      </Button>
      <span className="jev-muted">
        {page === "checkout"
          ? "Stripe takes the card. Pantry keeps no card data."
          : "Stripe shows the card and the invoices."}
      </span>
      {error === null ? null : (
        <p className="jev-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const PAYMENT_STATE_TEXT: Readonly<
  Record<BillingView["paymentState"], string>
> = {
  none: "Not set up.",
  active: "Active.",
  past_due:
    "A payment failed. Paid use is stopped until the payment passes. Free use continues.",
  canceled: "Canceled. Paid use is stopped. Free use continues.",
};

/** Each billing fact of the month as one row. */
function billingRows(view: BillingView): readonly JevFact[] {
  const { freeUse, paidUse } = view;
  const plan: JevFact = ["Plan", view.plan.name];
  if (freeUse === null)
    return [
      plan,
      ["Who pays for Jev", "Your own TypeSafe key. TypeSafe bills you."],
    ];
  return [
    plan,
    [
      "Payment",
      view.paymentState === "past_due" ? (
        <span className="jev-warning">{PAYMENT_STATE_TEXT.past_due}</span>
      ) : (
        PAYMENT_STATE_TEXT[view.paymentState]
      ),
    ],
    [
      "Free Jev use",
      `${microDollars(freeUse.usedMicrousd)} of ${microDollars(freeUse.limitMicrousd)} this month`,
    ],
    ["Free use starts again", resetDay(freeUse.resetsAt)],
    [
      "Paid use",
      paidUse.enabled
        ? "On. Jev keeps running above the free use."
        : "Off. Jev stops at the free use.",
    ],
    ["Paid charge this month", cents(paidUse.spentMinor)],
    [
      "Monthly spending limit",
      paidUse.limitReached
        ? `${cents(paidUse.spendingLimitMinor)}. Jev reached the limit and stops until the next month.`
        : cents(paidUse.spendingLimitMinor),
    ],
  ];
}

function resetDay(resetsAt: number): string {
  return new Date(resetsAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

import React from "react";
import { Link } from "react-router";
import type { JevFeaturesView } from "@purin-labs/control-api/portal/jev-features";
import {
  jevFeatureErrorMessage,
  readJevFeatures,
} from "@purin-labs/area-integrations-contract/ui/features/jev-features/api";
import {
  JevFacts,
  type JevFact,
} from "@purin-labs/area-integrations-contract/ui/features/jev-features/facts";
import {
  JEV_PAID_USE_ID,
  JevUsePrompt,
  cents,
  microDollars,
  pricedNote,
  resetDate,
} from "@purin-labs/area-integrations-contract/ui/features/jev-features/paid-use";
import "@purin-labs/area-integrations-contract/ui/features/jev-features/styles.css";
import "./billing.css";

/**
 * Settings › Billing (Plan 88 section 4): the Jev use of the month against
 * the free use, paid use, the month's paid charge and the spending limit. It
 * reads the jev-features view and keeps no copy of a balance. Pantry has no
 * payment method, credit or invoice of its own yet (Plan 95 step 6).
 */
type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; view: JevFeaturesView }>;

export function BillingRoute(props: {
  readonly organisationId: string;
  readonly isOwner: boolean;
  /** Settings › Jev, where the owner turns paid use on. */
  readonly jevHref: string;
}): React.ReactNode {
  const { organisationId } = props;
  const [load, setLoad] = React.useState<LoadState>({ kind: "loading" });

  const reload = React.useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      setLoad({ kind: "ready", view: await readJevFeatures(organisationId) });
    } catch (error) {
      setLoad({ kind: "failed", message: jevFeatureErrorMessage(error) });
    }
  }, [organisationId]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

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
          {load.message}{" "}
          <button type="button" onClick={() => void reload()}>
            Retry
          </button>
        </p>
      </div>
    );

  const { view } = load;
  const paidUseHref = `${props.jevHref}#${JEV_PAID_USE_ID}`;
  return (
    <div className="jev-page billing-page">
      <JevUsePrompt
        view={view}
        isOwner={props.isOwner}
        turnOn={{ kind: "link", href: paidUseHref }}
      />
      <JevFacts label="Billing" rows={billingRows(view)} />
      {view.allowance === null ? null : (
        <p className="jev-muted">
          <Link to={paidUseHref}>Change paid use in Jev</Link>
        </p>
      )}
    </div>
  );
}

/**
 * Each money fact of the month as one row. Pantry has no payment method,
 * credit or invoice of its own yet; the last row says so.
 */
function billingRows(view: JevFeaturesView): readonly JevFact[] {
  return [...jevRows(view), PANTRY_BILLING_ROW];
}

const PANTRY_BILLING_ROW: JevFact = [
  "Payment method, credit and invoices",
  "Purin Pantry billing has not started, so Pantry keeps none of them yet.",
];

function jevRows(view: JevFeaturesView): readonly JevFact[] {
  const { allowance, paidUse } = view;
  if (allowance === null)
    return [["Who pays for Jev", "Your own TypeSafe key. TypeSafe bills you."]];
  const note = pricedNote(paidUse.priced);
  const reached =
    paidUse.enabled && paidUse.spentMinor >= paidUse.spendingLimitMinor;
  return [
    [
      "Free Jev use",
      `${microDollars(Math.min(allowance.usedMicrousd, allowance.limitMicrousd))} of ${microDollars(allowance.limitMicrousd)} this month`,
    ],
    ["Free use starts again", resetDate(allowance)],
    [
      "Paid use",
      <>
        {paidUse.enabled
          ? "On. Jev keeps running above the free use."
          : "Off. Jev stops at the free use."}
        {note === null ? null : (
          <>
            {" "}
            <span className="jev-warning">{note}</span>
          </>
        )}
      </>,
    ],
    ["Paid charge this month", cents(paidUse.spentMinor)],
    [
      "Monthly spending limit",
      reached
        ? `${cents(paidUse.spendingLimitMinor)}. Jev reached the limit and stops until the next month.`
        : cents(paidUse.spendingLimitMinor),
    ],
  ];
}

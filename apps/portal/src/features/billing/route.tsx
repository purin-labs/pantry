import React from "react";
import { Link } from "react-router";
import type { JevFeaturesView } from "@seams/control-api/portal/jev-features";
import {
  jevFeatureErrorMessage,
  readJevFeatures,
} from "../jev-features/api";
import {
  JEV_PAID_USE_ID,
  JevUsePrompt,
  cents,
  microDollars,
  pricedNote,
  resetDate,
} from "../jev-features/paid-use";
import "../jev-features/styles.css";

/**
 * Settings › Billing (Plan 88 section 4): the Jev use of the month against
 * the free use, paid use, the month's paid charge and the spending limit. It
 * reads the jev-features view and keeps no copy of a balance. The payment
 * method, credit and invoices stay in the shared Seams Console.
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
    <div className="jev-page">
      <JevUsePrompt
        view={view}
        isOwner={props.isOwner}
        turnOn={{ kind: "link", href: paidUseHref }}
      />
      <dl className="billing-values">
        <JevUseValue view={view} />
        {view.allowance === null ? null : <PaidUseValues view={view} />}
        <div className="billing-value">
          <dt>Payment method, credit and invoices</dt>
          <dd>
            The Seams account keeps them, on the billing page of the Seams
            Console.
          </dd>
        </div>
      </dl>
      {view.allowance === null ? null : (
        <p className="jev-muted">
          <Link to={paidUseHref}>Settings › Jev</Link> has the paid use switch
          and the spending limit.
        </p>
      )}
    </div>
  );
}

function JevUseValue(props: { readonly view: JevFeaturesView }): React.ReactNode {
  const { allowance } = props.view;
  return (
    <div className="billing-value">
      <dt>Jev use this month</dt>
      <dd>
        {allowance === null
          ? "Your own TypeSafe key pays for Jev. TypeSafe bills that use to you."
          : `${microDollars(Math.min(allowance.usedMicrousd, allowance.limitMicrousd))} of ${microDollars(allowance.limitMicrousd)} free use. It starts again on ${resetDate(allowance)}.`}
      </dd>
    </div>
  );
}

function PaidUseValues(props: {
  readonly view: JevFeaturesView;
}): React.ReactNode {
  const { paidUse } = props.view;
  const note = pricedNote(paidUse.priced);
  return (
    <>
      <div className="billing-value">
        <dt>Paid use</dt>
        <dd>
          {paidUse.enabled
            ? "On. Jev keeps running above the free use."
            : "Off. Jev stops at the free use."}
          {note === null ? null : (
            <>
              {" "}
              <span className="jev-warning">{note}</span>
            </>
          )}
        </dd>
      </div>
      <div className="billing-value">
        <dt>Paid charge this month</dt>
        <dd>{cents(paidUse.spentMinor)}</dd>
      </div>
      <div className="billing-value">
        <dt>Monthly spending limit</dt>
        <dd>
          {cents(paidUse.spendingLimitMinor)}
          {paidUse.enabled && paidUse.spentMinor >= paidUse.spendingLimitMinor
            ? ". Jev reached the limit and stops until the next month."
            : null}
        </dd>
      </div>
    </>
  );
}

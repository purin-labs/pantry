import React from "react";
import { Link } from "react-router";
import type {
  JevAllowance,
  JevFeaturesView,
} from "@purin-labs/control-api/portal/jev-features";
import { Switch } from "@purin-labs/ui/toggle-switch";
import { changeJevPaidUse, jevFeatureErrorMessage } from "./api";
import { JevFacts } from "./facts";

/**
 * Paid Jev use above the free use, and the prompt at 80 % and 100 % of the
 * free use (Plan 88 section 4). Settings › Jev and Settings › Billing share
 * these parts.
 */

/** The id of the Paid use section; `#jev-paid-use` opens it. */
export const JEV_PAID_USE_ID = "jev-paid-use";

const PROMPT_SHARE = 0.8;
const MAX_LIMIT_MINOR = 100_000;

export function resetDate(allowance: JevAllowance): string {
  return new Date(allowance.resetsAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

export function microDollars(microusd: number): string {
  return "$" + (microusd / 1_000_000).toFixed(2);
}

export function cents(minor: number): string {
  return "$" + (minor / 100).toFixed(2);
}

/** The prompt shows at 80 % of the free use while paid use is off. */
function promptDue(view: JevFeaturesView): boolean {
  const { allowance } = view;
  if (allowance === null || view.paidUse.enabled) return false;
  if (allowance.reached) return true;
  return (
    allowance.limitMicrousd > 0 &&
    allowance.usedMicrousd / allowance.limitMicrousd >= PROMPT_SHARE
  );
}

/** "$5" or "5.00" to US cents, or null when it is not a valid limit. */
function parseLimit(text: string): number | null {
  const match = /^\s*\$?\s*(\d{1,4})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (match === null) return null;
  const minor =
    Number(match[1]) * 100 + Number((match[2] ?? "0").padEnd(2, "0"));
  return minor >= 1 && minor <= MAX_LIMIT_MINOR ? minor : null;
}

const LIMIT_HINT = "Enter a spending limit from $0.01 to $1,000.00.";

/**
 * One line at 80 % or 100 % of the free use. The owner gets "Turn on paid
 * use"; another member is told to ask the owner.
 */
export function JevUsePrompt(props: {
  readonly view: JevFeaturesView;
  readonly isOwner: boolean;
  readonly turnOn: Readonly<
    { kind: "focus"; onClick: () => void } | { kind: "link"; href: string }
  >;
}): React.ReactNode {
  const { view } = props;
  if (!promptDue(view) || view.allowance === null) return null;
  const share = view.allowance.reached ? "all of" : "80 % of";
  return (
    <p className="jev-prompt" role="status">
      <span>
        You have used {share} the free Jev use of this month. It starts again on{" "}
        {resetDate(view.allowance)}.
        {props.isOwner ? null : " Ask the owner to turn on paid use."}
      </span>
      {props.isOwner ? (
        props.turnOn.kind === "focus" ? (
          <button
            type="button"
            className="secondary"
            onClick={props.turnOn.onClick}
          >
            Turn on paid use
          </button>
        ) : (
          <Link className="jev-prompt-link" to={props.turnOn.href}>
            Turn on paid use
          </Link>
        )
      ) : null}
    </p>
  );
}

/** Why paid use cannot start yet, or null when it is open. */
export function pricedNote(priced: boolean): string | null {
  return priced
    ? null
    : "Paid Jev use is not open yet. It opens when Purin Pantry billing starts.";
}

/** The stop at the spending limit, while paid use is on. */
function SpendingLimitReached(props: {
  readonly view: JevFeaturesView;
}): React.ReactNode {
  const { paidUse, allowance } = props.view;
  if (!paidUse.enabled || paidUse.spentMinor < paidUse.spendingLimitMinor)
    return null;
  return (
    <p className="jev-warning" role="status">
      Jev reached the spending limit.{" "}
      {allowance === null
        ? "Jev features pause until the next month."
        : `Jev features pause until ${resetDate(allowance)}.`}{" "}
      A higher limit starts them again.
    </p>
  );
}

/**
 * Settings › Jev › Paid use. The owner turns it on or off and sets the
 * monthly spending limit; other members see the state.
 */
export function PaidUseSection(props: {
  readonly organisationId: string;
  readonly view: JevFeaturesView;
  readonly isOwner: boolean;
  readonly onView: (view: JevFeaturesView) => void;
  readonly switchRef: React.Ref<HTMLDivElement>;
}): React.ReactNode {
  const { view, isOwner } = props;
  const { paidUse } = view;
  const [limit, setLimit] = React.useState(
    (paidUse.spendingLimitMinor / 100).toFixed(2),
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    setLimit((paidUse.spendingLimitMinor / 100).toFixed(2));
  }, [paidUse.spendingLimitMinor]);

  const send = async (enabled: boolean): Promise<void> => {
    const spendingLimitMinor = parseLimit(limit);
    setSaved(false);
    if (spendingLimitMinor === null) {
      setError(LIMIT_HINT);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      props.onView(
        await changeJevPaidUse(props.organisationId, {
          enabled,
          spendingLimitMinor,
        }),
      );
      setSaved(true);
    } catch (caught) {
      setError(jevFeatureErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const note = pricedNote(paidUse.priced);
  // A person can always turn paid use off; turning it on needs the price.
  const switchDisabled = !isOwner || (!paidUse.enabled && !paidUse.priced);
  const limitChanged = parseLimit(limit) !== paidUse.spendingLimitMinor;

  return (
    <section
      id={JEV_PAID_USE_ID}
      className="jev-paid-use"
      aria-labelledby="jev-paid-use-title"
      tabIndex={-1}
    >
      <div className="jev-row-head">
        <h3 id="jev-paid-use-title" className="jev-row-title">
          Paid use
        </h3>
        <span className="jev-row-state" aria-hidden="true">
          {busy ? "Saving…" : paidUse.enabled ? "On" : "Off"}
        </span>
        <div ref={props.switchRef} className="jev-paid-use-switch">
          <Switch
            checked={paidUse.enabled}
            onCheckedChange={(enabled) => void send(enabled)}
            busy={busy}
            disabled={switchDisabled}
            aria-labelledby="jev-paid-use-title"
            aria-describedby="jev-paid-use-description"
          />
        </div>
      </div>
      <p id="jev-paid-use-description" className="jev-row-description">
        Jev keeps running above the free use, and the use is billed.
      </p>
      <JevFacts
        label="Paid use"
        rows={[
          ["Price", "$0.084 for each million input tokens"],
          [
            "How you pay",
            "Through Purin Pantry billing, which has not started yet.",
          ],
          ...(paidUse.enabled
            ? [
                [
                  "Spent this month",
                  `${cents(paidUse.spentMinor)} of ${cents(paidUse.spendingLimitMinor)}`,
                ] as const,
              ]
            : []),
          ...(isOwner
            ? []
            : [
                [
                  "Monthly spending limit",
                  cents(paidUse.spendingLimitMinor),
                ] as const,
              ]),
        ]}
      />
      {note === null ? null : (
        <p className="jev-warning" role="status">
          {note}
        </p>
      )}
      <SpendingLimitReached view={view} />
      {isOwner ? (
        <form
          className="jev-limit"
          onSubmit={(event) => {
            event.preventDefault();
            void send(paidUse.enabled);
          }}
        >
          <label htmlFor="jev-spending-limit">Monthly spending limit</label>
          <span className="jev-limit-field">
            <span aria-hidden="true">$</span>
            <input
              id="jev-spending-limit"
              inputMode="decimal"
              autoComplete="off"
              value={limit}
              disabled={busy}
              aria-describedby="jev-spending-limit-hint"
              onChange={(event) => {
                setLimit(event.target.value);
                setSaved(false);
              }}
            />
          </span>
          <button
            type="submit"
            className="secondary"
            disabled={busy || !limitChanged}
          >
            Save
          </button>
          <span id="jev-spending-limit-hint" className="jev-muted">
            At the limit, Jev stops until the next month.
          </span>
        </form>
      ) : null}
      {isOwner ? null : (
        <p className="jev-muted">Only the owner can turn on paid use.</p>
      )}
      {error === null ? null : (
        <p className="jev-error" role="alert">
          {error}
        </p>
      )}
      {saved && error === null ? (
        <p className="jev-muted" role="status">
          Saved.
        </p>
      ) : null}
    </section>
  );
}

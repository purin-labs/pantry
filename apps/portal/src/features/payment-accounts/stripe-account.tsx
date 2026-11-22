import React from "react";
import { Select } from "@purin-labs/ui/select";

import {
  paymentAccountErrorMessage,
  readStripePaymentAccounts,
  startStripeOnboarding,
} from "./api";
import type { StripePaymentAccount } from "@purin-labs/control-api/portal/payment-accounts";

/** Countries where Stripe accepts a new business, nearest market first. */
const ONBOARDING_COUNTRIES: readonly Readonly<{
  code: string;
  name: string;
}>[] = [
  { code: "JP", name: "Japan" },
  { code: "SG", name: "Singapore" },
  { code: "HK", name: "Hong Kong" },
  { code: "AU", name: "Australia" },
  { code: "NZ", name: "New Zealand" },
  { code: "MY", name: "Malaysia" },
  { code: "TH", name: "Thailand" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "FR", name: "France" },
];
const COUNTRY_ITEMS = ONBOARDING_COUNTRIES.map((option) => ({
  value: option.code,
  label: option.name,
}));

const STATE_LABELS: Readonly<Record<StripePaymentAccount["state"], string>> = {
  onboarding: "Stripe needs more details",
  active: "Takes payments",
  restricted: "Stripe has paused payments",
};

/**
 * The shop's Stripe account (Plan 80 step 5). Commerce holds the account
 * that takes the shop's online payments. A shop with no Stripe account
 * opens Stripe's own onboarding; Stripe returns the owner to this page. An
 * owner who already uses Stripe connects that account instead.
 */
export function StripePaymentAccountSetup(props: {
  readonly organisationId: string;
  /** Null once a Stripe account is connected, or for a member who cannot. */
  readonly connectExisting: (() => void) | null;
  readonly connectBusy: boolean;
  readonly connectFeedback: React.ReactNode;
}): React.ReactNode {
  const { organisationId } = props;
  const [accounts, setAccounts] = React.useState<
    readonly StripePaymentAccount[] | null
  >(null);
  const [country, setCountry] = React.useState("JP");
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);

  React.useEffect(() => {
    let current = true;
    readStripePaymentAccounts(organisationId).then(
      (listed) => {
        if (current) setAccounts(listed);
      },
      (error: unknown) => {
        if (current) setFailure(paymentAccountErrorMessage(error));
      },
    );
    return () => {
      current = false;
    };
  }, [organisationId]);

  const open = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const url = await startStripeOnboarding(
        organisationId,
        country,
        `${window.location.pathname}${window.location.search}`,
      );
      window.location.assign(url);
    } catch (error) {
      setFailure(paymentAccountErrorMessage(error));
      setBusy(false);
    }
  };

  if (accounts === null && failure === null)
    return <p className="field-hint">Reading the shop's Stripe account…</p>;
  const account = accounts?.[0] ?? null;
  const failureText =
    failure === null ? null : (
      <p className="error-text" role="alert">
        {failure}
      </p>
    );
  if (account !== null)
    return (
      <form
        className="stripe-account-state"
        onSubmit={(event) => {
          event.preventDefault();
          void open();
        }}
        noValidate
      >
        <p>
          <strong>{STATE_LABELS[account.state]}</strong>
          <span>
            {account.providerAccountId} · {account.country}
          </span>
        </p>
        {account.state === "active" ? null : (
          <button
            type="submit"
            className="connection-primary-action"
            disabled={busy}
          >
            Finish Stripe setup
          </button>
        )}
        {failureText}
      </form>
    );
  return (
    <>
      <p className="field-hint">
        Stripe takes card payments for the shop's online orders and pays them
        out to your bank.
      </p>
      {accounts === null ? null : (
        <form
          className="provider-connect"
          onSubmit={(event) => {
            event.preventDefault();
            void open();
          }}
          noValidate
        >
          <label>
            <span>Country of the business</span>
            <Select.Root
              name="country"
              items={COUNTRY_ITEMS}
              value={country}
              onValueChange={(value) => {
                if (value !== null) setCountry(value);
              }}
              disabled={busy}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {ONBOARDING_COUNTRIES.map((option) => (
                  <Select.Item key={option.code} value={option.code}>
                    {option.name}
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Root>
          </label>
          <button
            type="submit"
            className="connection-primary-action"
            disabled={busy}
          >
            Create a Stripe account
          </button>
        </form>
      )}
      {failureText}
      {props.connectExisting === null ? null : (
        <div className="stripe-account-existing">
          <span>Already use Stripe?</span>
          <button
            type="button"
            aria-label="Connect your Stripe account in a popup"
            onClick={props.connectExisting}
            disabled={props.connectBusy}
          >
            Connect your Stripe account
          </button>
        </div>
      )}
      {props.connectFeedback}
    </>
  );
}

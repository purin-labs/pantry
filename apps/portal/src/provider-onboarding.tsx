import React from "react";

import { formatRelativeTime } from "./formatting";
import { assertNever } from "@purin-labs/std";

/**
 * The pieces every provider onboarding card shares: the one primary action
 * with its progress spoken aloud, and the dated record of a last attempt that
 * did not finish. File storage, email, and WhatsApp compose these with their
 * own copy; nothing here knows a provider by name.
 */

/**
 * Where one provider's connection stands, from the pieces the route keeps:
 * the in-flight start request, the consent window it is waiting on, and the
 * last failure it recorded. At most one of them holds at a time.
 */
export type ProviderConnectionState =
  | { readonly kind: "idle" }
  | { readonly kind: "opening" }
  | { readonly kind: "waiting" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The organisation's latest connection attempt that failed at the provider
 * callback, as the control plane recorded it. It stays until a later attempt
 * for the same provider succeeds, so it is dated rather than treated as live.
 */
export type ProviderAttemptDiagnostics = {
  readonly provider: string;
  readonly supportReference: string;
  readonly reasonCode: string;
  readonly occurredAt: number;
};

export type ProviderAttemptFailureCopy = {
  /** What went wrong, in the operator's words. */
  readonly summary: string;
  /** What to do about it. */
  readonly nextStep: string;
};

/**
 * The one primary action of an onboarding card. The button names what it is
 * doing, a live region narrates the wait, a cancel appears only while a
 * consent window is open, and the help and error text are tied to the button.
 */
export function ProviderConnectAction(props: {
  readonly id: string;
  /** The service whose window opens, as the operator knows it (Meta, Google, Dropbox). */
  readonly service: string;
  readonly label: string;
  readonly state: ProviderConnectionState;
  /** Held closed by something outside the state, such as a missing deployment credential. */
  readonly disabled: boolean;
  readonly connect: () => Promise<void>;
  readonly cancel: () => void;
  /** A line under the button; null when the card already says it. */
  readonly help: string | null;
  readonly waitingHint: string;
}): React.ReactNode {
  const helpId = `${props.id}-help`;
  const errorId = `${props.id}-error`;
  const busy = props.state.kind === "opening" || props.state.kind === "waiting";
  return (
    <>
      <div className="connection-actions provider-onboarding-actions">
        <button
          type="button"
          className="connection-primary-action"
          onClick={props.connect}
          disabled={props.disabled || busy}
          aria-describedby={
            [
              props.help === null ? null : helpId,
              props.state.kind === "failed" ? errorId : null,
            ]
              .filter(isPresent)
              .join(" ") || undefined
          }
        >
          {providerConnectLabel(props.state, props.service, props.label)}
        </button>
        {props.state.kind === "waiting" ? (
          <button type="button" onClick={props.cancel}>
            Cancel
          </button>
        ) : null}
        {props.help === null ? null : (
          <p id={helpId} className="notice-text">
            {props.help}
          </p>
        )}
      </div>
      <p className="provider-onboarding-status" role="status">
        {providerConnectProgress(props.state, props.service, props.waitingHint)}
      </p>
      {props.state.kind === "failed" ? (
        <p id={errorId} className="error-text" role="alert">
          {props.state.message}
        </p>
      ) : null}
    </>
  );
}

function isPresent(value: string | null): value is string {
  return value !== null;
}

function providerConnectLabel(
  state: ProviderConnectionState,
  service: string,
  label: string,
): string {
  switch (state.kind) {
    case "opening":
      return `Opening ${service}…`;
    case "waiting":
      return `Waiting for ${service}…`;
    case "idle":
    case "failed":
      return label;
    default:
      return assertNever(state, "Unhandled provider onboarding state");
  }
}

function providerConnectProgress(
  state: ProviderConnectionState,
  service: string,
  waitingHint: string,
): string {
  switch (state.kind) {
    case "opening":
      return `Opening ${service} in a new window…`;
    case "waiting":
      return waitingHint;
    case "idle":
    case "failed":
      return "";
    default:
      return assertNever(state, "Unhandled provider onboarding state");
  }
}

/**
 * A dated account of the last attempt that failed at the provider, with the
 * reference support will ask for. It is not a live alert: the operator may be
 * reading it days later, so it says when, what, and what to do next.
 */
export function LastAttemptNotice(props: {
  readonly attempt: ProviderAttemptDiagnostics;
  readonly copy: ProviderAttemptFailureCopy;
}): React.ReactNode {
  return (
    <div className="notice notice-warning provider-last-attempt">
      <p>
        <strong>
          Your last attempt ({formatRelativeTime(props.attempt.occurredAt)})
          didn&rsquo;t finish.
        </strong>{" "}
        {props.copy.summary} Nothing was stored, and anything already connected
        is unchanged.
      </p>
      <p>
        {props.copy.nextStep} Support reference:{" "}
        <code>{props.attempt.supportReference}</code>
      </p>
    </div>
  );
}

/**
 * The reason codes a provider callback can record, in the operator's words.
 * Codes without their own sentence still get an honest generic one; nothing
 * here echoes the code itself.
 */
export function providerAttemptFailureCopy(
  service: string,
  reasonCode: string,
): ProviderAttemptFailureCopy {
  switch (reasonCode) {
    case "authorization_cancelled":
      return {
        summary: `The ${service} sign-in was closed or declined before it finished.`,
        nextStep: "Start again when you're ready.",
      };
    case "authorization_expired":
      return {
        summary: `The ${service} sign-in sat idle too long and expired.`,
        nextStep: "Start again.",
      };
    case "provider_scope_missing":
      return {
        summary: `${service} didn't grant every permission that Seams Pantry asked for.`,
        nextStep:
          "Try again. On the consent screen, tick every box before you continue.",
      };
    case "provider_account_already_claimed":
      return {
        summary: `This ${service} account is already connected to another Seams Pantry organisation.`,
        nextStep:
          "Use a different account, or delete the other organisation first.",
      };
    case "provider_account_ineligible":
      return {
        summary: `${service} finished the sign-in without an account that Seams Pantry can use.`,
        nextStep: "Try again with a different account.",
      };
    case "provider_asset_missing":
      return {
        summary: `${service} finished the sign-in without sharing the business account that Seams Pantry needs.`,
        nextStep: "Try again and choose the account before finishing.",
      };
    case "provider_environment_mismatch":
      return {
        summary: `The ${service} account belongs to a different environment than this workspace.`,
        nextStep: "Connect an account that matches this workspace.",
      };
    case "provider_distribution_disabled":
      return {
        summary: `This Seams Pantry deployment isn't set up for ${service} connections yet.`,
        nextStep:
          "Nothing for you to fix. Contact support and quote the reference below.",
      };
    case "provider_state_invalid":
      return {
        summary: `Pantry couldn't verify what ${service} sent back.`,
        nextStep: "Start a new connection.",
      };
    case "provider_rate_limited":
    case "provider_temporarily_unavailable":
      return {
        summary: `${service} didn't answer in time.`,
        nextStep: "Try again in a few minutes.",
      };
    case "credential_verification_failed":
      return {
        summary: "Pantry couldn't store the connection securely.",
        nextStep: "Try again. Contact support if it happens twice.",
      };
    default:
      return {
        summary: "The connection couldn't be completed.",
        nextStep:
          "Try again. If it keeps failing, contact support and quote the reference below.",
      };
  }
}

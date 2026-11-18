import React from "react";
import { Check, Circle, CircleAlert } from "lucide-react";

import { providerLabel, providerTile } from "../../integration-catalogue";
import { ProviderTile } from "../../page-components";
import { AuthorizationScreen } from "../../ui";

/**
 * Says what a provider sign-in does before it starts, on an authorization
 * screen of its own. The sign-in opens from the Continue click, so the browser
 * still treats the popup as user-opened.
 */
export function ConnectConsentDialog(
  props: Readonly<{
    /** The provider that is about to open; null keeps the dialog closed. */
    provider: string | null;
    /** The signed-in person, shown as the account chip when known. */
    signedInAs?: string | null;
    close: () => void;
    confirm: () => void;
  }>,
): React.ReactNode {
  const provider = props.provider;
  const label = provider === null ? "" : providerLabel(provider);
  return (
    <AuthorizationScreen
      open={provider !== null}
      onClose={props.close}
      className="connect-consent"
      requester={{
        name: "Seams Pantry",
        icon: <ProviderTile provider="satyr_commerce" label="Seams Pantry" />,
      }}
      target={{
        name: label,
        icon: (
          <ProviderTile
            provider={provider === null ? "generic" : providerTile(provider)}
            label={label}
          />
        ),
      }}
      title={`Connect to ${label}`}
      subtitle="Let Seams Pantry use this account for your workspace."
      asideHeading={`What happens when you continue`}
      aside={
        <ul className="connect-consent-points">
          <ConsentPoint
            title={`Sign in at ${label}`}
            detail="Pantry never sees your password."
          />
          <ConsentPoint
            title="You approve the access"
            detail={`Pantry gets only what you approve at ${label}.`}
          />
          <ConsentPoint
            title="You stay in control"
            detail="Disable this connection at any time."
          />
        </ul>
      }
      confirm={{ label: "Continue", onSelect: props.confirm }}
      cancelLabel="Cancel"
      footnote="Manage your connections at any time in Integrations."
      account={
        props.signedInAs === undefined || props.signedInAs === null
          ? null
          : { name: props.signedInAs, action: null }
      }
    />
  );
}

/**
 * One line of what a sign-in or a setup means. A caution and a step still to
 * do carry their own marks and words, so the point does not depend on its
 * colour.
 */
export function ConsentPoint(
  props: Readonly<{
    title: string;
    detail: string;
    mark?: "done" | "todo" | "caution";
  }>,
): React.ReactNode {
  const mark = props.mark ?? "done";
  return (
    <li
      className={
        mark === "caution"
          ? "connect-consent-caution"
          : mark === "todo"
            ? "connect-consent-todo"
            : undefined
      }
    >
      {mark === "caution" ? (
        <CircleAlert aria-hidden="true" size={18} />
      ) : mark === "todo" ? (
        <Circle aria-hidden="true" size={18} />
      ) : (
        <Check aria-hidden="true" size={18} />
      )}
      <span>
        <strong>
          {mark === "todo" ? (
            <span className="visually-hidden">Not yet: </span>
          ) : null}
          {props.title}
        </strong>
        <small>{props.detail}</small>
      </span>
    </li>
  );
}

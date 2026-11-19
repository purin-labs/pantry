import React from "react";
import { controlMutation } from "../control-client";
import { PortalFrame } from "../shell";
import { isRecord } from "@purin-labs/std";

type Invitation = Readonly<{
  organisationId: string;
  invitationId: string;
  token: string;
}>;

type AccountInvitationRoute =
  | Readonly<{ kind: "none"; invitation?: never }>
  | Readonly<{ kind: "invalid"; invitation?: never }>
  | Readonly<{ kind: "link_failed"; retryHref: string; invitation?: never }>
  | Readonly<{ kind: "pending"; invitation: Invitation }>;

type Acceptance =
  | Readonly<{ kind: "ready"; problem?: never }>
  | Readonly<{ kind: "accepting"; problem?: never }>
  | Readonly<{ kind: "accepted"; problem?: never }>
  | Readonly<{ kind: "failed"; problem: string }>;

export function readAccountInvitationRoute(
  url: URL,
  storage: Storage,
): AccountInvitationRoute {
  const organisationId = url.searchParams.get("accountInvitationOrganisation");
  const invitationId = url.searchParams.get("accountInvitationId");
  const fragmentToken = new URLSearchParams(url.hash.slice(1)).get(
    "accountInvitationToken",
  );
  if (
    organisationId === null &&
    invitationId === null &&
    fragmentToken === null
  ) {
    return { kind: "none" };
  }
  if (
    !validInvitationValue(organisationId) ||
    !validInvitationValue(invitationId)
  ) {
    return { kind: "invalid" };
  }
  let token: string | null;
  try {
    const key = accountInvitationTokenKey(organisationId, invitationId);
    token = fragmentToken ?? storage.getItem(key);
    if (!validInvitationValue(token)) return { kind: "invalid" };
    storage.setItem(key, token);
  } catch {
    return { kind: "invalid" };
  }
  if (url.searchParams.get("accountInvitationLink") === "failed") {
    const retry = new URL(url.href);
    retry.searchParams.delete("accountInvitationLink");
    retry.searchParams.delete("accountLink");
    return {
      kind: "link_failed",
      retryHref: `/v1/control/auth/google/start?returnTo=${encodeURIComponent(retry.pathname + retry.search)}`,
    };
  }
  return {
    kind: "pending",
    invitation: { organisationId, invitationId, token },
  };
}

function accountInvitationTokenKey(
  organisationId: string,
  invitationId: string,
): string {
  return `satyr.accountInvitationToken:${JSON.stringify([organisationId, invitationId])}`;
}

function validInvitationValue(value: string | null): value is string {
  return (
    value !== null &&
    value.length > 0 &&
    value.length <= 2048 &&
    value.trim() === value
  );
}

export function accountInvitationHref(
  organisationId: string,
  invitationId: string,
  token: string,
): string {
  const url = new URL("/portal", window.location.origin);
  url.searchParams.set("accountInvitationOrganisation", organisationId);
  url.searchParams.set("accountInvitationId", invitationId);
  url.hash = new URLSearchParams({ accountInvitationToken: token }).toString();
  return url.href;
}

export function AccountInvitationPage(
  props: Readonly<{
    route: Exclude<AccountInvitationRoute, { kind: "none" }>;
    displayName: string;
    logout: () => Promise<void>;
  }>,
): React.ReactNode {
  const [acceptance, setAcceptance] = React.useState<Acceptance>({
    kind: "ready",
  });
  return (
    <PortalFrame
      identity={{
        kind: "ready",
        displayName: props.displayName,
        logout: props.logout,
      }}
    >
      <section
        className="portal-band"
        aria-labelledby="account-invitation-title"
      >
        <h1 id="account-invitation-title">Seams Pantry invitation</h1>
        {props.route.kind === "invalid" ? (
          <p role="alert">
            This invitation link is incomplete. Ask the sender for a new link.
          </p>
        ) : props.route.kind === "link_failed" ? (
          <>
            <p role="alert">
              Pantry could not connect this invitation to your account. Your
              other organisations remain available.
            </p>
            <div className="connection-actions">
              <a
                className="connection-primary-action"
                href={props.route.retryHref}
              >
                Sign in to retry
              </a>
              <a className="button-link" href="/portal">
                Open your organisations
              </a>
            </div>
          </>
        ) : acceptance.kind === "accepted" ? (
          <>
            <p role="status">Invitation accepted. Your Pantry role is ready.</p>
            <a className="primary-button" href="/portal">
              Open your organisations
            </a>
          </>
        ) : (
          <>
            <p>
              Accept this invitation with the Google account that received it.
            </p>
            <button
              type="button"
              className="connection-primary-action"
              disabled={acceptance.kind === "accepting"}
              onClick={acceptAccountInvitation.bind(
                null,
                props.route.invitation,
                setAcceptance,
              )}
            >
              {acceptance.kind === "accepting"
                ? "Accepting…"
                : "Accept invitation"}
            </button>
            {acceptance.kind === "failed" ? (
              <p role="alert">{acceptance.problem}</p>
            ) : null}
          </>
        )}
      </section>
    </PortalFrame>
  );
}

async function acceptAccountInvitation(
  invitation: Invitation,
  setAcceptance: React.Dispatch<React.SetStateAction<Acceptance>>,
): Promise<void> {
  setAcceptance({ kind: "accepting" });
  try {
    const result = await controlMutation(
      `/v1/control/organisations/${encodeURIComponent(invitation.organisationId)}/invitations/${encodeURIComponent(invitation.invitationId)}/accept`,
      "POST",
      { token: invitation.token },
    );
    if (!isRecord(result) || result.ok !== true || !isRecord(result.member)) {
      throw new Error("The invitation could not be accepted.");
    }
    window.sessionStorage.removeItem(
      accountInvitationTokenKey(
        invitation.organisationId,
        invitation.invitationId,
      ),
    );
    window.history.replaceState(null, "", "/portal");
    setAcceptance({ kind: "accepted" });
  } catch (error) {
    setAcceptance({
      kind: "failed",
      problem:
        error instanceof Error
          ? error.message
          : "The invitation could not be accepted.",
    });
  }
}

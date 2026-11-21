import React from "react";
import { ControlApiError } from "../control-client";
import { signInPath } from "../control-paths";
import {
  acceptOrganisationInvitation,
  type OrganisationInvitation,
} from "../features/access/organisation-requests";
import { Button, useMutation, type Mutation } from "../ui";
import type { AccountFrame } from "./workspaces";

type AccountInvitationRoute =
  | Readonly<{ kind: "none"; invitation?: never }>
  | Readonly<{ kind: "invalid"; invitation?: never }>
  | Readonly<{ kind: "pending"; invitation: OrganisationInvitation }>;

type InvitationAcceptance = Mutation<"accept", OrganisationInvitation, void>;

/** What a refused accept tells the person, and the way forward. */
type InvitationProblem = Readonly<{
  message: string;
  /** A second press can work: the refusal was not about the invitation. */
  retry: boolean;
  /** The label of a sign-in link that comes back to this page, or null. */
  signIn: string | null;
}>;

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
  try {
    // The token stays in this tab, so a sign-in that comes back here keeps it.
    const key = accountInvitationTokenKey(organisationId, invitationId);
    const token = fragmentToken ?? storage.getItem(key);
    if (!validInvitationValue(token)) return { kind: "invalid" };
    storage.setItem(key, token);
    return {
      kind: "pending",
      invitation: { organisationId, invitationId, token },
    };
  } catch {
    return { kind: "invalid" };
  }
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

export function AccountInvitationPage(
  props: Readonly<{
    Frame: AccountFrame;
    route: Exclude<AccountInvitationRoute, { kind: "none" }>;
    displayName: string;
    logout: () => Promise<void>;
  }>,
): React.ReactNode {
  const acceptance = useMutation(acceptInvitation);
  const [accepted, setAccepted] = React.useState(false);
  return (
    <props.Frame
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
        ) : accepted ? (
          <>
            <p role="status">Invitation accepted. Your Pantry role is ready.</p>
            <a className="primary-button" href="/portal">
              Open your organisations
            </a>
          </>
        ) : (
          <InvitationAcceptance
            invitation={props.route.invitation}
            acceptance={acceptance}
            accepted={setAccepted}
          />
        )}
      </section>
    </props.Frame>
  );
}

function InvitationAcceptance(
  props: Readonly<{
    invitation: OrganisationInvitation;
    acceptance: InvitationAcceptance;
    accepted: (accepted: boolean) => void;
  }>,
): React.ReactNode {
  const state = props.acceptance.state("accept");
  const problem =
    state.kind === "failed" ? invitationProblem(state.error) : null;
  return (
    <>
      <p>Accept this invitation with the Google account that received it.</p>
      {problem === null || problem.retry ? (
        <Button
          variant="primary"
          disabled={state.kind === "running"}
          onClick={runAcceptance.bind(
            null,
            props.acceptance,
            props.invitation,
            props.accepted,
          )}
        >
          {state.kind === "running" ? "Accepting…" : "Accept invitation"}
        </Button>
      ) : null}
      {problem === null ? null : <p role="alert">{problem.message}</p>}
      {problem === null || problem.retry ? null : (
        <div className="connection-actions">
          {problem.signIn === null ? null : (
            <a className="primary-button" href={signInPath()}>
              {problem.signIn}
            </a>
          )}
          <a className="button-link" href="/portal">
            Open your organisations
          </a>
        </div>
      )}
    </>
  );
}

async function runAcceptance(
  acceptance: InvitationAcceptance,
  invitation: OrganisationInvitation,
  accepted: (accepted: boolean) => void,
): Promise<void> {
  const outcome = await acceptance.run("accept", invitation);
  if (outcome.kind === "done") accepted(true);
}

async function acceptInvitation(
  invitation: OrganisationInvitation,
): Promise<void> {
  await acceptOrganisationInvitation(invitation);
  window.sessionStorage.removeItem(
    accountInvitationTokenKey(
      invitation.organisationId,
      invitation.invitationId,
    ),
  );
  window.history.replaceState(null, "", "/portal");
}

/**
 * The message of each refusal comes from the control errors. A refusal about
 * the invitation itself ends the page: a second press cannot change it.
 */
function invitationProblem(error: unknown): InvitationProblem {
  if (!(error instanceof ControlApiError))
    return {
      message:
        error instanceof Error
          ? error.message
          : "Pantry could not accept the invitation. Try again.",
      retry: true,
      signIn: null,
    };
  switch (error.kind) {
    case "organisation_invitation_email_mismatch":
      return {
        message: error.message,
        retry: false,
        signIn: "Sign in with another account",
      };
    case "session_ended":
      return { message: error.message, retry: false, signIn: "Sign in again" };
    case "organisation_invitation_not_found":
    case "organisation_invitation_closed":
    case "organisation_invitation_expired":
      return { message: error.message, retry: false, signIn: null };
    default:
      return { message: error.message, retry: true, signIn: null };
  }
}

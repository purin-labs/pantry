import { SLACK_BOT_NAME } from "@purin-labs/control-api";
import React from "react";

import { identityServiceErrorMessage } from "./identity-copy";
import { assertNever, isRecord } from "@purin-labs/std";
import { readCookie } from "./control-client";
import { signInPath } from "./control-paths";

type Invitation = {
  challengeId: string;
  kind: "slack";
  workspaceId: string;
  externalUserId: string;
  expiresAt: number;
};

type BootstrapState =
  | { kind: "loading" }
  | { kind: "identity_ready"; token: string; invitation: Invitation }
  | { kind: "failed"; title: string; message: string };

type LinkState =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "complete" }
  | { kind: "failed"; message: string };

type IdentityControllerProps = {
  token: string;
  invitation: Invitation;
};

type IdentityControllerState = {
  link: LinkState;
};

export class IdentityApp extends React.Component<
  Record<string, never>,
  BootstrapState
> {
  state: BootstrapState = { kind: "loading" };

  componentDidMount(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const token = readBrowserToken(window.location.href);

    if (token === null) {
      this.setState(
        {
          kind: "failed",
          title: "Unable to connect Slack",
          message: `This link is incomplete. Return to Slack and mention ${SLACK_BOT_NAME} again to get a new one.`,
        },
        focusSecurePage,
      );
      return;
    }

    try {
      const invitation = await fetchInvitation(token);
      this.setState(
        { kind: "identity_ready", token, invitation },
        focusSecurePage,
      );
    } catch (error) {
      this.setState(
        {
          kind: "failed",
          title: "Unable to connect Slack",
          message: identityLinkErrorMessage(error),
        },
        focusSecurePage,
      );
    }
  }

  render(): React.ReactNode {
    switch (this.state.kind) {
      case "loading":
        return (
          <PageFrame>
            <StatusPanel
              title="Checking your link"
              detail="This will only take a moment."
            />
          </PageFrame>
        );
      case "failed":
        return (
          <PageFrame>
            <StatusPanel title={this.state.title} detail={this.state.message} />
          </PageFrame>
        );
      case "identity_ready":
        return (
          <IdentityLinkController
            token={this.state.token}
            invitation={this.state.invitation}
          />
        );
      default:
        return assertNever(this.state, "Unexpected state");
    }
  }
}

class IdentityLinkController extends React.Component<
  IdentityControllerProps,
  IdentityControllerState
> {
  state: IdentityControllerState = { link: { kind: "idle" } };

  constructor(props: IdentityControllerProps) {
    super(props);
    this.linkIdentity = this.linkIdentity.bind(this);
  }

  async linkIdentity(): Promise<void> {
    this.setState({ link: { kind: "signing" } });

    try {
      await completeInvitation(this.props.token);
      clearIdentityLinkToken();
      this.setState({ link: { kind: "complete" } }, focusSecurePage);
    } catch (error) {
      this.setState({
        link: { kind: "failed", message: identityLinkErrorMessage(error) },
      });
    }
  }

  render(): React.ReactNode {
    if (this.state.link.kind === "complete") {
      return (
        <PageFrame>
          <StatusPanel
            title="Slack account connected"
            detail={`Return to Slack, mention ${SLACK_BOT_NAME}, and try your request again.`}
          />
        </PageFrame>
      );
    }

    return (
      <PageFrame>
        <section className="identity-panel" aria-labelledby="identity-title">
          <p className="brand">Seams Pantry</p>
          <h1 id="identity-title" tabIndex={-1}>
            Connect your Slack account
          </h1>
          <p className="summary">
            Sign in with the Google account you use for Seams Pantry, then
            confirm the connection.
          </p>
          <dl className="invitation-facts">
            <dt>Workspace</dt>
            <dd>{this.props.invitation.workspaceId}</dd>
            <dt>Slack account</dt>
            <dd>{this.props.invitation.externalUserId}</dd>
            <dt>Use this link by</dt>
            <dd>{formatExpiry(this.props.invitation.expiresAt)}</dd>
          </dl>
          {this.renderLinkAction()}
        </section>
      </PageFrame>
    );
  }

  renderLinkAction(): React.ReactNode {
    const link = this.state.link;
    const busy = link.kind === "signing";
    const message = link.kind === "failed" ? link.message : null;

    if (!hasControlSession()) {
      return (
        <div className="action-region">
          <a className="signin-button" href={signInPath()}>
            Sign in with Google
          </a>
          <p>
            After signing in, you will return here to confirm the Slack
            connection.
          </p>
        </div>
      );
    }

    return (
      <div className="action-region">
        <button type="button" onClick={this.linkIdentity} disabled={busy}>
          {busy ? "Connecting Slack…" : "Connect Slack account"}
        </button>
        {message === null ? null : (
          <p className="error-text" role="alert">
            {message}
          </p>
        )}
      </div>
    );
  }
}

function PageFrame(props: { children: React.ReactNode }): React.ReactNode {
  return (
    <main id="portal-content" className="page-shell" tabIndex={-1}>
      {props.children}
    </main>
  );
}

function StatusPanel(props: {
  title: string;
  detail: string;
}): React.ReactNode {
  return (
    <section className="status-panel">
      <p className="brand">Seams Pantry</p>
      <h1 tabIndex={-1}>{props.title}</h1>
      <p>{props.detail}</p>
    </section>
  );
}

function focusSecurePage(): void {
  const main = document.getElementById("portal-content");
  const heading = main?.querySelector<HTMLElement>("h1");
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  (heading ?? main)?.focus({ preventScroll: true });
}

async function fetchInvitation(token: string): Promise<Invitation> {
  const raw = await fetchJson(
    `/v1/identity-links/${encodeURIComponent(token)}`,
  );

  if (!isRecord(raw) || raw.ok !== true) {
    throw new Error(readApiError(raw));
  }

  if (
    typeof raw.challengeId !== "string" ||
    raw.kind !== "slack" ||
    typeof raw.workspaceId !== "string" ||
    typeof raw.externalUserId !== "string" ||
    typeof raw.expiresAt !== "number"
  ) {
    throw new Error("Identity invitation is invalid.");
  }

  return {
    challengeId: raw.challengeId,
    kind: raw.kind,
    workspaceId: raw.workspaceId,
    externalUserId: raw.externalUserId,
    expiresAt: raw.expiresAt,
  };
}

async function completeInvitation(token: string): Promise<void> {
  const csrf = readControlCsrf();
  if (csrf === null) throw new Error("control_session_missing");
  const response = await fetch(
    `/v1/identity-links/${encodeURIComponent(token)}/complete`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pantry-csrf": csrf,
      },
      body: "{}",
    },
  );
  const raw: unknown = await response.json();

  if (!response.ok || !isRecord(raw) || raw.ok !== true) {
    throw new Error(readApiError(raw));
  }
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(path, {
    headers: { accept: "application/json" },
  });
  const raw: unknown = await response.json();

  if (!response.ok) {
    throw new Error(readApiError(raw));
  }

  return raw;
}

function readBrowserToken(href: string): string | null {
  const value = new URL(href).searchParams.get("token");
  return value !== null && /^[A-Za-z0-9._-]+$/u.test(value) ? value : null;
}

function clearIdentityLinkToken(): void {
  window.history.replaceState(null, "", "/identity/link");
}

function hasControlSession(): boolean {
  return readControlCsrf() !== null;
}

/** The control CSRF token, or null when the cookie is missing or empty. */
function readControlCsrf(): string | null {
  const csrf = readCookie("pantry_csrf");
  return csrf === "" ? null : csrf;
}

function readApiError(raw: unknown): string {
  if (isRecord(raw) && typeof raw.error === "string") {
    return raw.error;
  }
  if (
    isRecord(raw) &&
    isRecord(raw.error) &&
    typeof raw.error.code === "string"
  ) {
    return raw.error.code;
  }
  return "identity_request_failed";
}

function formatExpiry(expiresAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(expiresAt));
}

function identityLinkErrorMessage(error: unknown): string {
  return identityServiceErrorMessage(
    error instanceof Error ? error.message : "identity_request_failed",
  );
}

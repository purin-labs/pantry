import React from "react";
import type { MailboxSetupAgentChoice } from "@purin-labs/control-api";

import { controlMutation, controlRead } from "../../control-client";
import { ProviderTile } from "../../page-components";
import { DEFAULT_MAILBOX_POLICY } from "../../pages/agent-mailbox";
import { ConsentPoint } from "../integrations/connect-consent-dialog";
import { ConnectionDialog } from "../integrations/connection-dialog";
import {
  actionHint,
  ACCESS_REQUIREMENTS,
  agentSentence,
  mailboxSetupAction,
  modelSentence,
  requirementIsMet,
  type MailboxSetupAction,
} from "../mail-setup/model";
import {
  readMailboxSetup,
  type MailboxSetupTransport,
} from "../mail-setup/run";
import { setUpMailbox } from "../mail-setup/turn-on";
import { useMailboxSetup } from "../mail-setup/use-mailbox-setup";

const TRANSPORT: MailboxSetupTransport = {
  read: controlRead,
  mutate: controlMutation,
};

type Run =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "running" }>
  | Readonly<{ kind: "failed"; message: string }>;

type Props = Readonly<{
  organisationId: string;
  accountId: string;
  address: string;
  open: boolean;
  close: () => void;
  /** The mailbox is on now. */
  onTurnedOn: () => void;
  /** The mailbox's full settings, for its limits and its agent. */
  settingsHref: string;
}>;

/**
 * Turns a mailbox on from the Inbox. The sheet shows what the mailbox still
 * needs and makes it through the same setup as the Integrations page, with
 * the default limits. The full settings stay one link away.
 */
export function MailboxTurnOnSheet(props: Props): React.ReactNode {
  const [run, setRun] = React.useState<Run>({ kind: "idle" });
  const [revision, setRevision] = React.useState(0);
  const read = React.useCallback(
    (integrationAccountId: string, choice: MailboxSetupAgentChoice) =>
      readMailboxSetup(
        TRANSPORT,
        { organisationId: props.organisationId, integrationAccountId },
        choice,
      ),
    [props.organisationId],
  );
  const setup = useMailboxSetup(
    read,
    props.open ? props.accountId : null,
    String(revision),
    run.kind !== "running",
  );
  const turnOn = async (): Promise<void> => {
    if (setup.state.kind !== "ready") return;
    const plan = setup.state.plan;
    const action = mailboxSetupAction(plan);
    if (action === "wait_for_model") return;
    setRun({ kind: "running" });
    try {
      await setUpMailbox(
        TRANSPORT,
        {
          organisationId: props.organisationId,
          integrationAccountId: props.accountId,
        },
        plan.agent.choice,
        action === "set_up" ? null : DEFAULT_MAILBOX_POLICY,
      );
      setRun({ kind: "idle" });
      setRevision(nextRevision);
      if (action !== "set_up") props.onTurnedOn();
    } catch (error) {
      setRun({
        kind: "failed",
        message:
          error instanceof Error
            ? error.message
            : "The setup did not finish. Try again.",
      });
      setRevision(nextRevision);
    }
  };
  return (
    <ConnectionDialog
      open={props.open}
      title={props.address}
      tile={<ProviderTile provider="gmail" label="Gmail" />}
      description="Turn on the agent for this mailbox."
      close={props.close}
    >
      {setup.state.kind === "ready" ? (
        <section
          className="provider-consent"
          aria-label="What turning on needs"
        >
          <ul className="connect-consent-points">
            <ConsentPoint
              title={setup.state.plan.agent.name}
              detail={agentSentence(setup.state.plan.agent)}
              mark={
                requirementIsMet(setup.state.plan, "agent") ? "done" : "todo"
              }
            />
            <ConsentPoint
              title="Access"
              detail={`${setup.state.plan.agent.name} may write reply drafts and read the Case of each thread. Owners and admins may review them.`}
              mark={
                ACCESS_REQUIREMENTS.every(
                  (requirement) =>
                    setup.state.kind === "ready" &&
                    requirementIsMet(setup.state.plan, requirement.id),
                )
                  ? "done"
                  : "todo"
              }
            />
            <ConsentPoint
              title="AI model"
              detail={modelSentence(setup.state.plan)}
              mark={
                setup.state.plan.model.kind === "approved" ? "done" : "todo"
              }
            />
          </ul>
          {run.kind === "failed" ? (
            <p className="error-text" role="alert">
              {run.message}
            </p>
          ) : null}
          <div className="connection-actions">
            <button
              type="button"
              className="connection-primary-action"
              onClick={turnOn}
              disabled={
                run.kind === "running" ||
                setup.reading ||
                mailboxSetupAction(setup.state.plan) === "wait_for_model"
              }
            >
              {run.kind === "running"
                ? "Turning on…"
                : turnOnLabel(mailboxSetupAction(setup.state.plan))}
            </button>
          </div>
          <p className="notice-text">
            {actionHint(setup.state.plan, mailboxSetupAction(setup.state.plan))}{" "}
            <a href={props.settingsHref}>All mailbox settings</a>
          </p>
        </section>
      ) : setup.state.kind === "failed" ? (
        <div className="provider-consent">
          <p role="alert">Pantry could not check what this mailbox needs.</p>
          <div className="connection-actions">
            <button type="button" onClick={setup.retry}>
              Try again
            </button>
          </div>
        </div>
      ) : (
        <p role="status">Checking what this mailbox needs…</p>
      )}
    </ConnectionDialog>
  );
}

function turnOnLabel(action: MailboxSetupAction): string {
  switch (action) {
    case "set_up_and_turn_on":
      return "Set up and turn on";
    case "set_up":
      return "Set up";
    case "turn_on":
    case "wait_for_model":
      return "Turn on";
  }
}

function nextRevision(revision: number): number {
  return revision + 1;
}

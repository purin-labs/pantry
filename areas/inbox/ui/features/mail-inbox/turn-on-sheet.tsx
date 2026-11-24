import React from "react";

import {
  controlMutation,
  controlRead,
} from "@purin-labs/control/portal/control-client";
import { ProviderTile } from "@purin-labs/ui/page-components";
import { ConnectionDialog } from "@purin-labs/area-integrations-contract/ui/features/integrations/connection-dialog";
import {
  mailboxCanTurnOn,
  turnOnHint,
} from "@purin-labs/area-inbox-contract/ui/features/mail-setup/model";
import {
  MailboxModelConsent,
  useMailboxModelConsent,
} from "@purin-labs/area-inbox-contract/ui/features/mail-setup/model-consent";
import {
  readMailboxSetup,
  type MailboxSetupTransport,
} from "../mail-setup/run";
import { setUpMailbox } from "../mail-setup/turn-on";
import { useMailboxSetup } from "@purin-labs/area-inbox-contract/ui/features/mail-setup/use-mailbox-setup";

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
  /** The mailbox's own view. */
  settingsHref: string;
}>;

/**
 * Turns a mailbox on from the Inbox, with the same one press as the
 * mailbox's own view: the setup that it still needs, the acceptance of the
 * AI model's terms, then the default limits.
 */
export function MailboxTurnOnSheet(props: Props): React.ReactNode {
  const [run, setRun] = React.useState<Run>({ kind: "idle" });
  const [revision, setRevision] = React.useState(0);
  const read = React.useCallback(
    (integrationAccountId: string) =>
      readMailboxSetup(
        TRANSPORT,
        { organisationId: props.organisationId, integrationAccountId },
        { kind: "automatic" },
      ),
    [props.organisationId],
  );
  const setup = useMailboxSetup(
    read,
    props.open ? props.accountId : null,
    String(revision),
    run.kind !== "running",
  );
  const plan = setup.state.kind === "ready" ? setup.state.plan : null;
  const consent = useMailboxModelConsent(plan);
  const turnOn = async (): Promise<void> => {
    if (plan === null || !mailboxCanTurnOn(plan, consent.accepted)) return;
    setRun({ kind: "running" });
    try {
      await setUpMailbox(
        TRANSPORT,
        {
          organisationId: props.organisationId,
          integrationAccountId: props.accountId,
        },
        plan.agent.choice,
        true,
        consent.accepted,
      );
      setRun({ kind: "idle" });
      setRevision(nextRevision);
      props.onTurnedOn();
    } catch (error) {
      setRun({
        kind: "failed",
        message:
          error instanceof Error
            ? error.message
            : "The mailbox did not turn on. Try again.",
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
      {plan !== null ? (
        <section className="provider-consent" aria-label="Turn on">
          {consent.review === null ? null : (
            <MailboxModelConsent
              review={consent.review}
              accepted={consent.accepted !== null}
              disabled={run.kind === "running" || setup.reading}
              onChange={consent.setAccepted}
            />
          )}
          <p className="notice-text">{turnOnHint(plan)}</p>
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
                !mailboxCanTurnOn(plan, consent.accepted)
              }
            >
              {run.kind === "running" ? "Turning on…" : "Turn on"}
            </button>
          </div>
          <p className="notice-text">
            <a href={props.settingsHref}>Open the mailbox</a>
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

function nextRevision(revision: number): number {
  return revision + 1;
}

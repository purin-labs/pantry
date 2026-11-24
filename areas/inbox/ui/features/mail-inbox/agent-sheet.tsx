import React from "react";
import { WHATSAPP_DEFAULT_ALWAYS_WAIT_TOPICS } from "@purin-labs/control-api";
import type { WhatsAppAgentMode } from "@purin-labs/control-api";
import { Check } from "lucide-react";
import {
  controlMutation,
  controlRead,
} from "@purin-labs/control/portal/control-client";
import {
  parseWhatsAppSurface,
  type WhatsAppAccountView,
} from "@purin-labs/control-api/portal/whatsapp";
import {
  whatsappAccountActionPath,
  whatsappAccountsPath,
} from "@purin-labs/area-inbox-contract/ui/whatsapp";
import { ConnectionDialog } from "@purin-labs/area-integrations/ui/features/integrations/connection-dialog";
import { disableMailAgent } from "./api";
import type { MailAgentState } from "@purin-labs/control-api/portal/mail-agent";

type Channel = "email" | "whatsapp";
type Props = Readonly<{
  open: boolean;
  organisationId: string;
  /** The open mailbox, if the Organisation has one. */
  accountId: string | null;
  agent: MailAgentState | null;
  /** Whether a WhatsApp number is connected. */
  hasWhatsApp: boolean;
  close: () => void;
  /** The mailbox's agent must turn on. The Inbox opens its own sheet. */
  onTurnOnMailbox: () => void;
  onSaved: () => void;
}>;

/**
 * How the agent helps on each channel (Plan 83). The agent is optional: with
 * none, people read and answer every message.
 */
export function InboxAgentSheet(props: Props): React.ReactNode {
  const { open, organisationId } = props;
  const [channel, setChannel] = React.useState<Channel>(
    props.accountId === null ? "whatsapp" : "email",
  );
  const [accounts, setAccounts] = React.useState<
    readonly WhatsAppAccountView[]
  >([]);
  const [emailMode, setEmailMode] = React.useState<"off" | "draft">("draft");
  const [mode, setMode] = React.useState<WhatsAppAgentMode>("answer");
  const [topics, setTopics] = React.useState(
    WHATSAPP_DEFAULT_ALWAYS_WAIT_TOPICS,
  );
  const [run, setRun] = React.useState<"idle" | "saving" | "failed">("idle");
  const account = accounts[0] ?? null;
  const policy = account?.policy ?? null;

  React.useEffect(() => {
    if (!open) return;
    setRun("idle");
    setEmailMode(props.agent?.kind === "off" ? "off" : "draft");
    if (!props.hasWhatsApp) return;
    let current = true;
    void controlRead(whatsappAccountsPath(organisationId)).then((raw) => {
      if (!current) return;
      const surface = parseWhatsAppSurface(raw, { ok: true, proposals: [] });
      const selected = surface.accounts.filter(
        (candidate) => candidate.selectedAt !== null,
      );
      setAccounts(selected);
      const enabled = selected[0]?.policy;
      if (enabled?.kind === "enabled") {
        setMode(enabled.agentMode);
        setTopics(
          enabled.alwaysWaitTopics === ""
            ? WHATSAPP_DEFAULT_ALWAYS_WAIT_TOPICS
            : enabled.alwaysWaitTopics,
        );
      }
    });
    return () => {
      current = false;
    };
  }, [open, organisationId, props.agent, props.hasWhatsApp]);

  const save = async (): Promise<void> => {
    setRun("saving");
    try {
      if (channel === "email" && props.accountId !== null) {
        if (emailMode === "off" && props.agent?.kind !== "off")
          await disableMailAgent(organisationId, props.accountId);
        if (emailMode === "draft" && props.agent?.kind === "off") {
          props.onTurnOnMailbox();
          return;
        }
      }
      if (channel === "whatsapp" && account !== null)
        await controlMutation(
          whatsappAccountActionPath(
            organisationId,
            account.integrationAccountId,
            "policy",
          ),
          "POST",
          { agent: { agentMode: mode, alwaysWaitTopics: topics } },
        );
      setRun("idle");
      props.onSaved();
    } catch {
      setRun("failed");
    }
  };

  const whatsappEnabled = policy?.kind === "enabled";
  return (
    <ConnectionDialog
      open={open}
      title="How should the agent help?"
      description="Choose for each channel. You can change it later."
      close={props.close}
    >
      <div className="inbox-agent-sheet">
        {props.accountId !== null && props.hasWhatsApp ? (
          <div
            className="inbox-agent-channels"
            role="group"
            aria-label="Channel"
          >
            <button
              type="button"
              aria-pressed={channel === "email"}
              onClick={() => setChannel("email")}
            >
              Email
            </button>
            <button
              type="button"
              aria-pressed={channel === "whatsapp"}
              onClick={() => setChannel("whatsapp")}
            >
              WhatsApp
            </button>
          </div>
        ) : null}
        {channel === "email" ? (
          <div className="inbox-agent-choices" role="group" aria-label="Agent">
            <Choice
              title="No agent"
              detail="People read and answer every email. The agent does not read this mailbox."
              selected={emailMode === "off"}
              onSelect={() => setEmailMode("off")}
            />
            <Choice
              title="Agent drafts"
              detail="The agent prepares each reply. A person approves it before it is sent. A reply to a linked supplier contact can go at once."
              selected={emailMode === "draft"}
              onSelect={() => setEmailMode("draft")}
            />
            <Choice
              title="Agent answers"
              detail="Not available for email."
              selected={false}
              disabled={true}
              onSelect={() => undefined}
            />
          </div>
        ) : whatsappEnabled ? (
          <>
            <div
              className="inbox-agent-choices"
              role="group"
              aria-label="Agent"
            >
              <Choice
                title="No agent"
                detail="People answer every message. Only your fixed acknowledgement goes by itself."
                selected={mode === "off"}
                onSelect={() => setMode("off")}
              />
              <Choice
                title="Agent drafts"
                detail="The agent prepares each reply. A person approves it before it is sent."
                selected={mode === "draft"}
                onSelect={() => setMode("draft")}
              />
              <Choice
                title="Agent answers"
                detail="The agent answers your published topics. A person can take over at any time."
                selected={mode === "answer"}
                onSelect={() => setMode("answer")}
              />
            </div>
            {mode === "answer" ? (
              <label className="inbox-agent-topics">
                Topics that always wait for a person
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={topics}
                  onChange={(event) => setTopics(event.target.value)}
                />
              </label>
            ) : null}
          </>
        ) : (
          <p className="notice-text">
            Turn on message handling for this number in Integrations first.
          </p>
        )}
        {run === "failed" ? (
          <p className="error-text" role="alert">
            The setting did not save. Try again.
          </p>
        ) : null}
        <div className="connection-actions">
          <button
            type="button"
            className="connection-primary-action"
            disabled={
              run === "saving" || (channel === "whatsapp" && !whatsappEnabled)
            }
            onClick={() => void save()}
          >
            Save
          </button>
          <button type="button" onClick={props.close}>
            Cancel
          </button>
        </div>
      </div>
    </ConnectionDialog>
  );
}

function Choice(
  props: Readonly<{
    title: string;
    detail: string;
    selected: boolean;
    disabled?: boolean;
    onSelect: () => void;
  }>,
): React.ReactNode {
  return (
    <button
      type="button"
      className="inbox-agent-choice"
      aria-pressed={props.selected}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      <span className="inbox-agent-choice-text">
        <span className="inbox-agent-choice-title">{props.title}</span>
        <span className="inbox-agent-choice-detail">{props.detail}</span>
      </span>
      <span className="inbox-agent-choice-mark" aria-hidden="true">
        {props.selected ? <Check size={13} /> : null}
      </span>
    </button>
  );
}

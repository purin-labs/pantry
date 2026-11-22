import React from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, RefreshCw, Settings } from "lucide-react";
import type { MailInboxAccount } from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";
import type { MailAgentState } from "@purin-labs/control-api/portal/mail-agent";
import { GlideHighlight } from "@purin-labs/ui/glide-highlight";
import "@purin-labs/ui/action-menu.css";

type Props = Readonly<{
  accounts: readonly MailInboxAccount[];
  accountId: string | null;
  /** Null until the agent state is read, and when it cannot be read. */
  agent: MailAgentState | null;
  /** When the agent reads the new mail that a check found, if one did. */
  mailCheckAt: number | null;
  settingsHref: string | null;
  onMailbox: (accountId: string) => void;
  onRefresh: () => void;
  trigger: React.RefObject<HTMLButtonElement | null>;
}>;

/**
 * One small control for the open mailbox: its name, whether its agent works,
 * and the choice of another mailbox. Refresh asks Gmail for new mail.
 */
export function MailStatusMenu(props: Props): React.ReactNode {
  const mailbox =
    props.accounts.find(isOpenAccount.bind(null, props.accountId)) ?? null;
  const state = agentState(props.agent);
  return (
    <>
      <Menu.Root>
        <Menu.Trigger asChild>
          <button
            ref={props.trigger}
            type="button"
            className="mail-status-trigger"
            data-agent={props.agent?.kind ?? "unknown"}
            aria-label={`Mailbox: ${mailbox?.displayName ?? "none"}${state === null ? "" : `. ${state}`}`}
          >
            <span className="mail-status-dot" aria-hidden="true" />
            <span className="mail-status-name">
              {mailbox?.displayName ?? "Mailbox"}
            </span>
            {/* A working agent is the usual state, and its dot says it. */}
            {state === null || props.agent?.kind === "on" ? null : (
              <span className="mail-status-word">{state}</span>
            )}
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            className="action-menu mail-status-menu"
            aria-label="Mailbox"
            align="end"
            sideOffset={6}
            collisionPadding={12}
          >
            <GlideHighlight target="[data-highlighted]" />
            {props.accounts.length > 1 ? (
              <Menu.Group className="action-menu-section">
                <Menu.Label className="action-menu-heading">Mailbox</Menu.Label>
                <Menu.RadioGroup
                  value={props.accountId ?? ""}
                  onValueChange={props.onMailbox}
                >
                  {props.accounts.map(renderAccount)}
                </Menu.RadioGroup>
              </Menu.Group>
            ) : null}
            <Menu.Group className="action-menu-section">
              <Menu.Label className="action-menu-heading">
                {props.accounts.length > 1
                  ? "Agent"
                  : (mailbox?.displayName ?? "Mailbox")}
              </Menu.Label>
              <p className="mail-status-state" data-agent={props.agent?.kind}>
                {state ?? "Agent state unavailable"}
              </p>
              <Menu.Item
                className="action-menu-item"
                onSelect={props.onRefresh}
              >
                <RefreshCw size={16} aria-hidden="true" /> Refresh
              </Menu.Item>
              {props.settingsHref === null ? null : (
                <Menu.Item className="action-menu-item" asChild>
                  <a href={props.settingsHref}>
                    <Settings size={16} aria-hidden="true" /> Mailbox settings
                  </a>
                </Menu.Item>
              )}
            </Menu.Group>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      {/* The region stays, so that a later check is read out. */}
      <p className="mail-agent-check" role="status">
        {props.mailCheckAt === null
          ? null
          : `Reads new mail at ${formatMailCheckTime(props.mailCheckAt)}`}
      </p>
    </>
  );
}

function renderAccount(account: MailInboxAccount): React.ReactNode {
  return (
    <Menu.RadioItem
      key={account.integrationAccountId}
      className="action-menu-item"
      value={account.integrationAccountId}
    >
      <span className="action-menu-icon mail-status-check" aria-hidden="true">
        <Menu.ItemIndicator>
          <Check size={16} />
        </Menu.ItemIndicator>
      </span>
      {account.access === "reconnect_required"
        ? `${account.displayName} · Reconnect needed`
        : account.displayName}
    </Menu.RadioItem>
  );
}

function isOpenAccount(
  accountId: string | null,
  account: MailInboxAccount,
): boolean {
  return account.integrationAccountId === accountId;
}

/** The state in words. Null while the state is not read. */
function agentState(agent: MailAgentState | null): string | null {
  if (agent === null) return null;
  switch (agent.kind) {
    case "on":
      return "Agent on";
    case "paused":
      return "Agent paused";
    case "off":
      return "Agent off";
    default:
      return assertNever(agent);
  }
}

export function formatMailCheckTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(at);
}

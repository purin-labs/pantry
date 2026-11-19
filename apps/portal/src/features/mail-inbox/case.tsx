import React from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { MailInboxThreadMessage } from "@purin-labs/control-api";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  MoreHorizontal,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { GlideHighlight } from "../../ui/glide-highlight";
import {
  OverflowToolbar,
  type ToolbarItem,
  type ToolbarMenuEntry,
} from "../../ui/overflow-toolbar";
import "../../ui/action-menu.css";
import { MailConversation, type MailDraftDecision } from "./conversation";
import { conversationSender } from "./thread";

/** The conversation that the pane shows. */
export type MailThread =
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "loading"; threadId: string }>
  | Readonly<{ kind: "failed"; threadId: string; message: string }>
  | Readonly<{
      kind: "ready";
      threadId: string;
      messages: readonly MailInboxThreadMessage[];
    }>;

type OpenThread = Exclude<MailThread, Readonly<{ kind: "closed" }>>;

/** The pane steps through the list. */
export type MailCaseNavigation = Readonly<{
  kind: "drawer";
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  onClose: () => void;
}>;

type Props = Readonly<{
  navigation: MailCaseNavigation;
  organisationId: string;
  accountId: string;
  thread: OpenThread;
  /** The plain-language title. The subject serves until a better one exists. */
  title: string;
  /** The addresses that the mailbox sends from. */
  mailboxAddresses: readonly string[];
  /** The Inbox already knows that a draft waits in this thread. */
  draftExpected: boolean;
  canManage: boolean;
  supplierHref: (supplierId: string) => string;
  orderHref: (orderId: string) => string;
  memoryHref: (memoryId: string) => string;
  suppliersPath: string;
  heading: React.RefObject<HTMLHeadingElement | null>;
  onReviewChanged: () => Promise<void>;
  onDecided: (decision: MailDraftDecision) => void;
  onPersonReplied?: (threadId: string) => void;
  /** Opens JEV. Focus returns to the given control when JEV closes. */
  onJev: (opener: HTMLElement | null) => void;
  /** The thread's rule results, for the disclosure of what was checked. */
  children?: React.ReactNode;
}>;

/**
 * One case: what came in, the suggested reply and its three actions. Everything
 * else that was checked is behind one disclosure.
 */
export function MailCase(props: Props): React.ReactNode {
  const conversation = React.useRef<MailConversation>(null);
  const thread = props.thread;
  const sender =
    thread.kind === "ready"
      ? conversationSender(thread.messages, props.mailboxAddresses)
      : null;
  return (
    <section
      className="mail-case"
      data-navigation={props.navigation.kind}
      aria-label="Conversation"
    >
      <div className="mail-case-bar">
        <div className="mail-case-heading">
          <h2
            id="mail-case-title"
            tabIndex={-1}
            ref={props.heading}
            title={props.title}
          >
            {props.title}
          </h2>
          <span className="mail-case-channel">
            Email{sender === null ? "" : ` · ${sender}`}
          </span>
        </div>
        <OverflowToolbar
          className="mail-case-tools"
          overflowLabel="More conversation tools"
          items={[
            ...navigationItems(props.navigation),
            {
              key: "options",
              label: "Conversation options",
              node: renderCaseMenu.bind(
                null,
                thread.threadId,
                props.onJev,
                refreshConversation.bind(null, conversation),
              ),
            },
            closeItem(props.navigation),
          ]}
        />
      </div>
      <div className="mail-case-body">
        {thread.kind === "loading" ? (
          <p className="mail-case-state" role="status">
            Loading conversation…
          </p>
        ) : null}
        {thread.kind === "failed" ? (
          <p className="mail-case-state" role="alert">
            {thread.message}
          </p>
        ) : null}
        {thread.kind === "ready" ? (
          <MailConversation
            ref={conversation}
            key={`${props.organisationId}:${props.accountId}:${thread.threadId}`}
            organisationId={props.organisationId}
            accountId={props.accountId}
            threadId={thread.threadId}
            messages={thread.messages}
            mailboxAddresses={props.mailboxAddresses}
            draftExpected={props.draftExpected}
            canManage={props.canManage}
            supplierHref={props.supplierHref}
            orderHref={props.orderHref}
            memoryHref={props.memoryHref}
            suppliersPath={props.suppliersPath}
            onReviewChanged={props.onReviewChanged}
            onDecided={props.onDecided}
            onPersonReplied={props.onPersonReplied}
          >
            {props.children}
          </MailConversation>
        ) : null}
      </div>
    </section>
  );
}

function renderCaseMenu(
  threadId: string,
  onJev: (opener: HTMLElement | null) => void,
  onRefresh: () => void,
  overflow: readonly ToolbarMenuEntry[],
): React.ReactNode {
  return (
    <CaseMenu
      threadId={threadId}
      onJev={onJev}
      onRefresh={onRefresh}
      overflow={overflow}
    />
  );
}

function refreshConversation(
  conversation: React.RefObject<MailConversation | null>,
): void {
  conversation.current?.refresh();
}

/**
 * The case's menu. It also lists the tools that do not fit on the row. JEV
 * opens when the menu has closed, so that the menu does not take focus back
 * from JEV.
 */
function CaseMenu(
  props: Readonly<{
    threadId: string;
    onJev: (opener: HTMLElement | null) => void;
    onRefresh: () => void;
    overflow: readonly ToolbarMenuEntry[];
  }>,
): React.ReactNode {
  const trigger = React.useRef<HTMLButtonElement>(null);
  const jevChosen = React.useRef(false);
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          className="mail-icon-button"
          aria-label="Conversation options"
        >
          <MoreHorizontal size={18} aria-hidden="true" />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="action-menu mail-case-menu"
          aria-label="Conversation options"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          onCloseAutoFocus={openChosenJev.bind(
            null,
            jevChosen,
            trigger,
            props.onJev,
          )}
        >
          <GlideHighlight target="[data-highlighted]" />
          {renderOverflowEntries(props.overflow)}
          <Menu.Item
            className="action-menu-item"
            onSelect={chooseJev.bind(null, jevChosen)}
          >
            <span className="action-menu-icon" aria-hidden="true">
              <Sparkles size={16} />
            </span>
            <span className="action-menu-copy">
              <span>Open JEV</span>
              <small>Ask about this mail or the Inbox rules.</small>
            </span>
          </Menu.Item>
          <Menu.Item
            className="action-menu-item"
            onSelect={openInGmail.bind(null, props.threadId)}
          >
            <span className="action-menu-icon" aria-hidden="true">
              <ExternalLink size={16} />
            </span>
            Open in Gmail
          </Menu.Item>
          <Menu.Item className="action-menu-item" onSelect={props.onRefresh}>
            <span className="action-menu-icon" aria-hidden="true">
              <RefreshCw size={16} />
            </span>
            Refresh conversation
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The row's tools that do not fit, above the menu's own entries. */
export function renderOverflowEntries(
  overflow: readonly ToolbarMenuEntry[],
): React.ReactNode {
  if (overflow.length === 0) return null;
  return (
    <>
      {overflow.map(renderOverflowEntry)}
      <Menu.Separator className="action-menu-separator" />
    </>
  );
}

function renderOverflowEntry(entry: ToolbarMenuEntry): React.ReactNode {
  return (
    <Menu.Item
      key={entry.key}
      className="action-menu-item"
      disabled={entry.disabled}
      onSelect={entry.onSelect}
    >
      <span className="action-menu-icon" aria-hidden="true">
        {entry.icon}
      </span>
      {entry.label}
    </Menu.Item>
  );
}

function chooseJev(chosen: React.RefObject<boolean>): void {
  chosen.current = true;
}

function openChosenJev(
  chosen: React.RefObject<boolean>,
  trigger: React.RefObject<HTMLButtonElement | null>,
  onJev: (opener: HTMLElement | null) => void,
  event: Event,
): void {
  if (!chosen.current) return;
  chosen.current = false;
  event.preventDefault();
  onJev(trigger.current);
}

/** Previous and next. They are the first tools to move behind the ellipsis. */
export function navigationItems(
  navigation: MailCaseNavigation,
): readonly ToolbarItem[] {
  return [
    {
      key: "previous",
      label: "Previous conversation",
      node: (
        <button
          type="button"
          className="mail-icon-button"
          aria-label="Previous conversation"
          onClick={navigation.onPrevious ?? undefined}
          disabled={navigation.onPrevious === null}
        >
          <ChevronUp size={18} aria-hidden="true" />
        </button>
      ),
      menuEntry: {
        key: "previous",
        label: "Previous conversation",
        icon: <ChevronUp size={16} />,
        onSelect: navigation.onPrevious ?? noop,
        disabled: navigation.onPrevious === null,
      },
    },
    {
      key: "next",
      label: "Next conversation",
      node: (
        <button
          type="button"
          className="mail-icon-button"
          aria-label="Next conversation"
          onClick={navigation.onNext ?? undefined}
          disabled={navigation.onNext === null}
        >
          <ChevronDown size={18} aria-hidden="true" />
        </button>
      ),
      menuEntry: {
        key: "next",
        label: "Next conversation",
        icon: <ChevronDown size={16} />,
        onSelect: navigation.onNext ?? noop,
        disabled: navigation.onNext === null,
      },
    },
  ];
}

export function closeItem(navigation: MailCaseNavigation): ToolbarItem {
  return {
    key: "close",
    label: "Close conversation",
    node: (
      <button
        type="button"
        className="mail-icon-button"
        aria-label="Close conversation"
        onClick={navigation.onClose}
      >
        <X size={18} aria-hidden="true" />
      </button>
    ),
    menuEntry: {
      key: "close",
      label: "Close conversation",
      icon: <X size={16} />,
      onSelect: navigation.onClose,
    },
  };
}

function noop(): void {}

function openInGmail(threadId: string): void {
  window.open(
    `https://mail.google.com/mail/#all/${encodeURIComponent(threadId)}`,
    "_blank",
    "noreferrer",
  );
}

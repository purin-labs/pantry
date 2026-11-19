import React from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { InboxWhatsAppConversation } from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import { Archive, Bot, MoreHorizontal, UserRound } from "lucide-react";
import {
  ControlApiError,
  controlMutation,
  controlRead,
} from "../../control-client";
import { formatFutureRelativeTime } from "../../formatting";
import {
  parseWhatsAppCaseView,
  parseWhatsAppReplyPreview,
  type WhatsAppCaseView,
  type WhatsAppReplyPreview,
} from "@purin-labs/control-api/portal/whatsapp";
import { whatsappCasePath, whatsappReplyPath } from "../../whatsapp";
import {
  PermissionRequiredPrompt,
  permissionRequiredOf,
} from "../access/permission-required-prompt";
import { GlideHighlight } from "../../ui/glide-highlight";
import "../../ui/action-menu.css";
import {
  closeItem,
  navigationItems,
  renderOverflowEntries,
  type MailCaseNavigation,
} from "./case";
import {
  OverflowToolbar,
  type ToolbarMenuEntry,
} from "../../ui/overflow-toolbar";
import { formatMailDate } from "./thread";

type Load =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{
      kind: "ready";
      view: WhatsAppCaseView;
      preview: WhatsAppReplyPreview | null;
    }>;

type Props = Readonly<{
  organisationId: string;
  conversation: InboxWhatsAppConversation;
  canManage: boolean;
  heading: React.RefObject<HTMLHeadingElement | null>;
  /** The list reads again. */
  onChanged: () => Promise<void>;
  /** A reply went, and the next conversation that needs a person can open. */
  onSent: (caseId: string) => void;
  navigation: MailCaseNavigation;
}>;

/**
 * One WhatsApp conversation in the Inbox's pane. The text is read when the
 * person opens it and stays in memory only. Each action uses the same route and
 * send ladder as before, so the recipient always comes from the Case.
 */
export function WhatsAppConversation(props: Props): React.ReactNode {
  const { conversation, organisationId } = props;
  const closed = conversation.state === "closed";
  const [load, setLoad] = React.useState<Load>({ kind: "loading" });
  const [permission, setPermission] = React.useState<ReturnType<
    typeof permissionRequiredOf
  > | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [reply, setReply] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const [edit, setEdit] = React.useState("");
  const [messageId, setMessageId] = React.useState("");
  const proposalId = conversation.proposalId;

  const read = React.useCallback(async (): Promise<void> => {
    if (closed) return;
    try {
      const view = parseWhatsAppCaseView(
        await controlRead(
          whatsappCasePath(organisationId, conversation.caseId),
        ),
      );
      const preview =
        proposalId === null
          ? null
          : parseWhatsAppReplyPreview(
              await controlRead(whatsappReplyPath(organisationId, proposalId)),
            );
      setLoad({ kind: "ready", view, preview });
    } catch (error) {
      const refused = permissionRequiredOf(error);
      if (refused !== null) setPermission(refused);
      setLoad({ kind: "failed", message: problemText(error) });
    }
  }, [closed, conversation.caseId, organisationId, proposalId]);

  React.useEffect(() => {
    void read();
  }, [read]);

  const run = async (
    path: string,
    body: Record<string, unknown>,
    sent: boolean,
  ): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await controlMutation(path, "POST", body);
      setEditing(false);
      setReply("");
      await props.onChanged();
      if (!sent) await read();
      else if (wasSent(answer)) props.onSent(conversation.caseId);
      else {
        setProblem(notSentText(answer));
        await read();
      }
    } catch (error) {
      setProblem(problemText(error));
      await read();
    } finally {
      setBusy(false);
    }
  };
  const casePath = whatsappCasePath(organisationId, conversation.caseId);
  const replyPath =
    proposalId === null ? null : whatsappReplyPath(organisationId, proposalId);

  const sendPersonReply = async (): Promise<void> => {
    const body = reply.trim();
    if (body === "") return;
    setBusy(true);
    setProblem(null);
    try {
      // The composer is one person action: it takes the Case, then sends.
      if (load.kind === "ready" && load.view.ownershipKind !== "human_owned")
        await controlMutation(`${casePath}/take-over`, "POST", {});
      const answer = await controlMutation(`${casePath}/human-reply`, "POST", {
        body,
        confirmed: true,
      });
      await props.onChanged();
      if (wasSent(answer)) {
        setReply("");
        props.onSent(conversation.caseId);
      } else {
        setProblem(notSentText(answer));
        await read();
      }
    } catch (error) {
      setProblem(problemText(error));
      await read();
    } finally {
      setBusy(false);
    }
  };

  const view = load.kind === "ready" ? load.view : null;
  const preview = load.kind === "ready" ? load.preview : null;
  const windowOpen = conversation.serviceWindowExpiresAt > Date.now();
  const humanOwned =
    (view?.ownershipKind ?? conversation.ownership) === "human_owned";
  const showComposer =
    props.canManage &&
    view !== null &&
    windowOpen &&
    (preview === null || preview.kind !== "current") &&
    (humanOwned ||
      conversation.state === "no_reply_yet" ||
      conversation.state === "handoff_requested");

  return (
    <section className="mail-case" aria-label="Conversation">
      <div className="mail-case-bar">
        <div className="mail-case-heading">
          <h2 id="mail-case-title" tabIndex={-1} ref={props.heading}>
            {conversation.customerWaId}
          </h2>
          <span className="mail-case-channel">WhatsApp</span>
        </div>
        <OverflowToolbar
          className="mail-case-tools"
          overflowLabel="More conversation tools"
          items={[
            ...navigationItems(props.navigation),
            ...(props.canManage && !closed && view !== null
              ? [
                  {
                    key: "options",
                    label: "Conversation options",
                    node: (overflow: readonly ToolbarMenuEntry[]) => (
                      <Menu.Root>
                        <Menu.Trigger asChild>
                          <button
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
                          >
                            <GlideHighlight target="[data-highlighted]" />
                            {renderOverflowEntries(overflow)}
                            {humanOwned ? (
                              <Menu.Item
                                className="action-menu-item"
                                disabled={busy}
                                onSelect={() =>
                                  void run(
                                    `${casePath}/return-to-agent`,
                                    {},
                                    false,
                                  )
                                }
                              >
                                <span
                                  className="action-menu-icon"
                                  aria-hidden="true"
                                >
                                  <Bot size={16} />
                                </span>
                                <span className="action-menu-copy">
                                  <span>Return to agent</span>
                                  <small>
                                    The agent answers this customer again.
                                  </small>
                                </span>
                              </Menu.Item>
                            ) : (
                              <Menu.Item
                                className="action-menu-item"
                                disabled={busy}
                                onSelect={() =>
                                  void run(`${casePath}/take-over`, {}, false)
                                }
                              >
                                <span
                                  className="action-menu-icon"
                                  aria-hidden="true"
                                >
                                  <UserRound size={16} />
                                </span>
                                <span className="action-menu-copy">
                                  <span>Take over</span>
                                  <small>You answer. The agent stops.</small>
                                </span>
                              </Menu.Item>
                            )}
                            <Menu.Item
                              className="action-menu-item"
                              disabled={busy}
                              onSelect={() =>
                                void run(`${casePath}/close`, {}, false)
                              }
                            >
                              <span
                                className="action-menu-icon"
                                aria-hidden="true"
                              >
                                <Archive size={16} />
                              </span>
                              <span className="action-menu-copy">
                                <span>Close Case</span>
                                <small>
                                  Seams deletes its text. WhatsApp keeps the
                                  history.
                                </small>
                              </span>
                            </Menu.Item>
                          </Menu.Content>
                        </Menu.Portal>
                      </Menu.Root>
                    ),
                  },
                ]
              : []),
            closeItem(props.navigation),
          ]}
        />
      </div>
      <div className="mail-case-body">
        <div className="mail-conversation">
          <div className="mail-conversation-scroll">
            {closed ? (
              <p className="mail-conversation-notice">
                This conversation is closed. Seams deleted its text. WhatsApp
                keeps the full history.
              </p>
            ) : null}
            {!closed && load.kind === "loading" ? (
              <p role="status">Loading conversation…</p>
            ) : null}
            {load.kind === "failed" ? <p role="alert">{load.message}</p> : null}
            {view?.messages.map((message) => (
              <article
                key={message.providerMessageId}
                className="mail-inbox-message"
                data-own={message.direction === "outbound" ? "true" : undefined}
              >
                <header className="mail-message-head">
                  <h3>
                    {message.direction === "inbound" ? "Customer" : "Business"}
                  </h3>
                  <time dateTime={new Date(message.occurredAt).toISOString()}>
                    {formatMailDate(message.occurredAt)}
                  </time>
                </header>
                <div className="mail-inbox-body">{message.text}</div>
              </article>
            ))}
            {view === null || view.handoffReason === null ? null : (
              <p className="mail-conversation-notice">
                The agent asked for a person: {view.handoffReason}
              </p>
            )}
            {closed ? null : (
              <p className="mail-inbox-note">
                Seams keeps WhatsApp text for up to 24 hours. WhatsApp keeps the
                full history.
              </p>
            )}
          </div>
          {closed || view === null ? null : (
            <div className="mail-composer">
              {preview?.kind === "current" ? (
                <section
                  className="mail-draft"
                  aria-labelledby="whatsapp-draft-title"
                >
                  <h3 id="whatsapp-draft-title" className="mail-draft-title">
                    Suggested reply
                  </h3>
                  <p className="mail-draft-to">
                    To {preview.proposal.customerWaId}.{" "}
                    {windowText(conversation.serviceWindowExpiresAt)}
                  </p>
                  {editing ? (
                    <textarea
                      aria-label="Reply message"
                      rows={5}
                      value={edit}
                      onChange={(event) => setEdit(event.target.value)}
                    />
                  ) : (
                    <div className="mail-draft-body">
                      {preview.proposal.body}
                    </div>
                  )}
                  <p className="mail-inbox-note">
                    Not sent. It waits for your approval.
                  </p>
                </section>
              ) : null}
              {preview?.kind === "send_indeterminate" ? (
                <section className="mail-draft" data-draft="unconfirmed">
                  <h3 className="mail-draft-chip">Send not confirmed</h3>
                  <p>
                    Meta did not confirm this send. Seams Pantry does not retry
                    it. Check WhatsApp, then record what you found.
                  </p>
                  {props.canManage && replyPath !== null ? (
                    <>
                      <label>
                        WhatsApp message id
                        <input
                          value={messageId}
                          onChange={(event) => setMessageId(event.target.value)}
                        />
                      </label>
                      <div className="mail-draft-actions">
                        <button
                          type="button"
                          disabled={busy || messageId.trim() === ""}
                          onClick={() =>
                            void run(
                              `${replyPath}/resolve`,
                              {
                                resolution: {
                                  kind: "delivered",
                                  whatsappMessageId: messageId.trim(),
                                },
                              },
                              false,
                            )
                          }
                        >
                          It was delivered
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              `${replyPath}/resolve`,
                              { resolution: { kind: "not_delivered" } },
                              false,
                            )
                          }
                        >
                          It was not delivered
                        </button>
                      </div>
                    </>
                  ) : null}
                </section>
              ) : null}
              {showComposer ? (
                <label className="mail-person-reply">
                  Your reply
                  <textarea
                    rows={4}
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    placeholder="Write your reply"
                  />
                  <span className="mail-draft-to">
                    {windowText(conversation.serviceWindowExpiresAt)}
                  </span>
                </label>
              ) : null}
              {!windowOpen && view !== null ? (
                <p className="mail-inbox-note">
                  The 24-hour window has ended. WhatsApp does not allow a free
                  reply now.
                </p>
              ) : null}
              <div className="mail-draft-bar">
                {problem === null ? null : <p role="alert">{problem}</p>}
                {props.canManage &&
                preview?.kind === "current" &&
                replyPath !== null ? (
                  <div
                    className="mail-draft-actions"
                    role="group"
                    aria-label="Draft reply actions"
                  >
                    {editing ? (
                      <>
                        <button
                          type="button"
                          className="connection-primary-action"
                          disabled={busy || edit.trim() === ""}
                          onClick={() =>
                            void run(`${replyPath}/edit`, { body: edit }, false)
                          }
                        >
                          Save draft
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setEditing(false)}
                        >
                          Close
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="connection-primary-action"
                          disabled={busy || !windowOpen}
                          onClick={() =>
                            void run(
                              `${replyPath}/approve`,
                              {
                                version: preview.proposal.version,
                                bodyDigest: preview.proposal.bodyDigest,
                              },
                              true,
                            )
                          }
                        >
                          Approve and send
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setEdit(preview.proposal.body);
                            setEditing(true);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(`${replyPath}/reject`, {}, false)
                          }
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                ) : null}
                {showComposer ? (
                  <div className="mail-draft-actions">
                    <button
                      type="button"
                      className="connection-primary-action"
                      disabled={busy || reply.trim() === ""}
                      onClick={() => void sendPersonReply()}
                    >
                      Send
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
      {permission === null ? null : (
        <PermissionRequiredPrompt
          organisationId={organisationId}
          permission={permission}
          action="Read this conversation"
          grantScope="for this WhatsApp number only"
          onAllowed={() => {
            setPermission(null);
            setLoad({ kind: "loading" });
            void read();
            void props.onChanged();
          }}
          onClose={() => setPermission(null)}
        />
      )}
    </section>
  );
}

function resultKind(answer: unknown): string | null {
  return isRecord(answer) &&
    isRecord(answer.result) &&
    typeof answer.result.kind === "string"
    ? answer.result.kind
    : null;
}

function wasSent(answer: unknown): boolean {
  return resultKind(answer) === "sent";
}

/** The send ladder can answer without a send. The person must know why. */
function notSentText(answer: unknown): string {
  switch (resultKind(answer)) {
    case "send_indeterminate":
      return "Meta did not confirm this send. Seams Pantry does not retry it. Check WhatsApp.";
    case "stale_approval":
      return "This draft changed. Read the new text, then approve it.";
    case "expired":
      return "This draft expired. It was not sent.";
    default:
      return "This reply was not sent. Try again.";
  }
}

function windowText(expiresAt: number): string {
  return expiresAt <= Date.now()
    ? "The 24-hour window has ended."
    : `You can reply until the window closes ${formatFutureRelativeTime(expiresAt)}.`;
}

function problemText(error: unknown): string {
  if (error instanceof ControlApiError) {
    if (isCaseNotOwned(error.details))
      return "Another person owns this conversation. Ask them to return it.";
    return error.message;
  }
  return error instanceof Error
    ? error.message
    : "This action did not finish. Try again.";
}

function isCaseNotOwned(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    "error" in details &&
    details.error === "whatsapp_case_not_owned"
  );
}

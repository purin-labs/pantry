/**
 * Opens a permission request that an agent turn made: from the link that a
 * Slack thread holds, or in place in a paused Portal chat. Allow turns each
 * item's capability on and adds each item's grant through the same Access
 * mutations as the Access page, then records the decision. A Slack request
 * then continues in its thread; a Portal chat continues its paused run. An
 * item is a capability or the read of one record type. Deny stops the
 * request. A member who cannot decide sees who must, and in a chat gets a
 * link to send them.
 */
import React from "react";
import { Building2 } from "lucide-react";
import {
  parseAgentPermissionRequestView,
  type AgentPermissionDecision,
  type AgentPermissionRequestView,
} from "@seams/control-api";
import {
  ControlApiError,
  controlMutation,
  controlRead,
} from "../../control-client";
import {
  PermissionRequestDialog,
  PantryMark,
  type PermissionRequestDecision,
} from "../../ui";
import type { AccessRouteTransport } from "@seams/control-api/portal/access-models";
import { createGrants, enableCapabilities } from "./permission-enable";
import { AGENT_NAME } from "../../agent-name";

type Props = Readonly<{
  organisationId: string;
  requestId: string;
  workspaceName: string;
  access: Pick<AccessRouteTransport, "read" | "mutate">;
  open?: boolean;
  onClose: () => void;
  /** Runs after the decision is recorded; a chat continues or stops here. */
  onDecided: (decision: AgentPermissionDecision) => unknown;
  /** A paused Portal chat that waits for this request. */
  chat?: ChatRun;
}>;

/** The paused run of a Portal chat whose agent made the request. */
export type ChatRun = Readonly<{
  /** Run the paused step again; fails while the request is not allowed. */
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  /** The Portal link that opens this request for an owner or admin. */
  requestUrl: string;
}>;

type Load =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; view: AgentPermissionRequestView }>
  | Readonly<{ kind: "failed"; message: string }>;

export function AgentPermissionRequestPrompt(props: Props): React.ReactNode {
  const { organisationId, requestId } = props;
  const [load, setLoad] = React.useState<Load>({ kind: "loading" });
  const [pending, setPending] = React.useState<"allow" | "deny" | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let current = true;
    void readRequest(organisationId, requestId).then((next) => {
      if (current) setLoad(next);
    });
    return () => {
      current = false;
    };
  }, [organisationId, requestId]);

  const decide = React.useCallback(
    async (decision: AgentPermissionDecision): Promise<boolean> => {
      if (load.kind !== "ready") return false;
      setPending(decision);
      setError(null);
      try {
        if (decision === "allow") {
          const failure = await allowRequest(props, load.view);
          if (failure !== null) {
            setError(failure);
            return false;
          }
        }
        await controlMutation(
          `${requestPath(organisationId, requestId)}/decision`,
          "POST",
          { decision },
        );
        setLoad(await readRequest(organisationId, requestId));
        await props.onDecided(decision);
        return true;
      } catch (caught) {
        setError(decisionError(caught));
        return false;
      } finally {
        setPending(null);
      }
    },
    [load, organisationId, props, requestId],
  );

  const runChat = React.useCallback(
    async (
      action: (run: ChatRun) => Promise<void>,
      which: "allow" | "deny",
    ) => {
      if (props.chat === undefined) return;
      setPending(which);
      setError(null);
      try {
        await action(props.chat);
      } catch (caught) {
        setError(decisionError(caught));
      } finally {
        setPending(null);
      }
    },
    [props.chat],
  );

  const open = props.open ?? true;
  if (load.kind === "loading") return null;
  if (load.kind === "failed")
    return (
      <PermissionRequestDialog
        open={open}
        onClose={props.onClose}
        requester={{ name: AGENT_NAME, icon: <PantryMark /> }}
        target={agentParty(props.workspaceName)}
        title="This permission request is unavailable"
        subtitle={load.message}
        scope={null}
        listHeading=""
        items={[]}
        selectedIds={[]}
        onSelectionChange={ignoreSelection}
        decision={
          props.chat === undefined
            ? {
                kind: "explain",
                message: "Ask the person to send the request again in Slack.",
                pending: null,
                error: null,
                primary: { label: "Close", onSelect: props.onClose },
                secondary: null,
              }
            : {
                kind: "explain",
                message: "Stop this response, then ask again.",
                pending: pending === null ? null : "primary",
                error,
                primary: {
                  label: "Stop response",
                  onSelect: () => void runChat(stopRun, "deny"),
                },
                secondary: null,
              }
        }
        footnote={null}
        signedInAs={null}
      />
    );

  const view = load.view;
  const labels = joinLabels(view.items.map(itemLabel));
  return (
    <PermissionRequestDialog
      open={open}
      onClose={props.onClose}
      requester={{ name: AGENT_NAME, icon: <PantryMark /> }}
      target={agentParty(props.workspaceName)}
      title={`${AGENT_NAME} would like to ${labels}`}
      subtitle={
        view.threadUrl === null ? (
          <>
            Asked in {props.chat === undefined ? "a Portal chat" : "this chat"}{" "}
            for a member with the {view.requesterRole} role.
          </>
        ) : (
          <>
            Asked in a{" "}
            <a href={view.threadUrl} target="_blank" rel="noreferrer">
              Slack thread
            </a>{" "}
            for a member with the {view.requesterRole} role.
          </>
        )
      }
      scope={null}
      listHeading={`This will allow ${AGENT_NAME} to:`}
      items={view.items.map((item) => ({
        id: item.itemId,
        label: item.label,
        description: `${item.description} Granted to ${item.grant.subjectLabel}.`,
        required: true,
      }))}
      selectedIds={view.items.map((item) => item.itemId)}
      onSelectionChange={ignoreSelection}
      decision={
        props.chat === undefined
          ? decisionFor(view, labels, pending, error, decide, props.onClose)
          : chatDecisionFor(
              view,
              labels,
              props.chat,
              pending,
              error,
              decide,
              runChat,
            )
      }
      footnote={
        view.origin === "slack_thread" ? (
          <>
            Allow turns each item on for the whole workspace and adds the grants
            above. A Slack channel needs its own grant to read records, because
            everyone in the channel sees the answer. You can change both in
            Access.
          </>
        ) : (
          <>
            Allow turns each item on for the whole workspace and adds the grants
            above. You can change both in Access.
          </>
        )
      }
      signedInAs={null}
    />
  );
}

function decisionFor(
  view: AgentPermissionRequestView,
  labels: string,
  pending: "allow" | "deny" | null,
  error: string | null,
  decide: (decision: AgentPermissionDecision) => Promise<boolean>,
  close: () => void,
): PermissionRequestDecision {
  const closeAction = { label: "Close", onSelect: close };
  if (view.status === "allowed")
    return {
      kind: "result",
      tone: "allowed",
      title: "Request allowed",
      message: `${AGENT_NAME} can now ${labels}. ${
        view.waitingForSlack
          ? "Slack is not reachable now, so the agent continues in the Slack thread when the Slack connection works again."
          : view.origin === "slack_thread"
            ? "The agent continues in the Slack thread."
            : "The member continues the paused chat with Check again."
      }`,
      pending: null,
      error: null,
      primary: closeAction,
      secondary: null,
    };
  if (view.status !== "pending")
    return {
      kind: "result",
      tone: "denied",
      title: "Request denied",
      message: view.waitingForSlack
        ? "The agent stopped the request. Seams Pantry tells the Slack thread when the Slack connection works again."
        : "The agent stopped the request.",
      pending: null,
      error: null,
      primary: closeAction,
      secondary: null,
    };
  if (view.expired)
    return {
      kind: "explain",
      message:
        view.origin === "slack_thread"
          ? "This request is older than seven days. Ask the person to send it again in Slack."
          : "This request is older than seven days. Ask the member to ask again in the chat.",
      pending: null,
      error: null,
      primary: closeAction,
      secondary: null,
    };
  if (!view.mayDecide)
    return {
      kind: "explain",
      message: "An owner or admin of this workspace must allow this request.",
      pending: null,
      error: null,
      primary: closeAction,
      secondary: null,
    };
  return {
    kind: "grant",
    pending,
    error,
    onAllow: () => decide("allow"),
    onDeny: () => void decide("deny"),
  };
}

/**
 * The choices in a paused Portal chat. After an allow, or once an owner or
 * admin allowed the request from its link, the run continues. A member who
 * cannot decide sends the link and checks again.
 */
function chatDecisionFor(
  view: AgentPermissionRequestView,
  labels: string,
  chat: ChatRun,
  pending: "allow" | "deny" | null,
  error: string | null,
  decide: (decision: AgentPermissionDecision) => Promise<boolean>,
  runChat: (
    action: (run: ChatRun) => Promise<void>,
    which: "allow" | "deny",
  ) => Promise<void>,
): PermissionRequestDecision {
  const busy =
    pending === "allow" ? "primary" : pending === "deny" ? "secondary" : null;
  const stop = {
    label: "Stop response",
    onSelect: () => void runChat(stopRun, "deny"),
  };
  if (view.status === "allowed")
    return {
      kind: "result",
      tone: "allowed",
      title: "Request allowed",
      message: `${AGENT_NAME} can now ${labels}. Continue runs the paused step again.`,
      pending: busy,
      error,
      primary: {
        label: "Continue",
        onSelect: () => void runChat(resumeRun, "allow"),
      },
      secondary: stop,
    };
  if (view.status === "denied")
    return {
      kind: "result",
      tone: "denied",
      title: "Request denied",
      message: "The agent cannot do this step. Stop the response to end it.",
      pending: busy === null ? null : "primary",
      error,
      primary: stop,
      secondary: null,
    };
  if (view.expired)
    return {
      kind: "explain",
      message: "This request is older than seven days.",
      pending: busy === null ? null : "primary",
      error,
      primary: stop,
      secondary: null,
    };
  if (!view.mayDecide)
    return {
      kind: "explain",
      message: (
        <>
          An owner or admin of this workspace must allow this request. Send them{" "}
          <a href={chat.requestUrl}>this link</a>, then select Check again.
        </>
      ),
      pending: busy,
      error,
      primary: {
        label: "Check again",
        onSelect: () => void runChat(resumeRun, "allow"),
      },
      secondary: stop,
    };
  return {
    kind: "grant",
    pending,
    error,
    onAllow: () => decide("allow"),
    onDeny: () => void decide("deny"),
  };
}

function resumeRun(run: ChatRun): Promise<void> {
  return run.resume();
}

function stopRun(run: ChatRun): Promise<void> {
  return run.stop();
}

/**
 * Turn on each item's capability that is off, then add the role grant for
 * each item that the requester still lacks. The server checks the result
 * again.
 */
async function allowRequest(
  props: Props,
  view: AgentPermissionRequestView,
): Promise<string | null> {
  const enabled = await enableCapabilities(
    props.access,
    props.organisationId,
    view.items,
  );
  if (enabled !== null) return enabled;
  const current = await readRequest(props.organisationId, props.requestId);
  if (current.kind !== "ready") return "The request could not be read again.";
  return createGrants(
    props.access,
    props.organisationId,
    current.view.items.filter(notGranted).map(itemGrant),
  );
}

async function readRequest(
  organisationId: string,
  requestId: string,
): Promise<Load> {
  try {
    const view = parseAgentPermissionRequestView(
      await controlRead(requestPath(organisationId, requestId)),
    );
    return view === null
      ? { kind: "failed", message: "The request could not be read." }
      : { kind: "ready", view };
  } catch {
    return {
      kind: "failed",
      message: "The request could not be read. Refresh and try again.",
    };
  }
}

function requestPath(organisationId: string, requestId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/access-control/permission-requests/${encodeURIComponent(requestId)}`;
}

function decisionError(caught: unknown): string {
  if (caught instanceof ControlApiError && caught.message.length > 0)
    return caught.message;
  return "The request could not be answered. Try again.";
}

function notGranted(item: AgentPermissionRequestView["items"][number]): boolean {
  return !item.granted;
}

function itemGrant(item: AgentPermissionRequestView["items"][number]) {
  return { subjectRef: item.grant.subjectRef, target: item.grant.target };
}

function itemLabel(item: AgentPermissionRequestView["items"][number]): string {
  return item.label;
}

/**
 * The workspace that the Pantry agent asks, shown with the agent's mark: the
 * compact prompt shows one icon, and the agent is who asks.
 */
function agentParty(workspaceName: string) {
  return { name: workspaceName, icon: <PantryMark /> };
}

/** The workspace as the party that a permission request asks. */
export function workspaceParty(name: string) {
  return {
    name,
    icon: <Building2 size={22} aria-hidden="true" />,
  };
}

/**
 * "a", "a and b", "a, b and c", each label in lower case and once. A read for
 * a Slack channel and the same read for a role share one label.
 */
function joinLabels(labels: readonly string[]): string {
  const lower = [...new Set(labels.map(lowerFirst))];
  return lower.length <= 1
    ? lower.join("")
    : `${lower.slice(0, -1).join(", ")} and ${lower[lower.length - 1]}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function ignoreSelection(): void {
  // Every item is required, so the selection cannot change.
}

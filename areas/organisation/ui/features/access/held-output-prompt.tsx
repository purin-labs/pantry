/**
 * Opens an answer that the exit check stopped (Plan 27C), from the link that a
 * Slack thread holds or from the pending list. The person reads the answer and
 * decides. Allow sends that one answer, and Deny drops it.
 */
import React from "react";
import {
  parseHeldOutputView,
  type AgentPermissionDecision,
  type HeldEffectAction,
  type HeldOutputView,
} from "@purin-labs/control-api";
import {
  ControlApiError,
  controlMutation,
  controlRead,
} from "@purin-labs/control/portal/control-client";
import { heldOutputPath } from "@purin-labs/control/portal/control-paths";
import { AGENT_NAME } from "@purin-labs/ui/agent-name";
import { PermissionRequestDialog, PantryMark } from "@purin-labs/ui/index";
import { workspaceParty } from "@purin-labs/area-organisation-contract/ui/features/access/agent-permission-request";

type Props = Readonly<{
  organisationId: string;
  requestId: string;
  workspaceName: string;
  onClose: () => void;
  onDecided: () => unknown;
}>;

type Load =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; view: HeldOutputView }>
  | Readonly<{ kind: "failed"; message: string }>;

export function HeldOutputPrompt(props: Props): React.ReactNode {
  const { organisationId, requestId } = props;
  const [load, setLoad] = React.useState<Load>({ kind: "loading" });
  const [pending, setPending] = React.useState<AgentPermissionDecision | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let current = true;
    void readView(organisationId, requestId).then((next) => {
      if (current) setLoad(next);
    });
    return () => {
      current = false;
    };
  }, [organisationId, requestId]);

  const decide = async (
    decision: AgentPermissionDecision,
  ): Promise<boolean> => {
    setPending(decision);
    setError(null);
    try {
      await controlMutation(
        `${heldOutputPath(organisationId, requestId)}/decision`,
        "POST",
        { decision },
      );
      setLoad(await readView(organisationId, requestId));
      await props.onDecided();
      return true;
    } catch (caught) {
      setError(decisionError(caught));
      return false;
    } finally {
      setPending(null);
    }
  };

  if (load.kind === "loading") return null;
  const party = {
    requester: { name: AGENT_NAME, icon: <PantryMark /> },
    target: workspaceParty(props.workspaceName),
  };
  if (load.kind === "failed")
    return (
      <PermissionRequestDialog
        open
        onClose={props.onClose}
        {...party}
        title="This answer is unavailable"
        subtitle={load.message}
        listHeading=""
        items={[]}
        selectedIds={[]}
        onSelectionChange={ignoreSelection}
        decision={closeOnly(
          "Ask the person who has access to review it.",
          props.onClose,
        )}
        footnote={null}
        signedInAs={null}
      />
    );
  const view = load.view;
  const destination =
    view.destination === null ? "a Slack thread" : `#${view.destination}`;
  const item =
    view.answer === null
      ? {
          id: "effect",
          label: view.effect ?? "One step",
          description:
            view.action !== null
              ? actionText(view.action)
              : view.covers === "request"
                ? "The agent has not done this step. If you allow it, the agent can do it for one request in this conversation. One request can need this step more than one time."
                : "The agent has not done this step. If you allow it, the agent can do it one time in this conversation.",
          required: true,
        }
      : {
          id: "answer",
          label: "The answer",
          description: view.answer,
          required: true,
        };
  return (
    <PermissionRequestDialog
      open
      layout="compact"
      onClose={props.onClose}
      {...party}
      title={
        view.answer === null
          ? `${AGENT_NAME} wants to do one step`
          : `${AGENT_NAME} wants to post an answer in ${destination}`
      }
      subtitle={whyText(view)}
      listHeading={item.label}
      items={[item]}
      selectedIds={[item.id]}
      onSelectionChange={ignoreSelection}
      decision={
        view.status === "pending"
          ? {
              kind: "grant",
              allowLabel: view.answer === null ? "Allow" : "Send",
              denyLabel: view.answer === null ? "Deny" : "Do not send",
              pending,
              error,
              onAllow: () => decide("allow"),
              onDeny: () => void decide("deny"),
            }
          : view.status === "expired"
            ? closeOnly(statusText(view), props.onClose)
            : {
                kind: "result",
                tone: view.status,
                title:
                  view.status === "allowed"
                    ? "Request allowed"
                    : "Request denied",
                message: statusText(view),
                pending: null,
                error: null,
                primary: { label: "Close", onSelect: props.onClose },
                secondary: null,
              }
      }
      footnote={
        view.answer !== null
          ? "This decision is for this one answer. Purin Pantry asks again for each later answer."
          : view.reason === "outside_written"
            ? "This decision is for this exact step. Purin Pantry asks again if a value changes."
            : view.covers === "request"
              ? "This decision is for one request. Purin Pantry asks again for each later request."
              : "This decision is for this one step. Purin Pantry asks again for each later step."
      }
      signedInAs={null}
    />
  );
}

function closeOnly(message: string, onClose: () => void) {
  return {
    kind: "explain" as const,
    message,
    pending: null,
    error: null,
    primary: { label: "Close", onSelect: onClose },
    secondary: null,
  };
}

/** The exact step, as Pantry wrote it from the tool's values. */
function actionText(action: HeldEffectAction): string {
  const values = action.details
    .map((detail) => `${detail.name}: ${detail.value}`)
    .join("\n");
  return values === "" ? action.operation : `${action.operation}\n${values}`;
}

function whyText(view: HeldOutputView): string {
  if (view.reason === "outside_written")
    return "This conversation read text that a person outside the workspace wrote, such as an email or a customer message. That text can hold an instruction that you did not give. Allow this step only if you asked for it.";
  switch (view.source) {
    case "direct_message":
      return "It uses your direct message or private chat with the agent. People who would see the result cannot see that content now.";
    case "portal_chat":
      return "It uses a private Portal chat. People who would see the result cannot see that content now.";
    case "private_slack":
      return "It uses a private Slack conversation. People who would see the result cannot see that content now.";
    case "internal":
      return "It uses internal content, and the result would reach someone outside the workspace.";
  }
}

function statusText(view: HeldOutputView): string {
  switch (view.status) {
    case "allowed":
      // A Portal chat's turn has ended; the agent does the step when asked.
      if (view.conversationId === null)
        return "A person allowed this. Sous Chef continues in the thread or chat.";
      return view.covers === "request"
        ? "A person allowed this. Ask the agent again in the chat, and it does this step for that request."
        : "A person allowed this. Ask the agent again in the chat, and it does this step one time.";
    case "denied":
      return "A person denied this. Sous Chef did not do it.";
    case "expired":
      return "Nobody decided in seven days. Sous Chef did not do this.";
    case "pending":
      return "";
  }
}

async function readView(
  organisationId: string,
  requestId: string,
): Promise<Load> {
  try {
    const view = parseHeldOutputView(
      await controlRead(heldOutputPath(organisationId, requestId)),
    );
    return view === null
      ? { kind: "failed", message: "Pantry could not read this answer." }
      : { kind: "ready", view };
  } catch {
    return {
      kind: "failed",
      message: "This answer does not exist, or you cannot decide it.",
    };
  }
}

function decisionError(caught: unknown): string {
  return caught instanceof ControlApiError && caught.message.length > 0
    ? caught.message
    : "Pantry could not record the decision. Try again.";
}

function ignoreSelection(): void {}

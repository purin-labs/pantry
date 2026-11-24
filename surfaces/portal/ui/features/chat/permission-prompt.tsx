/**
 * Opens the permission request of a paused run. A run that paused on a chat
 * action's disabled capability gets this prompt: Allow turns each capability
 * on through the Access route, with the same authority and audit as the
 * Access page, and then resumes the run. A run whose agent asked for
 * permission gets the agent request prompt, which also adds the grants. A
 * member who cannot allow sees who must instead.
 */
import React from "react";
import type {
  ChatPermissionDecision,
  ChatPermissionRequest,
  ConversationId,
} from "@purin-labs/control-api";
import {
  PermissionRequestDialog,
  PantryMark,
  type PermissionRequestDecision,
} from "@purin-labs/ui/index";
import type { AccessRouteTransport } from "@purin-labs/control-api/portal/access-models";
import {
  AgentPermissionRequestPrompt,
  type ChatRun,
} from "@purin-labs/area-organisation-contract/ui/features/access/agent-permission-request";
import {
  enableCapabilities,
  mayEnableEvery,
} from "@purin-labs/area-organisation-contract/ui/features/access/permission-enable";
import { decideChatPermission } from "./api";
import { AGENT_NAME } from "@purin-labs/ui/agent-name";
import type { Chat } from "@purin-labs/control-api/portal/chat";
import type { Variant } from "@purin-labs/type-utils";

type Props = Readonly<{
  organisationId: string;
  conversationId: ConversationId;
  permission: ChatPermissionRequest;
  workspaceName: string;
  signedInAs: string | null;
  accessPath: string;
  access: Pick<AccessRouteTransport, "read" | "mutate">;
  onDecided: (conversation: Chat) => void;
}>;

type Authority =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "grant" }>
  | Readonly<{ kind: "explain" }>;

type Pending = "allow" | "deny" | null;

export function ChatPermissionPrompt(props: Props): React.ReactNode {
  return props.permission.items.every(isAgentRequestItem) ? (
    <ChatAgentPermissionPrompt {...props} />
  ) : (
    <ChatCapabilityPermissionPrompt {...props} />
  );
}

/** The request that the run's agent made, allowed in place. */
function ChatAgentPermissionPrompt(props: Props): React.ReactNode {
  const { organisationId, conversationId, permission, onDecided } = props;
  const [open, setOpen] = React.useState(true);
  const decide = React.useCallback(
    async (decision: ChatPermissionDecision) => {
      onDecided(
        await decideChatPermission(
          organisationId,
          conversationId,
          permission.permissionRequestId,
          decision,
        ),
      );
    },
    [conversationId, onDecided, organisationId, permission],
  );
  const chat = React.useMemo<ChatRun>(
    () => ({
      resume: () => decide("resume"),
      stop: () => decide("deny"),
      requestUrl: new URL(
        `${props.accessPath}?permissionRequest=${encodeURIComponent(permission.permissionRequestId)}`,
        window.location.origin,
      ).href,
    }),
    [decide, permission, props.accessPath],
  );
  return (
    <>
      {open ? null : (
        <WaitingBanner action={permission.action} onReview={setOpen} />
      )}
      <AgentPermissionRequestPrompt
        organisationId={organisationId}
        requestId={permission.permissionRequestId}
        workspaceName={props.workspaceName}
        access={props.access}
        open={open}
        onClose={() => setOpen(false)}
        onDecided={(decision) =>
          decide(decision === "allow" ? "resume" : "deny")
        }
        chat={chat}
      />
    </>
  );
}

function ChatCapabilityPermissionPrompt(props: Props): React.ReactNode {
  const { organisationId, conversationId, permission, access, onDecided } =
    props;
  const capabilities = React.useMemo(
    () => permission.items.filter(isCapabilityItem),
    [permission],
  );
  const [open, setOpen] = React.useState(true);
  const [authority, setAuthority] = React.useState<Authority>({
    kind: "loading",
  });
  const [pending, setPending] = React.useState<Pending>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let current = true;
    void access.read(organisationId, null, null).then((result) => {
      if (!current) return;
      setAuthority(
        result.ok && mayEnableEvery(result.value, capabilities)
          ? { kind: "grant" }
          : { kind: "explain" },
      );
    });
    return () => {
      current = false;
    };
  }, [access, organisationId, permission]);

  const decide = React.useCallback(
    async (
      decision: ChatPermissionDecision,
      enable: boolean,
    ): Promise<boolean> => {
      setPending(decision === "resume" ? "allow" : "deny");
      setError(null);
      try {
        if (enable) {
          const enabled = await enableCapabilities(
            access,
            organisationId,
            capabilities,
          );
          if (enabled !== null) {
            setError(enabled);
            return false;
          }
        }
        onDecided(
          await decideChatPermission(
            organisationId,
            conversationId,
            permission.permissionRequestId,
            decision,
          ),
        );
        return true;
      } catch (caught) {
        setError(
          caught instanceof Error && caught.message.length > 0
            ? caught.message
            : "The request could not be answered. Try again.",
        );
        return false;
      } finally {
        setPending(null);
      }
    },
    [access, conversationId, onDecided, organisationId, permission],
  );

  const labels = permission.items.map(itemLabel).join(", ");
  const decision: PermissionRequestDecision =
    authority.kind === "explain"
      ? {
          kind: "explain",
          message: `Ask an owner or admin of this workspace to allow ${labels}. Then select Check again.`,
          pending:
            pending === "allow"
              ? "primary"
              : pending === "deny"
                ? "secondary"
                : null,
          error,
          primary: {
            label: "Check again",
            onSelect: () => void decide("resume", false),
          },
          secondary: {
            label: "Stop response",
            onSelect: () => void decide("deny", false),
          },
        }
      : {
          kind: "grant",
          pending: authority.kind === "loading" ? "allow" : pending,
          error,
          onAllow: () => decide("resume", true),
          onDeny: () => void decide("deny", false),
        };

  return (
    <>
      {open ? null : (
        <WaitingBanner action={permission.action} onReview={setOpen} />
      )}
      <PermissionRequestDialog
        open={open}
        onClose={() => setOpen(false)}
        requester={{ name: AGENT_NAME, icon: <PantryMark /> }}
        target={{
          name: props.workspaceName,
          icon: <span aria-hidden="true">{initial(props.workspaceName)}</span>,
        }}
        title={`${AGENT_NAME} would like to ${lowerFirst(permission.action)}`}
        subtitle={
          permission.object === null ? (
            "Only allow this if you expected this request."
          ) : (
            <>
              Requested for <code>{permission.object}</code>
            </>
          )
        }
        listHeading={`This will allow ${AGENT_NAME} to:`}
        items={capabilities.map((item) => ({
          id: item.capabilityId,
          label: item.label,
          description: item.description,
          required: true,
        }))}
        selectedIds={capabilities.map((item) => item.capabilityId)}
        onSelectionChange={ignoreSelection}
        decision={decision}
        footnote={
          <>
            Allow turns this on for the whole workspace. You can turn it off in{" "}
            <a href={props.accessPath}>Access</a>.
          </>
        }
        signedInAs={
          props.signedInAs === null
            ? null
            : { name: props.signedInAs, action: null }
        }
      />
    </>
  );
}

function itemLabel(item: ChatPermissionRequest["items"][number]): string {
  return item.label;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "W";
}

function ignoreSelection(): void {
  // Every item is required, so the selection cannot change.
}

function WaitingBanner(
  props: Readonly<{ action: string; onReview: (open: boolean) => void }>,
): React.ReactNode {
  return (
    <div className="chat-permission-banner" role="status">
      <span>
        The agent is waiting for permission to {lowerFirst(props.action)}.
      </span>
      <button
        type="button"
        className="secondary-button"
        onClick={() => props.onReview(true)}
      >
        Review
      </button>
    </div>
  );
}

type CapabilityItem = Variant<
  ChatPermissionRequest["items"][number],
  "capability"
>;

function isCapabilityItem(
  item: ChatPermissionRequest["items"][number],
): item is CapabilityItem {
  return item.kind === "capability";
}

function isAgentRequestItem(
  item: ChatPermissionRequest["items"][number],
): boolean {
  return item.kind === "agent_request";
}

/**
 * The prompt of a Portal chat that paused on its agent's permission request,
 * for an owner who allows it in place and for a member who must ask. The
 * request view is served from memory; Allow and Check again do not reach a
 * backend.
 */
import React from "react";
import {
  newConversationId,
  type AgentPermissionRequestView,
  type ChatPermissionRequest,
} from "@purin-labs/control-api";
import { ChatPermissionPrompt } from "../features/chat/permission-prompt";
import type { AccessRouteTransport } from "@purin-labs/control-api/portal/access-models";

const ORGANISATION_ID = "organisation_preview";
const OWNER_REQUEST = "a".repeat(32);
const MEMBER_REQUEST = "b".repeat(32);

const permission = (requestId: string): ChatPermissionRequest => ({
  permissionRequestId: requestId,
  action: "Read product records and edit a product description draft",
  object: null,
  items: [
    {
      kind: "agent_request",
      itemId: "commerce.entity.read:product:requester",
      label: "Read product records",
      description:
        "Read product names and descriptions in drafts, Portal chats and direct messages.",
    },
    {
      kind: "agent_request",
      itemId: "commerce.product_description_draft.edit",
      label: "Edit a product description draft",
      description: "Replace one exact passage in a product description draft.",
    },
  ],
  requestedAt: Date.now(),
});

function view(requestId: string): AgentPermissionRequestView {
  const grant = {
    subjectRef: { subjectRefId: `subject_${"0".repeat(32)}`, revision: 1 },
    subjectLabel: requestId === OWNER_REQUEST ? "Owners" : "Operators",
  };
  return {
    requestId,
    status: "pending",
    expired: false,
    createdAt: Date.now(),
    decidedAt: null,
    requesterRole: requestId === OWNER_REQUEST ? "owner" : "operator",
    origin: "portal_chat",
    threadUrl: null,
    waitingForSlack: false,
    mayDecide: requestId === OWNER_REQUEST,
    items: [
      {
        itemId: "commerce.entity.read:product:requester",
        capabilityId: "commerce.entity.read",
        capabilityVersion: 1,
        label: "Read product records",
        description:
          "Read product names and descriptions in drafts, Portal chats and direct messages.",
        mode: "enabled",
        granted: false,
        grant: {
          ...grant,
          target: {
            kind: "commerce_entity_type",
            capabilityRef: {
              capabilityId: "commerce.entity.read",
              capabilityVersion: 1,
            },
            entityTypeId: { origin: "system", typeId: "product" },
          },
        },
      },
      {
        itemId: "commerce.product_description_draft.edit",
        capabilityId: "commerce.product_description_draft.edit",
        capabilityVersion: 1,
        label: "Edit a product description draft",
        description:
          "Replace one exact passage in a product description draft.",
        mode: "disabled",
        granted: false,
        grant: {
          ...grant,
          target: {
            kind: "platform",
            capabilityRef: {
              capabilityId: "commerce.product_description_draft.edit",
              capabilityVersion: 1,
            },
          },
        },
      },
    ],
  };
}

/** Serves the two request views; every other request goes through. */
function installRequestViews(): void {
  const network = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const match = /\/permission-requests\/([0-9a-f]{32})$/u.exec(url);
    return match?.[1] === undefined
      ? network(input, init)
      : Promise.resolve(Response.json(view(match[1])));
  };
}

const PREVIEW_ERROR = {
  kind: "decode",
  boundary: "access_control",
  field: "preview",
  code: "preview_only",
  reason: "The preview has no Access backend.",
  details: null,
} as const;

const access: Pick<AccessRouteTransport, "read" | "mutate"> = {
  read: () => Promise.resolve({ ok: false, error: PREVIEW_ERROR }),
  mutate: () => Promise.resolve({ ok: false, error: PREVIEW_ERROR }),
};

export function ChatAgentPermissionSample(
  props: Readonly<{ role: "owner" | "member" }>,
): React.ReactNode {
  const [open, setOpen] = React.useState(false);
  const requestId = props.role === "owner" ? OWNER_REQUEST : MEMBER_REQUEST;
  return (
    <div>
      <button
        type="button"
        className="secondary-button"
        onClick={() => setOpen(true)}
      >
        Open as {props.role === "owner" ? "the owner" : "an operator"}
      </button>
      {open ? (
        <ChatPermissionPrompt
          organisationId={ORGANISATION_ID}
          conversationId={newConversationId()}
          permission={permission(requestId)}
          workspaceName="Noix de Beurre"
          signedInAs="Camille Laurent"
          accessPath="/portal/noix/cafe/access"
          access={access}
          onDecided={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

installRequestViews();

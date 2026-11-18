/**
 * Two permission requests that wait for an owner, for the Access preview.
 * The list, each request view and each decision are served from memory.
 */
import type {
  AgentPermissionRequestItem,
  AgentPermissionRequestList,
  AgentPermissionRequestView,
  HeldOutputSummary,
  HeldOutputView,
} from "@seams/control-api";

const CHAT_REQUEST = "c".repeat(32);
const SLACK_REQUEST = "d".repeat(32);
const decided = new Map<string, "allowed" | "denied">();

const productRead: AgentPermissionRequestItem = {
  itemId: "commerce.entity.read:product:requester",
  capabilityId: "commerce.entity.read",
  capabilityVersion: 1,
  label: "Read product records",
  description:
    "Read product names and descriptions in drafts, Portal chats and direct messages.",
  mode: "enabled",
  granted: true,
  grant: {
    subjectRef: { subjectRefId: `subject_${"1".repeat(32)}`, revision: 1 },
    subjectLabel: "Operators",
    target: {
      kind: "commerce_entity_type",
      capabilityRef: {
        capabilityId: "commerce.entity.read",
        capabilityVersion: 1,
      },
      entityTypeId: { origin: "system", typeId: "product" },
    },
  },
};

function platformItem(
  capabilityId: string,
  label: string,
  description: string,
): AgentPermissionRequestItem {
  return {
    itemId: capabilityId,
    capabilityId,
    capabilityVersion: 1,
    label,
    description,
    mode: "enabled",
    granted: true,
    grant: {
      subjectRef: { subjectRefId: `subject_${"1".repeat(32)}`, revision: 1 },
      subjectLabel: "Operators",
      target: {
        kind: "platform",
        capabilityRef: { capabilityId, capabilityVersion: 1 },
      },
    },
  };
}

const requests = [
  {
    requestId: CHAT_REQUEST,
    origin: "portal_chat" as const,
    requesterName: "Mia Tanaka",
    createdAt: Date.now() - 20 * 60_000,
    items: [
      productRead,
      platformItem(
        "commerce.product_description_draft.edit",
        "Edit a product description draft",
        "Replace one exact passage in a product description draft.",
      ),
    ],
  },
  {
    requestId: SLACK_REQUEST,
    origin: "slack_thread" as const,
    requesterName: "Ken Ito",
    createdAt: Date.now() - 3 * 60 * 60_000,
    items: [
      platformItem(
        "commerce.entity_plane.context",
        "Read scoped commerce context",
        "Read orders, stock and catalogue context that this conversation may see.",
      ),
    ],
  },
];

const LIFETIME_MS = 7 * 24 * 60 * 60_000;

const heldSummary: HeldOutputSummary = {
  requestId: "e".repeat(32),
  reason: "private_source",
  destination: "kitchen",
  effect: null,
  conversationId: null,
  createdAt: Date.now() - 12 * 60_000,
  expiresAt: Date.now() + LIFETIME_MS,
};

const held: { status: HeldOutputView["status"] } = { status: "pending" };

function heldView(): HeldOutputView {
  return {
    ...heldSummary,
    status: held.status,
    source: "direct_message",
    covers: "step",
    action: null,
    answer:
      "The flour supplier raises the price by 12% on Monday, so I would move the brioche order to this Friday.",
  };
}

function list(): AgentPermissionRequestList {
  return {
    mayDecide: true,
    heldOutputs: held.status === "pending" ? [heldSummary] : [],
    requests: requests
      .filter((request) => !decided.has(request.requestId))
      .map((request) => ({
        requestId: request.requestId,
        origin: request.origin,
        requesterName: request.requesterName,
        requesterRole: "operator",
        itemLabels: request.items.map((item) => item.label),
        createdAt: request.createdAt,
        expiresAt: request.createdAt + LIFETIME_MS,
      })),
  };
}

function view(requestId: string): AgentPermissionRequestView | null {
  const request = requests.find((entry) => entry.requestId === requestId);
  if (request === undefined) return null;
  const status = decided.get(requestId) ?? "pending";
  return {
    requestId,
    status,
    expired: false,
    createdAt: request.createdAt,
    decidedAt: status === "pending" ? null : Date.now(),
    requesterRole: "operator",
    origin: request.origin,
    threadUrl:
      request.origin === "slack_thread"
        ? "https://app.slack.com/client/T000/C000/thread/C000-1700000000.000100"
        : null,
    waitingForSlack: false,
    mayDecide: true,
    items: request.items.map((item) =>
      status === "allowed" ? { ...item, granted: true, mode: "enabled" } : item,
    ),
  };
}

/** Serves the list, the views and the decisions; other requests go through. */
export function installPermissionRequestsPreview(): void {
  // A decision is a control mutation, which needs the session's CSRF cookie.
  document.cookie = "satyr_control_csrf=preview; path=/";
  const network = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (/\/access-control\/permission-requests$/u.test(url))
      return Response.json(list());
    if (/\/held-outputs\/[0-9a-f]{32}\/decision$/u.test(url)) {
      const body: unknown = JSON.parse(String(init?.body ?? "{}"));
      held.status =
        typeof body === "object" &&
        body !== null &&
        "decision" in body &&
        body.decision === "allow"
          ? "allowed"
          : "denied";
      return Response.json({ ok: true, status: held.status, released: true });
    }
    if (/\/held-outputs\/[0-9a-f]{32}$/u.test(url))
      return Response.json(heldView());
    const decision = /\/permission-requests\/([0-9a-f]{32})\/decision$/u.exec(
      url,
    );
    if (decision?.[1] !== undefined) {
      const body: unknown = JSON.parse(String(init?.body ?? "{}"));
      const allow =
        typeof body === "object" &&
        body !== null &&
        "decision" in body &&
        body.decision === "allow";
      decided.set(decision[1], allow ? "allowed" : "denied");
      await new Promise((resolve) => setTimeout(resolve, 300));
      return Response.json({ ok: true, status: decided.get(decision[1]) });
    }
    const single = /\/permission-requests\/([0-9a-f]{32})$/u.exec(url);
    if (single?.[1] !== undefined) {
      const found = view(single[1]);
      return found === null
        ? Response.json({ error: "not_found" }, { status: 404 })
        : Response.json(found);
    }
    return network(input, init);
  };
}

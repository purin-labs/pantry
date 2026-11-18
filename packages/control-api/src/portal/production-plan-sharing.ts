export type PlanSharing =
  | Readonly<{ kind: "slack_thread"; threadUrl: string }>
  | Readonly<{ kind: "portal_chat"; conversationId: string }>
  | null;

export function parseSharing(raw: unknown): PlanSharing {
  if (typeof raw !== "object" || raw === null || !("sharing" in raw))
    throw new Error("Invalid plan share response");
  const sharing: unknown = raw.sharing;
  if (sharing === null) return null;
  if (typeof sharing !== "object" || !("kind" in sharing))
    throw new Error("Invalid plan share response");
  if (
    sharing.kind === "slack_thread" &&
    "threadUrl" in sharing &&
    typeof sharing.threadUrl === "string"
  )
    return { kind: "slack_thread", threadUrl: sharing.threadUrl };
  if (
    sharing.kind === "portal_chat" &&
    "conversationId" in sharing &&
    typeof sharing.conversationId === "string"
  )
    return { kind: "portal_chat", conversationId: sharing.conversationId };
  throw new Error("Invalid plan share response");
}

import { assertNever, hasExactKeys, isRecord } from "@seams/std";

export type ChatDisclosureReason =
  | "source_policy_denied"
  | "access_changed"
  | "evidence_unavailable"
  | "execution_busy";
export type ChatDisclosureFailure =
  | Readonly<{
      kind: "rejected";
      code: "chat_history_forbidden";
      reason: "source_policy_denied" | "access_changed";
    }>
  | Readonly<{
      kind: "rejected";
      code: "project_reference_unavailable";
      reason: "source_policy_denied";
    }>
  | Readonly<{
      kind: "rejected";
      code: "chat_history_unavailable";
      reason: "evidence_unavailable";
    }>
  | Readonly<{
      kind: "rejected";
      code: "chat_running";
      reason: "execution_busy";
    }>;

export function parseChatDisclosureFailure(
  raw: unknown,
): ChatDisclosureFailure | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["kind", "code", "reason"]) ||
    raw.kind !== "rejected"
  )
    return null;
  switch (raw.code) {
    case "chat_history_forbidden":
      return raw.reason === "source_policy_denied" ||
        raw.reason === "access_changed"
        ? { kind: "rejected", code: raw.code, reason: raw.reason }
        : null;
    case "project_reference_unavailable":
      return raw.reason === "source_policy_denied"
        ? { kind: "rejected", code: raw.code, reason: raw.reason }
        : null;
    case "chat_history_unavailable":
      return raw.reason === "evidence_unavailable"
        ? { kind: "rejected", code: raw.code, reason: raw.reason }
        : null;
    case "chat_running":
      return raw.reason === "execution_busy"
        ? { kind: "rejected", code: raw.code, reason: raw.reason }
        : null;
    default:
      return null;
  }
}
export function chatDisclosureMessage(reason: ChatDisclosureReason): string {
  switch (reason) {
    case "source_policy_denied":
      return "This chat contains information that cannot be shared with every project member. Keep it private.";
    case "access_changed":
      return "Access changed while sharing was checked. Close this dialog and review the audience again.";
    case "evidence_unavailable":
      return "The history’s sharing permissions could not be verified. Keep this chat private.";
    case "execution_busy":
      return "A turn is running. Share or move this chat after it finishes.";
    default:
      return assertNever(reason);
  }
}

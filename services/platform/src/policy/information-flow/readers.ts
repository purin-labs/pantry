import { isProjectId, isConversationId } from "@seams/control-api";
import { hasExactKeys, isRecord } from "@seams/std";
import { parseOrganisationId } from "../../ids";
import { parseContextVisibility } from "../../authorization/access-grants/visibility";
import type { FlowAudience } from "./types";

export function parseFlowReader(
  raw: unknown,
):
  | ReturnType<typeof parseContextVisibility>
  | Readonly<{ ok: true; value: FlowAudience }> {
  if (
    !isRecord(raw) ||
    (raw.kind !== "project" && raw.kind !== "chat_conversation")
  )
    return parseContextVisibility(raw);
  if (typeof raw.organisationId !== "string") return invalidReader();
  const organisation = parseOrganisationId(raw.organisationId);
  if (!organisation.ok) return invalidReader();
  if (raw.kind === "project")
    return hasExactKeys(raw, ["kind", "organisationId", "projectId"]) &&
      isProjectId(raw.projectId)
      ? {
          ok: true,
          value: {
            kind: raw.kind,
            organisationId: organisation.value,
            projectId: raw.projectId,
          },
        }
      : invalidReader();
  return hasExactKeys(raw, ["kind", "organisationId", "conversationId"]) &&
    isConversationId(raw.conversationId)
    ? {
        ok: true,
        value: {
          kind: raw.kind,
          organisationId: organisation.value,
          conversationId: raw.conversationId,
        },
      }
    : invalidReader();
}
function invalidReader() {
  return {
    ok: false as const,
    error: {
      code: "invalid_context_visibility" as const,
      field: "native_identity",
    },
  };
}

import { parseCaseId } from "../../ids";
import type { Result } from "../../result";
import type { ContextVisibility } from "./types";
import { assertNever, isRecord, positiveIntegerOrNull } from "@purin-labs/std";

export type ContextVisibilityParseError = {
  readonly code: "invalid_context_visibility";
  readonly field: string;
};

export function encodeContextVisibility(visibility: ContextVisibility): string {
  switch (visibility.kind) {
    case "organisation_role":
      return `organisation_role:${visibility.role}`;
    case "person":
      return `person:${visibility.personId}`;
    case "conversation":
      return `conversation:${visibility.integrationAccountId}:${visibility.conversationId}`;
    case "case":
      return `case:${visibility.caseId}`;
    case "workflow":
      return `workflow:${visibility.workflowKind}:${visibility.workflowId}:${visibility.workflowRevision}`;
    case "agent_mailbox":
      return `agent_mailbox:${visibility.integrationAccountId}:${visibility.mailboxBindingId}:${visibility.bindingRevision}`;
    case "whatsapp_support":
      return `whatsapp_support:${visibility.integrationAccountId}:${visibility.supportBindingId}:${visibility.bindingRevision}`;
    default:
      return assertNever(visibility, "unhandled context visibility");
  }
}

export function parseContextVisibility(
  raw: unknown,
): Result<ContextVisibility, ContextVisibilityParseError> {
  if (!isRecord(raw) || typeof raw.kind !== "string")
    return invalidVisibility("kind");
  switch (raw.kind) {
    case "organisation_role": {
      const role = readNonEmptyString(raw.role);
      return role === null
        ? invalidVisibility("role")
        : { ok: true, value: { kind: raw.kind, role } };
    }
    case "person": {
      const personId = readNonEmptyString(raw.personId);
      return personId === null
        ? invalidVisibility("personId")
        : { ok: true, value: { kind: raw.kind, personId } };
    }
    case "conversation": {
      const integrationAccountId = readNonEmptyString(raw.integrationAccountId);
      const conversationId = readNonEmptyString(raw.conversationId);
      return integrationAccountId === null
        ? invalidVisibility("integrationAccountId")
        : conversationId === null
          ? invalidVisibility("conversationId")
          : {
              ok: true,
              value: { kind: raw.kind, integrationAccountId, conversationId },
            };
    }
    case "case": {
      const caseId = readNonEmptyString(raw.caseId);
      if (caseId === null) return invalidVisibility("caseId");
      const parsedCaseId = parseCaseId(caseId);
      return parsedCaseId.ok
        ? { ok: true, value: { kind: raw.kind, caseId: parsedCaseId.value } }
        : invalidVisibility("caseId");
    }
    case "workflow": {
      const workflowId = readNonEmptyString(raw.workflowId);
      const workflowRevision = positiveIntegerOrNull(raw.workflowRevision);
      return workflowId === null
        ? invalidVisibility("workflowId")
        : workflowRevision === null
          ? invalidVisibility("workflowRevision")
          : raw.workflowKind === "cue_subscription"
            ? {
                ok: true,
                value: {
                  kind: raw.kind,
                  workflowKind: "cue_subscription",
                  workflowId,
                  workflowRevision,
                },
              }
            : invalidVisibility("workflowKind");
    }
    case "agent_mailbox": {
      const integrationAccountId = readNonEmptyString(raw.integrationAccountId);
      const mailboxBindingId = readNonEmptyString(raw.mailboxBindingId);
      const bindingRevision = positiveIntegerOrNull(raw.bindingRevision);
      return integrationAccountId === null
        ? invalidVisibility("integrationAccountId")
        : mailboxBindingId === null
          ? invalidVisibility("mailboxBindingId")
          : bindingRevision === null
            ? invalidVisibility("bindingRevision")
            : {
                ok: true,
                value: {
                  kind: raw.kind,
                  integrationAccountId,
                  mailboxBindingId,
                  bindingRevision,
                },
              };
    }
    case "whatsapp_support": {
      const integrationAccountId = readNonEmptyString(raw.integrationAccountId);
      const supportBindingId = readNonEmptyString(raw.supportBindingId);
      const bindingRevision = positiveIntegerOrNull(raw.bindingRevision);
      return integrationAccountId === null
        ? invalidVisibility("integrationAccountId")
        : supportBindingId === null
          ? invalidVisibility("supportBindingId")
          : bindingRevision === null
            ? invalidVisibility("bindingRevision")
            : {
                ok: true,
                value: {
                  kind: raw.kind,
                  integrationAccountId,
                  supportBindingId,
                  bindingRevision,
                },
              };
    }
    default:
      return invalidVisibility("kind");
  }
}

export function contextVisibilityMatches(
  left: ContextVisibility,
  right: ContextVisibility,
): boolean {
  return encodeContextVisibility(left) === encodeContextVisibility(right);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function invalidVisibility(
  field: string,
): Result<never, ContextVisibilityParseError> {
  return { ok: false, error: { code: "invalid_context_visibility", field } };
}

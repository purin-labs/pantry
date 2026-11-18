import type {
  ContextVisibility,
  GrantSubject,
} from "../authorization/access-grants/types";
import { readActiveCaseOperations } from "../actors/case-operations";
import type { Env } from "../env";
import { parseCaseId, type CaseId, type OrganisationId } from "../ids";
import { digestCanonical } from "../policy";
import type { Result } from "../result";
import { assertNever } from "@seams/std";
export type SubjectReferenceInput = Readonly<{
  kind:
    | "organisation_role"
    | "person"
    | "conversation"
    | "workflow"
    | "agent_mailbox"
    | "whatsapp_support";
  firstId: string;
  secondId: string | null;
  revision: number;
}>;

export async function opaqueSubjectReference(
  organisationId: OrganisationId,
  value: SubjectReferenceInput,
): Promise<string> {
  return opaqueReference("subject", organisationId, value);
}

export async function opaqueContextVisibilityReference(
  organisationId: OrganisationId,
  value: ContextVisibility,
): Promise<string> {
  const canonical = subjectReferenceInputForVisibility(value);
  return canonical === null
    ? opaqueReference("subject", organisationId, value)
    : opaqueSubjectReference(organisationId, canonical);
}

export async function opaqueAccessTargetReference(
  organisationId: OrganisationId,
  value: unknown,
): Promise<string> {
  return opaqueReference("target", organisationId, value);
}

export async function opaqueInformationSourceReference(
  organisationId: OrganisationId,
  value: unknown,
): Promise<string> {
  return opaqueReference("source", organisationId, value);
}

export async function opaqueCaseReference(
  organisationId: OrganisationId,
  caseId: CaseId,
): Promise<string> {
  return opaqueReference("case", organisationId, caseId);
}

export type CaseReferenceError =
  "case_reference_unavailable" | "case_reference_stale";

export async function resolveCaseReference(
  input: Readonly<{ env: Env; organisationId: OrganisationId; now: number }>,
  caseRefId: string,
  revision: number,
): Promise<Result<CaseId, CaseReferenceError>> {
  const cases = await readActiveCaseOperations(input);
  if (!cases.ok) return { ok: false, error: "case_reference_unavailable" };
  for (const currentCase of cases.value) {
    const caseId = parseCaseId(currentCase.caseId);
    if (!caseId.ok) continue;
    const currentRefId = await opaqueCaseReference(
      input.organisationId,
      caseId.value,
    );
    if (currentRefId === caseRefId && currentCase.revision === revision) {
      return { ok: true, value: caseId.value };
    }
  }
  return { ok: false, error: "case_reference_stale" };
}

export function grantSubjectFromReferenceInput(
  value: SubjectReferenceInput,
): Result<GrantSubject, "access_subject_reference_invalid"> {
  const kind = value.kind;
  switch (kind) {
    case "organisation_role":
      return value.secondId === null
        ? {
            ok: true,
            value: { kind: "organisation_role", role: value.firstId },
          }
        : invalidSubjectReference();
    case "person":
      return value.secondId === null
        ? { ok: true, value: { kind: "person", personId: value.firstId } }
        : invalidSubjectReference();
    case "conversation":
      return value.secondId === null
        ? invalidSubjectReference()
        : {
            ok: true,
            value: {
              kind: "conversation",
              integrationAccountId: value.firstId,
              conversationId: value.secondId,
            },
          };
    case "workflow":
      return value.secondId === null
        ? {
            ok: true,
            value: {
              kind: "workflow",
              workflowKind: "cue_subscription",
              workflowId: value.firstId,
              workflowRevision: value.revision,
            },
          }
        : invalidSubjectReference();
    case "agent_mailbox":
      return value.secondId === null
        ? invalidSubjectReference()
        : {
            ok: true,
            value: {
              kind: "agent_mailbox",
              integrationAccountId: value.firstId,
              mailboxBindingId: value.secondId,
              bindingRevision: value.revision,
            },
          };
    case "whatsapp_support":
      return value.secondId === null
        ? invalidSubjectReference()
        : {
            ok: true,
            value: {
              kind: "whatsapp_support",
              integrationAccountId: value.firstId,
              supportBindingId: value.secondId,
              bindingRevision: value.revision,
            },
          };
    default:
      return assertNever(kind);
  }
}

export function subjectReferenceInputForVisibility(
  value: ContextVisibility,
): SubjectReferenceInput | null {
  switch (value.kind) {
    case "organisation_role":
      return {
        kind: value.kind,
        firstId: value.role,
        secondId: null,
        revision: 1,
      };
    case "person":
      return {
        kind: value.kind,
        firstId: value.personId,
        secondId: null,
        revision: 1,
      };
    case "conversation":
      return {
        kind: value.kind,
        firstId: value.integrationAccountId,
        secondId: value.conversationId,
        revision: 1,
      };
    case "workflow":
      return value.workflowKind === "cue_subscription"
        ? {
            kind: value.kind,
            firstId: value.workflowId,
            secondId: null,
            revision: value.workflowRevision,
          }
        : null;
    case "agent_mailbox":
      return {
        kind: value.kind,
        firstId: value.integrationAccountId,
        secondId: value.mailboxBindingId,
        revision: value.bindingRevision,
      };
    case "whatsapp_support":
      return {
        kind: value.kind,
        firstId: value.integrationAccountId,
        secondId: value.supportBindingId,
        revision: value.bindingRevision,
      };
    case "case":
      return null;
    default:
      return assertNever(value);
  }
}

async function opaqueReference(
  prefix: string,
  organisationId: OrganisationId,
  value: unknown,
): Promise<string> {
  const digest = await digestCanonical({ organisationId, value });
  return `${prefix}_${digest.slice(0, 32)}`;
}

function invalidSubjectReference(): Result<
  never,
  "access_subject_reference_invalid"
> {
  return { ok: false, error: "access_subject_reference_invalid" };
}

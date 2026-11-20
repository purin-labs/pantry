import type {
  AccessApprovalState,
  AccessDecisionQuestion,
  AccessSubjectRef,
  AccessTargetRef,
  CapabilityRef,
  CaseRef,
  FlowDestinationRef,
  InformationSourceRef,
} from "@purin-labs/contracts";

import {
  explainAccessDecision,
  type CustomConnectorAccountRead,
} from "../../access-control/decision-explanation";

import type { Env } from "../../env";
import type { Result } from "../../result";
import { authorizeOrganisationRequest } from "../authorization";
import {
  controlError,
  controlJson,
  isBoundedIdentifier,
  readJsonRecord,
  type JsonRecord,
} from "../http";
import { hasExactKeys, isPositiveInteger, isRecord } from "@purin-labs/std";
import type {
  CustomConnectorId,
  CustomConnectorRevision,
} from "../../custom-connectors/identity";
import type { OrganisationDatabase } from "../../database-handles";
import type { IntegrationAccountId, OrganisationId } from "../../ids";

/**
 * The parts of the product areas that the access control routes read. The
 * Worker router gives them.
 */
export type AccessControlParts = Readonly<{
  customConnectorAccount: CustomConnectorAccountRead;
  /** One revision of a custom connector, with its review state. */
  customConnectorRevision(
    input: Readonly<{
      db: OrganisationDatabase;
      organisationId: OrganisationId;
      connectorId: CustomConnectorId;
      revision: CustomConnectorRevision;
    }>,
  ): Promise<
    Result<
      | Readonly<{
          reviewState: "approved";
          definition: Readonly<{
            operations: readonly Readonly<{
              id: string;
              effect: Readonly<{ kind: string }>;
            }>[];
          }>;
        }>
      | Readonly<{
          reviewState: "draft" | "validated" | "rejected" | "retired";
        }>,
      unknown
    >
  >;
  /** The Airtable token of an integration account, for one operation. */
  airtableAccountToken(
    env: Env,
    organisationId: OrganisationId,
    integrationAccountId: IntegrationAccountId,
    operation: "read" | "write",
  ): Promise<string>;
}>;

const MAX_SOURCE_REFERENCES = 20;

export type AccessControlExplainRoute = Readonly<{
  kind: "accessControlExplain";
  organisationIdRaw: string;
}>;

type ParseError = "access_control_explanation_invalid";

export async function handleAccessControlExplainRoute(
  request: Request,
  env: Env,
  route: AccessControlExplainRoute,
  parts: AccessControlParts,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const raw = await readJsonRecord(request);
  if (!raw.ok) return controlError("access_control_explanation_invalid", 422);
  const question = parseAccessDecisionQuestion(raw.value);
  if (!question.ok) return controlError(question.error, 422);
  const explanation = await explainAccessDecision({
    customConnectorAccount: parts.customConnectorAccount,
    env,
    scope: authorized.executionScope,
    organisationId: authorized.organisationId,
    requesterMembership: authorized.membership,
    question: question.value,
    now: Date.now(),
  });
  return controlJson({ ok: true, explanation });
}

export function parseAccessDecisionQuestion(
  raw: JsonRecord,
): Result<AccessDecisionQuestion, ParseError> {
  switch (raw.kind) {
    case "capability":
      return parseCapabilityQuestion(raw);
    case "context_read":
      return parseContextReadQuestion(raw);
    case "conversation_delivery":
      return parseConversationDeliveryQuestion(raw);
    case "tool_effect":
      return parseToolEffectQuestion(raw);
    default:
      return invalidQuestion();
  }
}

function parseCapabilityQuestion(
  raw: JsonRecord,
): Result<AccessDecisionQuestion, ParseError> {
  if (
    !hasExactKeys(raw, [
      "kind",
      "authoritySubjectRef",
      "capabilityRef",
      "targetRef",
    ])
  ) {
    return invalidQuestion();
  }
  const authoritySubjectRef = parseSubjectRef(raw.authoritySubjectRef);
  const capabilityRef = parseCapabilityRef(raw.capabilityRef);
  const targetRef = parseTargetRef(raw.targetRef);
  if (
    authoritySubjectRef === null ||
    capabilityRef === null ||
    targetRef === null
  )
    return invalidQuestion();
  return {
    ok: true,
    value: {
      kind: "capability",
      authoritySubjectRef,
      capabilityRef,
      targetRef,
    },
  };
}

function parseContextReadQuestion(
  raw: JsonRecord,
): Result<AccessDecisionQuestion, ParseError> {
  if (
    !hasExactKeys(raw, ["kind", "authoritySubjectRef", "caseRef", "sourceRef"])
  )
    return invalidQuestion();
  const authoritySubjectRef = parseSubjectRef(raw.authoritySubjectRef);
  const caseRef = parseCaseRef(raw.caseRef);
  const sourceRef = parseSourceRef(raw.sourceRef);
  if (authoritySubjectRef === null || caseRef === null || sourceRef === null)
    return invalidQuestion();
  return {
    ok: true,
    value: { kind: "context_read", authoritySubjectRef, caseRef, sourceRef },
  };
}

function parseConversationDeliveryQuestion(
  raw: JsonRecord,
): Result<AccessDecisionQuestion, ParseError> {
  if (
    !hasExactKeys(raw, [
      "kind",
      "authoritySubjectRef",
      "sourceRefs",
      "destination",
    ])
  ) {
    return invalidQuestion();
  }
  const authoritySubjectRef = parseSubjectRef(raw.authoritySubjectRef);
  const sourceRefs = parseSourceRefs(raw.sourceRefs);
  const destination = parseDestination(raw.destination);
  if (
    authoritySubjectRef === null ||
    sourceRefs === null ||
    destination === null
  )
    return invalidQuestion();
  return {
    ok: true,
    value: {
      kind: "conversation_delivery",
      authoritySubjectRef,
      sourceRefs,
      destination,
    },
  };
}

function parseToolEffectQuestion(
  raw: JsonRecord,
): Result<AccessDecisionQuestion, ParseError> {
  if (
    !hasExactKeys(raw, [
      "kind",
      "authoritySubjectRef",
      "sourceRefs",
      "capabilityRef",
      "targetRef",
      "approvalState",
    ])
  )
    return invalidQuestion();
  const authoritySubjectRef = parseSubjectRef(raw.authoritySubjectRef);
  const sourceRefs = parseSourceRefs(raw.sourceRefs);
  const capabilityRef = parseCapabilityRef(raw.capabilityRef);
  const targetRef = parseTargetRef(raw.targetRef);
  const approvalState = parseApprovalState(raw.approvalState);
  if (
    authoritySubjectRef === null ||
    sourceRefs === null ||
    capabilityRef === null ||
    targetRef === null ||
    approvalState === null
  )
    return invalidQuestion();
  return {
    ok: true,
    value: {
      kind: "tool_effect",
      authoritySubjectRef,
      sourceRefs,
      capabilityRef,
      targetRef,
      approvalState,
    },
  };
}

function parseSubjectRef(value: unknown): AccessSubjectRef | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["subjectRefId", "revision"]) ||
    !opaqueReference(value.subjectRefId, "subject") ||
    !isPositiveInteger(value.revision)
  )
    return null;
  return { subjectRefId: value.subjectRefId, revision: value.revision };
}

function parseCapabilityRef(value: unknown): CapabilityRef | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["capabilityId", "capabilityVersion"]) ||
    !isBoundedIdentifier(value.capabilityId) ||
    !isPositiveInteger(value.capabilityVersion)
  )
    return null;
  return {
    capabilityId: value.capabilityId,
    capabilityVersion: value.capabilityVersion,
  };
}

function parseTargetRef(value: unknown): AccessTargetRef | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["targetRefId", "revision"]) ||
    !opaqueReference(value.targetRefId, "target") ||
    !isPositiveInteger(value.revision)
  )
    return null;
  return { targetRefId: value.targetRefId, revision: value.revision };
}

function parseCaseRef(value: unknown): CaseRef | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["caseRefId", "revision"]) ||
    !opaqueReference(value.caseRefId, "case") ||
    !isPositiveInteger(value.revision)
  )
    return null;
  return { caseRefId: value.caseRefId, revision: value.revision };
}

function parseSourceRef(value: unknown): InformationSourceRef | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["sourceRefId", "revision"]) ||
    !opaqueReference(value.sourceRefId, "source") ||
    !isPositiveInteger(value.revision)
  )
    return null;
  return { sourceRefId: value.sourceRefId, revision: value.revision };
}

function parseSourceRefs(value: unknown): InformationSourceRef[] | null {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_REFERENCES)
    return null;
  const refs: InformationSourceRef[] = [];
  const identities = new Set<string>();
  for (const raw of value) {
    const parsed = parseSourceRef(raw);
    if (parsed === null) return null;
    const identity = `${parsed.sourceRefId}:${parsed.revision}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
    refs.push(parsed);
  }
  return refs;
}

function parseDestination(value: unknown): FlowDestinationRef | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "conversation":
      return hasExactKeys(value, ["kind", "conversationRefId", "revision"]) &&
        opaqueReference(value.conversationRefId, "subject") &&
        isPositiveInteger(value.revision)
        ? {
            kind: "conversation",
            conversationRefId: value.conversationRefId,
            revision: value.revision,
          }
        : null;
    case "workflow":
      return hasExactKeys(value, ["kind", "workflowRefId", "revision"]) &&
        opaqueReference(value.workflowRefId, "subject") &&
        isPositiveInteger(value.revision)
        ? {
            kind: "workflow",
            workflowRefId: value.workflowRefId,
            revision: value.revision,
          }
        : null;
    default:
      return null;
  }
}

function parseApprovalState(value: unknown): AccessApprovalState | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "not_required":
      return hasExactKeys(value, ["kind"]) ? { kind: "not_required" } : null;
    case "pending":
      return hasExactKeys(value, ["kind", "approvalRequestId"]) &&
        isBoundedIdentifier(value.approvalRequestId)
        ? { kind: "pending", approvalRequestId: value.approvalRequestId }
        : null;
    case "approved":
      return hasExactKeys(value, ["kind", "approvalReceiptId"]) &&
        isBoundedIdentifier(value.approvalReceiptId)
        ? { kind: "approved", approvalReceiptId: value.approvalReceiptId }
        : null;
    default:
      return null;
  }
}

function opaqueReference(
  value: unknown,
  prefix: "subject" | "source" | "target" | "case",
): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^${prefix}_[0-9a-f]{32}$`, "u").test(value)
  );
}

function invalidQuestion(): Result<never, ParseError> {
  return { ok: false, error: "access_control_explanation_invalid" };
}

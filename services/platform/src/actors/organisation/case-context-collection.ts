import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { resolveCaseContextCollectionSelectionVerification } from "../../case-context-discovery/source";
import { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { isOrganisationExecutionActive } from "../actor-execution-quiescence";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseIntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  resolveVerifiedContactEndpoint,
  type VerifiedContactEndpoint,
} from "../../data/contact-verification";
import type { Result } from "@purin-labs/kernel/result";
import { readCaseContextDiscoveryPolicy } from "../../case-context-discovery/evaluation-store";
import { gmailConnectorId } from "../../mail-inbox/contract/connector-ids";
import { resolveActiveConnectorActor } from "../actor-router";
import {
  decideCaseContextCollectionRelationship,
  listMemberCaseContextCollectionIdsForCase,
  parseCaseContextCollectionSelection,
  readCaseContextCollection,
  sameCaseContextCollectionScope,
  type CaseContextCollection,
  type CaseContextCollectionRelationship,
  type CaseContextCollectionScope,
} from "../../case-context-discovery/relationships";
import {
  readAgentMailboxBinding,
  readMailboxIngressPolicy,
} from "../../data/email-mailbox";
import { buildAgentMailboxAuthority } from "../../request-authority";
import { createCurrentSourceFlowLabel } from "../../policy/information-flow/source-labels";
import type {
  OperationalCaseContextDiscoveryEvidence,
  OperationalCaseContextDiscoveryRequest,
  OperationalCaseContextDiscoverySourceRequest,
} from "../../case-context-discovery/operational-evaluation";
import { identifier } from "../../case-context-discovery/policy";
import { assertNever, isRecord } from "@purin-labs/std";
import type { CaseContextCollectionReviewCommand } from "@purin-labs/control-api";
import type { PolicyCaseContextSourcePort } from "./organisation-policy";
import { organisationPlacementConflict } from "./organisation-record";

function parseOperationalCaseContextDiscoverySourceRequest(
  raw: unknown,
): OperationalCaseContextDiscoverySourceRequest | null {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 4 ||
    !identifier(raw.issueKind) ||
    !identifier(raw.issueInstance) ||
    !Array.isArray(raw.candidates) ||
    raw.candidates.length === 0 ||
    raw.candidates.length > 5
  ) {
    return null;
  }
  const anchor = parseOperationalCaseContextDiscoveryEvidence(raw.anchor);
  if (anchor === null) return null;
  const candidates: OperationalCaseContextDiscoveryEvidence[] = [];
  for (const rawCandidate of raw.candidates) {
    const candidate =
      parseOperationalCaseContextDiscoveryEvidence(rawCandidate);
    if (candidate === null) return null;
    candidates.push(candidate);
  }
  return {
    issueKind: raw.issueKind,
    issueInstance: raw.issueInstance,
    anchor,
    candidates,
  };
}

function parseOperationalCaseContextDiscoveryEvidence(
  raw: unknown,
): OperationalCaseContextDiscoveryEvidence | null {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 2 ||
    typeof raw.evidence !== "string" ||
    raw.evidence.trim().length === 0 ||
    raw.evidence.length > 8_192
  ) {
    return null;
  }
  const selection = parseCaseContextCollectionSelection(raw.selection);
  return selection === null ? null : { selection, evidence: raw.evidence };
}

export async function caseContextCollectionSourceAccess(
  scope: OrganisationExecutionScope,
  sql: SqlStorage,
  accountId: string,
) {
  const db = scope.database;
  const organisationId = scope.organisationId;
  const account = parseIntegrationAccountId(accountId);
  if (!account.ok)
    return {
      ok: false as const,
      error: { code: "case_context_collection_relationship_invalid" as const },
    };
  const binding = await readAgentMailboxBinding({
    db,
    organisationId,
    integrationAccountId: account.value,
  });
  if (!(await isOrganisationExecutionActive(sql, scope)))
    return organisationPlacementConflict();
  const policy = await readMailboxIngressPolicy({
    db,
    organisationId,
    integrationAccountId: account.value,
    connectedAt: 0,
  });
  if (!(await isOrganisationExecutionActive(sql, scope)))
    return organisationPlacementConflict();
  if (!binding.ok || policy.kind !== "enabled")
    return {
      ok: false as const,
      error: {
        code: "case_context_collection_relationship_unavailable" as const,
      },
    };
  const authority = buildAgentMailboxAuthority({
    organisationId,
    integrationAccountId: account.value,
    mailboxBindingId: binding.value.binding.mailboxBindingId,
    bindingRevision: binding.value.currentRevision.revision,
    mailboxPolicyVersion: policy.policyVersion,
  }).requestAuthority;
  const label = await createCurrentSourceFlowLabel({
    kind: "ingress",
    db,
    authority,
  });
  if (!(await isOrganisationExecutionActive(sql, scope)))
    return organisationPlacementConflict();
  if (!label.ok)
    return {
      ok: false as const,
      error: {
        code: "case_context_collection_relationship_unavailable" as const,
      },
    };
  return { ok: true as const, value: { authority, label: label.value } };
}

async function verifiedOperationalCaseContextDiscoveryRequest(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    sql: SqlStorage;
    request: OperationalCaseContextDiscoverySourceRequest;
  }>,
): Promise<
  Result<
    OperationalCaseContextDiscoveryRequest,
    Readonly<{
      code:
        | "case_context_collection_relationship_invalid"
        | "case_context_collection_relationship_unavailable"
        | "case_context_collection_relationship_conflict"
        | "organisation_placement_conflict";
    }>
  >
> {
  const anchor = await resolveCaseContextCollectionSelectionVerification(
    input.scope.database,
    input.scope.organisationId,
    input.request.anchor.selection,
  );
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  if (!anchor.ok) return anchor;
  for (const candidate of input.request.candidates) {
    const verified = await resolveCaseContextCollectionSelectionVerification(
      input.scope.database,
      input.scope.organisationId,
      candidate.selection,
    );
    if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    if (!verified.ok) return verified;
    if (!sameVerifiedCaseContextCollectionParty(anchor.value, verified.value)) {
      return {
        ok: false,
        error: { code: "case_context_collection_relationship_invalid" },
      };
    }
  }
  const initialScope = caseContextCollectionScopeForVerifiedContact(
    input.scope.organisationId,
    anchor.value,
    input.request.issueKind,
    input.request.issueInstance,
  );
  const scope = existingOperationalCaseContextDiscoveryScope(
    input.sql,
    input.scope.organisationId,
    initialScope,
    input.request,
  );
  return scope.ok
    ? {
        ok: true,
        value: {
          scope: scope.value,
          anchor: input.request.anchor,
          candidates: input.request.candidates,
        },
      }
    : scope;
}

function sameVerifiedCaseContextCollectionParty(
  left: VerifiedContactEndpoint,
  right: VerifiedContactEndpoint,
): boolean {
  if (
    left.organisationId !== right.organisationId ||
    left.merchantId !== right.merchantId ||
    left.target.kind !== right.target.kind
  ) {
    return false;
  }
  switch (left.target.kind) {
    case "customer_contact":
      return (
        right.target.kind === "customer_contact" &&
        left.target.customerId === right.target.customerId &&
        left.target.contactId === right.target.contactId
      );
    case "supplier_contact":
      return (
        right.target.kind === "supplier_contact" &&
        left.target.supplierId === right.target.supplierId &&
        left.target.contactId === right.target.contactId
      );
    default:
      return assertNever(left.target);
  }
}

function caseContextCollectionScopeForVerifiedContact(
  organisationId: OrganisationId,
  verified: VerifiedContactEndpoint,
  issueKind: string,
  issueInstance: string,
): CaseContextCollectionScope {
  return {
    organisationId,
    merchantId: verified.merchantId,
    party:
      verified.target.kind === "customer_contact"
        ? { kind: "customer", id: verified.target.customerId }
        : { kind: "supplier", id: verified.target.supplierId },
    issueKind,
    issueInstance,
  };
}

function existingOperationalCaseContextDiscoveryScope(
  sql: SqlStorage,
  organisationId: OrganisationId,
  initialScope: CaseContextCollectionScope,
  request: OperationalCaseContextDiscoverySourceRequest,
): Result<
  CaseContextCollectionScope,
  Readonly<{
    code:
      | "case_context_collection_relationship_invalid"
      | "case_context_collection_relationship_conflict";
  }>
> {
  const caseContextCollectionIds = new Set<string>();
  for (const caseContextCollectionId of listMemberCaseContextCollectionIdsForCase(
    sql,
    organisationId,
    request.anchor.selection.caseId,
  )) {
    caseContextCollectionIds.add(caseContextCollectionId);
  }
  if (caseContextCollectionIds.size === 0)
    return { ok: true, value: initialScope };
  if (caseContextCollectionIds.size > 1) {
    return {
      ok: false,
      error: { code: "case_context_collection_relationship_conflict" },
    };
  }
  const caseContextCollectionId = caseContextCollectionIds
    .values()
    .next().value;
  const caseContextCollection =
    typeof caseContextCollectionId === "string"
      ? readCaseContextCollection(sql, organisationId, caseContextCollectionId)
      : null;
  if (
    caseContextCollection === null ||
    caseContextCollection.lifecycle !== "open" ||
    caseContextCollection.scope.organisationId !==
      initialScope.organisationId ||
    caseContextCollection.scope.merchantId !== initialScope.merchantId ||
    caseContextCollection.scope.party.kind !== initialScope.party.kind ||
    caseContextCollection.scope.party.id !== initialScope.party.id
  ) {
    return {
      ok: false,
      error: { code: "case_context_collection_relationship_invalid" },
    };
  }
  return { ok: true, value: caseContextCollection.scope };
}

type CaseContextCollectionReviewDecision = Parameters<
  typeof decideCaseContextCollectionRelationship
>[0]["decision"];

export async function caseContextCollectionReviewDecision(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    caseContextCollection: CaseContextCollection;
    command: CaseContextCollectionReviewCommand["decision"];
  }>,
): Promise<
  Result<
    CaseContextCollectionReviewDecision,
    Readonly<{
      code:
        | "case_context_collection_relationship_invalid"
        | "case_context_collection_relationship_unavailable";
    }>
  >
> {
  switch (input.command.kind) {
    case "resolve":
      return { ok: true, value: { kind: "resolve" } };
    case "reject":
      return {
        ok: true,
        value: {
          kind: "reject",
          relationshipId: input.command.relationshipId,
        },
      };
    case "detach":
      return {
        ok: true,
        value: {
          kind: "detach",
          relationshipId: input.command.relationshipId,
        },
      };
    case "confirm": {
      const relationship = findCaseContextCollectionRelationship(
        input.caseContextCollection,
        input.command.relationshipId,
      );
      if (relationship === null) {
        return {
          ok: false,
          error: { code: "case_context_collection_relationship_unavailable" },
        };
      }
      const verified = await resolveVerifiedContactEndpoint({
        db: input.db,
        organisationId: input.organisationId,
        verificationId: relationship.selection.verificationId,
        expectedRevision: relationship.selection.verificationRevision,
      });
      if (!verified.ok) {
        return {
          ok: false,
          error: { code: "case_context_collection_relationship_unavailable" },
        };
      }
      const sourceScope = confirmedCaseContextCollectionSourceScope(
        input.caseContextCollection,
        relationship,
        verified.value,
      );
      return sourceScope === null
        ? {
            ok: false,
            error: { code: "case_context_collection_relationship_invalid" },
          }
        : {
            ok: true,
            value: {
              kind: "confirm",
              relationshipId: input.command.relationshipId,
              sourceScope,
            },
          };
    }
    default:
      return assertNever(input.command);
  }
}

function findCaseContextCollectionRelationship(
  caseContextCollection: CaseContextCollection,
  relationshipId: string,
): CaseContextCollectionRelationship | null {
  for (const relationship of caseContextCollection.relationships) {
    if (relationship.relationshipId === relationshipId) return relationship;
  }
  return null;
}

function confirmedCaseContextCollectionSourceScope(
  caseContextCollection: CaseContextCollection,
  relationship: CaseContextCollectionRelationship,
  verified: VerifiedContactEndpoint,
): CaseContextCollectionScope | null {
  const selection = relationship.selection;
  if (
    selection.source === "commerce" ||
    selection.source !== verified.endpoint.channel ||
    selection.integrationAccountId !== verified.integrationAccountId
  ) {
    return null;
  }
  const sourceScope: CaseContextCollectionScope = {
    organisationId: verified.organisationId,
    merchantId: verified.merchantId,
    party:
      verified.target.kind === "customer_contact"
        ? { kind: "customer", id: verified.target.customerId }
        : { kind: "supplier", id: verified.target.supplierId },
    issueKind: caseContextCollection.scope.issueKind,
    issueInstance: caseContextCollection.scope.issueInstance,
  };
  return sameCaseContextCollectionScope(
    caseContextCollection.scope,
    sourceScope,
  )
    ? sourceScope
    : null;
}

export async function deliverCaseContextCollectionInvalidations(
  env: Env,
  sql: SqlStorage,
  scope: OrganisationExecutionScope,
): Promise<void> {
  const organisationId = scope.organisationId;
  const rows = sql
    .exec<{ case_context_collection_id: string }>(
      "SELECT case_context_collection_id FROM case_context_collection_invalidation WHERE organisation_id = ? AND pending = 1 LIMIT 20",
      organisationId,
    )
    .toArray();
  for (const row of rows) {
    if (!(await isOrganisationExecutionActive(sql, scope))) return;
    const caseContextCollection = readCaseContextCollection(
      sql,
      organisationId,
      row.case_context_collection_id,
    );
    if (caseContextCollection === null) continue;
    const policyRevision = readCaseContextDiscoveryPolicy(
      sql,
      organisationId,
    ).revision;
    const accounts = new Set<string>([
      caseContextCollection.anchorSelection.integrationAccountId,
    ]);
    for (const relationship of caseContextCollection.relationships)
      if (relationship.selection.source === "gmail")
        accounts.add(relationship.selection.integrationAccountId);
    let delivered = true;
    for (const account of accounts) {
      try {
        const connectorId = gmailConnectorId(account);
        if (!connectorId.ok) {
          delivered = false;
          continue;
        }
        const connector = await resolveActiveConnectorActor({
          env: env,
          namespace: env.CONNECTOR,
          organisationId,
          connectorId: connectorId.value,
          now: Date.now(),
        });
        if (!connector.ok) {
          delivered = false;
          continue;
        }
        if (!(await isOrganisationExecutionActive(sql, scope))) return;
        const result =
          await connector.value.invalidateCaseContextCollectionEvidence({
            organisationId,
            caseContextCollectionId:
              caseContextCollection.caseContextCollectionId,
            caseContextCollectionRevision: caseContextCollection.revision,
            policyRevision,
          });
        if (!result.ok) delivered = false;
      } catch {
        delivered = false;
      }
    }
    if (
      delivered &&
      readCaseContextCollection(
        sql,
        organisationId,
        row.case_context_collection_id,
      )?.revision === caseContextCollection.revision &&
      readCaseContextDiscoveryPolicy(sql, organisationId).revision ===
        policyRevision
    )
      sql.exec(
        "UPDATE case_context_collection_invalidation SET pending = 0 WHERE organisation_id = ? AND case_context_collection_id = ?",
        organisationId,
        row.case_context_collection_id,
      );
  }
}

function unsupportedCaseContextCollectionReplySource(
  source: Readonly<{ source: string }>,
): boolean {
  return source.source !== "gmail";
}

/** The source functions that the discovery commands of the policy call. */
export const CASE_CONTEXT_SOURCE_FOR_POLICY: PolicyCaseContextSourcePort = {
  unsupportedReplySource: unsupportedCaseContextCollectionReplySource,
  sourceAccess: caseContextCollectionSourceAccess,
  parseSourceRequest: parseOperationalCaseContextDiscoverySourceRequest,
  verifiedRequest: verifiedOperationalCaseContextDiscoveryRequest,
};

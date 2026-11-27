import { resolveCaseContextCollectionSelectionVerification } from "../../case-context-discovery/source";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { isOrganisationExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import { parseCaseId, type OrganisationId } from "@purin-labs/kernel/ids";
import { readCaseContextDiscoveryPolicy } from "@purin-labs/agent/case-context-discovery/evaluation-store";
import {
  commitCaseContextCollectionEffectFence,
  evidenceForCaseContextCollection,
  eraseCaseContextCollectionSource,
  parseCaseContextCollectionEffectAttempt,
  parseCaseContextCollectionEvidenceDependency,
  validateCaseContextCollectionEvidence,
  replayCaseContextCollectionEffectFence,
  invalidateCaseContextCollectionVerification,
} from "@purin-labs/agent/case-context-discovery/evidence";
import {
  resolveTypeSafeCredential,
  sameTypeSafeAuthority,
} from "@purin-labs/agent/typesafe/authority";
import {
  decideCaseContextCollectionRelationship,
  listCaseContextCollectionIdsForCase,
  listMemberCaseContextCollectionIdsForCase,
  parseCaseContextCollectionReviewCommand,
  parseCaseContextCollectionSelection,
  readCaseContextCollection,
  replayCaseContextCollectionRelationshipCommand,
  type CaseContextCollection,
} from "@purin-labs/agent/case-context-discovery/relationships";
import {
  caseContextDiscoveryRouteAuthority,
  identifier,
  integerIn,
} from "@purin-labs/agent/case-context-discovery/policy";
import { digestCanonical } from "@purin-labs/authority/policy/information-flow/digest";
import {
  caseContextCollectionReviewDecision,
  caseContextCollectionSourceAccess,
} from "./case-context-collection";
import type { Env } from "@purin-labs/kernel/env";
import type { SchemaTransaction } from "@purin-labs/actor-runtime/actors/schema-migrations";
import type { OrganisationStateError } from "@purin-labs/tenancy/actors/organisation/types";
import type { Result } from "@purin-labs/kernel/result";
import { organisationPlacementConflict } from "@purin-labs/tenancy/actors/organisation/organisation-record";

/**
 * Policy activation, credentials, TypeSafe and Case context discovery for the Organisation.
 */

/** What the Organisation actor gives to the Case context collection commands. */
export type OrganisationCollectionHost = Readonly<{
  env: Env;
  storage: DurableObjectStorage;
  /** The transaction of the actor's SQLite. A command asks for it when it writes. */
  transaction(): SchemaTransaction;
  /** Checks the Organisation record of this actor. */
  validateOrganisation(
    organisationId: OrganisationId,
  ): Result<null, OrganisationStateError>;
  /** Sets the alarm of the Organisation again after a command changed its work. */
  rearm(): Promise<unknown>;
}>;

/**
 * The RPC methods of the Case context collection on the Organisation actor.
 * A collection holds the mail of one verified contact, so the Inbox owns its
 * commands. The class of the Worker implements this interface: each method
 * calls one function of this module inside a command of the Organisation.
 */
export interface OrganisationCaseContextCollectionRpc {
  prepareCaseContextCollectionEvidence(
    input: Readonly<{
      organisationId: OrganisationId;
      caseId: string;
      integrationAccountId: string;
      triggeringMessageId: string;
    }>,
  ): Promise<unknown>;
  validateCaseContextCollectionEvidence(
    input: Readonly<{ organisationId: OrganisationId; dependency: unknown }>,
  ): Promise<unknown>;
  commitCaseContextCollectionEffectFence(
    input: Readonly<{ organisationId: OrganisationId; attempt: unknown }>,
  ): Promise<unknown>;
  invalidateCaseContextCollectionVerification(
    input: Readonly<{
      organisationId: OrganisationId;
      verificationId: string;
      revision: number;
    }>,
  ): Promise<unknown>;
  eraseCaseContextCollectionSource(
    input: Readonly<{ organisationId: OrganisationId; selection: unknown }>,
  ): Promise<unknown>;
  readCaseContextCollection(
    input: Readonly<{
      organisationId: OrganisationId;
      caseContextCollectionId: string;
    }>,
  ): Promise<unknown>;
  readCaseContextCollectionsForCase(
    input: Readonly<{
      organisationId: OrganisationId;
      caseId: string;
    }>,
  ): Promise<unknown>;
  reviewCaseContextCollectionRelationship(
    input: Readonly<{
      organisationId: OrganisationId;
      actorId: string;
      caseContextCollectionId: string;
      body: unknown;
    }>,
  ): Promise<unknown>;
}

export async function admittedPrepareCaseContextCollectionEvidence(
  host: OrganisationCollectionHost,
  input: Readonly<{
    organisationId: OrganisationId;
    caseId: string;
    integrationAccountId: string;
    triggeringMessageId: string;
  }>,
  scope: OrganisationExecutionScope,
) {
  const organisation = host.validateOrganisation(scope.organisationId);
  if (!organisation.ok) return organisation;
  if (
    !identifier(input.caseId) ||
    !identifier(input.integrationAccountId) ||
    !identifier(input.triggeringMessageId)
  )
    return {
      ok: false as const,
      error: { code: "case_context_collection_evidence_invalid" as const },
    };
  const policy = readCaseContextDiscoveryPolicy(
    host.storage.sql,
    scope.organisationId,
  );
  if (policy.policy.mode !== "party_context")
    return { ok: true as const, value: { kind: "source_only" as const } };
  const ids = listMemberCaseContextCollectionIdsForCase(
    host.storage.sql,
    scope.organisationId,
    input.caseId,
  );
  if (ids.length !== 1)
    return { ok: true as const, value: { kind: "source_only" as const } };
  const caseContextCollection = readCaseContextCollection(
    host.storage.sql,
    scope.organisationId,
    ids[0]!,
  );
  if (
    caseContextCollection === null ||
    caseContextCollection.lifecycle !== "open"
  )
    return { ok: true as const, value: { kind: "source_only" as const } };
  const verified = await resolveCaseContextCollectionSelectionVerification(
    scope.database,
    scope.organisationId,
    caseContextCollection.anchorSelection,
  );
  if (!(await isOrganisationExecutionActive(host.storage.sql, scope)))
    return organisationPlacementConflict();
  if (
    !verified.ok ||
    verified.value.endpoint.channel !== "gmail" ||
    verified.value.integrationAccountId !== input.integrationAccountId
  )
    return {
      ok: false as const,
      error: { code: "case_context_collection_evidence_stale" as const },
    };
  const target = verified.value.target;
  if (target.kind !== "supplier_contact")
    return { ok: true as const, value: { kind: "source_only" as const } };
  const recipient = {
    organisationId: scope.organisationId,
    merchantId: verified.value.merchantId,
    integrationAccountId: input.integrationAccountId,
    partyKind: "supplier" as const,
    partyId: target.supplierId,
    contactId: target.contactId,
    contactRevision: target.contactRevision,
    verificationId: verified.value.verificationId,
    verificationRevision: verified.value.revision,
    endpointDigest: await digestCanonical(verified.value.endpoint.address),
    purpose: "supplier_reply" as const,
  };
  if (!(await isOrganisationExecutionActive(host.storage.sql, scope)))
    return organisationPlacementConflict();
  const dependency = evidenceForCaseContextCollection(
    caseContextCollection,
    policy.revision,
    recipient,
    Date.now(),
  );
  if (dependency === null)
    return {
      ok: false as const,
      error: { code: "case_context_collection_evidence_stale" as const },
    };
  const receipt = await scope.database
    .prepare(
      `SELECT admitted_at FROM email_message_receipt WHERE organisation_id = ? AND integration_account_id = ? AND provider_message_id = ? AND case_id = ? AND contact_verification_id = ? AND contact_verification_revision = ?`,
    )
    .bind(
      scope.organisationId,
      input.integrationAccountId,
      input.triggeringMessageId,
      input.caseId,
      recipient.verificationId,
      recipient.verificationRevision,
    )
    .first<{ admitted_at: number }>();
  if (!(await isOrganisationExecutionActive(host.storage.sql, scope)))
    return organisationPlacementConflict();
  if (receipt === null)
    return { ok: true as const, value: { kind: "source_only" as const } };
  const valid = await admittedValidateCaseContextCollectionEvidence(
    host,
    {
      organisationId: scope.organisationId,
      dependency,
    },
    scope,
  );
  return valid.ok ? { ok: true as const, value: dependency } : valid;
}

export async function admittedValidateCaseContextCollectionEvidence(
  host: OrganisationCollectionHost,
  input: Readonly<{ organisationId: OrganisationId; dependency: unknown }>,
  scope: OrganisationExecutionScope,
) {
  const organisation = host.validateOrganisation(scope.organisationId);
  if (!organisation.ok) return organisation;
  const dependency = parseCaseContextCollectionEvidenceDependency(
    input.dependency,
  );
  if (dependency?.kind !== "case_context_collection_evidence")
    return {
      ok: false as const,
      error: { code: "case_context_collection_evidence_invalid" as const },
    };
  const source = await caseContextCollectionSourceAccess(
    scope,
    host.storage.sql,
    dependency.recipient.integrationAccountId,
  );
  if (!(await isOrganisationExecutionActive(host.storage.sql, scope)))
    return organisationPlacementConflict();
  const credential = await resolveTypeSafeCredential({
    sql: host.storage.sql,
    db: scope.database,
    keys: host.env,
    organisationId: scope.organisationId,
  });
  if (!(await isOrganisationExecutionActive(host.storage.sql, scope)))
    return organisationPlacementConflict();
  const policy = readCaseContextDiscoveryPolicy(
    host.storage.sql,
    scope.organisationId,
  );
  if (
    !source.ok ||
    policy.policy.mode !== "party_context" ||
    credential === null ||
    !sameTypeSafeAuthority(
      credential.authority,
      caseContextDiscoveryRouteAuthority(policy.policy.route),
    )
  )
    return {
      ok: false as const,
      error: { code: "case_context_collection_evidence_stale" as const },
    };
  for (const selection of dependency.selections) {
    const verified = await resolveCaseContextCollectionSelectionVerification(
      scope.database,
      scope.organisationId,
      selection.source,
    );
    if (!(await isOrganisationExecutionActive(host.storage.sql, scope)))
      return organisationPlacementConflict();
    if (
      !verified.ok ||
      verified.value.endpoint.channel !== "gmail" ||
      verified.value.target.contactId !== dependency.recipient.contactId ||
      verified.value.target.contactRevision !==
        dependency.recipient.contactRevision
    )
      return {
        ok: false as const,
        error: { code: "case_context_collection_evidence_stale" as const },
      };
    const endpointDigest = await digestCanonical(
      verified.value.endpoint.address,
    );
    if (!(await isOrganisationExecutionActive(host.storage.sql, scope)))
      return organisationPlacementConflict();
    if (endpointDigest !== dependency.recipient.endpointDigest)
      return {
        ok: false as const,
        error: { code: "case_context_collection_evidence_stale" as const },
      };
  }
  if (!(await isOrganisationExecutionActive(host.storage.sql, scope)))
    return organisationPlacementConflict();
  return validateCaseContextCollectionEvidence({
    sql: host.storage.sql,
    organisationId: scope.organisationId,
    dependency,
    now: Date.now(),
  });
}

export async function admittedCommitCaseContextCollectionEffectFence(
  host: OrganisationCollectionHost,
  input: Readonly<{ organisationId: OrganisationId; attempt: unknown }>,
  scope: OrganisationExecutionScope,
) {
  const organisation = host.validateOrganisation(scope.organisationId);
  if (!organisation.ok) return organisation;
  const attempt = parseCaseContextCollectionEffectAttempt(input.attempt);
  if (attempt === null)
    return {
      ok: false as const,
      error: { code: "case_context_collection_evidence_invalid" as const },
    };
  const replay = await replayCaseContextCollectionEffectFence({
    sql: host.storage.sql,
    scope,
    attempt,
    now: Date.now,
  });
  if (!replay.ok) return replay;
  if (replay.value !== null) return { ok: true as const, value: replay.value };
  const valid = await admittedValidateCaseContextCollectionEvidence(
    host,
    {
      organisationId: scope.organisationId,
      dependency: attempt.dependency,
    },
    scope,
  );
  if (!valid.ok) return valid;
  return commitCaseContextCollectionEffectFence({
    sql: host.storage.sql,
    transaction: host.transaction(),
    scope,
    attempt,
    now: Date.now,
  });
}

export async function admittedInvalidateCaseContextCollectionVerification(
  host: OrganisationCollectionHost,
  input: Readonly<{
    organisationId: OrganisationId;
    verificationId: string;
    revision: number;
  }>,
  scope: OrganisationExecutionScope,
) {
  const organisation = host.validateOrganisation(scope.organisationId);
  if (!organisation.ok) return organisation;
  if (
    !identifier(input.verificationId) ||
    !integerIn(input.revision, 1, Number.MAX_SAFE_INTEGER)
  )
    return {
      ok: false as const,
      error: { code: "case_context_collection_evidence_invalid" as const },
    };
  host.storage.transactionSync(
    invalidateCaseContextCollectionVerification.bind(null, {
      sql: host.storage.sql,
      organisationId: scope.organisationId,
      verificationId: input.verificationId,
      revision: input.revision,
    }),
  );
  await host.rearm();
  return { ok: true as const, value: null };
}

export async function admittedEraseCaseContextCollectionSource(
  host: OrganisationCollectionHost,
  input: Readonly<{ organisationId: OrganisationId; selection: unknown }>,
  scope: OrganisationExecutionScope,
) {
  const organisation = host.validateOrganisation(scope.organisationId);
  if (!organisation.ok) return organisation;
  const selection = parseCaseContextCollectionSelection(input.selection);
  if (selection === null)
    return {
      ok: false as const,
      error: { code: "case_context_collection_evidence_invalid" as const },
    };
  eraseCaseContextCollectionSource({
    sql: host.storage.sql,
    transaction: host.transaction(),
    organisationId: scope.organisationId,
    selection,
    now: Date.now(),
  });
  await host.rearm();
  return { ok: true as const, value: null };
}

export async function admittedReadCaseContextCollection(
  host: OrganisationCollectionHost,
  input: Readonly<{
    organisationId: OrganisationId;
    caseContextCollectionId: string;
  }>,
  scope: OrganisationExecutionScope,
) {
  const organisation = host.validateOrganisation(scope.organisationId);
  if (!organisation.ok) return organisation;
  if (!identifier(input.caseContextCollectionId)) {
    return {
      ok: false as const,
      error: {
        code: "case_context_collection_relationship_invalid" as const,
      },
    };
  }
  const caseContextCollection = readCaseContextCollection(
    host.storage.sql,
    scope.organisationId,
    input.caseContextCollectionId,
  );
  return caseContextCollection === null
    ? {
        ok: false as const,
        error: {
          code: "case_context_collection_relationship_unavailable" as const,
        },
      }
    : { ok: true as const, value: caseContextCollection };
}

export async function admittedReadCaseContextCollectionsForCase(
  host: OrganisationCollectionHost,
  input: Readonly<{
    organisationId: OrganisationId;
    caseId: string;
  }>,
  scope: OrganisationExecutionScope,
) {
  const organisation = host.validateOrganisation(scope.organisationId);
  if (!organisation.ok) return organisation;
  const caseId = parseCaseId(input.caseId);
  if (!caseId.ok) {
    return {
      ok: false as const,
      error: {
        code: "case_context_collection_relationship_invalid" as const,
      },
    };
  }
  const caseContextCollectionIds = listCaseContextCollectionIdsForCase(
    host.storage.sql,
    scope.organisationId,
    caseId.value,
    Date.now(),
  );
  const caseContextCollections: CaseContextCollection[] = [];
  for (const caseContextCollectionId of caseContextCollectionIds) {
    const caseContextCollection = readCaseContextCollection(
      host.storage.sql,
      scope.organisationId,
      caseContextCollectionId,
    );
    if (caseContextCollection === null) {
      return {
        ok: false as const,
        error: {
          code: "case_context_collection_relationship_unavailable" as const,
        },
      };
    }
    caseContextCollections.push(caseContextCollection);
  }
  return {
    ok: true as const,
    value: { caseId: caseId.value, caseContextCollections },
  };
}

export async function admittedReviewCaseContextCollectionRelationship(
  host: OrganisationCollectionHost,
  input: Readonly<{
    organisationId: OrganisationId;
    actorId: string;
    caseContextCollectionId: string;
    body: unknown;
  }>,
  scope: OrganisationExecutionScope,
) {
  const organisation = host.validateOrganisation(scope.organisationId);
  if (!organisation.ok) return organisation;
  const command = parseCaseContextCollectionReviewCommand(input.body);
  if (
    !identifier(input.caseContextCollectionId) ||
    !identifier(input.actorId) ||
    command === null
  ) {
    return {
      ok: false as const,
      error: {
        code: "case_context_collection_relationship_invalid" as const,
      },
    };
  }
  const requestDigest = await digestCanonical({
    actorId: input.actorId,
    caseContextCollectionId: input.caseContextCollectionId,
    command,
  });
  if (!(await isOrganisationExecutionActive(host.storage.sql, scope)))
    return organisationPlacementConflict();
  const replayed = replayCaseContextCollectionRelationshipCommand({
    sql: host.storage.sql,
    organisationId: scope.organisationId,
    commandId: command.commandId,
    requestDigest,
  });
  if (!replayed.ok || replayed.value !== null) return replayed;
  const caseContextCollection = readCaseContextCollection(
    host.storage.sql,
    scope.organisationId,
    input.caseContextCollectionId,
  );
  if (caseContextCollection === null) {
    return {
      ok: false as const,
      error: {
        code: "case_context_collection_relationship_unavailable" as const,
      },
    };
  }
  const decision = await caseContextCollectionReviewDecision({
    db: scope.database,
    organisationId: scope.organisationId,
    caseContextCollection,
    command: command.decision,
  });
  if (!(await isOrganisationExecutionActive(host.storage.sql, scope)))
    return organisationPlacementConflict();
  if (!decision.ok) return decision;
  const result = decideCaseContextCollectionRelationship({
    sql: host.storage.sql,
    transaction: host.transaction(),
    organisationId: scope.organisationId,
    commandId: command.commandId,
    requestDigest,
    caseContextCollectionId: input.caseContextCollectionId,
    expectedRevision: command.expectedRevision,
    actorId: input.actorId,
    now: Date.now(),
    decision: decision.value,
  });
  await host.rearm();
  return result;
}

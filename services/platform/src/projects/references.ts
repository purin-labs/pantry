import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { parseSystemEntityRef } from "@seams/commerce-client";
import { listAccessGrants } from "../data/access-grants";
import { resolveOrganisationCommerceSystemAuthority } from "../data/organisation-commerce-system";
import { resolveCurrentOrganisationCommerceMerchantBinding } from "../data/commerce-merchant-binding";
import { selectNamedCommerceQuerySourceGrant } from "../context/assembly/commerce";
import { integrationResourceScopeForGrant } from "../policy/information-flow/source-labels";
import {
  readChatControlAuthority,
  resolveNativeChatAudience,
  evaluateChatFlowLabelSink,
} from "../chat/information-flow";
import {
  ProjectAudienceProposal,
  type DisclosureDestination,
} from "../chat/disclosure-evidence";
import { readGrantedFileMetadata } from "../context/files/tools";
import { prepareTurnAuthority } from "../context/turn-context";
import { readCurrentOrganisationPolicySnapshot } from "../policy-snapshot";
import { parseCaseId, parseIntegrationAccountId } from "../ids";
import {
  audiencesForAdmission,
  createCurrentSourceFlowLabel,
  decideContextAdmission,
  FlowLabel,
  ObservationEvidence,
} from "../policy/information-flow";
import {
  projectReferenceIdentity,
  isConversationId,
  type ProjectReference,
  type ConversationId,
  type ProjectReferenceObservation,
} from "@seams/control-api";
import { assertNever, canonicalJson, sha256Hex } from "@seams/std";
import { deriveDirectCaseIdentities } from "../actors/case-direct-processing";
import { resolveActiveCaseActor } from "../actors/actor-router";
import {
  bakeryRunSnapshotPrefix,
  bakeryRunSnapshotSummary,
} from "../commerce/bakery/saved-runs";
import type { Env } from "../env";
import type { ConversationScope } from "../chat/store";
import {
  authorizeConversation,
  VISIBLE_CONVERSATIONS_SQL,
} from "../chat/conversation-access";
import { parseConversationActorIdentity } from "../chat/conversation-actor-identity";
import type { Variant } from "@seams/type-utils";

export async function searchProjectReferences(
  env: Env,
  execution: OrganisationExecutionScope,
  scope: ConversationScope,
  query: string,
): Promise<readonly ProjectReference[]> {
  const prefix = bakeryRunSnapshotPrefix(scope.organisationId);
  const saved = await env.ARCHIVE.list({
    prefix,
    limit: 100,
    include: ["customMetadata"],
  });
  const references: ProjectReference[] = [];
  for (const object of saved.objects) {
    const summary = bakeryRunSnapshotSummary(prefix, object);
    if (summary.name.toLocaleLowerCase().includes(query)) {
      const observed = await observeProjectReference(
        env,
        execution,
        scope,
        { kind: "bakery_run", id: summary.id, label: summary.name },
        Date.now(),
      );
      if (observed.kind === "available") references.push(observed.reference);
    }
    if (references.length === 12) return references;
  }
  const resources = await execution.database
    .prepare(
      `SELECT r.provider_resource_id, r.resource_kind, r.display_label, s.provider, s.integration_account_id
    FROM provider_discovered_resource r JOIN provider_resource_snapshot s USING (snapshot_revision) JOIN integration_account a ON a.integration_account_id = s.integration_account_id AND a.organisation_id = s.organisation_id AND a.lifecycle = 'active'
    WHERE s.organisation_id = ? AND r.access_state = 'accessible' AND lower(r.display_label) LIKE ? ORDER BY s.created_at DESC LIMIT 30`,
    )
    .bind(scope.organisationId, `%${query}%`)
    .all<ResourceRow>();
  const seen = new Set(references.map(projectReferenceIdentity));
  for (const row of resources.results) {
    const reference = referenceFromResource(row);
    if (reference === null || seen.has(projectReferenceIdentity(reference)))
      continue;
    seen.add(projectReferenceIdentity(reference));
    const observed = await observeProjectReference(
      env,
      execution,
      scope,
      reference,
      Date.now(),
    );
    if (observed.kind === "available") references.push(observed.reference);
    if (references.length === 12) return references;
  }
  if (query.length === 0) return references;
  const chats = await execution.database
    .prepare(
      `${VISIBLE_CONVERSATIONS_SQL}
    SELECT conversation_id, actor_identity, json_extract(state_json, '$.title') AS title
    FROM visible_conversation WHERE title_normalized LIKE ? ORDER BY updated_at DESC LIMIT 4`,
    )
    .bind(scope.organisationId, scope.userId, `%${query}%`)
    .all<ReferenceConversationRow>();
  for (const row of chats.results) {
    const chat = parseReferenceConversation(row, scope.organisationId);
    const identities = await deriveDirectCaseIdentities(chat.actorIdentity);
    if (!identities.ok) continue;
    const actor = await resolveActiveCaseActor({
      env: env,
      namespace: env.CASE,
      organisationId: scope.organisationId,
      caseId: identities.value.caseId,
      now: Date.now(),
    });
    if (!actor.ok) continue;
    const snapshot = await actor.value.inspect();
    if (
      !snapshot.ok ||
      (await authorizeConversation(execution.database, scope, chat.id)) === null
    )
      continue;
    for (const entry of snapshot.value.entries.slice(-3)) {
      const observed = await observeProjectReference(
        env,
        execution,
        scope,
        {
          kind: "case_entry",
          caseId: identities.value.caseId,
          entryId: entry.entryId,
          label: `${chat.title.slice(0, 80)} · ${entry.entryId}`,
        },
        Date.now(),
      );
      if (observed.kind === "available") references.push(observed.reference);
      if (references.length === 12) return references;
    }
  }
  return references;
}

type ReferenceConversationRow = Readonly<{
  conversation_id: unknown;
  actor_identity: unknown;
  title: unknown;
}>;

function parseReferenceConversation(
  row: ReferenceConversationRow,
  organisationId: ConversationScope["organisationId"],
): Readonly<{ id: ConversationId; actorIdentity: string; title: string }> {
  if (!isConversationId(row.conversation_id) || typeof row.title !== "string")
    throw new Error("chat_reference_storage_invalid");
  return {
    id: row.conversation_id,
    actorIdentity: parseConversationActorIdentity(
      row.actor_identity,
      organisationId,
    ),
    title: row.title,
  };
}

type ResourceRow = Readonly<{
  provider_resource_id: string;
  resource_kind: string;
  display_label: string;
  provider: string;
  integration_account_id: string;
}>;
function referenceFromResource(row: ResourceRow): ProjectReference | null {
  if (
    (row.provider === "google_drive" || row.provider === "dropbox") &&
    (row.resource_kind === "file" ||
      row.resource_kind === "google_drive_file" ||
      row.resource_kind === "dropbox_file")
  )
    return {
      kind: "file",
      integrationAccountId: row.integration_account_id,
      provider: row.provider,
      providerFileId: row.provider_resource_id,
      label: row.display_label,
    };
  if (row.provider === "underclerk" && isCommerceRecordType(row.resource_kind))
    return {
      kind: "commerce_record",
      type: row.resource_kind,
      id: row.provider_resource_id,
      label: row.display_label,
    };
  return null;
}
function isCommerceRecordType(
  raw: string,
): raw is Variant<ProjectReference, "commerce_record">["type"] {
  return (
    raw === "product" ||
    raw === "order" ||
    raw === "menu" ||
    raw === "recipe_revision" ||
    raw === "production_batch"
  );
}

export async function observeProjectReference(
  env: Env,
  execution: OrganisationExecutionScope,
  scope: ConversationScope,
  reference: ProjectReference,
  now: number,
  destination: DisclosureDestination = { kind: "current" },
): Promise<ProjectReferenceObservation> {
  const authority = await readChatControlAuthority(execution.database, scope);
  if (authority === null) return unavailable(reference, now);
  switch (reference.kind) {
    case "bakery_run": {
      const object = await env.ARCHIVE.head(
        bakeryRunSnapshotPrefix(scope.organisationId) + reference.id,
      );
      if (object === null) return unavailable(reference, now);
      const label = await createCurrentSourceFlowLabel({
        kind: "ingress",
        db: execution.database,
        authority,
      });
      if (!label.ok) return unavailable(reference, now);
      const canonical = {
        kind: "bakery_run" as const,
        id: reference.id,
        label: bakeryRunSnapshotSummary(
          bakeryRunSnapshotPrefix(scope.organisationId),
          object,
        ).name,
      };
      const digest = await referenceMetadataDigest(canonical, object.etag);
      return admittedReference(
        canonical,
        now,
        object.etag,
        label.value,
        {
          kind: "organisation_record",
          organisationId: scope.organisationId,
          recordId: `bakery-run:${reference.id}`,
        },
        object.uploaded.getTime(),
        digest,
      );
    }

    case "case_entry": {
      if (
        destination.kind === "project_admission" &&
        !ProjectAudienceProposal.is(destination.proposal)
      )
        return unavailable(reference, now);
      const readerScope =
        destination.kind === "project_admission"
          ? destination.proposal.scope
          : scope;
      const visible = await execution.database
        .prepare(
          `${VISIBLE_CONVERSATIONS_SQL}
        SELECT conversation_id, actor_identity, json_extract(state_json, '$.title') AS title
        FROM visible_conversation`,
        )
        .bind(readerScope.organisationId, readerScope.userId)
        .all<ReferenceConversationRow>();
      for (const row of visible.results) {
        const chat = parseReferenceConversation(row, scope.organisationId);
        const identities = await deriveDirectCaseIdentities(chat.actorIdentity);
        if (!identities.ok || identities.value.caseId !== reference.caseId)
          continue;
        const actor = await resolveActiveCaseActor({
          env: env,
          namespace: env.CASE,
          organisationId: scope.organisationId,
          caseId: identities.value.caseId,
          now,
        });
        if (!actor.ok) return unavailable(reference, now);
        const access = await authorizeConversation(
          execution.database,
          readerScope,
          chat.id,
        );
        if (
          destination.kind === "project_admission" &&
          (access?.access.kind !== "shared" ||
            access.access.sharedProjectId !== destination.proposal.projectId)
        )
          continue;
        const snapshot = await actor.value.inspect();
        if (!snapshot.ok || access === null) return unavailable(reference, now);
        const entry = snapshot.value.entries.find(
          entryHasId.bind(null, reference.entryId),
        );
        if (entry === undefined) return unavailable(reference, now);
        const source = await actor.value.readMetadata({
          organisationId: scope.organisationId,
          caseId: identities.value.caseId,
          entryId: entry.entryId,
        });
        if (!source.ok) return unavailable(reference, now);
        const label = await FlowLabel.restore(source.value.inputLabel);
        if (!label.ok) return unavailable(reference, now);
        const audience = await resolveNativeChatAudience(
          execution.database,
          execution.accountAccess,
          authority,
          label.value,
          destination,
        );
        if (audience === null) return unavailable(reference, now);
        const current = await evaluateChatFlowLabelSink(
          execution.database,
          execution.accountAccess,
          label.value,
          authority,
          { kind: "conversation_delivery", destinationAuthority: authority },
          destination,
        );
        if (current.kind !== "allow") return unavailable(reference, now);
        const decision = await decideContextAdmission({
          subject: {
            kind: "native_chat",
            requestAuthority: authority,
            caseId: identities.value.caseId,
            audience,
          },
          inputLabel: label.value,
        });
        if (decision.kind !== "admit") return unavailable(reference, now);
        const canonical = {
          kind: "case_entry" as const,
          caseId: identities.value.caseId,
          entryId: entry.entryId,
          label: `${chat.title.slice(0, 80)} · ${entry.entryId}`,
        };
        return admittedReference(
          canonical,
          now,
          String(source.value.sourceRevision),
          label.value,
          {
            kind: "case_entry",
            caseId: identities.value.caseId,
            entryId: entry.entryId,
          },
          source.value.sourceRevision,
          await referenceMetadataDigest(
            canonical,
            String(source.value.sourceRevision),
          ),
        );
      }
      return unavailable(reference, now);
    }
    case "file": {
      const account = parseIntegrationAccountId(reference.integrationAccountId);
      const caseId = parseCaseId("case_project_metadata");
      const policy = await readCurrentOrganisationPolicySnapshot(
        execution.database,
        scope.organisationId,
      );
      if (!account.ok || !caseId.ok || !policy.ok)
        return unavailable(reference, now);
      const compiled = await prepareTurnAuthority({
        db: execution.database,
        accountAccess: execution.accountAccess,
        userAuthority: {
          kind: "disclosure_recipient",
          disclosureEvidenceId: await sha256Hex(canonicalJson(reference)),
        },
        action: "disclose",
        organisationId: scope.organisationId,
        requestAuthority: authority,
        policy: policy.value,
      });
      if (!compiled.ok) return unavailable(reference, now);
      const metadata = await readGrantedFileMetadata({
        db: execution.database,
        organisationId: scope.organisationId,
        caseId: caseId.value,
        requestAuthority: compiled.value.requestAuthority,
        visibility: audiencesForAdmission(
          compiled.value.requestAuthority,
          caseId.value,
        ),
        reference: {
          integrationAccountId: account.value,
          provider: reference.provider,
          providerFileId: reference.providerFileId,
        },
      });
      if (metadata === null) return unavailable(reference, now);
      return {
        kind: "available",
        reference: {
          kind: "file",
          integrationAccountId: account.value,
          provider: reference.provider,
          providerFileId: reference.providerFileId,
          label: metadata.title,
        },
        observedAt: metadata.evidence.observedAt,
        revision: String(metadata.sourceRevision),
        digest: metadata.evidence.contentDigest,
        admission: {
          flowLabelJson: JSON.stringify(metadata.inputLabel.toJSON()),
          observationJson: JSON.stringify(metadata.evidence.toJSON()),
        },
      };
    }
    case "commerce_record": {
      const commerce = await resolveOrganisationCommerceSystemAuthority({
        db: execution.database,
        organisationId: scope.organisationId,
      });
      const merchant =
        await resolveCurrentOrganisationCommerceMerchantBinding({
          db: execution.database,
          organisationId: scope.organisationId,
        });
      const grants = await listAccessGrants({
        db: execution.database,
        organisationId: scope.organisationId,
        lifecycle: "active",
      });
      if (!commerce.ok || !merchant.ok || !grants.ok)
        return unavailable(reference, now);
      const grant = selectNamedCommerceQuerySourceGrant({
        organisationId: scope.organisationId,
        merchantId: merchant.value.merchantId,
        grants: grants.value,
        requestAuthority: authority,
        causationId: `project_reference_${reference.id}`,
        query: {
          kind: "entity_by_ref",
          reference: parseSystemEntityRef(reference.type, reference.id),
          traversal: { maxDepth: 0, resultLimit: 1 },
          filter: null,
        },
        allowedSensitivity: "public",
        now: new Date(now).toISOString(),
      });
      if (!grant.ok) return unavailable(reference, now);
      const resourceScope = integrationResourceScopeForGrant(grant.value);
      if (resourceScope === null) return unavailable(reference, now);
      const label = await createCurrentSourceFlowLabel({
        kind: "integration_resource",
        db: execution.database,
        organisationId: scope.organisationId,
        integrationAccountId: commerce.value.integrationAccountId,
        resourceScope,
        capabilityId: grant.value.target.capabilityId,
        grantIds: [grant.value.grantId],
      });
      if (!label.ok) return unavailable(reference, now);
      const admission = await decideContextAdmission({
        subject: {
          kind: "authority_derived",
          requestAuthority: authority,
          caseId: "case_project_metadata",
        },
        inputLabel: label.value,
      });
      if (admission.kind !== "admit") return unavailable(reference, now);
      const row = await execution.database
        .prepare(
          `SELECT r.display_label, r.provider_revision, s.created_at FROM provider_discovered_resource r
        JOIN provider_resource_snapshot s USING(snapshot_revision) JOIN integration_account a ON a.organisation_id = s.organisation_id AND a.integration_account_id = s.integration_account_id AND a.lifecycle = 'active'
        WHERE s.organisation_id = ? AND s.integration_account_id = ? AND s.provider = 'underclerk' AND r.resource_kind = ? AND r.provider_resource_id = ? AND r.access_state = 'accessible'
        ORDER BY s.created_at DESC LIMIT 1`,
        )
        .bind(
          scope.organisationId,
          commerce.value.integrationAccountId,
          reference.type,
          reference.id,
        )
        .first<{
          display_label: string;
          provider_revision: string;
          created_at: number;
        }>();
      if (row === null) return unavailable(reference, now);
      const canonical = {
        kind: "commerce_record" as const,
        type: reference.type,
        id: reference.id,
        label: row.display_label,
      };
      return admittedReference(
        canonical,
        row.created_at,
        row.provider_revision,
        label.value,
        {
          kind: "integration_resource",
          organisationId: scope.organisationId,
          integrationAccountId: commerce.value.integrationAccountId,
          resourceScope,
        },
        row.created_at,
        await referenceMetadataDigest(canonical, row.provider_revision),
      );
    }

    default:
      return assertNever(reference);
  }
}
async function referenceMetadataDigest(
  reference: ProjectReference,
  revision: string,
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      reference,
      revision,
    }),
  );
}
function entryHasId(id: string, entry: { entryId: string }): boolean {
  return entry.entryId === id;
}
function unavailable(
  reference: ProjectReference,
  observedAt: number,
): ProjectReferenceObservation {
  return {
    kind: "unavailable",
    reference: unavailableReference(reference),
    observedAt,
    reason:
      "Source metadata is unavailable. An authorized read must verify its current accessibility.",
  };
}

function unavailableReference(reference: ProjectReference): ProjectReference {
  switch (reference.kind) {
    case "bakery_run":
      return {
        kind: reference.kind,
        id: reference.id,
        label: "Unavailable reference",
      };
    case "case_entry":
      return {
        kind: reference.kind,
        caseId: reference.caseId,
        entryId: reference.entryId,
        label: "Unavailable reference",
      };
    case "file":
      return {
        kind: reference.kind,
        integrationAccountId: reference.integrationAccountId,
        provider: reference.provider,
        providerFileId: reference.providerFileId,
        label: "Unavailable reference",
      };
    case "commerce_record":
      return {
        kind: reference.kind,
        type: reference.type,
        id: reference.id,
        label: "Unavailable reference",
      };
    default:
      return assertNever(reference);
  }
}
async function admittedReference(
  reference: ProjectReference,
  observedAt: number,
  revision: string,
  inputLabel: FlowLabel,
  source: import("../policy/information-flow").FlowSource,
  sourceRevision: number,
  contentDigest: string,
): Promise<ProjectReferenceObservation> {
  const evidence = await ObservationEvidence.create({
    source,
    sourceRevision,
    contentDigest,
    inputLabel,
    observedAt,
  });
  if (!evidence.ok) return unavailable(reference, observedAt);
  return {
    kind: "available",
    reference,
    observedAt,
    revision,
    digest: contentDigest,
    admission: {
      flowLabelJson: JSON.stringify(inputLabel.toJSON()),
      observationJson: JSON.stringify(evidence.value.toJSON()),
    },
  };
}

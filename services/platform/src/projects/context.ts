import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationAccess } from "@purin-labs/tenancy/organisation-access/access";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Result } from "@purin-labs/kernel/result";
import type { RequestAuthority } from "@purin-labs/contracts";
import { canonicalJson, sha256Hex } from "@purin-labs/std";
import {
  readChatControlAuthority,
  resolveNativeChatAudience,
  evaluateChatFlowLabelSink,
} from "../chat/information-flow";
import {
  createCurrentSourceFlowLabel,
  FlowLabel,
  ObservationEvidence,
  decideAutomaticContextAdmission,
} from "../policy/information-flow";
import {
  digestContextBundle,
  materializeContextBundle,
  type ContextAssemblyResult,
  type ContextItem,
} from "../context/assembly";
import {
  createProjectSnapshot,
  verifyProjectSnapshot,
  type ProjectId,
  type ProjectSnapshot,
  type ProjectReferenceObservation,
} from "@purin-labs/control-api";
import type { Env } from "@purin-labs/kernel/env";
import type { ProjectAccessScope } from "./access";
import { NATIVE_CHAT_SOURCE_ACCESS } from "../chat/conversation-access";
import { readProject } from "./records";
import { observeProjectReference } from "./references";
import type { Variant } from "@purin-labs/type-utils";

export type ProjectSnapshotPlacement = Readonly<{
  projectId: ProjectId;
  membershipRevision: number;
  // False when the Case takes nothing from its Project whatever the acting
  // member can read there, as a canvas chat does.
  inherits: boolean;
}>;

// The acting member inherits a Project's content only under their own access
// to it. Without that access the snapshot names the Project and carries nothing.
export async function prepareProjectSnapshot(
  env: Env,
  execution: OrganisationExecutionScope,
  scope: ProjectAccessScope,
  placement: ProjectSnapshotPlacement,
): Promise<ProjectSnapshot> {
  const now = Date.now();
  const project = placement.inherits
    ? await readProject(execution.database, scope, placement.projectId)
    : null;
  if (project === null)
    return createProjectSnapshot(
      {
        kind: "withheld",
        projectId: placement.projectId,
        membershipRevision: placement.membershipRevision,
      },
      now,
    );
  const authority = await readChatControlAuthority(execution.database, scope);
  if (authority === null) throw new Error("project_context_unavailable");
  const label = await createCurrentSourceFlowLabel({
    kind: "native_chat",
    db: execution.database,
    authority,
    source: {
      kind: "project",
      organisationId: scope.organisationId,
      projectId: project.id,
    },
    access: NATIVE_CHAT_SOURCE_ACCESS,
  });
  if (!label.ok) throw new Error("project_context_unavailable");
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "project",
      organisationId: scope.organisationId,
      projectId: project.id,
    },
    sourceRevision: project.contentRevision,
    contentDigest: await sha256Hex(
      projectBriefText(project.name, project.brief),
    ),
    inputLabel: label.value,
    observedAt: now,
  });
  if (!evidence.ok) throw new Error("project_context_unavailable");
  const references: ProjectReferenceObservation[] = [];
  for (const reference of project.references)
    references.push(
      await observeProjectReference(env, execution, scope, reference, now),
    );
  return createProjectSnapshot(
    {
      kind: "project",
      projectId: project.id,
      membershipRevision: placement.membershipRevision,
      contentRevision: project.contentRevision,
      name: project.name,
      brief: project.brief,
      admission: {
        flowLabelJson: JSON.stringify(label.value.toJSON()),
        observationJson: JSON.stringify(evidence.value.toJSON()),
      },
      references,
    },
    now,
  );
}

function projectBriefText(name: string, brief: string): string {
  return canonicalJson({ name, brief });
}

export async function admitProjectContext(
  db: OrganisationDatabase,
  accountAccess: OrganisationAccess,
  authority: RequestAuthority,
  context: ContextAssemblyResult,
  snapshot: ProjectSnapshot | null,
): Promise<ContextAssemblyResult> {
  if (snapshot === null || snapshot.layer.kind === "withheld") return context;
  // Only a member's own chat turn carries Project context. Case moves rely on
  // that: a chat's move is fenced by its idle state and revision in D1, and no
  // other turn reads a Project, so a move is not serialized through the Case
  // Actor. Admitting Project context for any other authority needs that step.
  if (authority.kind !== "control")
    throw new Error("project_context_unavailable");
  const layer = snapshot.layer;
  const items: ContextItem[] = [...context.bundle.items];
  const brief = await projectObservationItem(
    db,
    accountAccess,
    authority,
    context.bundle.caseId,
    snapshot.digest,
    projectBriefText(layer.name, layer.brief),
    layer.admission,
  );
  if (!brief.ok) throw new Error(brief.error.code);
  items.push(brief.value);
  for (const reference of layer.references) {
    if (reference.kind === "unavailable") continue;
    const observed = await projectObservationItem(
      db,
      accountAccess,
      authority,
      context.bundle.caseId,
      snapshot.digest,
      canonicalJson({
        reference: reference.reference,
        revision: reference.revision,
      }),
      reference.admission,
    );
    if (!observed.ok) throw new Error(observed.error.code);
    items.push(observed.value);
  }
  const bundle = {
    organisationId: context.bundle.organisationId,
    caseId: context.bundle.caseId,
    assignmentId: context.bundle.assignmentId,
    sessionId: context.bundle.sessionId,
    policyVersion: context.bundle.policyVersion,
    assemblyStrategyVersion: context.bundle.assemblyStrategyVersion,
    assembledAt: context.bundle.assembledAt,
    items,
    usage: {
      items: items.length,
      estimatedTokens: items.reduce(contextTokens, 0),
    },
    disposition: context.bundle.disposition,
    memory: context.bundle.memory,
  };
  return {
    bundle,
    bundleDigest: await digestContextBundle(bundle),
    modelContext: materializeContextBundle(bundle),
  };
}
function contextTokens(total: number, item: ContextItem): number {
  return total + Math.ceil(item.boundedExcerpt.length / 4);
}
type ProjectObservationError = Readonly<{
  code:
    | "project_evidence_unavailable"
    | "project_access_changed"
    | "project_context_forbidden";
}>;

async function projectObservationItem(
  db: OrganisationDatabase,
  accountAccess: OrganisationAccess,
  authority: Variant<RequestAuthority, "control">,
  caseId: string,
  snapshotDigest: string,
  text: string,
  admission: import("@purin-labs/control-api").ProjectContextAdmission,
): Promise<Result<ContextItem, ProjectObservationError>> {
  const inputLabel = await FlowLabel.restore(
    JSON.parse(admission.flowLabelJson),
  );
  const evidence = await ObservationEvidence.restore(
    JSON.parse(admission.observationJson),
  );
  if (
    !inputLabel.ok ||
    !evidence.ok ||
    evidence.value.flowLabelDigest !== inputLabel.value.digest
  )
    return { ok: false, error: { code: "project_evidence_unavailable" } };
  if ((await sha256Hex(text)) !== evidence.value.contentDigest)
    return { ok: false, error: { code: "project_evidence_unavailable" } };
  const audience = await resolveNativeChatAudience(
    db,
    accountAccess,
    authority,
    inputLabel.value,
    { kind: "current" },
  );
  if (audience === null)
    return { ok: false, error: { code: "project_access_changed" } };
  const decision = await decideAutomaticContextAdmission({
    subject: {
      kind: "native_chat",
      requestAuthority: authority,
      caseId,
      audience,
    },
    inputLabel: inputLabel.value,
    recipient: null,
  });
  if (decision.kind !== "admit")
    return { ok: false, error: { code: "project_context_forbidden" } };
  return {
    ok: true,
    value: {
      source: {
        kind: "project_observation",
        source: evidence.value.source,
        snapshotDigest,
      },
      provenance: { kind: "project_context" },
      sourceRevision: evidence.value.sourceRevision,
      contentDigest: evidence.value.contentDigest,
      boundedExcerpt: text,
      inputLabel: inputLabel.value,
      observationEvidence: evidence.value,
      observedAt: evidence.value.observedAt,
      freshness: { kind: "fresh" },
      retrievalEvidence: {
        exactPhraseMatch: false,
        tokenOverlapMillionths: 0,
        recencyRank: 0,
      },
    },
  };
}

export async function authorizeProjectContextDisclosure(
  db: OrganisationDatabase,
  accountAccess: OrganisationAccess,
  authority: Variant<RequestAuthority, "control">,
  caseId: string,
  snapshot: ProjectSnapshot | null,
): Promise<Result<true, ProjectObservationError>> {
  if (snapshot === null || snapshot.layer.kind === "withheld")
    return { ok: true, value: true };
  if (!(await verifyProjectSnapshot(snapshot)))
    return { ok: false, error: { code: "project_evidence_unavailable" } };
  const layer = snapshot.layer;
  const observations = [
    {
      text: projectBriefText(layer.name, layer.brief),
      admission: layer.admission,
    },
  ];
  for (const reference of layer.references) {
    if (reference.kind === "available")
      observations.push({
        text: canonicalJson({
          reference: reference.reference,
          revision: reference.revision,
        }),
        admission: reference.admission,
      });
  }
  for (const observation of observations) {
    const restored = await projectObservationItem(
      db,
      accountAccess,
      authority,
      caseId,
      snapshot.digest,
      observation.text,
      observation.admission,
    );
    if (!restored.ok) return restored;
    const decision = await evaluateChatFlowLabelSink(
      db,
      accountAccess,
      restored.value.inputLabel,
      authority,
      { kind: "conversation_delivery", destinationAuthority: authority },
    );
    if (decision.kind === "unavailable")
      return {
        ok: false,
        error: { code: "project_evidence_unavailable" },
      };
    if (decision.kind !== "allow")
      return { ok: false, error: { code: "project_context_forbidden" } };
  }
  return { ok: true, value: true };
}

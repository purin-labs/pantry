import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type {
  AccessDecisionExplanation,
  AccessDecisionQuestion,
  AccessSubjectRef,
  CapabilityMode,
  EffectiveGrantRef,
  FlowDestinationRef,
  InformationSourceRef,
  RequestAuthority,
} from "@purin-labs/contracts";

import type {
  AccessGrant,
  AccessGrantTarget,
  FileResourceAccessGrantTarget,
  GrantSubject,
} from "../authorization/access-grants/types";
import { selectActiveGrants } from "../authorization/access-grants";
import { CAPABILITY_CATALOGUE } from "../authorization/capability-catalogue";
import { listAccessGrants } from "../data/access-grants";
import { readOrganisationCapabilityPolicies } from "../data/capability-policy";
import type { ActiveOrganisationMembership } from "@purin-labs/tenancy/data/control-plane";
import {
  resolveActiveProviderAccountContext,
  resolveIntegrationAccount,
} from "@purin-labs/connections/data/integration-account";
import { resolveOrganisationCommerceSystemAuthority } from "@purin-labs/connections/data/organisation-commerce-system";
import { resolveCommerceMerchantBinding } from "@purin-labs/connections/data/commerce-merchant-binding";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseConnectorId,
  parseIntegrationAccountId,
  parsePersonId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import {
  createCurrentSourceFlowLabel,
  decideContextAdmission,
  emptyFlowLabel,
  currentFlowSinkCheck,
  evaluateFlowLabelSink,
  FlowLabel,
  integrationResourceScopeForGrant,
  joinFlowLabels,
} from "../policy/information-flow";
import {
  buildAgentMailboxAuthority,
  buildControlAuthority,
  buildSharedSlackAuthority,
  buildWhatsAppSupportAuthority,
  buildWorkflowAuthority,
  validateNativeRequestAuthority,
} from "../request-authority";
import type { Result } from "@purin-labs/kernel/result";
import {
  grantSubjectFromReferenceInput,
  opaqueAccessTargetReference,
  opaqueInformationSourceReference,
  opaqueSubjectReference,
  resolveCaseReference,
  type CaseReferenceError,
  type SubjectReferenceInput,
} from "./references";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, isPositiveInteger } from "@purin-labs/std";
import type {
  CustomConnectorId,
  CustomConnectorRevision,
} from "@purin-labs/connections/custom-connectors/identity";

const SUBJECT_RESOLUTION_LIMIT = 1_000;

/**
 * Reads the active custom connector account of an integration account: its
 * connector and the binding that the Organisation accepted. The integrations
 * area gives the read through the Worker.
 */
export type CustomConnectorAccountRead = (
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    integrationAccountId: IntegrationAccountId;
  }>,
) => Promise<
  Result<
    Readonly<{
      source: Readonly<{ connectorId: CustomConnectorId }>;
      binding: Readonly<{
        acceptedRevision: CustomConnectorRevision;
        definitionDigest: string;
      }>;
    }>,
    unknown
  >
>;

type ExplanationInput = Readonly<{
  /** The read of a custom connector account, from the integrations area. */
  customConnectorAccount: CustomConnectorAccountRead;
  scope: OrganisationExecutionScope;
  env: Env;
  organisationId: OrganisationId;
  requesterMembership: ActiveOrganisationMembership;
  question: AccessDecisionQuestion;
  now: number;
}>;

type ResolvedAuthority = Readonly<{
  subject: GrantSubject;
  requestAuthority: RequestAuthority;
}>;

type ResolvedDeliveryAuthority = Readonly<{
  subject: GrantSubject;
  requestAuthority: Variant<
    RequestAuthority,
    "direct_conversation" | "shared_conversation" | "workflow"
  >;
}>;

type SourceGroup = Readonly<{
  sourceRefId: string;
  revision: number;
  integrationAccountId: IntegrationAccountId;
  capabilityId: string;
  capabilityVersion: number;
  resourceScope: string;
  grantIds: readonly string[];
}>;

type ResolvedSource = SourceGroup &
  Readonly<{
    label: FlowLabel;
  }>;

type CapabilityGatePermit = Readonly<{
  authority: ResolvedAuthority;
  target: AccessGrantTarget;
  grants: readonly AccessGrant[];
  policyMode: CapabilityMode;
}>;

type ExplanationFailure = Variant<
  AccessDecisionExplanation,
  "denied" | "unavailable"
>;

export async function resolveGrantSubjectReference(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    subjectRef: AccessSubjectRef;
  }>,
): Promise<Result<GrantSubject, "access_subject_reference_unavailable">> {
  const resolved = await resolveSubjectReference(
    input.db,
    input.organisationId,
    input.subjectRef,
  );
  return resolved.ok
    ? resolved
    : { ok: false, error: "access_subject_reference_unavailable" };
}

export async function resolveGrantTargetReference(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    targetRef: Readonly<{ targetRefId: string; revision: number }>;
  }>,
): Promise<Result<AccessGrantTarget, "access_target_reference_unavailable">> {
  const grants = await listAccessGrants({
    db: input.db,
    organisationId: input.organisationId,
  });
  if (!grants.ok)
    return { ok: false, error: "access_target_reference_unavailable" };
  const resolved = await resolveTarget(
    input.organisationId,
    input.targetRef,
    grants.value,
  );
  return resolved.ok
    ? resolved
    : { ok: false, error: "access_target_reference_unavailable" };
}

export async function explainAccessDecision(
  input: ExplanationInput,
): Promise<AccessDecisionExplanation> {
  switch (input.question.kind) {
    case "capability":
      return explainCapability(input, input.question);
    case "context_read":
      return explainContextRead(input, input.question);
    case "conversation_delivery":
      return explainConversationDelivery(input, input.question);
    case "tool_effect":
      return explainToolEffect(input, input.question);
    default:
      return assertNever(input.question);
  }
}

async function explainCapability(
  input: ExplanationInput,
  question: Variant<AccessDecisionQuestion, "capability">,
): Promise<AccessDecisionExplanation> {
  const gate = await capabilityGate(
    input,
    question.authoritySubjectRef,
    question.capabilityRef,
    question.targetRef,
  );
  if (!gate.ok) return gate.error;
  return gate.value.policyMode === "approval_required"
    ? approvalRequired(
        gate.value.grants,
        gate.value.policyMode,
        "This capability requires approval.",
      )
    : allowed(gate.value.grants, gate.value.policyMode, []);
}

async function explainContextRead(
  input: ExplanationInput,
  question: Variant<AccessDecisionQuestion, "context_read">,
): Promise<AccessDecisionExplanation> {
  const authority = await resolveCurrentAuthority(
    input,
    question.authoritySubjectRef,
  );
  if (!authority.ok) return authority.error;
  const grants = await readGrants(input.scope.database, input.organisationId);
  if (!grants.ok) return grants.error;
  const source = await resolveSource(input, question.sourceRef, grants.value);
  if (!source.ok) return source.error;
  const selected = selectActiveGrants({
    organisationId: input.organisationId,
    authority: authority.value.requestAuthority,
    grants: grants.value,
  });
  if (!selected.ok)
    return unavailable(
      "grant_selection",
      "Access grants could not be evaluated.",
      "Refresh and try again.",
    );
  const effective = sourceGrants(selected.value, source.value);
  if (effective.length === 0) {
    return denied(
      "grant_selection",
      "The selected subject has no current grant for this source.",
      "Grant access to this exact source.",
    );
  }
  const policy = await currentPolicyMode(
    input.scope.database,
    input.organisationId,
    source.value.capabilityId,
    source.value.capabilityVersion,
  );
  if (!policy.ok) return policy.error;
  if (policy.value === "disabled") {
    return denied(
      "organisation_policy",
      "The source capability is disabled.",
      "Enable the capability before reading this source.",
    );
  }
  const currentCase = await resolveCaseReference(
    input,
    question.caseRef.caseRefId,
    question.caseRef.revision,
  );
  if (!currentCase.ok) return explainCaseReferenceFailure(currentCase.error);
  const admission = await decideContextAdmission({
    subject: {
      kind: "authority_derived",
      requestAuthority: authority.value.requestAuthority,
      caseId: currentCase.value,
    },
    inputLabel: source.value.label,
  });
  if (admission.kind === "deny") {
    return denied(
      "context_admission",
      "The source policy does not admit this subject and Case.",
      "Choose an admitted Case or update the source grant.",
    );
  }
  return policy.value === "approval_required"
    ? approvalRequired(
        effective,
        policy.value,
        "Reading this source requires approval.",
      )
    : allowed(
        effective,
        policy.value,
        flowReaderPresentations(source.value.label),
      );
}

async function explainConversationDelivery(
  input: ExplanationInput,
  question: Variant<AccessDecisionQuestion, "conversation_delivery">,
): Promise<AccessDecisionExplanation> {
  const destination = await resolveDestinationAuthority(
    input,
    question.destination,
  );
  if (!destination.ok) return destination.error;
  const sourceAuthority = await resolveCurrentAuthority(
    input,
    question.authoritySubjectRef,
  );
  if (!sourceAuthority.ok) return sourceAuthority.error;
  const grants = await readGrants(input.scope.database, input.organisationId);
  if (!grants.ok) return grants.error;
  const sources = await resolveSources(
    input,
    question.sourceRefs,
    grants.value,
  );
  if (!sources.ok) return sources.error;
  const joined = await joinedSourceLabel(sources.value);
  if (!joined.ok) return joined.error;
  const decision = evaluateFlowLabelSink({
    flowLabel: joined.value,
    organisationAuthz: null,
    sink: {
      kind: "conversation_delivery",
      destinationAuthority: destination.value.requestAuthority,
    },
  });
  // Only a tool effect can need an approval, so a delivery is allowed or denied.
  if (decision.kind !== "allow")
    return denied(
      "flow_sink",
      "The combined source policy forbids this destination.",
      "Choose a permitted destination or change the source grants.",
    );
  return allowedRefs(
    sourceEffectiveGrantRefs(grants.value, sources.value),
    "enabled",
    flowReaderPresentations(joined.value),
  );
}

async function explainToolEffect(
  input: ExplanationInput,
  question: Variant<AccessDecisionQuestion, "tool_effect">,
): Promise<AccessDecisionExplanation> {
  const gate = await capabilityGate(
    input,
    question.authoritySubjectRef,
    question.capabilityRef,
    question.targetRef,
  );
  if (!gate.ok) return gate.error;
  const allGrants = await readGrants(
    input.scope.database,
    input.organisationId,
  );
  if (!allGrants.ok) return allGrants.error;
  const sources = await resolveSources(
    input,
    question.sourceRefs,
    allGrants.value,
  );
  if (!sources.ok) return sources.error;
  const joined = await joinedSourceLabel(sources.value);
  if (!joined.ok) return joined.error;
  const sinkTarget = toolEffectTarget(gate.value.target);
  if (sinkTarget === null) {
    return denied(
      "resource_lifecycle",
      "The selected target cannot receive a tool effect.",
      "Choose an effect-capable target.",
    );
  }
  const approvalSatisfied = question.approvalState.kind === "approved";
  const check = await currentFlowSinkCheck({
    db: input.scope.database,
    flowLabel: joined.value,
    sink: {
      kind: "tool_effect",
      destinationAuthority: gate.value.authority.requestAuthority,
      capabilityId: question.capabilityRef.capabilityId,
      integrationAccountId: sinkTarget.integrationAccountId,
      resourceScope: sinkTarget.resourceScope,
      approvalSatisfied,
    },
  });
  if (!check.ok)
    return unavailable(
      "organisation_policy",
      "The organisation policy could not be read.",
      "Retry the check.",
    );
  const flowDecision = evaluateFlowLabelSink(check.value);
  if (flowDecision.kind === "deny") {
    return denied(
      "flow_sink",
      "The combined source policy forbids this effect.",
      "Choose a permitted target or change the source grants.",
    );
  }
  if (
    gate.value.policyMode === "approval_required" ||
    flowDecision.kind === "approval_required"
  ) {
    if (!approvalSatisfied) {
      return approvalRequired(
        gate.value.grants,
        gate.value.policyMode,
        "This effect requires a current approval.",
      );
    }
  }
  const credential = await credentialIsAdmissible(
    input.customConnectorAccount,
    input.scope.database,
    input.organisationId,
    gate.value.target,
  );
  if (!credential.ok) return credential.error;
  return allowed(
    gate.value.grants,
    gate.value.policyMode,
    flowReaderPresentations(joined.value),
  );
}

async function capabilityGate(
  input: ExplanationInput,
  subjectRef: AccessSubjectRef,
  capabilityRef: Readonly<{ capabilityId: string; capabilityVersion: number }>,
  targetRef: Readonly<{ targetRefId: string; revision: number }>,
): Promise<Result<CapabilityGatePermit, ExplanationFailure>> {
  const authority = await resolveCurrentAuthority(input, subjectRef);
  if (!authority.ok) return authority;
  const allGrants = await readGrants(
    input.scope.database,
    input.organisationId,
  );
  if (!allGrants.ok) return allGrants;
  const target = await resolveTarget(
    input.organisationId,
    targetRef,
    allGrants.value,
  );
  if (!target.ok) return target;
  if (
    target.value.capabilityId !== capabilityRef.capabilityId ||
    target.value.capabilityVersion !== capabilityRef.capabilityVersion
  ) {
    return {
      ok: false,
      error: denied(
        "grant_selection",
        "The capability and target do not match.",
        "Choose a compatible target.",
      ),
    };
  }
  const selected = selectActiveGrants({
    organisationId: input.organisationId,
    authority: authority.value.requestAuthority,
    grants: allGrants.value,
  });
  if (!selected.ok) {
    return {
      ok: false,
      error: unavailable(
        "grant_selection",
        "Access grants could not be evaluated.",
        "Refresh and try again.",
      ),
    };
  }
  const effective = exactTargetGrants(selected.value, target.value);
  if (effective.length === 0) {
    return {
      ok: false,
      error: denied(
        "grant_selection",
        "The selected subject has no current grant for this target.",
        "Create an exact grant for this subject and target.",
      ),
    };
  }
  const policy = await currentPolicyMode(
    input.scope.database,
    input.organisationId,
    capabilityRef.capabilityId,
    capabilityRef.capabilityVersion,
  );
  if (!policy.ok) return policy;
  if (policy.value === "disabled") {
    return {
      ok: false,
      error: denied(
        "organisation_policy",
        "The capability is disabled.",
        "Enable the capability before using this grant.",
      ),
    };
  }
  const available = await targetIsAvailable(
    input.customConnectorAccount,
    input.scope.database,
    input.organisationId,
    target.value,
  );
  if (!available.ok) return available;
  return {
    ok: true,
    value: {
      authority: authority.value,
      target: target.value,
      grants: effective,
      policyMode: policy.value,
    },
  };
}

async function resolveCurrentAuthority(
  input: ExplanationInput,
  ref: AccessSubjectRef,
): Promise<Result<ResolvedAuthority, ExplanationFailure>> {
  const subject = await resolveSubjectReference(
    input.scope.database,
    input.organisationId,
    ref,
  );
  if (!subject.ok) return subject;
  const authority = await deriveRequestAuthority(input, subject.value);
  if (!authority.ok) return authority;
  const live = await validateNativeRequestAuthority({
    db: input.scope.database,
    authority: authority.value,
  });
  if (!live.ok) {
    return {
      ok: false,
      error:
        live.error.code === "request_authority_inactive"
          ? denied(
              "membership",
              "The selected subject is no longer active.",
              "Choose a current subject.",
            )
          : unavailable(
              "membership",
              "Current subject authority is unavailable.",
              "Refresh and try again.",
            ),
    };
  }
  return {
    ok: true,
    value: { subject: subject.value, requestAuthority: authority.value },
  };
}

async function resolveSubjectReference(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  ref: AccessSubjectRef,
): Promise<Result<GrantSubject, ExplanationFailure>> {
  try {
    const rows = await db
      .prepare(subjectReferenceSql())
      .bind(
        organisationId,
        organisationId,
        organisationId,
        organisationId,
        organisationId,
        organisationId,
        SUBJECT_RESOLUTION_LIMIT + 1,
      )
      .all<Record<string, unknown>>();
    if ((rows.results?.length ?? 0) > SUBJECT_RESOLUTION_LIMIT) {
      return {
        ok: false,
        error: unavailable(
          "membership",
          "The subject directory is too large to resolve safely.",
          "Use a narrower subject search.",
        ),
      };
    }
    for (const row of rows.results ?? []) {
      const candidate = parseSubjectReferenceRow(row);
      if (candidate === null || candidate.revision !== ref.revision) continue;
      if (
        (await opaqueSubjectReference(organisationId, candidate)) !==
        ref.subjectRefId
      )
        continue;
      const subject = grantSubjectFromReferenceInput(candidate);
      return subject.ok
        ? { ok: true, value: subject.value }
        : {
            ok: false,
            error: unavailable(
              "membership",
              "The subject reference is invalid.",
              "Choose the subject again.",
            ),
          };
    }
    return {
      ok: false,
      error: unavailable(
        "membership",
        "The subject reference is stale or unavailable.",
        "Choose a current subject.",
      ),
    };
  } catch {
    return {
      ok: false,
      error: unavailable(
        "membership",
        "The subject directory is unavailable.",
        "Refresh and try again.",
      ),
    };
  }
}

async function deriveRequestAuthority(
  input: ExplanationInput,
  subject: GrantSubject,
): Promise<Result<RequestAuthority, ExplanationFailure>> {
  switch (subject.kind) {
    case "organisation_role":
      return controlAuthorityForRole(
        input.scope.database,
        input.organisationId,
        subject.role,
      );
    case "person":
      return controlAuthorityForPerson(
        input.scope.database,
        input.organisationId,
        subject.personId,
      );
    case "conversation": {
      const integrationAccountId = parseIntegrationAccountId(
        subject.integrationAccountId,
      );
      const connectorId = parseConnectorId(
        `connector_slack_${subject.integrationAccountId}`,
      );
      if (!integrationAccountId.ok || !connectorId.ok) {
        return {
          ok: false,
          error: unavailable(
            "membership",
            "Conversation authority is unavailable.",
            "Choose a current conversation.",
          ),
        };
      }
      const revision = await readOrganisationConfigurationVersion(
        input.scope.database,
        input.organisationId,
      );
      if (revision === null) {
        return {
          ok: false,
          error: unavailable(
            "membership",
            "Membership state is unavailable.",
            "Refresh and try again.",
          ),
        };
      }
      return {
        ok: true,
        value: buildSharedSlackAuthority({
          organisationId: input.organisationId,
          requesterPersonId: input.requesterMembership.personId,
          membershipRevision: revision,
          role: input.requesterMembership.role,
          connectorId: connectorId.value,
          integrationAccountId: integrationAccountId.value,
          conversationId: subject.conversationId,
        }).requestAuthority,
      };
    }
    case "workflow":
      return {
        ok: true,
        value: buildWorkflowAuthority({
          organisationId: input.organisationId,
          workflowId: subject.workflowId,
          workflowRevision: subject.workflowRevision,
        }).requestAuthority,
      };
    case "agent_mailbox":
      return agentMailboxAuthority(
        input.scope.database,
        input.organisationId,
        subject,
      );
    case "whatsapp_support":
      return whatsappSupportAuthority(
        input.scope.database,
        input.organisationId,
        subject,
      );
    default:
      return assertNever(subject);
  }
}

async function controlAuthorityForRole(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  role: string,
): Promise<Result<RequestAuthority, ExplanationFailure>> {
  const row = await db
    .prepare(
      `SELECT membership.person_id AS personId,
            membership.user_id AS userId,
            onboarding.configuration_version AS membershipRevision
       FROM service_role_grant AS membership
       JOIN organisation_onboarding AS onboarding ON onboarding.organisation_id = membership.organisation_id
      WHERE membership.organisation_id = ? AND membership.role = ? AND membership.status = 'active'
      ORDER BY membership.user_id
      LIMIT 1`,
    )
    .bind(organisationId, role)
    .first<Record<string, unknown>>();
  return controlAuthorityFromRow(organisationId, role, row);
}

async function controlAuthorityForPerson(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  personIdRaw: string,
): Promise<Result<RequestAuthority, ExplanationFailure>> {
  const row = await db
    .prepare(
      `SELECT membership.person_id AS personId,
            membership.user_id AS userId,
            membership.role,
            onboarding.configuration_version AS membershipRevision
       FROM service_role_grant AS membership
       JOIN organisation_onboarding AS onboarding ON onboarding.organisation_id = membership.organisation_id
      WHERE membership.organisation_id = ? AND membership.person_id = ? AND membership.status = 'active'
      LIMIT 1`,
    )
    .bind(organisationId, personIdRaw)
    .first<Record<string, unknown>>();
  return typeof row?.role === "string"
    ? controlAuthorityFromRow(organisationId, row.role, row)
    : {
        ok: false,
        error: denied(
          "membership",
          "The selected member is no longer active.",
          "Choose a current member.",
        ),
      };
}

function controlAuthorityFromRow(
  organisationId: OrganisationId,
  role: string,
  row: Record<string, unknown> | null,
): Result<RequestAuthority, ExplanationFailure> {
  const personId = parsePersonId(
    typeof row?.personId === "string" ? row.personId : "",
  );
  const userId = parseUserId(typeof row?.userId === "string" ? row.userId : "");
  if (
    !personId.ok ||
    !userId.ok ||
    !isPositiveInteger(row?.membershipRevision)
  ) {
    return {
      ok: false,
      error: denied(
        "membership",
        "No active member represents this subject.",
        "Choose a current member or role.",
      ),
    };
  }
  return {
    ok: true,
    value: buildControlAuthority({
      organisationId,
      requesterPersonId: personId.value,
      userId: userId.value,
      membershipRevision: row.membershipRevision,
      role,
    }).requestAuthority,
  };
}

async function agentMailboxAuthority(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  subject: Variant<GrantSubject, "agent_mailbox">,
): Promise<Result<RequestAuthority, ExplanationFailure>> {
  const integrationAccountId = parseIntegrationAccountId(
    subject.integrationAccountId,
  );
  if (!integrationAccountId.ok) return invalidSubjectAuthority();
  const row = await db
    .prepare(
      `SELECT current_version AS policyVersion FROM mailbox_ingress_policy
      WHERE organisation_id = ? AND integration_account_id = ?`,
    )
    .bind(organisationId, integrationAccountId.value)
    .first<{ policyVersion: unknown }>();
  if (!isPositiveInteger(row?.policyVersion)) return invalidSubjectAuthority();
  return {
    ok: true,
    value: buildAgentMailboxAuthority({
      organisationId,
      integrationAccountId: integrationAccountId.value,
      mailboxBindingId: subject.mailboxBindingId,
      bindingRevision: subject.bindingRevision,
      mailboxPolicyVersion: row.policyVersion,
    }).requestAuthority,
  };
}

async function whatsappSupportAuthority(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  subject: Variant<GrantSubject, "whatsapp_support">,
): Promise<Result<RequestAuthority, ExplanationFailure>> {
  const integrationAccountId = parseIntegrationAccountId(
    subject.integrationAccountId,
  );
  if (!integrationAccountId.ok) return invalidSubjectAuthority();
  const row = await db
    .prepare(
      `SELECT current_version AS policyVersion FROM whatsapp_ingress_policy
      WHERE organisation_id = ? AND integration_account_id = ?`,
    )
    .bind(organisationId, integrationAccountId.value)
    .first<{ policyVersion: unknown }>();
  if (!isPositiveInteger(row?.policyVersion)) return invalidSubjectAuthority();
  return {
    ok: true,
    value: buildWhatsAppSupportAuthority({
      organisationId,
      integrationAccountId: integrationAccountId.value,
      supportBindingId: subject.supportBindingId,
      bindingRevision: subject.bindingRevision,
      ingressPolicyVersion: row.policyVersion,
    }).requestAuthority,
  };
}

async function resolveDestinationAuthority(
  input: ExplanationInput,
  destination: FlowDestinationRef,
): Promise<Result<ResolvedDeliveryAuthority, ExplanationFailure>> {
  const ref: AccessSubjectRef =
    destination.kind === "conversation"
      ? {
          subjectRefId: destination.conversationRefId,
          revision: destination.revision,
        }
      : {
          subjectRefId: destination.workflowRefId,
          revision: destination.revision,
        };
  const resolved = await resolveCurrentAuthority(input, ref);
  if (!resolved.ok) return resolved;
  if (
    destination.kind === "conversation" &&
    resolved.value.subject.kind !== "conversation"
  ) {
    return {
      ok: false,
      error: denied(
        "resource_lifecycle",
        "The destination is not a conversation.",
        "Choose a conversation destination.",
      ),
    };
  }
  if (
    destination.kind === "workflow" &&
    resolved.value.subject.kind !== "workflow"
  ) {
    return {
      ok: false,
      error: denied(
        "resource_lifecycle",
        "The destination is not a workflow.",
        "Choose a workflow destination.",
      ),
    };
  }
  if (
    resolved.value.requestAuthority.kind !== "direct_conversation" &&
    resolved.value.requestAuthority.kind !== "shared_conversation" &&
    resolved.value.requestAuthority.kind !== "workflow"
  ) {
    return {
      ok: false,
      error: denied(
        "resource_lifecycle",
        "The destination cannot receive this delivery.",
        "Choose a conversation or workflow.",
      ),
    };
  }
  return {
    ok: true,
    value: {
      subject: resolved.value.subject,
      requestAuthority: resolved.value.requestAuthority,
    },
  };
}

async function resolveTarget(
  organisationId: OrganisationId,
  ref: Readonly<{ targetRefId: string; revision: number }>,
  grants: readonly AccessGrant[],
): Promise<Result<AccessGrantTarget, ExplanationFailure>> {
  for (const grant of grants) {
    if (grant.lifecycle.revision !== ref.revision) continue;
    if (
      (await opaqueAccessTargetReference(organisationId, grant.target)) ===
      ref.targetRefId
    ) {
      return { ok: true, value: grant.target };
    }
  }
  return {
    ok: false,
    error: unavailable(
      "resource_lifecycle",
      "The target reference is stale or unavailable.",
      "Choose a current target.",
    ),
  };
}

async function resolveSources(
  input: ExplanationInput,
  refs: readonly InformationSourceRef[],
  grants: readonly AccessGrant[],
): Promise<Result<readonly ResolvedSource[], ExplanationFailure>> {
  const resolved: ResolvedSource[] = [];
  for (const ref of refs) {
    const source = await resolveSource(input, ref, grants);
    if (!source.ok) return source;
    resolved.push(source.value);
  }
  return { ok: true, value: resolved };
}

async function resolveSource(
  input: ExplanationInput,
  ref: InformationSourceRef,
  grants: readonly AccessGrant[],
): Promise<Result<ResolvedSource, ExplanationFailure>> {
  const groups = await sourceGroups(
    input.scope.database,
    input.organisationId,
    grants,
  );
  if (!groups.ok) return groups;
  for (const group of groups.value) {
    if (
      group.sourceRefId !== ref.sourceRefId ||
      group.revision !== ref.revision
    )
      continue;
    const label = await createCurrentSourceFlowLabel({
      kind: "integration_resource",
      db: input.scope.database,
      organisationId: input.organisationId,
      integrationAccountId: group.integrationAccountId,
      capabilityId: group.capabilityId,
      resourceScope: group.resourceScope,
      grantIds: group.grantIds,
    });
    if (!label.ok)
      return { ok: false, error: sourceLabelFailure(label.error.code) };
    return { ok: true, value: { ...group, label: label.value } };
  }
  return {
    ok: false,
    error: unavailable(
      "resource_lifecycle",
      "The source reference is stale or unavailable.",
      "Choose a current source.",
    ),
  };
}

async function sourceGroups(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  grants: readonly AccessGrant[],
): Promise<Result<readonly SourceGroup[], ExplanationFailure>> {
  let commerceIntegrationAccountId: IntegrationAccountId | null = null;
  if (grants.some(isCommerceReadGrant)) {
    const commerce = await resolveOrganisationCommerceSystemAuthority({
      db,
      organisationId,
    });
    if (!commerce.ok) {
      return {
        ok: false,
        error: unavailable(
          "resource_lifecycle",
          "The commerce source is unavailable.",
          "Reconnect the commerce system.",
        ),
      };
    }
    commerceIntegrationAccountId = commerce.value.integrationAccountId;
  }
  const groups = new Map<
    string,
    {
      integrationAccountId: IntegrationAccountId;
      capabilityId: string;
      capabilityVersion: number;
      resourceScope: string;
      grantIds: string[];
      revision: number;
    }
  >();
  for (const grant of grants) {
    if (
      grant.lifecycle.kind !== "active" ||
      !capabilityIsRead(
        grant.target.capabilityId,
        grant.target.capabilityVersion,
      )
    )
      continue;
    const scope = integrationResourceScopeForGrant(grant);
    if (scope === null) continue;
    const integrationAccountId = sourceIntegrationAccountId(
      grant,
      commerceIntegrationAccountId,
    );
    if (integrationAccountId === null) continue;
    const key = JSON.stringify([
      integrationAccountId,
      grant.target.capabilityId,
      grant.target.capabilityVersion,
      scope,
    ]);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        integrationAccountId,
        capabilityId: grant.target.capabilityId,
        capabilityVersion: grant.target.capabilityVersion,
        resourceScope: scope,
        grantIds: [grant.grantId],
        revision: grant.lifecycle.revision,
      });
      continue;
    }
    existing.grantIds.push(grant.grantId);
    existing.revision = Math.max(existing.revision, grant.lifecycle.revision);
  }
  const resolved: SourceGroup[] = [];
  for (const group of groups.values()) {
    const sourceRefId = await opaqueInformationSourceReference(organisationId, {
      integrationAccountId: group.integrationAccountId,
      capabilityId: group.capabilityId,
      capabilityVersion: group.capabilityVersion,
      resourceScope: group.resourceScope,
    });
    resolved.push({ sourceRefId, ...group });
  }
  return { ok: true, value: resolved };
}

async function joinedSourceLabel(
  sources: readonly ResolvedSource[],
): Promise<Result<FlowLabel, ExplanationFailure>> {
  let joined = await emptyFlowLabel();
  for (const source of sources) {
    const next = await joinFlowLabels(joined, source.label);
    if (!next.ok) {
      return {
        ok: false,
        error: unavailable(
          "flow_sink",
          "Source policies could not be combined.",
          "Refresh and try again.",
        ),
      };
    }
    joined = next.value;
  }
  return { ok: true, value: joined };
}

async function currentPolicyMode(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  capabilityId: string,
  capabilityVersion: number,
): Promise<Result<CapabilityMode, ExplanationFailure>> {
  const policies = await readOrganisationCapabilityPolicies({
    db,
    organisationId,
  });
  if (!policies.ok) {
    return {
      ok: false,
      error: unavailable(
        "organisation_policy",
        "Capability policy is unavailable.",
        "Refresh and try again.",
      ),
    };
  }
  for (const policy of policies.value) {
    if (
      policy.capabilityId === capabilityId &&
      policy.capabilityVersion === capabilityVersion
    ) {
      return { ok: true, value: policy.mode };
    }
  }
  return {
    ok: false,
    error: unavailable(
      "organisation_policy",
      "Capability policy is unavailable.",
      "Choose a current capability.",
    ),
  };
}

async function targetIsAvailable(
  resolveActiveCustomConnectorAccount: CustomConnectorAccountRead,
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  target: AccessGrantTarget,
): Promise<Result<true, ExplanationFailure>> {
  switch (target.kind) {
    case "platform_capability":
      return { ok: true, value: true };
    case "provider_resource":
    case "file_resource": {
      const integrationAccountId = parseIntegrationAccountId(
        target.integrationAccountId,
      );
      if (!integrationAccountId.ok) return invalidTargetAvailability();
      const account = await resolveIntegrationAccount({
        db,
        organisationId,
        integrationAccountId: integrationAccountId.value,
      });
      return account.ok && account.value.lifecycle.kind === "active"
        ? { ok: true, value: true }
        : invalidTargetAvailability();
    }
    case "custom_connector_operation": {
      const integrationAccountId = parseIntegrationAccountId(
        target.integrationAccountId,
      );
      if (!integrationAccountId.ok) return invalidTargetAvailability();
      const account = await resolveActiveCustomConnectorAccount({
        db,
        organisationId,
        integrationAccountId: integrationAccountId.value,
      });
      return account.ok &&
        account.value.source.connectorId === target.connectorId &&
        account.value.binding.acceptedRevision === target.definitionRevision &&
        account.value.binding.definitionDigest === target.definitionDigest
        ? { ok: true, value: true }
        : invalidTargetAvailability();
    }
    case "commerce_read":
    case "commerce_command": {
      const commerce = await resolveOrganisationCommerceSystemAuthority({
        db,
        organisationId,
      });
      return commerce.ok
        ? { ok: true, value: true }
        : invalidTargetAvailability();
    }
    default:
      return assertNever(target);
  }
}

async function credentialIsAdmissible(
  resolveActiveCustomConnectorAccount: CustomConnectorAccountRead,
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  target: AccessGrantTarget,
): Promise<Result<true, ExplanationFailure>> {
  switch (target.kind) {
    case "platform_capability":
      return { ok: true, value: true };
    case "provider_resource":
    case "file_resource": {
      const integrationAccountId = parseIntegrationAccountId(
        target.integrationAccountId,
      );
      if (!integrationAccountId.ok) return credentialUnavailable();
      const row = await db
        .prepare(
          `SELECT 1 AS present
           FROM integration_account AS account
           JOIN provider_connection AS connection
             ON connection.provider_connection_id = account.provider_connection_id
            AND connection.organisation_id = account.organisation_id
            AND connection.provider = account.provider
            AND connection.environment = account.environment
           JOIN provider_credential_generation AS generation
             ON generation.provider_connection_id = connection.provider_connection_id
            AND generation.credential_generation = connection.credential_generation
            AND generation.organisation_id = connection.organisation_id
            AND generation.provider = connection.provider
            AND generation.environment = connection.environment
            AND generation.credential_ref = connection.credential_ref
          WHERE account.organisation_id = ? AND account.integration_account_id = ?
            AND account.lifecycle = 'active' AND connection.lifecycle = 'active'
            AND generation.lifecycle = 'active'
          LIMIT 1`,
        )
        .bind(organisationId, integrationAccountId.value)
        .first<{ present: unknown }>();
      return row?.present === 1
        ? { ok: true, value: true }
        : credentialUnavailable();
    }
    case "custom_connector_operation": {
      const integrationAccountId = parseIntegrationAccountId(
        target.integrationAccountId,
      );
      if (!integrationAccountId.ok) return credentialUnavailable();
      const account = await resolveActiveCustomConnectorAccount({
        db,
        organisationId,
        integrationAccountId: integrationAccountId.value,
      });
      return account.ok &&
        account.value.source.connectorId === target.connectorId &&
        account.value.binding.acceptedRevision === target.definitionRevision &&
        account.value.binding.definitionDigest === target.definitionDigest
        ? { ok: true, value: true }
        : credentialUnavailable();
    }
    case "commerce_read":
    case "commerce_command": {
      const commerce = await resolveOrganisationCommerceSystemAuthority({
        db,
        organisationId,
      });
      if (!commerce.ok) return credentialUnavailable();
      switch (commerce.value.provider) {
        case "shopify": {
          const account = await resolveActiveProviderAccountContext({
            db,
            organisationId,
            integrationAccountId: commerce.value.integrationAccountId,
          });
          return account.ok && account.value.account.provider === "shopify"
            ? { ok: true, value: true }
            : credentialUnavailable();
        }
        case "commerce": {
          const binding = await resolveCommerceMerchantBinding({
            db,
            organisationId,
            integrationAccountId: commerce.value.integrationAccountId,
          });
          return binding.ok
            ? { ok: true, value: true }
            : credentialUnavailable();
        }
        default:
          return assertNever(commerce.value.provider);
      }
    }
    default:
      return assertNever(target);
  }
}

function explainCaseReferenceFailure(
  error: CaseReferenceError,
): ExplanationFailure {
  switch (error) {
    case "case_reference_unavailable":
      return unavailable(
        "context_admission",
        "Current Cases are unavailable.",
        "Refresh and try again.",
      );
    case "case_reference_stale":
      return unavailable(
        "context_admission",
        "The Case reference is stale.",
        "Refresh the Case and try again.",
      );
    default:
      return assertNever(error);
  }
}

async function readGrants(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<Result<readonly AccessGrant[], ExplanationFailure>> {
  const grants = await listAccessGrants({ db, organisationId });
  return grants.ok
    ? grants
    : {
        ok: false,
        error: unavailable(
          "grant_selection",
          "Access grants are unavailable.",
          "Refresh and try again.",
        ),
      };
}

function exactTargetGrants(
  grants: readonly AccessGrant[],
  target: AccessGrantTarget,
): readonly AccessGrant[] {
  const serialized = JSON.stringify(target);
  const matching: AccessGrant[] = [];
  for (const grant of grants) {
    if (JSON.stringify(grant.target) === serialized) matching.push(grant);
  }
  return matching;
}

function sourceGrants(
  grants: readonly AccessGrant[],
  source: SourceGroup,
): readonly AccessGrant[] {
  const grantIds = new Set(source.grantIds);
  const matching: AccessGrant[] = [];
  for (const grant of grants) {
    if (grantIds.has(grant.grantId)) matching.push(grant);
  }
  return matching;
}

function sourceEffectiveGrantRefs(
  grants: readonly AccessGrant[],
  sources: readonly SourceGroup[],
): readonly EffectiveGrantRef[] {
  const grantIds = new Set<string>();
  for (const source of sources) {
    for (const grantId of source.grantIds) grantIds.add(grantId);
  }
  const refs: EffectiveGrantRef[] = [];
  for (const grant of grants) {
    if (grant.lifecycle.kind === "active" && grantIds.has(grant.grantId)) {
      refs.push({ grantId: grant.grantId, revision: grant.lifecycle.revision });
    }
  }
  return refs.sort(compareEffectiveGrantRefs);
}

function effectiveGrantRefs(
  grants: readonly AccessGrant[],
): readonly EffectiveGrantRef[] {
  const refs: EffectiveGrantRef[] = [];
  for (const grant of grants) {
    if (grant.lifecycle.kind === "active")
      refs.push({ grantId: grant.grantId, revision: grant.lifecycle.revision });
  }
  return refs.sort(compareEffectiveGrantRefs);
}

function allowed(
  grants: readonly AccessGrant[],
  policyMode: CapabilityMode,
  flowReaders: readonly string[],
): AccessDecisionExplanation {
  return allowedRefs(effectiveGrantRefs(grants), policyMode, flowReaders);
}

function allowedRefs(
  effectiveGrants: readonly EffectiveGrantRef[],
  policyMode: CapabilityMode,
  flowReaders: readonly string[],
): AccessDecisionExplanation {
  return {
    kind: "allowed",
    effectiveGrants: [...effectiveGrants],
    policyMode,
    flowReaders: [...flowReaders],
  };
}

function approvalRequired(
  grants: readonly AccessGrant[],
  policyMode: CapabilityMode,
  reason: string,
): AccessDecisionExplanation {
  return approvalRequiredRefs(effectiveGrantRefs(grants), policyMode, reason);
}

function approvalRequiredRefs(
  effectiveGrants: readonly EffectiveGrantRef[],
  policyMode: CapabilityMode,
  reason: string,
): AccessDecisionExplanation {
  return {
    kind: "approval_required",
    effectiveGrants: [...effectiveGrants],
    policyMode,
    reason,
  };
}

function denied(
  stage: Variant<AccessDecisionExplanation, "denied">["stage"],
  reason: string,
  remediation: string,
): Variant<AccessDecisionExplanation, "denied"> {
  return { kind: "denied", stage, reason, remediation };
}

function unavailable(
  stage: Variant<AccessDecisionExplanation, "unavailable">["stage"],
  reason: string,
  remediation: string,
): Variant<AccessDecisionExplanation, "unavailable"> {
  return { kind: "unavailable", stage, reason, remediation };
}

function sourceLabelFailure(code: string): ExplanationFailure {
  switch (code) {
    case "source_capability_disabled":
      return denied(
        "organisation_policy",
        "The source capability is disabled.",
        "Enable the source capability.",
      );
    case "source_resource_inactive":
      return unavailable(
        "resource_lifecycle",
        "The source connection is unavailable.",
        "Reconnect the source account.",
      );
    case "source_subject_inactive":
    case "source_grant_unavailable":
      return denied(
        "grant_selection",
        "A source grant is no longer current.",
        "Refresh or replace the source grant.",
      );
    default:
      return unavailable(
        "context_admission",
        "The current source policy is unavailable.",
        "Refresh and try again.",
      );
  }
}

function invalidSubjectAuthority(): Result<never, ExplanationFailure> {
  return {
    ok: false,
    error: unavailable(
      "membership",
      "The selected subject authority is unavailable.",
      "Choose a current subject.",
    ),
  };
}

function invalidTargetAvailability(): Result<never, ExplanationFailure> {
  return {
    ok: false,
    error: unavailable(
      "resource_lifecycle",
      "The selected resource is unavailable.",
      "Reconnect or choose a current resource.",
    ),
  };
}

function credentialUnavailable(): Result<never, ExplanationFailure> {
  return {
    ok: false,
    error: unavailable(
      "credential_admission",
      "The target credential is unavailable.",
      "Reconnect the target account.",
    ),
  };
}

function toolEffectTarget(target: AccessGrantTarget): Readonly<{
  integrationAccountId: string;
  resourceScope: string;
}> | null {
  switch (target.kind) {
    case "provider_resource":
      return {
        integrationAccountId: target.integrationAccountId,
        resourceScope: target.resourceScope,
      };
    case "file_resource":
      return {
        integrationAccountId: target.integrationAccountId,
        resourceScope: fileResourceScope(target.scope),
      };
    case "custom_connector_operation":
      return {
        integrationAccountId: target.integrationAccountId,
        resourceScope: [
          "custom_connector",
          target.connectorId,
          String(target.definitionRevision),
          target.definitionDigest,
          target.operationId,
        ].join(":"),
      };
    case "commerce_command":
      return {
        integrationAccountId: "commerce_system",
        resourceScope: JSON.stringify(target.scope),
      };
    case "platform_capability":
      return { integrationAccountId: "platform", resourceScope: "platform" };
    case "commerce_read":
      return null;
    default:
      return assertNever(target);
  }
}

function fileResourceScope(
  scope: FileResourceAccessGrantTarget["scope"],
): string {
  switch (scope.kind) {
    case "dropbox_folder":
      return `dropbox_folder:${scope.providerFolderId}`;
    case "dropbox_file":
      return `dropbox_file:${scope.providerFileId}`;
    case "gdrive_file":
      return `gdrive_file:${scope.providerFileId}`;
    default:
      return assertNever(scope);
  }
}

function flowReaderPresentations(label: FlowLabel): readonly string[] {
  const readers = new Set<string>();
  for (const policy of label.policies) {
    for (const reader of policy.readers)
      readers.add(flowReaderPresentation(reader));
  }
  return [...readers].sort();
}

function flowReaderPresentation(
  reader: import("../policy/information-flow").FlowAudience,
): string {
  switch (reader.kind) {
    case "project":
      return "Project members";
    case "chat_conversation":
      return "Chat participants";
    case "organisation_role":
      return "Workspace role";
    case "person":
      return "Workspace member";
    case "conversation":
      return "Slack conversation";
    case "workflow":
      return "Workflow";
    case "agent_mailbox":
      return "Agent mailbox";
    case "whatsapp_support":
      return "WhatsApp support";
    case "case":
      return "Case participants";
    default:
      return assertNever(reader);
  }
}

function subjectReferenceSql(): string {
  return `WITH subject_options AS (
    SELECT * FROM (
      SELECT 'organisation_role' AS kind, 'owner' AS firstId, NULL AS secondId, 1 AS revision
      UNION ALL SELECT 'organisation_role', 'admin', NULL, 1
      UNION ALL SELECT 'organisation_role', 'operator', NULL, 1
      UNION ALL SELECT 'organisation_role', 'viewer', NULL, 1
      UNION ALL
      SELECT 'person', person_id, NULL, 1 FROM service_role_grant
       WHERE organisation_id = ? AND status = 'active'
    )
    UNION ALL
    SELECT * FROM (
      SELECT 'conversation' AS kind, integration_account_id AS firstId,
             channel_id AS secondId, 1 AS revision
        FROM organisation_slack_channel WHERE organisation_id = ?
      UNION ALL
      SELECT 'workflow', subscription_id, NULL, version FROM cue_subscription
       WHERE organisation_id = ? AND enabled = 1
      UNION ALL
      SELECT 'workflow', binding_id, NULL, revision FROM schedule_binding
       WHERE organisation_id = ? AND enabled = 1
      UNION ALL
      SELECT 'agent_mailbox', integration_account_id, mailbox_binding_id, current_revision
        FROM agent_mailbox_binding WHERE organisation_id = ?
      UNION ALL
      SELECT 'whatsapp_support', integration_account_id, support_binding_id, current_revision
        FROM whatsapp_support_binding WHERE organisation_id = ?
    )
  )
  SELECT kind, firstId, secondId, revision
    FROM subject_options
   ORDER BY kind, firstId, secondId
   LIMIT ?`;
}

function parseSubjectReferenceRow(
  row: Record<string, unknown>,
): SubjectReferenceInput | null {
  if (
    !subjectKind(row.kind) ||
    !boundedIdentifier(row.firstId) ||
    (row.secondId !== null && !boundedIdentifier(row.secondId)) ||
    !isPositiveInteger(row.revision)
  ) {
    return null;
  }
  const requiresSecondId =
    row.kind === "conversation" ||
    row.kind === "agent_mailbox" ||
    row.kind === "whatsapp_support";
  return requiresSecondId !== (row.secondId !== null)
    ? null
    : {
        kind: row.kind,
        firstId: row.firstId,
        secondId: row.secondId,
        revision: row.revision,
      };
}

async function readOrganisationConfigurationVersion(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<number | null> {
  const row = await db
    .prepare(
      "SELECT configuration_version AS revision FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ revision: unknown }>();
  return isPositiveInteger(row?.revision) ? row.revision : null;
}

function sourceIntegrationAccountId(
  grant: AccessGrant,
  commerceIntegrationAccountId: IntegrationAccountId | null,
): IntegrationAccountId | null {
  switch (grant.target.kind) {
    case "provider_resource":
    case "file_resource": {
      const parsed = parseIntegrationAccountId(
        grant.target.integrationAccountId,
      );
      return parsed.ok ? parsed.value : null;
    }
    case "custom_connector_operation": {
      const parsed = parseIntegrationAccountId(
        grant.target.integrationAccountId,
      );
      return parsed.ok ? parsed.value : null;
    }
    case "commerce_read":
      return commerceIntegrationAccountId;
    case "platform_capability":
    case "commerce_command":
      return null;
    default:
      return assertNever(grant.target);
  }
}

function capabilityIsRead(
  capabilityId: string,
  capabilityVersion: number,
): boolean {
  for (const definition of CAPABILITY_CATALOGUE) {
    if (
      definition.capabilityId === capabilityId &&
      definition.capabilityVersion === capabilityVersion
    ) {
      return definition.risk === "read";
    }
  }
  return false;
}

function isCommerceReadGrant(grant: AccessGrant): boolean {
  return (
    grant.lifecycle.kind === "active" && grant.target.kind === "commerce_read"
  );
}

function compareEffectiveGrantRefs(
  left: EffectiveGrantRef,
  right: EffectiveGrantRef,
): number {
  return left.grantId.localeCompare(right.grantId);
}

function subjectKind(value: unknown): value is SubjectReferenceInput["kind"] {
  return (
    value === "organisation_role" ||
    value === "person" ||
    value === "conversation" ||
    value === "workflow" ||
    value === "agent_mailbox" ||
    value === "whatsapp_support"
  );
}

function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 512
  );
}

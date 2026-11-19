import type {
  CommerceEntityPlaneEffect,
  CommerceEntityTypeId,
  CommerceListEntryRef,
  CommerceRelationshipRef,
  PublishedCommerceSelector,
} from "@purin-labs/contracts";
import {
  parseCommerceEntityPlaneCommand,
  parseCommerceGraphQuery,
  parseCommerceListEntryRef,
  parseCommerceRelationshipRef,
  parsePublishedCommerceSelector,
  parseEntityPlaneCommandResult,
  type CommerceEntityPlanePublishedResourceMetadataResponse,
} from "@purin-labs/commerce-client";
import {
  parseCommerceActionAmount,
  type CommerceActionRecord,
} from "./commerce-actions.ts";
import { parseCommerceExceptionInbox } from "./commerce-operations.ts";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, isRecord, isString } from "@purin-labs/std";
import type {
  AgentSkillRef,
  CommerceExceptionInbox,
  ScheduleSpec,
  ScheduleWeekday,
} from "../index.ts";

export type AgentOperationsSnapshot = {
  readonly areas: readonly OperationalArea[];
  readonly responsibilityScopes: readonly AgentResponsibilityScopeRecord[];
  readonly definitions: readonly AgentDefinition[];
  readonly installations: readonly AgentInstallation[];
  readonly skills: readonly Skill[];
  readonly bindings: readonly SkillBinding[];
  readonly cueBindings: readonly CueBinding[];
  readonly scheduleBindings: readonly ScheduleBinding[];
  readonly governance: readonly InstallationGovernance[];
  readonly escalationPolicies: readonly EscalationPolicy[];
  readonly configurationProposals: readonly AgentConfigurationProposal[];
  readonly activeCases: readonly ActiveCaseOperationsView[];
  readonly actionLedger: readonly ActionLedgerActivity[];
  readonly commerceExceptions: CommerceExceptionInbox;
};

export type CueBinding = {
  readonly bindingId: string;
  readonly areaId: string;
  readonly scopeIds: readonly string[];
  readonly installationId: string;
  readonly cueSource: string;
  readonly cueEventType: string;
  readonly enabled: boolean;
  readonly instructionBody: string | null;
  readonly revision: number;
};

export type ScheduleBinding = {
  readonly bindingId: string;
  readonly areaId: string;
  readonly scopeIds: readonly string[];
  readonly installationId: string;
  readonly spec: ScheduleSpec;
  readonly enabled: boolean;
  readonly instructionBody: string | null;
  readonly revision: number;
};

type InstallationGovernance = {
  readonly installationId: string;
  readonly maxSessionBudgetTokens: number;
  readonly revision: number;
};

type EscalationPolicy = {
  readonly areaId: string;
  readonly scopeIds: readonly string[];
  readonly approvalReminderAfterMs: number;
  readonly escalateAfterMs: number;
  readonly escalateTo: "organisation_owner";
  readonly revision: number;
};

export type AgentConfigurationProposal = {
  readonly proposalId: string;
  readonly installationId: string;
  readonly targetKind: "agent_instructions" | "skill_markdown";
  readonly targetId: string;
  readonly expectedRevision: number;
  readonly proposedBody: string;
  readonly rationale: string;
  readonly status: "open" | "accepted" | "dismissed";
  readonly publishedRevision: number | null;
};

type ActiveCaseOperationsView = {
  readonly caseId: string;
  readonly pinnedOrganisationId: string;
  readonly purpose: string;
  readonly revision: number;
  readonly lifecycle:
    | "open"
    | "waiting"
    | "completing"
    | "completed"
    | "quarantined"
    | "archived";
  readonly assignments: readonly {
    readonly assignmentId: string;
    readonly sessionId: string;
    readonly lifecycle: "assigned" | "running" | "settled";
  }[];
  readonly outputs: { readonly pending: number; readonly settled: number };
};

export type ActionLedgerActivity = {
  readonly action: {
    readonly nonce: { readonly value: string };
    readonly host: string;
    readonly verb: string;
    readonly resourceKey: string;
    readonly amount: CommerceActionRecord["amount"];
  };
  readonly caseId: string;
  readonly proposalId: string;
  readonly state: CommerceActionRecord["state"];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly providerResult: string | null;
  readonly commerceEffect: CommerceEntityPlaneEffect | null;
};

export type OperationalArea = {
  readonly areaId: string;
  readonly name: string;
  readonly purpose: string;
  readonly lifecycle: "active" | "archived";
};

type AgentResponsibilityScope =
  | {
      readonly kind: "entity_type";
      readonly entityTypeId: CommerceEntityTypeId;
    }
  | {
      readonly kind: "relationship";
      readonly relationship: CommerceRelationshipRef;
    }
  | { readonly kind: "commerce_list"; readonly listId: string }
  | {
      readonly kind: "commerce_list_entry";
      readonly entry: CommerceListEntryRef;
    }
  | {
      readonly kind: "saved_selector";
      readonly selector: AgentSavedCommerceSelector;
    };

type AgentSavedCommerceSelector = PublishedCommerceSelector;

export type AgentPublishedResourceMetadata = Variant<
  CommerceEntityPlanePublishedResourceMetadataResponse,
  "enumerated"
>;

export type AgentOperationFormContext = Readonly<{
  readonly publishedResources: AgentPublishedResourceMetadata;
}>;

type AgentResponsibilityScopeRecord = {
  readonly scopeId: string;
  readonly organisationId: string;
  readonly areaId: string;
  readonly scope: AgentResponsibilityScope;
  readonly lifecycle: "published" | "archived";
  readonly revision: number;
  readonly publishedAt: number;
};

export type AgentDefinition = {
  readonly agentDefinitionId: string;
  readonly displayName: string;
  readonly role: string;
  readonly purpose: string;
  readonly lifecycle: "active" | "archived";
  readonly currentRevision: {
    readonly revision: number;
    readonly instructions: string;
    readonly requestedCapabilities: readonly string[];
    readonly skillRefs: readonly AgentSkillRef[];
    readonly contentDigest: string;
  };
};

export type AgentInstallation = {
  readonly installationId: string;
  readonly agentDefinitionId: string;
  readonly definitionRevision: number;
  readonly policyRevision: number;
  readonly grantedCapabilities: readonly string[];
  readonly lifecycle: "active" | "suspended" | "archived";
  readonly areaAssignments: readonly {
    readonly areaId: string;
    readonly responsibility: string;
    readonly scopeIds: readonly string[];
  }[];
};

export type Skill = {
  readonly skillId: string;
  readonly title: string;
  readonly sensitivity: "ordinary" | "sensitive";
  readonly lifecycle: "published" | "archived";
  readonly currentRevision: {
    readonly revision: number;
    readonly markdownBody: string;
    readonly contentDigest: string;
  };
};

type SkillBinding = {
  readonly bindingId: string;
  readonly targetKind: "area";
  readonly targetId: string;
  readonly skillId: string;
  readonly skillRevision: number;
};

export type AgentOperationKind =
  | "create_area"
  | "publish_responsibility_scope"
  | "create_skill"
  | "publish_skill_revision"
  | "create_agent_definition"
  | "publish_agent_definition_revision"
  | "install_agent"
  | "bind_skill"
  | "configure_cue_binding"
  | "configure_schedule_binding"
  | "update_cue_binding"
  | "update_schedule_binding"
  | "configure_installation_governance"
  | "configure_escalation_policy"
  | "accept_configuration_proposal"
  | "dismiss_configuration_proposal"
  | "dispatch_manual_run"
  | "activate_agent_definition_revision";

export type AgentOperationCommand =
  | {
      readonly kind: "create_area";
      readonly name: string;
      readonly purpose: string;
    }
  | {
      readonly kind: "publish_responsibility_scope";
      readonly areaId: string;
      readonly scope: AgentResponsibilityScope;
    }
  | {
      readonly kind: "create_skill";
      readonly title: string;
      readonly sensitivity: Skill["sensitivity"];
      readonly markdownBody: string;
    }
  | {
      readonly kind: "publish_skill_revision";
      readonly skillId: string;
      readonly expectedRevision: number;
      readonly markdownBody: string;
    }
  | {
      readonly kind: "create_agent_definition";
      readonly displayName: string;
      readonly role: string;
      readonly purpose: string;
      readonly instructions: string;
      readonly requestedCapabilities: readonly string[];
      readonly skillRefs: readonly AgentSkillRef[];
    }
  | {
      readonly kind: "publish_agent_definition_revision";
      readonly agentDefinitionId: string;
      readonly expectedRevision: number;
      readonly instructions: string;
      readonly requestedCapabilities: readonly string[];
      readonly skillRefs: readonly AgentSkillRef[];
    }
  | {
      readonly kind: "install_agent";
      readonly agentDefinitionId: string;
      readonly definitionRevision: number;
      readonly areaId: string;
      readonly responsibility: string;
      readonly scopeIds: readonly string[];
      readonly policyRevision: number;
      readonly grantedCapabilities: readonly string[];
    }
  | {
      readonly kind: "bind_skill";
      readonly targetKind: SkillBinding["targetKind"];
      readonly targetId: string;
      readonly skillId: string;
      readonly skillRevision: number;
    }
  | {
      readonly kind: "configure_cue_binding";
      readonly areaId: string;
      readonly scopeIds: readonly string[];
      readonly installationId: string;
      readonly cueSource: string;
      readonly cueEventType: string;
      readonly enabled: boolean;
      readonly instructionBody: string | null;
    }
  | {
      readonly kind: "configure_schedule_binding";
      readonly areaId: string;
      readonly scopeIds: readonly string[];
      readonly installationId: string;
      readonly spec: ScheduleSpec;
      readonly enabled: boolean;
      readonly instructionBody: string | null;
    }
  | {
      readonly kind: "update_cue_binding";
      readonly bindingId: string;
      readonly expectedRevision: number;
      readonly enabled: boolean;
      readonly instructionBody: string | null;
    }
  | {
      readonly kind: "update_schedule_binding";
      readonly bindingId: string;
      readonly expectedRevision: number;
      readonly enabled: boolean;
      readonly instructionBody: string | null;
    }
  | {
      readonly kind: "configure_installation_governance";
      readonly installationId: string;
      readonly maxSessionBudgetTokens: number;
    }
  | {
      readonly kind: "configure_escalation_policy";
      readonly areaId: string;
      readonly scopeIds: readonly string[];
      readonly approvalReminderAfterMs: number;
      readonly escalateAfterMs: number;
    }
  | {
      readonly kind: "accept_configuration_proposal";
      readonly proposalId: string;
    }
  | {
      readonly kind: "dismiss_configuration_proposal";
      readonly proposalId: string;
    }
  | {
      /**
       * Adopts a published definition revision for one installation.
       *
       * Publication records what an agent may run; activation decides what it
       * does run. New Cases pin the activated revision; Cases already assigned
       * keep the revision they recorded.
       */
      readonly kind: "activate_agent_definition_revision";
      readonly installationId: string;
      readonly expectedDefinitionRevision: number;
      readonly definitionRevision: number;
      /**
       * The ordered skill set the operator is activating. It must equal the
       * chosen revision's set exactly, so the confirmation names what will run
       * rather than trusting whatever the definition holds at execution.
       */
      readonly skillRefs: readonly AgentSkillRef[];
    }
  | {
      readonly kind: "dispatch_manual_run";
      readonly installationId: string;
      readonly instructionBody: string;
    };

type AgentOperationFormResult =
  | { readonly ok: true; readonly command: AgentOperationCommand }
  | { readonly ok: false; readonly message: string };

export type AgentRevisionTarget = {
  readonly kind: "agent_definition" | "skill";
  readonly id: string;
};

/** One historical revision of an agent's instructions or a skill's body. */
export type AgentDocumentRevision = {
  readonly revision: number;
  readonly body: string;
  readonly contentDigest: string;
  readonly createdAt: number;
};

export function parseAgentRevisionsResponse(
  target: AgentRevisionTarget,
  raw: unknown,
): readonly AgentDocumentRevision[] {
  if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.revisions)) {
    throw new Error(apiError(raw));
  }
  return raw.revisions.map((entry) => {
    if (!isRecord(entry))
      throw new Error("Revision history response is invalid.");
    const body =
      target.kind === "agent_definition"
        ? entry.instructions
        : entry.markdownBody;
    if (
      typeof entry.revision !== "number" ||
      typeof body !== "string" ||
      typeof entry.contentDigest !== "string" ||
      typeof entry.createdAt !== "number"
    ) {
      throw new Error("Revision history response is invalid.");
    }
    return {
      revision: entry.revision,
      body,
      contentDigest: entry.contentDigest,
      createdAt: entry.createdAt,
    };
  });
}

export function parseAgentOperationForm(
  kind: AgentOperationKind,
  values: FormData,
  context?: AgentOperationFormContext,
): AgentOperationFormResult {
  switch (kind) {
    case "create_area":
      return parseAreaForm(values);
    case "publish_responsibility_scope":
      return parseResponsibilityScopeForm(values, context);
    case "create_skill":
      return parseSkillForm(values);
    case "publish_skill_revision":
      return parseSkillRevisionForm(values);
    case "create_agent_definition":
      return parseAgentDefinitionForm(values);
    case "publish_agent_definition_revision":
      return parseAgentDefinitionRevisionForm(values);
    case "install_agent":
      return parseAgentInstallationForm(values);
    case "bind_skill":
      return parseSkillBindingForm(values);
    case "activate_agent_definition_revision":
      return parseActivationForm(values);
    case "configure_cue_binding":
      return parseCueBindingForm(values);
    case "configure_schedule_binding":
      return parseScheduleBindingForm(values);
    case "update_cue_binding":
      return parseBindingUpdateForm(values, "update_cue_binding");
    case "update_schedule_binding":
      return parseBindingUpdateForm(values, "update_schedule_binding");
    case "configure_installation_governance":
      return parseGovernanceForm(values);
    case "configure_escalation_policy":
      return parseEscalationForm(values);
    case "accept_configuration_proposal":
      return parseProposalDecisionForm(values, "accept_configuration_proposal");
    case "dismiss_configuration_proposal":
      return parseProposalDecisionForm(
        values,
        "dismiss_configuration_proposal",
      );
    case "dispatch_manual_run":
      return parseManualRunForm(values);
    default:
      return assertNever(kind, "Unhandled agent operation value");
  }
}

export function parseAgentOperationsResponse(
  raw: unknown,
): AgentOperationsSnapshot {
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    !isRecord(raw.operations) ||
    !Array.isArray(raw.operations.areas) ||
    !Array.isArray(raw.operations.definitions) ||
    !Array.isArray(raw.operations.responsibilityScopes) ||
    !Array.isArray(raw.operations.installations) ||
    !Array.isArray(raw.operations.skills) ||
    !Array.isArray(raw.operations.bindings) ||
    !Array.isArray(raw.operations.activeCases) ||
    !Array.isArray(raw.operations.actionLedger) ||
    raw.operations.commerceExceptions === undefined ||
    !Array.isArray(raw.operations.cueBindings) ||
    !Array.isArray(raw.operations.scheduleBindings) ||
    !Array.isArray(raw.operations.governance) ||
    !Array.isArray(raw.operations.escalationPolicies) ||
    !Array.isArray(raw.operations.configurationProposals)
  ) {
    throw new Error(apiError(raw));
  }
  return {
    areas: raw.operations.areas.map(parseArea),
    responsibilityScopes: raw.operations.responsibilityScopes.map(
      parseResponsibilityScopeRecord,
    ),
    definitions: raw.operations.definitions.map(parseDefinition),
    installations: raw.operations.installations.map(parseInstallation),
    skills: raw.operations.skills.map(parseSkill),
    bindings: raw.operations.bindings.map(parseBinding),
    cueBindings: raw.operations.cueBindings.map(parseCueBinding),
    scheduleBindings: raw.operations.scheduleBindings.map(parseScheduleBinding),
    governance: raw.operations.governance.map(parseGovernance),
    escalationPolicies: raw.operations.escalationPolicies.map(
      parseEscalationPolicy,
    ),
    configurationProposals: raw.operations.configurationProposals.map(
      parseConfigurationProposal,
    ),
    activeCases: raw.operations.activeCases.map(parseActiveCase),
    actionLedger: raw.operations.actionLedger.map(parseActionLedgerActivity),
    commerceExceptions: parseCommerceExceptionInbox(
      raw.operations.commerceExceptions,
    ),
  };
}

function parseAreaForm(values: FormData): AgentOperationFormResult {
  const name = formText(values, "name");
  const purpose = formText(values, "purpose");
  if (name === null || purpose === null) return invalidForm();
  return { ok: true, command: { kind: "create_area", name, purpose } };
}

function parseResponsibilityScopeForm(
  values: FormData,
  context: AgentOperationFormContext | undefined,
): AgentOperationFormResult {
  const areaId = formText(values, "areaId");
  const resourceKey = formText(values, "resourceKey");
  if (areaId === null || resourceKey === null || context === undefined)
    return invalidForm();
  const resource = publishedResponsibilityResource(
    context.publishedResources,
    resourceKey,
  );
  if (resource === null) return invalidForm();
  switch (resource.kind) {
    case "entity_type":
      return {
        ok: true,
        command: {
          kind: "publish_responsibility_scope",
          areaId,
          scope: resource,
        },
      };
    case "commerce_list":
      return {
        ok: true,
        command: {
          kind: "publish_responsibility_scope",
          areaId,
          scope: resource,
        },
      };
    case "saved_selector":
      return {
        ok: true,
        command: {
          kind: "publish_responsibility_scope",
          areaId,
          scope: {
            kind: resource.kind,
            selector: buildPublishedSelector(resource.view),
          },
        },
      };
    default:
      return assertNever(resource, "Unhandled agent operation value");
  }
}

type AuthorableResponsibilityResource =
  | Variant<AgentResponsibilityScope, "entity_type">
  | Variant<AgentResponsibilityScope, "commerce_list">
  | Readonly<{
      kind: "saved_selector";
      view: AgentPublishedResourceMetadata["views"][number];
    }>;

function publishedResponsibilityResource(
  metadata: AgentPublishedResourceMetadata,
  resourceKey: string,
): AuthorableResponsibilityResource | null {
  if (resourceKey.startsWith("entity_type:system:")) {
    const typeId = resourceKey.slice("entity_type:system:".length);
    const entityType = metadata.entityTypes.find(
      (candidate) =>
        candidate.origin === "system" && String(candidate.typeId) === typeId,
    );
    return entityType === undefined
      ? null
      : {
          kind: "entity_type",
          entityTypeId: parseResponsibilityEntityTypeId({
            origin: "system",
            typeId: entityType.typeId,
          }),
        };
  }
  if (resourceKey.startsWith("entity_type:custom:")) {
    const typeId = resourceKey.slice("entity_type:custom:".length);
    const entityType = metadata.entityTypes.find(
      (candidate) =>
        candidate.origin === "custom" && String(candidate.typeId) === typeId,
    );
    return entityType === undefined
      ? null
      : {
          kind: "entity_type",
          entityTypeId: parseResponsibilityEntityTypeId({
            origin: "custom",
            typeId: entityType.typeId,
          }),
        };
  }
  if (resourceKey.startsWith("commerce_list:")) {
    const listId = resourceKey.slice("commerce_list:".length);
    const list = metadata.lists.find(
      (candidate) => String(candidate.listId) === listId,
    );
    return list === undefined
      ? null
      : { kind: "commerce_list", listId: String(list.listId) };
  }
  if (resourceKey.startsWith("saved_selector:")) {
    const viewId = resourceKey.slice("saved_selector:".length);
    const view = metadata.views.find(
      (candidate) => String(candidate.viewId) === viewId,
    );
    return view === undefined ? null : { kind: "saved_selector", view };
  }
  return null;
}

function buildPublishedSelector(
  view: AgentPublishedResourceMetadata["views"][number],
): AgentSavedCommerceSelector {
  const query = parseCommerceGraphQuery({
    kind: "saved_commerce_view",
    viewId: view.viewId,
    pagination: { limit: 50, cursor: null },
  });
  return parseSavedResponsibilitySelector({
    selectorId: view.viewId,
    revision: view.revision,
    query,
  });
}

function parseSavedResponsibilitySelector(
  value: unknown,
): AgentSavedCommerceSelector {
  return parsePublishedCommerceSelector(value);
}

function parseSkillForm(values: FormData): AgentOperationFormResult {
  const title = formText(values, "title");
  const sensitivity = formText(values, "sensitivity");
  const markdownBody = formText(values, "markdownBody");
  if (title === null || !isSensitivity(sensitivity) || markdownBody === null)
    return invalidForm();
  return {
    ok: true,
    command: { kind: "create_skill", title, sensitivity, markdownBody },
  };
}

function parseSkillRevisionForm(values: FormData): AgentOperationFormResult {
  const skillId = formText(values, "skillId");
  const expectedRevision = formPositiveInteger(values, "expectedRevision");
  const markdownBody = formText(values, "markdownBody");
  if (skillId === null || expectedRevision === null || markdownBody === null)
    return invalidForm();
  return {
    ok: true,
    command: {
      kind: "publish_skill_revision",
      skillId,
      expectedRevision,
      markdownBody,
    },
  };
}

function parseAgentDefinitionForm(values: FormData): AgentOperationFormResult {
  const displayName = formText(values, "displayName");
  const role = formText(values, "role");
  const purpose = formText(values, "purpose");
  const instructions = formText(values, "instructions");
  const skillRefs = formSkillRefs(values);
  if (
    displayName === null ||
    role === null ||
    purpose === null ||
    instructions === null ||
    !skillRefs.ok
  ) {
    return invalidForm();
  }
  return {
    ok: true,
    command: {
      kind: "create_agent_definition",
      displayName,
      role,
      purpose,
      instructions,
      requestedCapabilities: formList(values, "requestedCapabilities"),
      skillRefs: skillRefs.value,
    },
  };
}

function parseAgentDefinitionRevisionForm(
  values: FormData,
): AgentOperationFormResult {
  const agentDefinitionId = formText(values, "agentDefinitionId");
  const expectedRevision = formPositiveInteger(values, "expectedRevision");
  const instructions = formText(values, "instructions");
  const skillRefs = formSkillRefs(values);
  if (
    agentDefinitionId === null ||
    expectedRevision === null ||
    instructions === null ||
    !skillRefs.ok
  ) {
    return invalidForm();
  }
  return {
    ok: true,
    command: {
      kind: "publish_agent_definition_revision",
      agentDefinitionId,
      expectedRevision,
      instructions,
      requestedCapabilities: formList(values, "requestedCapabilities"),
      skillRefs: skillRefs.value,
    },
  };
}

/**
 * Reads the complete skill set a definition revision publishes. Each field
 * value is `skillId@revision`, so one form submission names both the skill and
 * the exact revision the agent will run.
 */
function formSkillRefs(
  values: FormData,
):
  | { readonly ok: true; readonly value: readonly AgentSkillRef[] }
  | { readonly ok: false } {
  const refs: AgentSkillRef[] = [];
  for (const entry of formList(values, "skillRefs")) {
    const separator = entry.lastIndexOf("@");
    if (separator <= 0) return { ok: false };
    const skillId = entry.slice(0, separator);
    const revision = Number(entry.slice(separator + 1));
    if (!Number.isSafeInteger(revision) || revision <= 0) return { ok: false };
    refs.push({ skillId, revision });
  }
  return new Set(refs.map((ref) => ref.skillId)).size === refs.length
    ? { ok: true, value: refs }
    : { ok: false };
}

function parseAgentInstallationForm(
  values: FormData,
): AgentOperationFormResult {
  const agentDefinitionId = formText(values, "agentDefinitionId");
  const definitionRevision = formPositiveInteger(values, "definitionRevision");
  const areaId = formText(values, "areaId");
  const responsibility = formText(values, "responsibility");
  const scopeIds = formList(values, "scopeIds");
  const policyRevision = formPositiveInteger(values, "policyRevision");
  if (
    agentDefinitionId === null ||
    definitionRevision === null ||
    areaId === null ||
    responsibility === null ||
    policyRevision === null
  )
    return invalidForm();
  return {
    ok: true,
    command: {
      kind: "install_agent",
      agentDefinitionId,
      definitionRevision,
      areaId,
      responsibility,
      scopeIds,
      policyRevision,
      grantedCapabilities: formList(values, "grantedCapabilities"),
    },
  };
}

function parseActivationForm(values: FormData): AgentOperationFormResult {
  const installationId = formText(values, "installationId");
  const expectedDefinitionRevision = formPositiveInteger(
    values,
    "expectedDefinitionRevision",
  );
  const definitionRevision = formPositiveInteger(values, "definitionRevision");
  const skillRefs = formSkillRefs(values);
  if (
    installationId === null ||
    expectedDefinitionRevision === null ||
    definitionRevision === null ||
    !skillRefs.ok
  ) {
    return invalidForm();
  }
  return {
    ok: true,
    command: {
      kind: "activate_agent_definition_revision",
      installationId,
      expectedDefinitionRevision,
      definitionRevision,
      skillRefs: skillRefs.value,
    },
  };
}

function parseSkillBindingForm(values: FormData): AgentOperationFormResult {
  const targetKind = formText(values, "targetKind");
  const targetId = formText(values, "targetId");
  const skillId = formText(values, "skillId");
  const skillRevision = formPositiveInteger(values, "skillRevision");
  if (
    !isTargetKind(targetKind) ||
    targetId === null ||
    skillId === null ||
    skillRevision === null
  ) {
    return invalidForm();
  }
  return {
    ok: true,
    command: {
      kind: "bind_skill",
      targetKind,
      targetId,
      skillId,
      skillRevision,
    },
  };
}

function parseCueBindingForm(values: FormData): AgentOperationFormResult {
  const areaId = formText(values, "areaId");
  const installationId = formText(values, "installationId");
  const cueSource = formText(values, "cueSource");
  const cueEventType = formText(values, "cueEventType");
  const scopeIds = formList(values, "scopeIds");
  if (
    areaId === null ||
    scopeIds.length === 0 ||
    installationId === null ||
    cueSource === null ||
    cueEventType === null
  ) {
    return invalidForm();
  }
  return {
    ok: true,
    command: {
      kind: "configure_cue_binding",
      areaId,
      scopeIds,
      installationId,
      cueSource,
      cueEventType,
      enabled: formText(values, "enabled") !== "false",
      instructionBody: formText(values, "instructionBody"),
    },
  };
}

function parseScheduleBindingForm(values: FormData): AgentOperationFormResult {
  const areaId = formText(values, "areaId");
  const installationId = formText(values, "installationId");
  const scopeIds = formList(values, "scopeIds");
  const spec = parseScheduleSpecForm(values);
  if (
    areaId === null ||
    scopeIds.length === 0 ||
    installationId === null ||
    spec === null
  ) {
    return invalidForm();
  }
  return {
    ok: true,
    command: {
      kind: "configure_schedule_binding",
      areaId,
      scopeIds,
      installationId,
      spec,
      enabled: formText(values, "enabled") !== "false",
      instructionBody: formText(values, "instructionBody"),
    },
  };
}

function parseScheduleSpecForm(values: FormData): ScheduleSpec | null {
  const cadence = formText(values, "cadence");
  if (cadence === "hourly") {
    const minuteOfHour = formMinute(values, "minuteOfHour");
    return minuteOfHour === null ? null : { cadence: "hourly", minuteOfHour };
  }
  const timeOfDay = formText(values, "timeOfDay");
  const timezone = formText(values, "timezone");
  if (
    timeOfDay === null ||
    !/^([01][0-9]|2[0-3]):[0-5][0-9]$/u.test(timeOfDay) ||
    timezone === null
  ) {
    return null;
  }
  if (cadence === "daily") {
    return { cadence: "daily", timeOfDay, timezone };
  }
  if (cadence === "weekly") {
    const weekday = formText(values, "weekday");
    return isWeekday(weekday)
      ? { cadence: "weekly", weekday, timeOfDay, timezone }
      : null;
  }
  return null;
}

function parseBindingUpdateForm(
  values: FormData,
  kind: "update_cue_binding" | "update_schedule_binding",
): AgentOperationFormResult {
  const bindingId = formText(values, "bindingId");
  const expectedRevision = formPositiveInteger(values, "expectedRevision");
  const enabled = formText(values, "enabled");
  if (
    bindingId === null ||
    expectedRevision === null ||
    (enabled !== "true" && enabled !== "false")
  ) {
    return invalidForm();
  }
  return {
    ok: true,
    command: {
      kind,
      bindingId,
      expectedRevision,
      enabled: enabled === "true",
      instructionBody: formText(values, "instructionBody"),
    },
  };
}

function formMinute(values: FormData, name: string): number | null {
  const raw = formText(values, name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && value <= 59
    ? value
    : null;
}

function isWeekday(value: string | null): value is ScheduleWeekday {
  return (
    value === "mon" ||
    value === "tue" ||
    value === "wed" ||
    value === "thu" ||
    value === "fri" ||
    value === "sat" ||
    value === "sun"
  );
}

function parseGovernanceForm(values: FormData): AgentOperationFormResult {
  const installationId = formText(values, "installationId");
  const maxSessionBudgetTokens = formPositiveInteger(
    values,
    "maxSessionBudgetTokens",
  );
  if (installationId === null || maxSessionBudgetTokens === null)
    return invalidForm();
  return {
    ok: true,
    command: {
      kind: "configure_installation_governance",
      installationId,
      maxSessionBudgetTokens,
    },
  };
}

function parseEscalationForm(values: FormData): AgentOperationFormResult {
  const areaId = formText(values, "areaId");
  const approvalReminderAfterMs = formPositiveInteger(
    values,
    "approvalReminderAfterMs",
  );
  const escalateAfterMs = formPositiveInteger(values, "escalateAfterMs");
  const scopeIds = formList(values, "scopeIds");
  if (
    areaId === null ||
    scopeIds.length === 0 ||
    approvalReminderAfterMs === null ||
    escalateAfterMs === null ||
    escalateAfterMs < approvalReminderAfterMs
  ) {
    return invalidForm();
  }
  return {
    ok: true,
    command: {
      kind: "configure_escalation_policy",
      areaId,
      scopeIds,
      approvalReminderAfterMs,
      escalateAfterMs,
    },
  };
}

function parseManualRunForm(values: FormData): AgentOperationFormResult {
  const installationId = formText(values, "installationId");
  const instructionBody = formText(values, "instructionBody");
  return installationId !== null && instructionBody !== null
    ? {
        ok: true,
        command: {
          kind: "dispatch_manual_run",
          installationId,
          instructionBody,
        },
      }
    : invalidForm();
}

function parseProposalDecisionForm(
  values: FormData,
  kind: "accept_configuration_proposal" | "dismiss_configuration_proposal",
): AgentOperationFormResult {
  const proposalId = formText(values, "proposalId");
  return proposalId === null
    ? invalidForm()
    : { ok: true, command: { kind, proposalId } };
}

function invalidForm(): AgentOperationFormResult {
  return { ok: false, message: "Complete the required operation fields." };
}

function formText(values: FormData, name: string): string | null {
  const value = values.get(name);
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function formPositiveInteger(values: FormData, name: string): number | null {
  const raw = formText(values, name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function formList(values: FormData, name: string): readonly string[] {
  return values
    .getAll(name)
    .filter(isString)
    .map(normalizeListItem)
    .filter(nonEmptyListItem);
}

function normalizeListItem(value: string): string {
  return value.trim();
}

function nonEmptyListItem(value: string): boolean {
  return value.length > 0;
}

function parseActiveCase(raw: unknown): ActiveCaseOperationsView {
  if (
    !isRecord(raw) ||
    typeof raw.caseId !== "string" ||
    typeof raw.pinnedOrganisationId !== "string" ||
    typeof raw.purpose !== "string" ||
    !isCaseLifecycle(raw.lifecycle) ||
    !Array.isArray(raw.assignments) ||
    !isRecord(raw.outputs) ||
    !Number.isSafeInteger(raw.revision) ||
    !Number.isSafeInteger(raw.outputs.pending) ||
    !Number.isSafeInteger(raw.outputs.settled)
  ) {
    throw new Error("Active Case response is invalid.");
  }
  const revision = requireNumber(raw.revision, "Case revision");
  const pending = requireNumber(raw.outputs.pending, "Case pending outputs");
  const settled = requireNumber(raw.outputs.settled, "Case settled outputs");
  const assignments = raw.assignments.map((assignment) => {
    if (
      !isRecord(assignment) ||
      typeof assignment.assignmentId !== "string" ||
      typeof assignment.sessionId !== "string" ||
      !isCaseAssignmentLifecycle(assignment.lifecycle)
    ) {
      throw new Error("Active Case assignment response is invalid.");
    }
    return {
      assignmentId: assignment.assignmentId,
      sessionId: assignment.sessionId,
      lifecycle: assignment.lifecycle,
    };
  });
  return {
    caseId: raw.caseId,
    pinnedOrganisationId: raw.pinnedOrganisationId,
    purpose: raw.purpose,
    revision,
    lifecycle: raw.lifecycle,
    assignments,
    outputs: { pending, settled },
  };
}

function parseActionLedgerActivity(raw: unknown): ActionLedgerActivity {
  if (
    !isRecord(raw) ||
    !isRecord(raw.action) ||
    !isRecord(raw.action.nonce) ||
    typeof raw.action.nonce.value !== "string" ||
    typeof raw.action.host !== "string" ||
    typeof raw.action.verb !== "string" ||
    typeof raw.action.resourceKey !== "string" ||
    typeof raw.caseId !== "string" ||
    typeof raw.proposalId !== "string" ||
    !isActionLedgerState(raw.state) ||
    !Number.isSafeInteger(raw.createdAt) ||
    !Number.isSafeInteger(raw.updatedAt) ||
    (raw.providerResult !== null && typeof raw.providerResult !== "string")
  ) {
    throw new Error("Action Ledger activity response is invalid.");
  }
  const amount = parseCommerceActionAmount(raw.action.amount);
  return {
    action: {
      nonce: { value: raw.action.nonce.value },
      host: raw.action.host,
      verb: raw.action.verb,
      resourceKey: raw.action.resourceKey,
      amount,
    },
    caseId: raw.caseId,
    proposalId: raw.proposalId,
    state: raw.state,
    createdAt: requireNumber(raw.createdAt, "Action Ledger created at"),
    updatedAt: requireNumber(raw.updatedAt, "Action Ledger updated at"),
    providerResult: raw.providerResult,
    commerceEffect:
      raw.commerceEffect === null
        ? null
        : parseCommerceEntityPlaneEffect(raw.commerceEffect),
  };
}

function parseCommerceEntityPlaneEffect(
  raw: unknown,
): CommerceEntityPlaneEffect {
  if (
    !isRecord(raw) ||
    !isActionLedgerEffectKind(raw.kind) ||
    !isRecord(raw.receipt)
  ) {
    throw new Error("Action Ledger entity-plane effect is invalid.");
  }
  const receipt = parseEntityPlaneCommandResult({
    status: "accepted",
    receipt: raw.receipt,
  });
  if (receipt.status !== "accepted")
    throw new Error("Action Ledger entity-plane receipt is invalid.");
  switch (raw.kind) {
    case "patch_custom_entity": {
      const command = parseCommerceEntityPlaneCommand({
        kind: raw.kind,
        command: {
          entityRef: raw.entityRef,
          typeRevision: raw.typeRevision,
          expectedRevision: raw.expectedRevision,
          attributes: [],
          displayName: null,
        },
      });
      if (command.kind !== raw.kind)
        throw new Error("Action Ledger entity-plane effect is invalid.");
      return {
        kind: raw.kind,
        entityRef: command.command.entityRef,
        typeRevision: command.command.typeRevision,
        expectedRevision: command.command.expectedRevision,
        receipt: receipt.receipt,
      };
    }
    case "create_custom_relationship": {
      const command = parseCommerceEntityPlaneCommand({
        kind: raw.kind,
        command: {
          target: {
            relationshipId: raw.relationshipId,
            definition: raw.definition,
            source: raw.source,
            target: raw.target,
          },
        },
      });
      if (command.kind !== raw.kind)
        throw new Error("Action Ledger entity-plane effect is invalid.");
      return {
        kind: raw.kind,
        ...command.command.target,
        receipt: receipt.receipt,
      };
    }
    case "replace_custom_relationship": {
      const command = parseCommerceEntityPlaneCommand({
        kind: raw.kind,
        command: {
          target: {
            relationship: raw.relationship,
            replacementTarget: raw.replacementTarget,
          },
        },
      });
      if (command.kind !== raw.kind)
        throw new Error("Action Ledger entity-plane effect is invalid.");
      return {
        kind: raw.kind,
        relationship: command.command.target.relationship,
        replacementTarget: command.command.target.replacementTarget,
        receipt: receipt.receipt,
      };
    }
    case "delete_custom_relationship": {
      const command = parseCommerceEntityPlaneCommand({
        kind: raw.kind,
        command: { target: { relationship: raw.relationship } },
      });
      if (command.kind !== raw.kind)
        throw new Error("Action Ledger entity-plane effect is invalid.");
      return {
        kind: raw.kind,
        relationship: command.command.target.relationship,
        receipt: receipt.receipt,
      };
    }
    case "add_commerce_list_entry": {
      const command = parseCommerceEntityPlaneCommand({
        kind: raw.kind,
        command: {
          entryId: raw.entryId,
          listId: raw.listId,
          expectedListRevision: raw.expectedListRevision,
          entityRef: raw.entityRef,
          attributeValues: [],
          revision: raw.revision,
        },
      });
      if (command.kind !== raw.kind)
        throw new Error("Action Ledger entity-plane effect is invalid.");
      return {
        kind: raw.kind,
        entryId: command.command.entryId,
        listId: command.command.listId,
        expectedListRevision: command.command.expectedListRevision,
        entityRef: command.command.entityRef,
        revision: command.command.revision,
        receipt: receipt.receipt,
      };
    }
    case "patch_commerce_list_entry": {
      const command = parseCommerceEntityPlaneCommand({
        kind: raw.kind,
        command: {
          target: raw.entry,
          expectedListRevision: raw.expectedListRevision,
          attributeValues: [],
        },
      });
      if (command.kind !== raw.kind)
        throw new Error("Action Ledger entity-plane effect is invalid.");
      return {
        kind: raw.kind,
        entry: command.command.target,
        expectedListRevision: command.command.expectedListRevision,
        receipt: receipt.receipt,
      };
    }
    case "remove_commerce_list_entry": {
      const command = parseCommerceEntityPlaneCommand({
        kind: raw.kind,
        command: {
          target: {
            entry: isRecord(raw.entry) ? raw.entry.entry : undefined,
            expectedRevision: isRecord(raw.entry)
              ? raw.entry.expectedRevision
              : undefined,
          },
        },
      });
      if (command.kind !== raw.kind)
        throw new Error("Action Ledger entity-plane effect is invalid.");
      return {
        kind: raw.kind,
        entry: command.command.target,
        receipt: receipt.receipt,
      };
    }
    default:
      return assertNever(raw.kind, "Unhandled agent operation value");
  }
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} is invalid.`);
  return value;
}

function isActionLedgerEffectKind(
  value: unknown,
): value is CommerceEntityPlaneEffect["kind"] {
  return (
    value === "patch_custom_entity" ||
    value === "create_custom_relationship" ||
    value === "delete_custom_relationship" ||
    value === "add_commerce_list_entry" ||
    value === "patch_commerce_list_entry" ||
    value === "remove_commerce_list_entry"
  );
}

function parseArea(raw: unknown): OperationalArea {
  if (
    !isRecord(raw) ||
    typeof raw.areaId !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.purpose !== "string" ||
    !isAgentLifecycle(raw.lifecycle)
  )
    throw new Error("Agent area response is invalid.");
  return {
    areaId: raw.areaId,
    name: raw.name,
    purpose: raw.purpose,
    lifecycle: raw.lifecycle,
  };
}

function parseResponsibilityScopeRecord(
  raw: unknown,
): AgentResponsibilityScopeRecord {
  if (
    !isRecord(raw) ||
    typeof raw.scopeId !== "string" ||
    typeof raw.organisationId !== "string" ||
    typeof raw.areaId !== "string" ||
    !isScopeLifecycle(raw.lifecycle) ||
    typeof raw.revision !== "number" ||
    typeof raw.publishedAt !== "number"
  )
    throw new Error("Agent responsibility scope response is invalid.");
  strictObject(raw, [
    "scopeId",
    "organisationId",
    "areaId",
    "scope",
    "lifecycle",
    "revision",
    "publishedAt",
  ]);
  const scope = parseResponsibilityScope(raw.scope);
  if (scope === null)
    throw new Error("Agent responsibility scope response is invalid.");
  return {
    scopeId: raw.scopeId,
    organisationId: raw.organisationId,
    areaId: raw.areaId,
    scope,
    lifecycle: raw.lifecycle,
    revision: raw.revision,
    publishedAt: raw.publishedAt,
  };
}

function parseResponsibilityScope(
  raw: unknown,
): AgentResponsibilityScope | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  try {
    switch (raw.kind) {
      case "entity_type": {
        const branch = strictObject(raw, ["kind", "entityTypeId"]);
        return {
          kind: raw.kind,
          entityTypeId: parseResponsibilityEntityTypeId(branch.entityTypeId),
        };
      }
      case "relationship": {
        const branch = strictObject(raw, ["kind", "relationship"]);
        return {
          kind: raw.kind,
          relationship: parseCommerceRelationshipRef(branch.relationship),
        };
      }
      case "commerce_list": {
        const branch = strictObject(raw, ["kind", "listId"]);
        return {
          kind: raw.kind,
          listId: parseResponsibilityListId(branch.listId),
        };
      }
      case "commerce_list_entry": {
        const branch = strictObject(raw, ["kind", "entry"]);
        return {
          kind: raw.kind,
          entry: parseCommerceListEntryRef(branch.entry),
        };
      }
      case "saved_selector": {
        const branch = strictObject(raw, ["kind", "selector"]);
        return {
          kind: raw.kind,
          selector: parseSavedResponsibilitySelector(branch.selector),
        };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function parseResponsibilityEntityTypeId(value: unknown): CommerceEntityTypeId {
  const query = parseCommerceGraphQuery({
    kind: "entity_type_page",
    entityTypeId: value,
    filter: { kind: "all" },
    sorts: [],
    pagination: { limit: 50, cursor: null },
    traversal: { maxDepth: 0, resultLimit: 100 },
  });
  if (query.kind !== "entity_type_page")
    throw new Error("entity type parser changed shape");
  return query.entityTypeId;
}

function parseResponsibilityListId(value: unknown): string {
  const query = parseCommerceGraphQuery({
    kind: "commerce_list_page",
    listId: value,
    filter: { kind: "all" },
    sorts: [],
    pagination: { limit: 50, cursor: null },
  });
  if (query.kind !== "commerce_list_page")
    throw new Error("Commerce List parser changed shape");
  return String(query.listId);
}

function parseSkillRefs(raw: unknown): readonly AgentSkillRef[] | null {
  if (!Array.isArray(raw)) return null;
  const refs: AgentSkillRef[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.skillId !== "string" ||
      typeof entry.revision !== "number"
    ) {
      return null;
    }
    refs.push({ skillId: entry.skillId, revision: entry.revision });
  }
  return refs;
}

function parseDefinition(raw: unknown): AgentDefinition {
  const skillRefs =
    isRecord(raw) && isRecord(raw.currentRevision)
      ? parseSkillRefs(raw.currentRevision.skillRefs)
      : null;
  if (
    !isRecord(raw) ||
    typeof raw.agentDefinitionId !== "string" ||
    typeof raw.displayName !== "string" ||
    typeof raw.role !== "string" ||
    typeof raw.purpose !== "string" ||
    !isAgentLifecycle(raw.lifecycle) ||
    !isRecord(raw.currentRevision) ||
    typeof raw.currentRevision.revision !== "number" ||
    typeof raw.currentRevision.instructions !== "string" ||
    typeof raw.currentRevision.contentDigest !== "string" ||
    !stringArray(raw.currentRevision.requestedCapabilities) ||
    skillRefs === null
  ) {
    throw new Error("Agent definition response is invalid.");
  }
  return {
    agentDefinitionId: raw.agentDefinitionId,
    displayName: raw.displayName,
    role: raw.role,
    purpose: raw.purpose,
    lifecycle: raw.lifecycle,
    currentRevision: {
      revision: raw.currentRevision.revision,
      instructions: raw.currentRevision.instructions,
      requestedCapabilities: raw.currentRevision.requestedCapabilities,
      skillRefs,
      contentDigest: raw.currentRevision.contentDigest,
    },
  };
}

function parseInstallation(raw: unknown): AgentInstallation {
  if (
    !isRecord(raw) ||
    typeof raw.installationId !== "string" ||
    typeof raw.agentDefinitionId !== "string" ||
    typeof raw.definitionRevision !== "number" ||
    typeof raw.policyRevision !== "number" ||
    !isInstallationLifecycle(raw.lifecycle) ||
    !stringArray(raw.grantedCapabilities) ||
    !Array.isArray(raw.areaAssignments)
  ) {
    throw new Error("Agent installation response is invalid.");
  }
  const areaAssignments = raw.areaAssignments.map((assignment) => {
    if (
      !isRecord(assignment) ||
      typeof assignment.areaId !== "string" ||
      typeof assignment.responsibility !== "string" ||
      !stringArray(assignment.scopeIds)
    ) {
      throw new Error("Agent assignment response is invalid.");
    }
    return {
      areaId: assignment.areaId,
      responsibility: assignment.responsibility,
      scopeIds: assignment.scopeIds,
    };
  });
  return {
    installationId: raw.installationId,
    agentDefinitionId: raw.agentDefinitionId,
    definitionRevision: raw.definitionRevision,
    policyRevision: raw.policyRevision,
    grantedCapabilities: raw.grantedCapabilities,
    lifecycle: raw.lifecycle,
    areaAssignments,
  };
}

function parseSkill(raw: unknown): Skill {
  if (
    !isRecord(raw) ||
    typeof raw.skillId !== "string" ||
    typeof raw.title !== "string" ||
    !isSensitivity(raw.sensitivity) ||
    !isSkillLifecycle(raw.lifecycle) ||
    !isRecord(raw.currentRevision) ||
    typeof raw.currentRevision.revision !== "number" ||
    typeof raw.currentRevision.markdownBody !== "string" ||
    typeof raw.currentRevision.contentDigest !== "string"
  )
    throw new Error("Skill response is invalid.");
  return {
    skillId: raw.skillId,
    title: raw.title,
    sensitivity: raw.sensitivity,
    lifecycle: raw.lifecycle,
    currentRevision: {
      revision: raw.currentRevision.revision,
      markdownBody: raw.currentRevision.markdownBody,
      contentDigest: raw.currentRevision.contentDigest,
    },
  };
}

function parseBinding(raw: unknown): SkillBinding {
  if (
    !isRecord(raw) ||
    typeof raw.bindingId !== "string" ||
    !isTargetKind(raw.targetKind) ||
    typeof raw.targetId !== "string" ||
    typeof raw.skillId !== "string" ||
    typeof raw.skillRevision !== "number"
  ) {
    throw new Error("Skill binding response is invalid.");
  }
  return {
    bindingId: raw.bindingId,
    targetKind: raw.targetKind,
    targetId: raw.targetId,
    skillId: raw.skillId,
    skillRevision: raw.skillRevision,
  };
}

function parseCueBinding(raw: unknown): CueBinding {
  if (
    !isRecord(raw) ||
    typeof raw.bindingId !== "string" ||
    typeof raw.areaId !== "string" ||
    !stringArray(raw.scopeIds) ||
    typeof raw.installationId !== "string" ||
    typeof raw.cueSource !== "string" ||
    typeof raw.cueEventType !== "string" ||
    typeof raw.enabled !== "boolean" ||
    (raw.instructionBody !== null && typeof raw.instructionBody !== "string") ||
    typeof raw.revision !== "number"
  ) {
    throw new Error("Cue binding response is invalid.");
  }
  return {
    bindingId: raw.bindingId,
    areaId: raw.areaId,
    scopeIds: raw.scopeIds,
    installationId: raw.installationId,
    cueSource: raw.cueSource,
    cueEventType: raw.cueEventType,
    enabled: raw.enabled,
    instructionBody: raw.instructionBody,
    revision: raw.revision,
  };
}

function parseScheduleBinding(raw: unknown): ScheduleBinding {
  if (
    !isRecord(raw) ||
    typeof raw.bindingId !== "string" ||
    typeof raw.areaId !== "string" ||
    !stringArray(raw.scopeIds) ||
    typeof raw.installationId !== "string" ||
    typeof raw.enabled !== "boolean" ||
    (raw.instructionBody !== null && typeof raw.instructionBody !== "string") ||
    typeof raw.revision !== "number"
  ) {
    throw new Error("Schedule binding response is invalid.");
  }
  return {
    bindingId: raw.bindingId,
    areaId: raw.areaId,
    scopeIds: raw.scopeIds,
    installationId: raw.installationId,
    spec: parseScheduleSpecResponse(raw.spec),
    enabled: raw.enabled,
    instructionBody: raw.instructionBody,
    revision: raw.revision,
  };
}

function parseScheduleSpecResponse(raw: unknown): ScheduleSpec {
  if (isRecord(raw)) {
    if (raw.cadence === "hourly" && typeof raw.minuteOfHour === "number") {
      return { cadence: "hourly", minuteOfHour: raw.minuteOfHour };
    }
    if (
      raw.cadence === "daily" &&
      typeof raw.timeOfDay === "string" &&
      typeof raw.timezone === "string"
    ) {
      return {
        cadence: "daily",
        timeOfDay: raw.timeOfDay,
        timezone: raw.timezone,
      };
    }
    if (
      raw.cadence === "weekly" &&
      typeof raw.weekday === "string" &&
      isWeekday(raw.weekday) &&
      typeof raw.timeOfDay === "string" &&
      typeof raw.timezone === "string"
    ) {
      return {
        cadence: "weekly",
        weekday: raw.weekday,
        timeOfDay: raw.timeOfDay,
        timezone: raw.timezone,
      };
    }
  }
  throw new Error("Schedule binding response is invalid.");
}

function parseGovernance(raw: unknown): InstallationGovernance {
  if (
    !isRecord(raw) ||
    typeof raw.installationId !== "string" ||
    typeof raw.maxSessionBudgetTokens !== "number" ||
    typeof raw.revision !== "number"
  ) {
    throw new Error("Installation governance response is invalid.");
  }
  return {
    installationId: raw.installationId,
    maxSessionBudgetTokens: raw.maxSessionBudgetTokens,
    revision: raw.revision,
  };
}

function parseEscalationPolicy(raw: unknown): EscalationPolicy {
  if (
    !isRecord(raw) ||
    typeof raw.areaId !== "string" ||
    !stringArray(raw.scopeIds) ||
    typeof raw.approvalReminderAfterMs !== "number" ||
    typeof raw.escalateAfterMs !== "number" ||
    raw.escalateTo !== "organisation_owner" ||
    typeof raw.revision !== "number"
  ) {
    throw new Error("Escalation policy response is invalid.");
  }
  return {
    areaId: raw.areaId,
    scopeIds: raw.scopeIds,
    approvalReminderAfterMs: raw.approvalReminderAfterMs,
    escalateAfterMs: raw.escalateAfterMs,
    escalateTo: "organisation_owner",
    revision: raw.revision,
  };
}

function parseConfigurationProposal(raw: unknown): AgentConfigurationProposal {
  if (
    !isRecord(raw) ||
    typeof raw.proposalId !== "string" ||
    typeof raw.installationId !== "string" ||
    (raw.targetKind !== "agent_instructions" &&
      raw.targetKind !== "skill_markdown") ||
    typeof raw.targetId !== "string" ||
    typeof raw.expectedRevision !== "number" ||
    typeof raw.proposedBody !== "string" ||
    typeof raw.rationale !== "string" ||
    (raw.status !== "open" &&
      raw.status !== "accepted" &&
      raw.status !== "dismissed") ||
    (raw.publishedRevision !== null &&
      typeof raw.publishedRevision !== "number")
  ) {
    throw new Error("Configuration proposal response is invalid.");
  }
  return {
    proposalId: raw.proposalId,
    installationId: raw.installationId,
    targetKind: raw.targetKind,
    targetId: raw.targetId,
    expectedRevision: raw.expectedRevision,
    proposedBody: raw.proposedBody,
    rationale: raw.rationale,
    status: raw.status,
    publishedRevision: raw.publishedRevision,
  };
}

function stringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isScopeLifecycle(value: unknown): value is "published" | "archived" {
  return value === "published" || value === "archived";
}

function isAgentLifecycle(
  value: unknown,
): value is AgentDefinition["lifecycle"] {
  return value === "active" || value === "archived";
}

function isInstallationLifecycle(
  value: unknown,
): value is AgentInstallation["lifecycle"] {
  return value === "active" || value === "suspended" || value === "archived";
}

function isSkillLifecycle(value: unknown): value is Skill["lifecycle"] {
  return value === "published" || value === "archived";
}

function isSensitivity(value: unknown): value is Skill["sensitivity"] {
  return value === "ordinary" || value === "sensitive";
}

function isTargetKind(value: unknown): value is SkillBinding["targetKind"] {
  return value === "area";
}

function isActionLedgerState(
  value: unknown,
): value is CommerceActionRecord["state"] {
  return (
    value === "proposed" ||
    value === "approval_requested" ||
    value === "signed" ||
    value === "executing" ||
    value === "confirmed" ||
    value === "failed" ||
    value === "rejected" ||
    value === "expired" ||
    value === "indeterminate"
  );
}

function isCaseLifecycle(
  value: unknown,
): value is ActiveCaseOperationsView["lifecycle"] {
  return (
    value === "open" ||
    value === "waiting" ||
    value === "completing" ||
    value === "completed" ||
    value === "quarantined" ||
    value === "archived"
  );
}

function isCaseAssignmentLifecycle(
  value: unknown,
): value is ActiveCaseOperationsView["assignments"][number]["lifecycle"] {
  return value === "assigned" || value === "running" || value === "settled";
}

function strictObject(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error("unsupported responsibility scope fields");
  return value;
}

function apiError(raw: unknown): string {
  void raw;
  return "Agent operations are unavailable.";
}

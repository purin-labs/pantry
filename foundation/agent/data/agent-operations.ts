import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { CommerceEntityPlaneCueEvent } from "../cues/engine";
import type { CommerceTypeParts } from "@purin-labs/kernel/commerce-type-parts";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { Variant } from "@purin-labs/type-utils";
import { isRecord } from "@purin-labs/std";
import type { AgentSkillRef, ScheduleSpec } from "@purin-labs/control-api";
import type { AgentOperationCommandOf as ApiAgentOperationCommand } from "@purin-labs/control-api";
import {
  createArea,
  publishResponsibilityScope,
} from "./agent-operations/areas";
import {
  configureCueBinding,
  configureEscalationPolicy,
  configureInstallationGovernance,
  configureScheduleBinding,
  updateCueBinding,
  updateScheduleBinding,
} from "./agent-operations/bindings";
import {
  activateDefinitionRevision,
  createDefinition,
  installAgent,
  publishDefinitionRevision,
} from "./agent-operations/definitions";
import {
  AgentOperationFailure,
  failUnhandled,
  isConstraintError,
} from "./agent-operations/failure";
import {
  invalid,
  parseActivationInput,
  parseAreaInput,
  parseBindingInput,
  parseBindingUpdateInput,
  parseCueBindingInput,
  parseDefinitionInput,
  parseDefinitionRevisionInput,
  parseEscalationInput,
  parseGovernanceInput,
  parseInstallationInput,
  parseManualRunInput,
  parseProposalDecisionInput,
  parseResponsibilityScopeInput,
  parseScheduleBindingInput,
  parseSkillInput,
  parseSkillRevisionInput,
  text,
} from "./agent-operations/input";
import {
  acceptConfigurationProposal,
  dismissConfigurationProposal,
} from "./agent-operations/proposals";
import {
  type RawArea,
  type RawAssignment,
  type RawBinding,
  type RawConfigurationProposal,
  type RawCueBinding,
  type RawDefinition,
  type RawEscalationPolicy,
  type RawGovernance,
  type RawInstallation,
  type RawResponsibilityScope,
  type RawScheduleBinding,
  type RawSkill,
  parseAreaRow,
  parseBindingRow,
  parseConfigurationProposalRow,
  parseCueBindingRow,
  parseDefinitionRow,
  parseEscalationPolicyRow,
  parseGovernanceRow,
  parseInstallationRow,
  parseResponsibilityScopeRow,
  parseScheduleBindingRow,
  parseSkillRow,
} from "./agent-operations/rows";
import { SCHEDULE_BINDING_COLUMNS } from "./agent-operations/schedule-dispatch";
import {
  bindSkill,
  createSkill,
  publishSkillRevision,
} from "./agent-operations/skills";

export type AgentLifecycle = "active" | "archived";

export type InstallationLifecycle = "active" | "suspended" | "archived";

export type SkillSensitivity = "ordinary" | "sensitive";

export type SkillLifecycle = "published" | "archived";

export type AgentResponsibilityScope =
  | {
      readonly kind: "entity_type";
      readonly entityTypeId: {
        readonly origin: "system" | "custom";
        readonly typeId: string;
      };
    }
  | {
      readonly kind: "relationship";
      readonly relationship: CommerceTypeParts["relationshipRef"];
    }
  | {
      readonly kind: "commerce_list";
      readonly listId: string;
    }
  | {
      readonly kind: "commerce_list_entry";
      readonly entry: CommerceTypeParts["listEntryRef"];
    }
  | {
      readonly kind: "saved_selector";
      readonly selector: {
        readonly selectorId: string;
        readonly revision: number;
        readonly query: CommerceTypeParts["graphQuery"];
      };
    };

export type SavedSelectorCueResolverInput = Readonly<{
  organisationId: OrganisationId;
  selector: Variant<AgentResponsibilityScope, "saved_selector">["selector"];
  observation: CommerceEntityPlaneCueEvent["payload"]["observation"];
}>;

export type SavedSelectorCueResolverError = Readonly<{
  code:
    "saved_selector_resolver_unavailable" | "saved_selector_resolver_failed";
}>;

export type SavedSelectorCueResolver = (
  input: SavedSelectorCueResolverInput,
) => Promise<Result<boolean, SavedSelectorCueResolverError>>;

export type AgentResponsibilityScopeRecord = {
  readonly scopeId: string;
  readonly organisationId: OrganisationId;
  readonly areaId: string;
  readonly scope: AgentResponsibilityScope;
  readonly lifecycle: "published" | "archived";
  readonly revision: number;
  readonly publishedAt: number;
};

export type OperationalArea = {
  readonly areaId: string;
  readonly organisationId: OrganisationId;
  readonly name: string;
  readonly purpose: string;
  readonly lifecycle: AgentLifecycle;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type AgentDefinitionRevision = {
  readonly agentDefinitionId: string;
  readonly revision: number;
  readonly instructions: string;
  readonly requestedCapabilities: readonly string[];
  readonly skillRefs: readonly AgentSkillRef[];
  readonly contentDigest: string;
  readonly authoredBy: string;
  readonly createdAt: number;
};

export type AgentDefinition = {
  readonly agentDefinitionId: string;
  readonly organisationId: OrganisationId;
  readonly displayName: string;
  readonly role: string;
  readonly purpose: string;
  readonly lifecycle: AgentLifecycle;
  readonly currentRevision: AgentDefinitionRevision;
};

export type AgentInstallation = {
  readonly installationId: string;
  readonly organisationId: OrganisationId;
  readonly agentDefinitionId: string;
  readonly definitionRevision: number;
  readonly policyRevision: number;
  readonly grantedCapabilities: readonly string[];
  readonly lifecycle: InstallationLifecycle;
  readonly areaAssignments: readonly {
    readonly areaId: string;
    readonly responsibility: string;
    readonly scopeIds: readonly string[];
    readonly assignedAt: number;
  }[];
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type SkillRevision = {
  readonly skillId: string;
  readonly revision: number;
  readonly markdownBody: string;
  readonly contentDigest: string;
  readonly authoredBy: string;
  readonly createdAt: number;
};

export type Skill = {
  readonly skillId: string;
  readonly organisationId: OrganisationId;
  readonly title: string;
  readonly sensitivity: SkillSensitivity;
  readonly lifecycle: SkillLifecycle;
  readonly currentRevision: SkillRevision;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type SkillBinding = {
  readonly bindingId: string;
  readonly organisationId: OrganisationId;
  readonly targetKind: "area";
  readonly targetId: string;
  readonly skillId: string;
  readonly skillRevision: number;
  readonly createdAt: number;
};

export type CueBinding = {
  readonly bindingId: string;
  readonly organisationId: OrganisationId;
  readonly areaId: string;
  readonly scopeIds: readonly string[];
  readonly installationId: string;
  readonly cueSource: string;
  readonly cueEventType: string;
  readonly enabled: boolean;
  readonly instructionBody: string | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ScheduleBinding = {
  readonly bindingId: string;
  readonly organisationId: OrganisationId;
  readonly areaId: string;
  readonly scopeIds: readonly string[];
  readonly installationId: string;
  readonly spec: ScheduleSpec;
  readonly scheduleTimeKey: string;
  readonly enabled: boolean;
  readonly instructionBody: string | null;
  readonly lastDispatchedWindow: string | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type InstallationGovernance = {
  readonly installationId: string;
  readonly organisationId: OrganisationId;
  readonly maxSessionBudgetTokens: number;
  readonly revision: number;
  readonly updatedAt: number;
};

export type EscalationPolicy = {
  readonly areaId: string;
  readonly scopeIds: readonly string[];
  readonly organisationId: OrganisationId;
  readonly approvalReminderAfterMs: number;
  readonly escalateAfterMs: number;
  readonly escalateTo: "organisation_owner";
  readonly revision: number;
  readonly updatedAt: number;
};

type ConfigurationProposalTargetKind = "agent_instructions" | "skill_markdown";

export type AgentConfigurationProposal = {
  readonly proposalId: string;
  readonly organisationId: OrganisationId;
  readonly installationId: string;
  readonly targetKind: ConfigurationProposalTargetKind;
  readonly targetId: string;
  readonly expectedRevision: number;
  readonly proposedBody: string;
  readonly rationale: string;
  readonly status: "open" | "accepted" | "dismissed";
  readonly createdAt: number;
  readonly decidedAt: number | null;
  readonly publishedRevision: number | null;
};

export type CaseAssignmentPin = {
  readonly organisationId: OrganisationId;
  readonly assignmentId: string;
  readonly caseId: string;
  readonly installationId: string;
  readonly agentDefinitionId: string;
  readonly definitionRevision: number;
  readonly policyRevision: number;
  readonly skillRefs: readonly AgentSkillRef[];
  readonly grantedCapabilities: readonly string[];
  readonly maxSessionBudgetTokens: number | null;
  readonly pinnedAt: number;
};

/**
 * Resolution of one enabled cue binding at admission: the exact installation,
 * definition, skill, policy, grant, and budget values a new assignment
 * pins.
 */
export type CueAutomationResolution = {
  readonly binding: CueBinding;
  readonly agentDefinitionId: string;
  readonly definitionRevision: number;
  readonly policyRevision: number;
  readonly skillRefs: readonly AgentSkillRef[];
  readonly grantedCapabilities: readonly string[];
  readonly maxSessionBudgetTokens: number | null;
};

/**
 * Resolution of one enabled schedule binding at dispatch: the exact
 * installation, definition, skill, policy, grant, and budget values a new
 * assignment pins — the same pin shape the cue path uses.
 */
export type ScheduleAutomationResolution = {
  readonly binding: ScheduleBinding;
  readonly agentDefinitionId: string;
  readonly definitionRevision: number;
  readonly policyRevision: number;
  readonly skillRefs: readonly AgentSkillRef[];
  readonly grantedCapabilities: readonly string[];
  readonly maxSessionBudgetTokens: number | null;
};

export type ScheduleDispatchReceipt = {
  readonly bindingId: string;
  readonly windowKey: string;
  readonly organisationId: OrganisationId;
  readonly caseId: string;
  readonly dispatchedAt: number;
};

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
  readonly activeCases: readonly {
    readonly caseId: string;
    readonly pinnedOrganisationId: OrganisationId;
    readonly purpose: string;
    readonly revision: number;
    readonly lifecycle: "open" | "waiting" | "quarantined";
    readonly assignments: readonly {
      readonly assignmentId: string;
      readonly sessionId: string;
      readonly lifecycle: "assigned" | "running" | "settled";
    }[];
    readonly outputs: { readonly pending: number; readonly settled: number };
  }[];
};

/**
 * The agent operation commands that the Portal sends
 * (`@purin-labs/control-api`), with the responsibility scope as Platform reads it:
 * plain ids and any graph query, where the Portal type carries branded ids.
 */
export type AgentOperationInput =
  | Exclude<
      ApiAgentOperationCommand,
      Variant<ApiAgentOperationCommand, "publish_responsibility_scope">
    >
  | {
      readonly kind: "publish_responsibility_scope";
      readonly areaId: string;
      readonly scope: AgentResponsibilityScope;
    };

export type AgentOperationsError =
  | { readonly code: "agent_operation_invalid"; readonly field: string }
  | { readonly code: "agent_operation_conflict"; readonly field: string }
  | { readonly code: "agent_operation_not_found"; readonly field: string }
  | { readonly code: "agent_operation_persistence_failed" };

type AgentOperationCommandMetadata = Readonly<{
  readonly operationId: string;
  readonly actorUserId: string;
  readonly now: number;
}>;

export type AgentResponsibilityScopePublicationEvidence = Variant<
  CommerceTypeParts["publishedResourceMetadata"],
  "resolved"
>;

type PublishResponsibilityScopeInput = Variant<
  AgentOperationInput,
  "publish_responsibility_scope"
>;

export type AgentOperationCommand =
  | (Exclude<AgentOperationInput, PublishResponsibilityScopeInput> &
      AgentOperationCommandMetadata)
  | (PublishResponsibilityScopeInput &
      AgentOperationCommandMetadata &
      Readonly<{
        readonly publishedResourceEvidence: AgentResponsibilityScopePublicationEvidence;
      }>);

export function parseAgentOperationInput(
  raw: unknown,
): Result<AgentOperationInput, AgentOperationsError> {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return invalid("kind");
  }
  switch (raw.kind) {
    case "create_area":
      return parseAreaInput(raw);
    case "publish_responsibility_scope":
      return parseResponsibilityScopeInput(raw);
    case "create_skill":
      return parseSkillInput(raw);
    case "publish_skill_revision":
      return parseSkillRevisionInput(raw);
    case "create_agent_definition":
      return parseDefinitionInput(raw);
    case "publish_agent_definition_revision":
      return parseDefinitionRevisionInput(raw);
    case "install_agent":
      return parseInstallationInput(raw);
    case "bind_skill":
      return parseBindingInput(raw);
    case "configure_cue_binding":
      return parseCueBindingInput(raw);
    case "configure_schedule_binding":
      return parseScheduleBindingInput(raw);
    case "update_cue_binding":
      return parseBindingUpdateInput(raw, "update_cue_binding");
    case "update_schedule_binding":
      return parseBindingUpdateInput(raw, "update_schedule_binding");
    case "configure_installation_governance":
      return parseGovernanceInput(raw);
    case "configure_escalation_policy":
      return parseEscalationInput(raw);
    case "accept_configuration_proposal":
      return parseProposalDecisionInput(raw, "accept_configuration_proposal");
    case "dismiss_configuration_proposal":
      return parseProposalDecisionInput(raw, "dismiss_configuration_proposal");
    case "dispatch_manual_run":
      return parseManualRunInput(raw);
    case "activate_agent_definition_revision":
      return parseActivationInput(raw);
    default:
      return invalid("kind");
  }
}

export async function applyAgentOperation(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: AgentOperationCommand,
  /**
   * Statements that must commit with this operation or not at all.
   *
   * A caller that needs to know whether the operation ran passes its record
   * of that here rather than writing it afterwards, because "afterwards" is
   * exactly where an interrupted turn loses it.
   */
  trailing: readonly D1PreparedStatement[] = [],
): Promise<Result<AgentOperationsSnapshot, AgentOperationsError>> {
  try {
    switch (command.kind) {
      case "create_area":
        await createArea(db, organisationId, command, trailing);
        break;
      case "publish_responsibility_scope":
        await publishResponsibilityScope(db, organisationId, command, trailing);
        break;
      case "create_skill":
        await createSkill(db, organisationId, command, trailing);
        break;
      case "publish_skill_revision":
        await publishSkillRevision(db, organisationId, command, trailing);
        break;
      case "create_agent_definition":
        await createDefinition(db, organisationId, command, trailing);
        break;
      case "publish_agent_definition_revision":
        await publishDefinitionRevision(db, organisationId, command, trailing);
        break;
      case "install_agent":
        await installAgent(db, organisationId, command, trailing);
        break;
      case "bind_skill":
        await bindSkill(db, organisationId, command, trailing);
        break;
      case "configure_cue_binding":
        await configureCueBinding(db, organisationId, command, trailing);
        break;
      case "configure_schedule_binding":
        await configureScheduleBinding(db, organisationId, command, trailing);
        break;
      case "update_cue_binding":
        await updateCueBinding(db, organisationId, command, trailing);
        break;
      case "update_schedule_binding":
        await updateScheduleBinding(db, organisationId, command, trailing);
        break;
      case "configure_installation_governance":
        await configureInstallationGovernance(
          db,
          organisationId,
          command,
          trailing,
        );
        break;
      case "configure_escalation_policy":
        await configureEscalationPolicy(db, organisationId, command, trailing);
        break;
      case "accept_configuration_proposal":
        await acceptConfigurationProposal(
          db,
          organisationId,
          command,
          trailing,
        );
        break;
      case "dismiss_configuration_proposal":
        await dismissConfigurationProposal(
          db,
          organisationId,
          command,
          trailing,
        );
        break;
      case "dispatch_manual_run":
        // Manual runs start agent work, not a configuration write; the
        // control route dispatches them through the direct-case path.
        throw new AgentOperationFailure({
          code: "agent_operation_invalid",
          field: "kind",
        });
      case "activate_agent_definition_revision":
        await activateDefinitionRevision(db, organisationId, command, trailing);
        break;
      default:
        return failUnhandled(command);
    }
    return { ok: true, value: await readAgentOperations(db, organisationId) };
  } catch (error) {
    if (error instanceof AgentOperationFailure) {
      return { ok: false, error: error.value };
    }
    if (isConstraintError(error)) {
      return {
        ok: false,
        error: { code: "agent_operation_conflict", field: "record" },
      };
    }
    return { ok: false, error: { code: "agent_operation_persistence_failed" } };
  }
}

export async function readAgentOperations(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<AgentOperationsSnapshot> {
  const areas = (
    await db
      .prepare(
        `SELECT area_id AS areaId, organisation_id AS organisationId,
            name, purpose, lifecycle, 1 AS revision, created_at AS createdAt,
            updated_at AS updatedAt
     FROM operational_area WHERE organisation_id = ? ORDER BY name, area_id`,
      )
      .bind(organisationId)
      .all<RawArea>()
  ).results.map(parseAreaRow);

  const responsibilityScopes = (
    await db
      .prepare(
        `SELECT scope_id AS scopeId, organisation_id AS organisationId, area_id AS areaId,
            scope_kind AS scopeKind, entity_type_origin AS entityTypeOrigin,
            entity_type_id AS entityTypeId, commerce_list_id AS commerceListId,
            relationship_json AS relationshipJson, list_entry_json AS listEntryJson,
            selector_id AS selectorId, selector_revision AS selectorRevision,
            selector_query_json AS selectorQueryJson, lifecycle, revision,
            published_at AS publishedAt
     FROM agent_responsibility_scope
     WHERE organisation_id = ? ORDER BY area_id, scope_id`,
      )
      .bind(organisationId)
      .all<RawResponsibilityScope>()
  ).results.map(parseResponsibilityScopeRow);

  const definitions = (
    await db
      .prepare(
        `SELECT d.agent_definition_id AS agentDefinitionId, d.organisation_id AS organisationId,
            d.display_name AS displayName, d.role, d.purpose, d.lifecycle,
            d.current_revision AS currentRevision, r.instructions,
            r.requested_capabilities_json AS requestedCapabilities,
            r.skill_refs_json AS skillRefs, r.content_digest AS contentDigest,
            r.authored_by_user_id AS authoredBy, r.created_at AS createdAt
     FROM agent_definition d
     JOIN agent_definition_revision r
       ON r.agent_definition_id = d.agent_definition_id
      AND r.revision = d.current_revision
     WHERE d.organisation_id = ? ORDER BY d.display_name, d.agent_definition_id`,
      )
      .bind(organisationId)
      .all<RawDefinition>()
  ).results.map(parseDefinitionRow);

  const installationRows = (
    await db
      .prepare(
        `SELECT installation_id AS installationId, organisation_id AS organisationId,
            agent_definition_id AS agentDefinitionId, definition_revision AS definitionRevision,
            policy_revision AS policyRevision, granted_capabilities_json AS grantedCapabilities,
            lifecycle, created_at AS createdAt, updated_at AS updatedAt
     FROM agent_installation WHERE organisation_id = ? ORDER BY installation_id`,
      )
      .bind(organisationId)
      .all<RawInstallation>()
  ).results;
  const assignmentRows = (
    await db
      .prepare(
        `SELECT i.installation_id AS installationId, i.area_id AS areaId,
            i.responsibility, i.scope_ids_json AS scopeIds,
            i.assigned_at AS assignedAt
     FROM agent_area_assignment i
     JOIN agent_installation a ON a.installation_id = i.installation_id
     WHERE a.organisation_id = ? ORDER BY i.installation_id, i.area_id`,
      )
      .bind(organisationId)
      .all<RawAssignment>()
  ).results;
  const assignments = new Map<string, RawAssignment[]>();
  for (const row of assignmentRows) {
    const installationId = text(row.installationId);
    const values = assignments.get(installationId) ?? [];
    values.push(row);
    assignments.set(installationId, values);
  }
  const installations = installationRows.map((row) => {
    const installationId = text(row.installationId);
    return parseInstallationRow(row, assignments.get(installationId) ?? []);
  });

  const skills = (
    await db
      .prepare(
        `SELECT p.skill_id AS skillId, p.organisation_id AS organisationId, p.title,
            p.sensitivity, p.lifecycle, p.current_revision AS currentRevision,
            p.created_at AS createdAt, p.updated_at AS updatedAt,
            r.markdown_body AS markdownBody, r.content_digest AS contentDigest,
            r.authored_by_user_id AS authoredBy, r.created_at AS revisionCreatedAt
     FROM skill p
     JOIN skill_revision r
       ON r.skill_id = p.skill_id AND r.revision = p.current_revision
     WHERE p.organisation_id = ? ORDER BY p.title, p.skill_id`,
      )
      .bind(organisationId)
      .all<RawSkill>()
  ).results.map(parseSkillRow);

  const bindings = (
    await db
      .prepare(
        `SELECT binding_id AS bindingId, organisation_id AS organisationId, target_kind AS targetKind,
            target_id AS targetId, skill_id AS skillId,
            skill_revision AS skillRevision, created_at AS createdAt
     FROM skill_binding WHERE organisation_id = ? ORDER BY binding_id`,
      )
      .bind(organisationId)
      .all<RawBinding>()
  ).results.map(parseBindingRow);

  const cueBindings = (
    await db
      .prepare(
        `SELECT binding_id AS bindingId, organisation_id AS organisationId, area_id AS areaId,
            scope_ids_json AS scopeIds,
            installation_id AS installationId, cue_source AS cueSource,
            cue_event_type AS cueEventType, enabled,
            instruction_body AS instructionBody, revision,
            created_at AS createdAt, updated_at AS updatedAt
     FROM cue_binding WHERE organisation_id = ? ORDER BY cue_source, cue_event_type`,
      )
      .bind(organisationId)
      .all<RawCueBinding>()
  ).results.map(parseCueBindingRow);

  const scheduleBindings = (
    await db
      .prepare(
        `SELECT ${SCHEDULE_BINDING_COLUMNS}
     FROM schedule_binding WHERE organisation_id = ?
     ORDER BY installation_id, cadence, schedule_time_key`,
      )
      .bind(organisationId)
      .all<RawScheduleBinding>()
  ).results.map(parseScheduleBindingRow);

  const governance = (
    await db
      .prepare(
        `SELECT installation_id AS installationId, organisation_id AS organisationId,
            max_session_budget_tokens AS maxSessionBudgetTokens, revision,
            updated_at AS updatedAt
     FROM agent_installation_governance WHERE organisation_id = ? ORDER BY installation_id`,
      )
      .bind(organisationId)
      .all<RawGovernance>()
  ).results.map(parseGovernanceRow);

  const escalationPolicies = (
    await db
      .prepare(
        `SELECT area_id AS areaId, organisation_id AS organisationId,
            scope_ids_json AS scopeIds,
            approval_reminder_after_ms AS approvalReminderAfterMs,
            escalate_after_ms AS escalateAfterMs, escalate_to AS escalateTo,
            revision, updated_at AS updatedAt
     FROM escalation_policy WHERE organisation_id = ? ORDER BY area_id`,
      )
      .bind(organisationId)
      .all<RawEscalationPolicy>()
  ).results.map(parseEscalationPolicyRow);

  const configurationProposals = (
    await db
      .prepare(
        `SELECT proposal_id AS proposalId, organisation_id AS organisationId,
            installation_id AS installationId, target_kind AS targetKind,
            target_id AS targetId, expected_revision AS expectedRevision,
            proposed_body AS proposedBody, rationale, status,
            created_at AS createdAt, decided_at AS decidedAt,
            published_revision AS publishedRevision
     FROM agent_configuration_proposal WHERE organisation_id = ?
     ORDER BY created_at DESC, proposal_id`,
      )
      .bind(organisationId)
      .all<RawConfigurationProposal>()
  ).results.map(parseConfigurationProposalRow);

  return {
    areas,
    responsibilityScopes,
    definitions,
    installations,
    skills,
    bindings,
    cueBindings,
    scheduleBindings,
    governance,
    escalationPolicies,
    configurationProposals,
    activeCases: [],
  };
}

export type ManualDispatchResolution = {
  readonly installationId: string;
  readonly agentDefinitionId: string;
  readonly definitionRevision: number;
  readonly policyRevision: number;
  readonly skillRefs: readonly AgentSkillRef[];
  readonly grantedCapabilities: readonly string[];
  readonly maxSessionBudgetTokens: number | null;
};

export type ConfigurationProposalSubmission = {
  readonly proposalId: string;
  readonly installationId: string;
  readonly targetKind: ConfigurationProposalTargetKind;
  readonly targetId: string;
  readonly expectedRevision: number;
  readonly proposedBody: string;
  readonly rationale: string;
  readonly now: number;
};

export type ConfigurationProposalSubmissionError =
  | { readonly code: "configuration_proposal_installation_unavailable" }
  | { readonly code: "configuration_proposal_target_forbidden" }
  | { readonly code: "configuration_proposal_target_stale" }
  | { readonly code: "configuration_proposal_invalid"; readonly field: string };

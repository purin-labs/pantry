import type { OrganisationDatabase } from "../../database-handles";
import type {
  CommerceEntityPlaneCueEvent,
  CommerceEntityPlaneCueSelector,
} from "../../cues/engine";
import type { OrganisationId } from "../../ids";
import type { Result } from "../../result";
import type { Variant } from "@seams/type-utils";
import { sameJson } from "@seams/std";
import type { AgentSkillRef } from "@seams/control-api";
import type {
  AgentResponsibilityScope,
  CueAutomationResolution,
  ManualDispatchResolution,
  SavedSelectorCueResolver,
  SavedSelectorCueResolverError,
  ScheduleAutomationResolution,
} from "../agent-operations";
import { failUnhandled } from "./failure";
import { positive, text } from "./input";
import {
  type RawCueBinding,
  type RawResponsibilityScope,
  type RawScheduleBinding,
  jsonSkillRefs,
  jsonStrings,
  parseCueBindingRow,
  parseResponsibilityScopeRow,
  parseScheduleBindingRow,
} from "./rows";

/**
 * Resolves the enabled cue binding for one organisation cue and the exact
 * installation, definition, skill, policy, grant, and budget values a new
 * Case assignment pins. Returns null when no enabled binding matches or the
 * bound installation is not active; admission then proceeds unpinned.
 */
export async function resolveCueAutomation(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  cueSource: string,
  cueEventType: string,
  entityPlane?: CommerceEntityPlaneCueEvent["payload"],
  savedSelectorResolver?: SavedSelectorCueResolver,
): Promise<CueAutomationResolution | null> {
  const row = await db
    .prepare(
      `SELECT binding.binding_id AS bindingId, binding.organisation_id AS organisationId,
            binding.area_id AS areaId, binding.scope_ids_json AS scopeIds,
            binding.installation_id AS installationId,
            binding.cue_source AS cueSource, binding.cue_event_type AS cueEventType,
            binding.enabled, binding.instruction_body AS instructionBody, binding.revision,
            binding.created_at AS createdAt, binding.updated_at AS updatedAt,
            installation.agent_definition_id AS agentDefinitionId,
            installation.definition_revision AS definitionRevision,
            installation.policy_revision AS policyRevision,
            installation.granted_capabilities_json AS grantedCapabilities,
            governance.max_session_budget_tokens AS maxSessionBudgetTokens,
            revision.skill_refs_json AS definitionSkillRefs
     FROM cue_binding AS binding
     JOIN agent_installation AS installation
       ON installation.installation_id = binding.installation_id
      AND installation.organisation_id = binding.organisation_id
      AND installation.lifecycle = 'active'
     JOIN agent_definition_revision AS revision
       ON revision.agent_definition_id = installation.agent_definition_id
      AND revision.organisation_id = installation.organisation_id
      AND revision.revision = installation.definition_revision
     LEFT JOIN agent_installation_governance AS governance
       ON governance.installation_id = installation.installation_id
     WHERE binding.organisation_id = ? AND binding.cue_source = ?
       AND binding.cue_event_type = ? AND binding.enabled = 1`,
    )
    .bind(organisationId, cueSource, cueEventType)
    .first<
      RawCueBinding & {
        readonly agentDefinitionId: unknown;
        readonly definitionRevision: unknown;
        readonly policyRevision: unknown;
        readonly grantedCapabilities: unknown;
        readonly maxSessionBudgetTokens: unknown;
        readonly definitionSkillRefs: unknown;
      }
    >();
  if (row === null) {
    return null;
  }
  const binding = parseCueBindingRow(row);
  if (entityPlane !== undefined) {
    const matched = await cueBindingMatchesEntityPlane({
      db,
      organisationId,
      scopeIds: binding.scopeIds,
      payload: entityPlane,
      savedSelectorResolver,
    });
    if (!matched.ok || !matched.value) {
      return null;
    }
  }
  return {
    binding,
    agentDefinitionId: text(row.agentDefinitionId),
    definitionRevision: positive(row.definitionRevision),
    policyRevision: positive(row.policyRevision),
    skillRefs: await resolveAutomationSkillRefs(
      db,
      organisationId,
      binding.areaId,
      row.definitionSkillRefs,
    ),
    grantedCapabilities: jsonStrings(row.grantedCapabilities),
    maxSessionBudgetTokens:
      row.maxSessionBudgetTokens === null
        ? null
        : positive(row.maxSessionBudgetTokens),
  };
}

/**
 * The skill set one automation run pins: every skill the installed definition
 * revision attaches, plus any skill the operational area binds that the
 * definition does not already carry. The definition wins on conflict, because
 * its revision is the immutable record of what the agent was published to run.
 */
async function resolveAutomationSkillRefs(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  areaId: string,
  definitionSkillRefs: unknown,
): Promise<readonly AgentSkillRef[]> {
  const refs = jsonSkillRefs(definitionSkillRefs);
  const rows = (
    await db
      .prepare(
        `SELECT skill_id AS skillId, skill_revision AS skillRevision
       FROM skill_binding
      WHERE organisation_id = ? AND target_kind = 'area' AND target_id = ?
      ORDER BY binding_id`,
      )
      .bind(organisationId, areaId)
      .all<{ readonly skillId: unknown; readonly skillRevision: unknown }>()
  ).results;
  const attached = new Set(refs.map((ref) => ref.skillId));
  const merged = [...refs];
  for (const row of rows) {
    const skillId = text(row.skillId);
    if (attached.has(skillId)) {
      continue;
    }
    attached.add(skillId);
    merged.push({ skillId, revision: positive(row.skillRevision) });
  }
  return merged;
}

async function cueBindingMatchesEntityPlane(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly scopeIds: readonly string[];
  readonly payload: CommerceEntityPlaneCueEvent["payload"];
  readonly savedSelectorResolver: SavedSelectorCueResolver | undefined;
}): Promise<Result<boolean, SavedSelectorCueResolverError>> {
  if (input.scopeIds.length === 0) {
    return { ok: true, value: false };
  }
  const placeholders = input.scopeIds.map(() => "?").join(", ");
  const rows = (
    await input.db
      .prepare(
        `SELECT scope_id AS scopeId, organisation_id AS organisationId, area_id AS areaId,
            scope_kind AS scopeKind, entity_type_origin AS entityTypeOrigin,
            entity_type_id AS entityTypeId, commerce_list_id AS commerceListId,
            relationship_json AS relationshipJson,
            list_entry_json AS listEntryJson,
            selector_id AS selectorId, selector_revision AS selectorRevision,
            selector_query_json AS selectorQueryJson, lifecycle, revision,
            published_at AS publishedAt
     FROM agent_responsibility_scope
     WHERE organisation_id = ? AND lifecycle = 'published' AND scope_id IN (${placeholders})`,
      )
      .bind(input.organisationId, ...input.scopeIds)
      .all<RawResponsibilityScope>()
  ).results;
  for (const record of rows.map(parseResponsibilityScopeRow)) {
    if (
      record.scope.kind === "saved_selector" &&
      record.scope.selector.query.kind === "saved_commerce_view"
    ) {
      const selector = input.payload.selectors[0];
      if (selector === undefined) {
        continue;
      }
      const matched = await matchesEntityPlaneScopeAtAdmission({
        organisationId: input.organisationId,
        scope: record.scope,
        selector,
        observation: input.payload.observation,
        savedSelectorResolver: input.savedSelectorResolver,
      });
      if (!matched.ok) {
        return matched;
      }
      if (matched.value) {
        return matched;
      }
      continue;
    }
    for (const selector of input.payload.selectors) {
      const matched = await matchesEntityPlaneScopeAtAdmission({
        organisationId: input.organisationId,
        scope: record.scope,
        selector,
        observation: input.payload.observation,
        savedSelectorResolver: input.savedSelectorResolver,
      });
      if (!matched.ok) {
        return matched;
      }
      if (matched.value) {
        return matched;
      }
    }
  }
  return { ok: true, value: false };
}

export async function matchesEntityPlaneScopeAtAdmission(
  input: Readonly<{
    organisationId: OrganisationId;
    scope: AgentResponsibilityScope;
    selector: CommerceEntityPlaneCueSelector;
    observation: CommerceEntityPlaneCueEvent["payload"]["observation"];
    savedSelectorResolver: SavedSelectorCueResolver | undefined;
  }>,
): Promise<Result<boolean, SavedSelectorCueResolverError>> {
  if (
    input.scope.kind !== "saved_selector" ||
    input.scope.selector.query.kind !== "saved_commerce_view"
  ) {
    return {
      ok: true,
      value: matchesEntityPlaneScope(
        input.scope,
        input.selector,
        input.observation,
      ),
    };
  }
  if (input.savedSelectorResolver === undefined) {
    return {
      ok: false,
      error: { code: "saved_selector_resolver_unavailable" },
    };
  }
  try {
    return await input.savedSelectorResolver({
      organisationId: input.organisationId,
      selector: input.scope.selector,
      observation: input.observation,
    });
  } catch {
    return { ok: false, error: { code: "saved_selector_resolver_failed" } };
  }
}

export function matchesEntityPlaneScope(
  scope: AgentResponsibilityScope,
  selector: CommerceEntityPlaneCueSelector,
  observation: CommerceEntityPlaneCueEvent["payload"]["observation"],
): boolean {
  switch (scope.kind) {
    case "entity_type":
      return (
        selector.kind === "entity_type" &&
        scope.entityTypeId.origin === selector.entityTypeId.origin &&
        scope.entityTypeId.typeId === selector.entityTypeId.typeId
      );
    case "relationship":
      return (
        selector.kind === "relationship" &&
        sameJson(scope.relationship, selector.relationship)
      );
    case "commerce_list":
      return (
        selector.kind === "commerce_list" && scope.listId === selector.listId
      );
    case "commerce_list_entry":
      return (
        selector.kind === "commerce_list_entry" &&
        sameJson(scope.entry, selector.entry)
      );
    case "saved_selector":
      if (scope.selector.query.kind === "saved_commerce_view") {
        throw new Error(
          "saved commerce view matching requires an admission resolver",
        );
      }
      return savedSelectorMatchesEntityPlane(scope.selector, observation);
    default:
      return failUnhandled(scope);
  }
}

function savedSelectorMatchesEntityPlane(
  selector: Variant<AgentResponsibilityScope, "saved_selector">["selector"],
  observation: CommerceEntityPlaneCueEvent["payload"]["observation"],
): boolean {
  switch (selector.query.kind) {
    case "entity_by_ref":
      return observation.kind === "system_entity_changed" ||
        observation.kind === "custom_entity_changed"
        ? sameJson(selector.query.reference, observation.entityRef)
        : observation.kind === "commerce_list_entry_changed"
          ? sameJson(selector.query.reference, observation.entityRef)
          : false;
    case "entity_type_page":
      return observation.kind === "system_entity_changed" ||
        observation.kind === "custom_entity_changed"
        ? sameJson(selector.query.entityTypeId, {
            origin: observation.entityRef.origin,
            typeId: observation.entityRef.typeId,
          })
        : observation.kind === "commerce_list_entry_changed"
          ? sameJson(selector.query.entityTypeId, {
              origin: observation.entityRef.origin,
              typeId: observation.entityRef.typeId,
            })
          : false;
    case "search":
      return (
        selector.query.entityTypeId !== null &&
        savedSelectorMatchesEntityType(selector.query.entityTypeId, observation)
      );
    case "commerce_list_page":
      return (
        observation.kind === "commerce_list_entry_changed" &&
        selector.query.listId === observation.entry.listId
      );
    case "relationship_traversal":
      return (
        observation.kind === "relationship_changed" &&
        (selector.query.relationshipDefinition === null ||
          sameJson(
            selector.query.relationshipDefinition,
            observation.relationship.definition,
          )) &&
        selector.query.seeds.some(
          (seed) =>
            sameJson(seed, observation.relationship.source) ||
            sameJson(seed, observation.relationship.target),
        )
      );
    case "saved_commerce_view":
      throw new Error(
        "saved commerce view matching requires an admission resolver",
      );
    case "aggregation":
    case "underclerk_context":
      return false;
    default:
      return failUnhandled(selector.query);
  }
}

function savedSelectorMatchesEntityType(
  typeId: Variant<AgentResponsibilityScope, "entity_type">["entityTypeId"],
  observation: CommerceEntityPlaneCueEvent["payload"]["observation"],
): boolean {
  if (observation.kind === "relationship_changed") {
    return false;
  }
  const entityRef = observation.entityRef;
  return (
    typeId.origin === entityRef.origin && typeId.typeId === entityRef.typeId
  );
}

/**
 * Resolves one enabled schedule binding at dispatch time and the exact
 * installation, definition, skill, policy, grant, and budget values a new
 * Case assignment pins. Returns null when the binding is missing, disabled,
 * or bound to an installation that is no longer active — the dispatcher then
 * drops the window without starting agent work.
 */
export async function resolveScheduleAutomation(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  bindingId: string,
): Promise<ScheduleAutomationResolution | null> {
  const row = await db
    .prepare(
      `SELECT binding.binding_id AS bindingId, binding.organisation_id AS organisationId,
            binding.area_id AS areaId, binding.scope_ids_json AS scopeIds,
            binding.installation_id AS installationId,
            binding.cadence, binding.minute_of_hour AS minuteOfHour,
            binding.time_of_day AS timeOfDay, binding.weekday, binding.timezone,
            binding.schedule_time_key AS scheduleTimeKey,
            binding.instruction_body AS instructionBody,
            binding.last_dispatched_window AS lastDispatchedWindow,
            binding.enabled, binding.revision,
            binding.created_at AS createdAt, binding.updated_at AS updatedAt,
            installation.agent_definition_id AS agentDefinitionId,
            installation.definition_revision AS definitionRevision,
            installation.policy_revision AS policyRevision,
            installation.granted_capabilities_json AS grantedCapabilities,
            governance.max_session_budget_tokens AS maxSessionBudgetTokens,
            revision.skill_refs_json AS definitionSkillRefs
     FROM schedule_binding AS binding
     JOIN agent_installation AS installation
       ON installation.installation_id = binding.installation_id
      AND installation.organisation_id = binding.organisation_id
      AND installation.lifecycle = 'active'
     JOIN agent_definition_revision AS revision
       ON revision.agent_definition_id = installation.agent_definition_id
      AND revision.organisation_id = installation.organisation_id
      AND revision.revision = installation.definition_revision
     LEFT JOIN agent_installation_governance AS governance
       ON governance.installation_id = installation.installation_id
     WHERE binding.organisation_id = ? AND binding.binding_id = ? AND binding.enabled = 1`,
    )
    .bind(organisationId, bindingId)
    .first<
      RawScheduleBinding & {
        readonly agentDefinitionId: unknown;
        readonly definitionRevision: unknown;
        readonly policyRevision: unknown;
        readonly grantedCapabilities: unknown;
        readonly maxSessionBudgetTokens: unknown;
        readonly definitionSkillRefs: unknown;
      }
    >();
  if (row === null) {
    return null;
  }
  const binding = parseScheduleBindingRow(row);
  return {
    binding,
    agentDefinitionId: text(row.agentDefinitionId),
    definitionRevision: positive(row.definitionRevision),
    policyRevision: positive(row.policyRevision),
    skillRefs: await resolveAutomationSkillRefs(
      db,
      organisationId,
      binding.areaId,
      row.definitionSkillRefs,
    ),
    grantedCapabilities: jsonStrings(row.grantedCapabilities),
    maxSessionBudgetTokens:
      row.maxSessionBudgetTokens === null
        ? null
        : positive(row.maxSessionBudgetTokens),
  };
}

/**
 * Resolves one active installation for an operator-initiated manual run
 * (plan 30 phase 4) with the same pin shape the cue and schedule paths use.
 * Returns null when the installation is missing or not active.
 */
export async function resolveManualDispatchAutomation(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  installationId: string,
): Promise<ManualDispatchResolution | null> {
  const row = await db
    .prepare(
      `SELECT installation.installation_id AS installationId,
            installation.agent_definition_id AS agentDefinitionId,
            installation.definition_revision AS definitionRevision,
            installation.policy_revision AS policyRevision,
            installation.granted_capabilities_json AS grantedCapabilities,
            governance.max_session_budget_tokens AS maxSessionBudgetTokens,
            revision.skill_refs_json AS definitionSkillRefs
     FROM agent_installation AS installation
     JOIN agent_definition_revision AS revision
       ON revision.agent_definition_id = installation.agent_definition_id
      AND revision.organisation_id = installation.organisation_id
      AND revision.revision = installation.definition_revision
     LEFT JOIN agent_installation_governance AS governance
       ON governance.installation_id = installation.installation_id
     WHERE installation.organisation_id = ? AND installation.installation_id = ?
       AND installation.lifecycle = 'active'`,
    )
    .bind(organisationId, installationId)
    .first<{
      readonly installationId: unknown;
      readonly agentDefinitionId: unknown;
      readonly definitionRevision: unknown;
      readonly policyRevision: unknown;
      readonly grantedCapabilities: unknown;
      readonly maxSessionBudgetTokens: unknown;
      readonly definitionSkillRefs: unknown;
    }>();
  if (row === null) {
    return null;
  }
  return {
    installationId: text(row.installationId),
    agentDefinitionId: text(row.agentDefinitionId),
    definitionRevision: positive(row.definitionRevision),
    policyRevision: positive(row.policyRevision),
    skillRefs: jsonSkillRefs(row.definitionSkillRefs),
    grantedCapabilities: jsonStrings(row.grantedCapabilities),
    maxSessionBudgetTokens:
      row.maxSessionBudgetTokens === null
        ? null
        : positive(row.maxSessionBudgetTokens),
  };
}

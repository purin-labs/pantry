import { responsibilityScopeCommerce } from "./scope-commerce";
import type { CommerceTypeParts } from "@purin-labs/kernel/commerce-type-parts";

type CommerceListEntryRef = CommerceTypeParts["listEntryRef"];
type CommerceRelationshipRef = CommerceTypeParts["relationshipRef"];
import type { Result } from "@purin-labs/kernel/result";
import {
  isScheduleWeekday,
  isTimeOfDay,
  isValidTimeZone,
} from "../../schedules/window";
import { isRecord, positiveIntegerOrNull } from "@purin-labs/std";
import type { AgentSkillRef, ScheduleSpec } from "@purin-labs/control-api";
import type {
  AgentOperationInput,
  AgentOperationsError,
  AgentResponsibilityScope,
} from "../agent-operations";
import { fail } from "./failure";

export function parseAreaInput(
  raw: Record<string, unknown>,
): Result<AgentOperationInput, AgentOperationsError> {
  const name = boundedString(raw.name, "name", 2, 120);
  const purpose = boundedString(raw.purpose, "purpose", 2, 2_000);
  return name !== null && purpose !== null
    ? { ok: true, value: { kind: "create_area", name, purpose } }
    : invalid(name === null ? "name" : "purpose");
}

export function parseResponsibilityScopeInput(
  raw: Record<string, unknown>,
): Result<AgentOperationInput, AgentOperationsError> {
  const areaId = boundedString(raw.areaId, "areaId", 1, 200);
  const scope = parseResponsibilityScope(raw.scope);
  return areaId !== null && scope !== null
    ? {
        ok: true,
        value: { kind: "publish_responsibility_scope", areaId, scope },
      }
    : invalid(areaId === null ? "areaId" : "scope");
}

function parseResponsibilityRelationship(
  raw: unknown,
): CommerceRelationshipRef | null {
  return responsibilityScopeCommerce.use().parseRelationship(raw);
}

function parseResponsibilityListEntry(
  raw: unknown,
): CommerceListEntryRef | null {
  return responsibilityScopeCommerce.use().parseListEntry(raw);
}

export function parseResponsibilityRelationshipJson(
  raw: unknown,
): CommerceRelationshipRef | null {
  if (typeof raw !== "string") {
    return null;
  }
  try {
    return parseResponsibilityRelationship(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseResponsibilityListEntryJson(
  raw: unknown,
): CommerceListEntryRef | null {
  if (typeof raw !== "string") {
    return null;
  }
  try {
    return parseResponsibilityListEntry(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseResponsibilityScope(
  raw: unknown,
): AgentResponsibilityScope | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return null;
  }
  switch (raw.kind) {
    case "entity_type": {
      if (!isRecord(raw.entityTypeId)) {
        return null;
      }
      const origin = raw.entityTypeId.origin;
      const typeId = boundedString(raw.entityTypeId.typeId, "typeId", 1, 200);
      return typeId === null || (origin !== "system" && origin !== "custom")
        ? null
        : { kind: "entity_type", entityTypeId: { origin, typeId } };
    }
    case "relationship": {
      const relationship = parseResponsibilityRelationship(raw.relationship);
      return relationship === null
        ? null
        : { kind: "relationship", relationship };
    }
    case "commerce_list": {
      const listId = boundedString(raw.listId, "listId", 1, 200);
      return listId === null ? null : { kind: "commerce_list", listId };
    }
    case "commerce_list_entry": {
      const entry = parseResponsibilityListEntry(raw.entry);
      return entry === null ? null : { kind: "commerce_list_entry", entry };
    }
    case "saved_selector": {
      if (!isRecord(raw.selector)) {
        return null;
      }
      const selectorId = boundedString(
        raw.selector.selectorId,
        "selectorId",
        1,
        200,
      );
      const revision = positiveIntegerOrNull(raw.selector.revision);
      const query = responsibilityScopeCommerce
        .use()
        .parseSelectorQuery(raw.selector.query);
      return selectorId === null || revision === null || query === null
        ? null
        : {
            kind: "saved_selector",
            selector: { selectorId, revision, query },
          };
    }
    default:
      return null;
  }
}

export function parseSkillInput(
  raw: Record<string, unknown>,
): Result<AgentOperationInput, AgentOperationsError> {
  const sensitivity =
    raw.sensitivity === "ordinary" || raw.sensitivity === "sensitive"
      ? raw.sensitivity
      : null;
  if (sensitivity === null) {
    return invalid("sensitivity");
  }
  const title = boundedString(raw.title, "title", 2, 120);
  const markdownBody = boundedString(
    raw.markdownBody,
    "markdownBody",
    1,
    50_000,
  );
  if (title === null) {
    return invalid("title");
  }
  if (markdownBody === null) {
    return invalid("markdownBody");
  }
  return {
    ok: true,
    value: { kind: "create_skill", title, sensitivity, markdownBody },
  };
}

export function parseSkillRevisionInput(
  raw: Record<string, unknown>,
): Result<AgentOperationInput, AgentOperationsError> {
  const skillId = boundedString(raw.skillId, "skillId", 1, 200);
  const expectedRevision = positiveIntegerOrNull(raw.expectedRevision);
  const markdownBody = boundedString(
    raw.markdownBody,
    "markdownBody",
    1,
    50_000,
  );
  if (skillId === null) {
    return invalid("skillId");
  }
  if (expectedRevision === null) {
    return invalid("expectedRevision");
  }
  if (markdownBody === null) {
    return invalid("markdownBody");
  }
  return {
    ok: true,
    value: {
      kind: "publish_skill_revision",
      skillId,
      expectedRevision,
      markdownBody,
    },
  };
}

/**
 * Decodes the complete skill set a definition revision attaches. Each entry
 * names one skill and the exact revision to run, so publication is the only
 * way to attach, replace, or remove a skill.
 */
function skillRefArray(raw: unknown): readonly AgentSkillRef[] | null {
  if (!Array.isArray(raw) || raw.length > 32) {
    return null;
  }
  const refs: AgentSkillRef[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      return null;
    }
    const skillId = boundedString(entry.skillId, "skillId", 1, 200);
    const revision = positiveIntegerOrNull(entry.revision);
    if (skillId === null || revision === null) {
      return null;
    }
    refs.push({ skillId, revision });
  }
  return new Set(refs.map((ref) => ref.skillId)).size === refs.length
    ? refs
    : null;
}

export function parseDefinitionInput(
  raw: Record<string, unknown>,
): Result<AgentOperationInput, AgentOperationsError> {
  const displayName = boundedString(raw.displayName, "displayName", 2, 120);
  const role = boundedString(raw.role, "role", 2, 120);
  const purpose = boundedString(raw.purpose, "purpose", 2, 2_000);
  const instructions = boundedString(
    raw.instructions,
    "instructions",
    1,
    50_000,
  );
  const requestedCapabilities = stringArray(
    raw.requestedCapabilities,
    "requestedCapabilities",
    32,
  );
  const skillRefs = skillRefArray(raw.skillRefs);
  if (displayName === null) {
    return invalid("displayName");
  }
  if (role === null) {
    return invalid("role");
  }
  if (purpose === null) {
    return invalid("purpose");
  }
  if (instructions === null) {
    return invalid("instructions");
  }
  if (requestedCapabilities === null) {
    return invalid("requestedCapabilities");
  }
  if (skillRefs === null) {
    return invalid("skillRefs");
  }
  return {
    ok: true,
    value: {
      kind: "create_agent_definition",
      displayName,
      role,
      purpose,
      instructions,
      requestedCapabilities,
      skillRefs,
    },
  };
}

export function parseDefinitionRevisionInput(
  raw: Record<string, unknown>,
): Result<AgentOperationInput, AgentOperationsError> {
  const agentDefinitionId = boundedString(
    raw.agentDefinitionId,
    "agentDefinitionId",
    1,
    200,
  );
  const expectedRevision = positiveIntegerOrNull(raw.expectedRevision);
  const instructions = boundedString(
    raw.instructions,
    "instructions",
    1,
    50_000,
  );
  const requestedCapabilities = stringArray(
    raw.requestedCapabilities,
    "requestedCapabilities",
    32,
  );
  const skillRefs = skillRefArray(raw.skillRefs);
  if (agentDefinitionId === null) {
    return invalid("agentDefinitionId");
  }
  if (expectedRevision === null) {
    return invalid("expectedRevision");
  }
  if (instructions === null) {
    return invalid("instructions");
  }
  if (requestedCapabilities === null) {
    return invalid("requestedCapabilities");
  }
  if (skillRefs === null) {
    return invalid("skillRefs");
  }
  return {
    ok: true,
    value: {
      kind: "publish_agent_definition_revision",
      agentDefinitionId,
      expectedRevision,
      instructions,
      requestedCapabilities,
      skillRefs,
    },
  };
}

export function parseActivationInput(
  raw: Record<string, unknown>,
): Result<AgentOperationInput, AgentOperationsError> {
  const installationId = boundedString(
    raw.installationId,
    "installationId",
    1,
    200,
  );
  const expectedDefinitionRevision = positiveIntegerOrNull(
    raw.expectedDefinitionRevision,
  );
  const definitionRevision = positiveIntegerOrNull(raw.definitionRevision);
  const skillRefs = skillRefArray(raw.skillRefs);
  if (installationId === null) {
    return invalid("installationId");
  }
  if (expectedDefinitionRevision === null) {
    return invalid("expectedDefinitionRevision");
  }
  if (definitionRevision === null) {
    return invalid("definitionRevision");
  }
  if (skillRefs === null) {
    return invalid("skillRefs");
  }
  return {
    ok: true,
    value: {
      kind: "activate_agent_definition_revision",
      installationId,
      expectedDefinitionRevision,
      definitionRevision,
      skillRefs,
    },
  };
}

export function parseInstallationInput(
  raw: Record<string, unknown>,
): Result<AgentOperationInput, AgentOperationsError> {
  const agentDefinitionId = boundedString(
    raw.agentDefinitionId,
    "agentDefinitionId",
    1,
    200,
  );
  const areaId = boundedString(raw.areaId, "areaId", 1, 200);
  const responsibility = boundedString(
    raw.responsibility,
    "responsibility",
    2,
    2_000,
  );
  const scopeIds = stringArray(raw.scopeIds, "scopeIds", 64);
  const definitionRevision = positiveIntegerOrNull(raw.definitionRevision);
  const policyRevision = positiveIntegerOrNull(raw.policyRevision);
  const grantedCapabilities = stringArray(
    raw.grantedCapabilities,
    "grantedCapabilities",
    32,
  );
  if (agentDefinitionId === null) {
    return invalid("agentDefinitionId");
  }
  if (areaId === null) {
    return invalid("areaId");
  }
  if (responsibility === null) {
    return invalid("responsibility");
  }
  if (scopeIds === null) {
    return invalid("scopeIds");
  }
  if (definitionRevision === null) {
    return invalid("definitionRevision");
  }
  if (policyRevision === null) {
    return invalid("policyRevision");
  }
  if (grantedCapabilities === null) {
    return invalid("grantedCapabilities");
  }
  return {
    ok: true,
    value: {
      kind: "install_agent",
      agentDefinitionId,
      definitionRevision,
      areaId,
      responsibility,
      scopeIds,
      policyRevision,
      grantedCapabilities,
    },
  };
}

export function parseBindingInput(
  raw: Record<string, unknown>,
): Result<AgentOperationInput, AgentOperationsError> {
  const targetKind = raw.targetKind === "area" ? raw.targetKind : null;
  const targetId = boundedString(raw.targetId, "targetId", 1, 200);
  const skillId = boundedString(raw.skillId, "skillId", 1, 200);
  const skillRevision = positiveIntegerOrNull(raw.skillRevision);
  if (targetKind === null) {
    return invalid("targetKind");
  }
  if (targetId === null) {
    return invalid("targetId");
  }
  if (skillId === null) {
    return invalid("skillId");
  }
  if (skillRevision === null) {
    return invalid("skillRevision");
  }
  return {
    ok: true,
    value: { kind: "bind_skill", targetKind, targetId, skillId, skillRevision },
  };
}

export function parseCueBindingInput(
  raw: Record<string, unknown>,
): Result<AgentOperationInput, AgentOperationsError> {
  const areaId = boundedString(raw.areaId, "areaId", 1, 200);
  const scopeIds = nonEmptyStringArray(raw.scopeIds, "scopeIds", 64);
  const installationId = boundedString(
    raw.installationId,
    "installationId",
    1,
    200,
  );
  const cueSource = boundedString(raw.cueSource, "cueSource", 1, 64);
  const cueEventType = boundedString(raw.cueEventType, "cueEventType", 1, 64);
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : null;
  const instructionBody = parseInstructionBody(raw.instructionBody);
  if (!instructionBody.ok) {
    return instructionBody;
  }
  if (areaId === null) {
    return invalid("areaId");
  }
  if (scopeIds === null) {
    return invalid("scopeIds");
  }
  if (installationId === null) {
    return invalid("installationId");
  }
  if (cueSource === null) {
    return invalid("cueSource");
  }
  if (cueEventType === null) {
    return invalid("cueEventType");
  }
  if (enabled === null) {
    return invalid("enabled");
  }
  return {
    ok: true,
    value: {
      kind: "configure_cue_binding",
      areaId,
      scopeIds,
      installationId,
      cueSource,
      cueEventType,
      enabled,
      instructionBody: instructionBody.value,
    },
  };
}

export function parseScheduleBindingInput(
  raw: Record<string, unknown>,
): Result<AgentOperationInput, AgentOperationsError> {
  const areaId = boundedString(raw.areaId, "areaId", 1, 200);
  const scopeIds = nonEmptyStringArray(raw.scopeIds, "scopeIds", 64);
  const installationId = boundedString(
    raw.installationId,
    "installationId",
    1,
    200,
  );
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : null;
  const spec = parseScheduleSpecInput(raw.spec);
  if (!spec.ok) {
    return spec;
  }
  const instructionBody = parseInstructionBody(raw.instructionBody);
  if (!instructionBody.ok) {
    return instructionBody;
  }
  if (areaId === null) {
    return invalid("areaId");
  }
  if (scopeIds === null) {
    return invalid("scopeIds");
  }
  if (installationId === null) {
    return invalid("installationId");
  }
  if (enabled === null) {
    return invalid("enabled");
  }
  return {
    ok: true,
    value: {
      kind: "configure_schedule_binding",
      areaId,
      scopeIds,
      installationId,
      spec: spec.value,
      enabled,
      instructionBody: instructionBody.value,
    },
  };
}

export function parseBindingUpdateInput(
  raw: Record<string, unknown>,
  kind: "update_cue_binding" | "update_schedule_binding",
): Result<AgentOperationInput, AgentOperationsError> {
  const bindingId = boundedString(raw.bindingId, "bindingId", 1, 200);
  const expectedRevision = positiveIntegerOrNull(raw.expectedRevision);
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : null;
  const instructionBody = parseInstructionBody(raw.instructionBody);
  if (!instructionBody.ok) {
    return instructionBody;
  }
  if (bindingId === null) {
    return invalid("bindingId");
  }
  if (expectedRevision === null) {
    return invalid("expectedRevision");
  }
  if (enabled === null) {
    return invalid("enabled");
  }
  return {
    ok: true,
    value: {
      kind,
      bindingId,
      expectedRevision,
      enabled,
      instructionBody: instructionBody.value,
    },
  };
}

/**
 * Optional trigger instruction body. Null (or absent) preserves the derived
 * objective; a present body must be a bounded non-empty string.
 */
function parseInstructionBody(
  raw: unknown,
): Result<string | null, AgentOperationsError> {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null };
  }
  const body = boundedString(raw, "instructionBody", 1, 20_000);
  return body === null ? invalid("instructionBody") : { ok: true, value: body };
}

function parseScheduleSpecInput(
  raw: unknown,
): Result<ScheduleSpec, AgentOperationsError> {
  if (!isRecord(raw)) {
    return invalid("spec");
  }
  switch (raw.cadence) {
    case "hourly": {
      const minuteOfHour = raw.minuteOfHour;
      return typeof minuteOfHour === "number" &&
        Number.isSafeInteger(minuteOfHour) &&
        minuteOfHour >= 0 &&
        minuteOfHour <= 59
        ? { ok: true, value: { cadence: "hourly", minuteOfHour } }
        : invalid("spec.minuteOfHour");
    }
    case "daily": {
      if (!isTimeOfDay(raw.timeOfDay)) {
        return invalid("spec.timeOfDay");
      }
      if (!isValidTimeZone(raw.timezone)) {
        return invalid("spec.timezone");
      }
      return {
        ok: true,
        value: {
          cadence: "daily",
          timeOfDay: raw.timeOfDay,
          timezone: raw.timezone,
        },
      };
    }
    case "weekly": {
      if (!isScheduleWeekday(raw.weekday)) {
        return invalid("spec.weekday");
      }
      if (!isTimeOfDay(raw.timeOfDay)) {
        return invalid("spec.timeOfDay");
      }
      if (!isValidTimeZone(raw.timezone)) {
        return invalid("spec.timezone");
      }
      return {
        ok: true,
        value: {
          cadence: "weekly",
          weekday: raw.weekday,
          timeOfDay: raw.timeOfDay,
          timezone: raw.timezone,
        },
      };
    }
    default:
      return invalid("spec.cadence");
  }
}

export function parseGovernanceInput(
  raw: Record<string, unknown>,
): Result<AgentOperationInput, AgentOperationsError> {
  const installationId = boundedString(
    raw.installationId,
    "installationId",
    1,
    200,
  );
  const maxSessionBudgetTokens = positiveIntegerOrNull(
    raw.maxSessionBudgetTokens,
  );
  if (installationId === null) {
    return invalid("installationId");
  }
  if (maxSessionBudgetTokens === null) {
    return invalid("maxSessionBudgetTokens");
  }
  return {
    ok: true,
    value: {
      kind: "configure_installation_governance",
      installationId,
      maxSessionBudgetTokens,
    },
  };
}

export function parseEscalationInput(
  raw: Record<string, unknown>,
): Result<AgentOperationInput, AgentOperationsError> {
  const areaId = boundedString(raw.areaId, "areaId", 1, 200);
  const scopeIds = nonEmptyStringArray(raw.scopeIds, "scopeIds", 64);
  const approvalReminderAfterMs = positiveIntegerOrNull(
    raw.approvalReminderAfterMs,
  );
  const escalateAfterMs = positiveIntegerOrNull(raw.escalateAfterMs);
  if (areaId === null) {
    return invalid("areaId");
  }
  if (scopeIds === null) {
    return invalid("scopeIds");
  }
  if (approvalReminderAfterMs === null) {
    return invalid("approvalReminderAfterMs");
  }
  if (escalateAfterMs === null || escalateAfterMs < approvalReminderAfterMs) {
    return invalid("escalateAfterMs");
  }
  return {
    ok: true,
    value: {
      kind: "configure_escalation_policy",
      areaId,
      scopeIds,
      approvalReminderAfterMs,
      escalateAfterMs,
    },
  };
}

export function parseManualRunInput(
  raw: Record<string, unknown>,
): Result<AgentOperationInput, AgentOperationsError> {
  const installationId = boundedString(
    raw.installationId,
    "installationId",
    1,
    200,
  );
  const instructionBody = boundedString(
    raw.instructionBody,
    "instructionBody",
    1,
    20_000,
  );
  if (installationId === null) {
    return invalid("installationId");
  }
  if (instructionBody === null) {
    return invalid("instructionBody");
  }
  return {
    ok: true,
    value: { kind: "dispatch_manual_run", installationId, instructionBody },
  };
}

export function parseProposalDecisionInput(
  raw: Record<string, unknown>,
  kind: "accept_configuration_proposal" | "dismiss_configuration_proposal",
): Result<AgentOperationInput, AgentOperationsError> {
  const proposalId = boundedString(raw.proposalId, "proposalId", 1, 200);
  return proposalId !== null
    ? { ok: true, value: { kind, proposalId } }
    : invalid("proposalId");
}

export function boundedString(
  value: unknown,
  _field: string,
  min: number,
  max: number,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
}

export function stringArray(
  value: unknown,
  _field: string,
  max: number,
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > max) {
    return null;
  }
  const values = value.map((item) =>
    typeof item === "string" ? item.trim() : null,
  );
  return values.every(
    (item): item is string =>
      item !== null && item.length > 0 && item.length <= 200,
  )
    ? [...new Set(values)]
    : null;
}

function nonEmptyStringArray(
  value: unknown,
  field: string,
  max: number,
): readonly string[] | null {
  const values = stringArray(value, field, max);
  return values !== null && values.length > 0 ? values : null;
}

export function invalid(field: string): {
  ok: false;
  error: AgentOperationsError;
} {
  return { ok: false, error: { code: "agent_operation_invalid", field } };
}

export function text(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : fail("text");
}

export function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fail("integer");
}

export function positive(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fail("positive");
}

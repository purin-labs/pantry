import { parseCommerceGraphQuery } from "../../commerce/entity-plane/routes";
import { parseOrganisationId, type OrganisationId } from "../../ids";
import {
  isScheduleWeekday,
  isTimeOfDay,
  isValidTimeZone,
} from "../../schedules/window";
import { isRecord } from "@seams/std";
import type { AgentSkillRef, ScheduleSpec } from "@seams/control-api";
import type {
  AgentConfigurationProposal,
  AgentDefinition,
  AgentInstallation,
  AgentLifecycle,
  AgentResponsibilityScope,
  AgentResponsibilityScopeRecord,
  CaseAssignmentPin,
  CueBinding,
  EscalationPolicy,
  InstallationGovernance,
  InstallationLifecycle,
  OperationalArea,
  ScheduleBinding,
  Skill,
  SkillBinding,
  SkillLifecycle,
  SkillSensitivity,
} from "../agent-operations";
import { fail, failUnhandled } from "./failure";
import {
  integer,
  parseResponsibilityListEntryJson,
  parseResponsibilityRelationshipJson,
  positive,
  stringArray,
  text,
} from "./input";

export type RawArea = Record<string, unknown> & {
  areaId: unknown;
  organisationId: unknown;
  name: unknown;
  purpose: unknown;
  lifecycle: unknown;
  revision: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

export type RawResponsibilityScope = Record<string, unknown> & {
  scopeId: unknown;
  organisationId: unknown;
  areaId: unknown;
  scopeKind: unknown;
  entityTypeOrigin: unknown;
  entityTypeId: unknown;
  commerceListId: unknown;
  relationshipJson: unknown;
  listEntryJson: unknown;
  selectorId: unknown;
  selectorRevision: unknown;
  selectorQueryJson: unknown;
  lifecycle: unknown;
  revision: unknown;
  publishedAt: unknown;
};

export type RawDefinition = Record<string, unknown> & {
  agentDefinitionId: unknown;
  organisationId: unknown;
  displayName: unknown;
  role: unknown;
  purpose: unknown;
  lifecycle: unknown;
  currentRevision: unknown;
  instructions: unknown;
  requestedCapabilities: unknown;
  skillRefs: unknown;
  contentDigest: unknown;
  authoredBy: unknown;
  createdAt: unknown;
};

export type RawInstallation = Record<string, unknown> & {
  installationId: unknown;
  organisationId: unknown;
  agentDefinitionId: unknown;
  definitionRevision: unknown;
  policyRevision: unknown;
  grantedCapabilities: unknown;
  lifecycle: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

export type RawAssignment = Record<string, unknown> & {
  installationId: unknown;
  areaId: unknown;
  responsibility: unknown;
  scopeIds: unknown;
  assignedAt: unknown;
};

export type RawSkill = Record<string, unknown> & {
  skillId: unknown;
  organisationId: unknown;
  title: unknown;
  sensitivity: unknown;
  lifecycle: unknown;
  currentRevision: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  markdownBody: unknown;
  contentDigest: unknown;
  authoredBy: unknown;
  revisionCreatedAt: unknown;
};

export type RawBinding = Record<string, unknown> & {
  bindingId: unknown;
  organisationId: unknown;
  targetKind: unknown;
  targetId: unknown;
  skillId: unknown;
  skillRevision: unknown;
  createdAt: unknown;
};

export type RawCueBinding = Record<string, unknown> & {
  bindingId: unknown;
  organisationId: unknown;
  areaId: unknown;
  scopeIds: unknown;
  installationId: unknown;
  cueSource: unknown;
  cueEventType: unknown;
  enabled: unknown;
  instructionBody: unknown;
  revision: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

export type RawScheduleBinding = Record<string, unknown> & {
  bindingId: unknown;
  organisationId: unknown;
  areaId: unknown;
  scopeIds: unknown;
  installationId: unknown;
  cadence: unknown;
  minuteOfHour: unknown;
  timeOfDay: unknown;
  weekday: unknown;
  timezone: unknown;
  scheduleTimeKey: unknown;
  instructionBody: unknown;
  lastDispatchedWindow: unknown;
  enabled: unknown;
  revision: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

export type RawGovernance = Record<string, unknown> & {
  installationId: unknown;
  organisationId: unknown;
  maxSessionBudgetTokens: unknown;
  revision: unknown;
  updatedAt: unknown;
};

export type RawEscalationPolicy = Record<string, unknown> & {
  areaId: unknown;
  organisationId: unknown;
  scopeIds: unknown;
  approvalReminderAfterMs: unknown;
  escalateAfterMs: unknown;
  escalateTo: unknown;
  revision: unknown;
  updatedAt: unknown;
};

export type RawConfigurationProposal = Record<string, unknown> & {
  proposalId: unknown;
  organisationId: unknown;
  installationId: unknown;
  targetKind: unknown;
  targetId: unknown;
  expectedRevision: unknown;
  proposedBody: unknown;
  rationale: unknown;
  status: unknown;
  createdAt: unknown;
  decidedAt: unknown;
  publishedRevision: unknown;
};

export type RawCaseAssignmentPin = Record<string, unknown> & {
  organisationId: unknown;
  assignmentId: unknown;
  caseId: unknown;
  installationId: unknown;
  agentDefinitionId: unknown;
  definitionRevision: unknown;
  policyRevision: unknown;
  skillRefs: unknown;
  grantedCapabilities: unknown;
  maxSessionBudgetTokens: unknown;
  pinnedAt: unknown;
};

export function parseAreaRow(row: RawArea): OperationalArea {
  return {
    areaId: text(row.areaId),
    organisationId: organisation(row.organisationId),
    name: text(row.name),
    purpose: text(row.purpose),
    lifecycle: lifecycle(row.lifecycle),
    revision: positive(row.revision),
    createdAt: integer(row.createdAt),
    updatedAt: integer(row.updatedAt),
  };
}

export function parseResponsibilityScopeRow(
  row: RawResponsibilityScope,
): AgentResponsibilityScopeRecord {
  const scope = parseStoredResponsibilityScope(row);
  const lifecycleValue =
    row.lifecycle === "published" || row.lifecycle === "archived"
      ? row.lifecycle
      : fail("scope lifecycle");
  return {
    scopeId: text(row.scopeId),
    organisationId: organisation(row.organisationId),
    areaId: text(row.areaId),
    scope,
    lifecycle: lifecycleValue,
    revision: positive(row.revision),
    publishedAt: integer(row.publishedAt),
  };
}

export function parseDefinitionRow(row: RawDefinition): AgentDefinition {
  return {
    agentDefinitionId: text(row.agentDefinitionId),
    organisationId: organisation(row.organisationId),
    displayName: text(row.displayName),
    role: text(row.role),
    purpose: text(row.purpose),
    lifecycle: lifecycle(row.lifecycle),
    currentRevision: {
      agentDefinitionId: text(row.agentDefinitionId),
      revision: positive(row.currentRevision),
      instructions: text(row.instructions),
      requestedCapabilities: jsonStrings(row.requestedCapabilities),
      skillRefs: jsonSkillRefs(row.skillRefs),
      contentDigest: text(row.contentDigest),
      authoredBy: text(row.authoredBy),
      createdAt: integer(row.createdAt),
    },
  };
}

export function parseInstallationRow(
  row: RawInstallation,
  assignments: readonly RawAssignment[],
): AgentInstallation {
  return {
    installationId: text(row.installationId),
    organisationId: organisation(row.organisationId),
    agentDefinitionId: text(row.agentDefinitionId),
    definitionRevision: positive(row.definitionRevision),
    policyRevision: positive(row.policyRevision),
    grantedCapabilities: jsonStrings(row.grantedCapabilities),
    lifecycle: installationLifecycle(row.lifecycle),
    areaAssignments: assignments.map((assignment) => ({
      areaId: text(assignment.areaId),
      responsibility: text(assignment.responsibility),
      scopeIds: jsonStrings(assignment.scopeIds),
      assignedAt: integer(assignment.assignedAt),
    })),
    createdAt: integer(row.createdAt),
    updatedAt: integer(row.updatedAt),
  };
}

export function parseSkillRow(row: RawSkill): Skill {
  return {
    skillId: text(row.skillId),
    organisationId: organisation(row.organisationId),
    title: text(row.title),
    sensitivity: sensitivity(row.sensitivity),
    lifecycle: skillLifecycle(row.lifecycle),
    currentRevision: {
      skillId: text(row.skillId),
      revision: positive(row.currentRevision),
      markdownBody: text(row.markdownBody),
      contentDigest: text(row.contentDigest),
      authoredBy: text(row.authoredBy),
      createdAt: integer(row.revisionCreatedAt),
    },
    createdAt: integer(row.createdAt),
    updatedAt: integer(row.updatedAt),
  };
}

export function parseBindingRow(row: RawBinding): SkillBinding {
  const targetKind =
    row.targetKind === "area" ? row.targetKind : fail("target kind");
  return {
    bindingId: text(row.bindingId),
    organisationId: organisation(row.organisationId),
    targetKind,
    targetId: text(row.targetId),
    skillId: text(row.skillId),
    skillRevision: positive(row.skillRevision),
    createdAt: integer(row.createdAt),
  };
}

export function parseCueBindingRow(row: RawCueBinding): CueBinding {
  return {
    bindingId: text(row.bindingId),
    organisationId: organisation(row.organisationId),
    areaId: text(row.areaId),
    scopeIds: jsonStrings(row.scopeIds),
    installationId: text(row.installationId),
    cueSource: text(row.cueSource),
    cueEventType: text(row.cueEventType),
    enabled: sqliteBoolean(row.enabled),
    instructionBody:
      row.instructionBody === null ? null : text(row.instructionBody),
    revision: positive(row.revision),
    createdAt: integer(row.createdAt),
    updatedAt: integer(row.updatedAt),
  };
}

export function parseScheduleBindingRow(
  row: RawScheduleBinding,
): ScheduleBinding {
  return {
    bindingId: text(row.bindingId),
    organisationId: organisation(row.organisationId),
    areaId: text(row.areaId),
    scopeIds: jsonStrings(row.scopeIds),
    installationId: text(row.installationId),
    spec: parseStoredScheduleSpec(row),
    scheduleTimeKey: text(row.scheduleTimeKey),
    enabled: sqliteBoolean(row.enabled),
    instructionBody:
      row.instructionBody === null ? null : text(row.instructionBody),
    lastDispatchedWindow:
      row.lastDispatchedWindow === null ? null : text(row.lastDispatchedWindow),
    revision: positive(row.revision),
    createdAt: integer(row.createdAt),
    updatedAt: integer(row.updatedAt),
  };
}

function parseStoredScheduleSpec(row: RawScheduleBinding): ScheduleSpec {
  switch (row.cadence) {
    case "hourly": {
      const minuteOfHour = row.minuteOfHour;
      if (
        !Number.isSafeInteger(minuteOfHour) ||
        Number(minuteOfHour) < 0 ||
        Number(minuteOfHour) > 59
      ) {
        return fail("schedule minute");
      }
      return { cadence: "hourly", minuteOfHour: Number(minuteOfHour) };
    }
    case "daily": {
      if (!isTimeOfDay(row.timeOfDay) || !isValidTimeZone(row.timezone)) {
        return fail("schedule time");
      }
      return {
        cadence: "daily",
        timeOfDay: row.timeOfDay,
        timezone: row.timezone,
      };
    }
    case "weekly": {
      if (
        !isScheduleWeekday(row.weekday) ||
        !isTimeOfDay(row.timeOfDay) ||
        !isValidTimeZone(row.timezone)
      ) {
        return fail("schedule time");
      }
      return {
        cadence: "weekly",
        weekday: row.weekday,
        timeOfDay: row.timeOfDay,
        timezone: row.timezone,
      };
    }
    default:
      return fail("cadence");
  }
}

export function parseGovernanceRow(row: RawGovernance): InstallationGovernance {
  return {
    installationId: text(row.installationId),
    organisationId: organisation(row.organisationId),
    maxSessionBudgetTokens: positive(row.maxSessionBudgetTokens),
    revision: positive(row.revision),
    updatedAt: integer(row.updatedAt),
  };
}

export function parseEscalationPolicyRow(
  row: RawEscalationPolicy,
): EscalationPolicy {
  if (row.escalateTo !== "organisation_owner") {
    fail("escalate target");
  }
  return {
    areaId: text(row.areaId),
    scopeIds: jsonStrings(row.scopeIds),
    organisationId: organisation(row.organisationId),
    approvalReminderAfterMs: positive(row.approvalReminderAfterMs),
    escalateAfterMs: positive(row.escalateAfterMs),
    escalateTo: "organisation_owner",
    revision: positive(row.revision),
    updatedAt: integer(row.updatedAt),
  };
}

export function parseConfigurationProposalRow(
  row: RawConfigurationProposal,
): AgentConfigurationProposal {
  const targetKind =
    row.targetKind === "agent_instructions" ||
    row.targetKind === "skill_markdown"
      ? row.targetKind
      : fail("proposal target kind");
  const status =
    row.status === "open" ||
    row.status === "accepted" ||
    row.status === "dismissed"
      ? row.status
      : fail("proposal status");
  return {
    proposalId: text(row.proposalId),
    organisationId: organisation(row.organisationId),
    installationId: text(row.installationId),
    targetKind,
    targetId: text(row.targetId),
    expectedRevision: positive(row.expectedRevision),
    proposedBody: text(row.proposedBody),
    rationale: text(row.rationale),
    status,
    createdAt: integer(row.createdAt),
    decidedAt: row.decidedAt === null ? null : integer(row.decidedAt),
    publishedRevision:
      row.publishedRevision === null ? null : positive(row.publishedRevision),
  };
}

export function parseCaseAssignmentPinRow(
  row: RawCaseAssignmentPin,
): CaseAssignmentPin {
  return {
    organisationId: organisation(row.organisationId),
    assignmentId: text(row.assignmentId),
    caseId: text(row.caseId),
    installationId: text(row.installationId),
    agentDefinitionId: text(row.agentDefinitionId),
    definitionRevision: positive(row.definitionRevision),
    policyRevision: positive(row.policyRevision),
    skillRefs: jsonSkillRefs(row.skillRefs),
    grantedCapabilities: jsonStrings(row.grantedCapabilities),
    maxSessionBudgetTokens:
      row.maxSessionBudgetTokens === null
        ? null
        : positive(row.maxSessionBudgetTokens),
    pinnedAt: integer(row.pinnedAt),
  };
}

function sqliteBoolean(value: unknown): boolean {
  if (value === 1 || value === true) {
    return true;
  }
  if (value === 0 || value === false) {
    return false;
  }
  return fail("boolean");
}

function parseStoredResponsibilityScope(
  row: RawResponsibilityScope,
): AgentResponsibilityScope {
  const scopeKind = row.scopeKind;
  if (scopeKind === "entity_type") {
    const origin = row.entityTypeOrigin;
    if (
      (origin !== "system" && origin !== "custom") ||
      row.entityTypeId === null
    ) {
      return fail("entity type scope");
    }
    return {
      kind: "entity_type",
      entityTypeId: { origin, typeId: text(row.entityTypeId) },
    };
  }
  if (scopeKind === "commerce_list") {
    return row.commerceListId === null
      ? fail("commerce list scope")
      : { kind: "commerce_list", listId: text(row.commerceListId) };
  }
  if (scopeKind === "relationship") {
    return {
      kind: "relationship",
      relationship:
        parseResponsibilityRelationshipJson(row.relationshipJson) ??
        fail("relationship scope"),
    };
  }
  if (scopeKind === "commerce_list_entry") {
    return {
      kind: "commerce_list_entry",
      entry:
        parseResponsibilityListEntryJson(row.listEntryJson) ??
        fail("commerce list entry scope"),
    };
  }
  if (scopeKind === "saved_selector") {
    const selectorId =
      row.selectorId === null ? fail("selector scope") : text(row.selectorId);
    const revision =
      row.selectorRevision === null
        ? fail("selector scope")
        : positive(row.selectorRevision);
    let queryValue: unknown;
    try {
      queryValue = JSON.parse(text(row.selectorQueryJson));
    } catch {
      return fail("selector query");
    }
    const query = parseCommerceGraphQuery(queryValue);
    return query.ok
      ? {
          kind: "saved_selector",
          selector: { selectorId, revision, query: query.value },
        }
      : fail("selector query");
  }
  return fail("scope kind");
}

export function responsibilityScopeColumns(scope: AgentResponsibilityScope): {
  readonly scopeKind: AgentResponsibilityScope["kind"];
  readonly entityTypeOrigin: string | null;
  readonly entityTypeId: string | null;
  readonly commerceListId: string | null;
  readonly relationshipJson: string | null;
  readonly listEntryJson: string | null;
  readonly selectorId: string | null;
  readonly selectorRevision: number | null;
  readonly selectorQueryJson: string | null;
} {
  switch (scope.kind) {
    case "entity_type":
      return {
        scopeKind: scope.kind,
        entityTypeOrigin: scope.entityTypeId.origin,
        entityTypeId: scope.entityTypeId.typeId,
        commerceListId: null,
        relationshipJson: null,
        listEntryJson: null,
        selectorId: null,
        selectorRevision: null,
        selectorQueryJson: null,
      };
    case "relationship":
      return {
        scopeKind: scope.kind,
        entityTypeOrigin: null,
        entityTypeId: null,
        commerceListId: null,
        relationshipJson: JSON.stringify(scope.relationship),
        listEntryJson: null,
        selectorId: null,
        selectorRevision: null,
        selectorQueryJson: null,
      };
    case "commerce_list":
      return {
        scopeKind: scope.kind,
        entityTypeOrigin: null,
        entityTypeId: null,
        commerceListId: scope.listId,
        relationshipJson: null,
        listEntryJson: null,
        selectorId: null,
        selectorRevision: null,
        selectorQueryJson: null,
      };
    case "commerce_list_entry":
      return {
        scopeKind: scope.kind,
        entityTypeOrigin: null,
        entityTypeId: null,
        commerceListId: null,
        relationshipJson: null,
        listEntryJson: JSON.stringify(scope.entry),
        selectorId: null,
        selectorRevision: null,
        selectorQueryJson: null,
      };
    case "saved_selector":
      return {
        scopeKind: scope.kind,
        entityTypeOrigin: null,
        entityTypeId: null,
        commerceListId: null,
        relationshipJson: null,
        listEntryJson: null,
        selectorId: scope.selector.selectorId,
        selectorRevision: scope.selector.revision,
        selectorQueryJson: JSON.stringify(scope.selector.query),
      };
    default:
      return failUnhandled(scope);
  }
}

export function organisation(value: unknown): OrganisationId {
  const parsed = parseOrganisationId(text(value));
  return parsed.ok ? parsed.value : fail("organisation id");
}

function lifecycle(value: unknown): AgentLifecycle {
  return value === "active" || value === "archived" ? value : fail("lifecycle");
}

function skillLifecycle(value: unknown): SkillLifecycle {
  return value === "published" || value === "archived"
    ? value
    : fail("skill lifecycle");
}

function installationLifecycle(value: unknown): InstallationLifecycle {
  return value === "active" || value === "suspended" || value === "archived"
    ? value
    : fail("installation lifecycle");
}

function sensitivity(value: unknown): SkillSensitivity {
  return value === "ordinary" || value === "sensitive"
    ? value
    : fail("sensitivity");
}

export function jsonStrings(value: unknown): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(text(value));
    const result = stringArray(parsed, "json", 64);
    return result ?? fail("json strings");
  } catch {
    return fail("json strings");
  }
}

export function jsonSkillRefs(value: unknown): readonly AgentSkillRef[] {
  const refs = parseStoredSkillRefs(value);
  return refs === null ? fail("json skill refs") : refs;
}

export function parseStoredSkillRefs(
  value: unknown,
): readonly AgentSkillRef[] | null {
  if (typeof value !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > 64) {
    return null;
  }
  const refs: AgentSkillRef[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) {
      return null;
    }
    const { skillId, revision } = entry;
    if (typeof skillId !== "string" || skillId.length === 0) {
      return null;
    }
    if (
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision <= 0
    ) {
      return null;
    }
    refs.push({ skillId, revision });
  }
  return refs;
}

export function parseStoredStringArray(
  value: unknown,
): readonly string[] | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return stringArray(parsed, "stored", 64);
  } catch {
    return null;
  }
}

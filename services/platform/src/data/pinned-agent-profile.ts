import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { Result } from "@purin-labs/kernel/result";

import type { OrganisationId } from "@purin-labs/kernel/ids";
import {
  readCaseAssignmentPin,
  recordCaseAssignmentPin,
} from "./agent-operations/case-assignment-pins";
import type { AgentSkillRef } from "@purin-labs/control-api";
import type { Variant } from "@purin-labs/type-utils";
/**
 * One skill body an agent runs this turn, read at the exact revision its
 * definition revision pinned.
 */
type PinnedAgentSkill = Readonly<{
  skillId: string;
  revision: number;
  title: string;
  markdownBody: string;
}>;

/**
 * Everything an installed agent contributes to one turn: the operator-published
 * instructions, the skill bodies the pinned definition revision attaches, and
 * the capabilities the installation was granted.
 *
 * Resolved before the turn starts so the session runs the configuration the
 * operator published, not whatever the console happens to hold at settlement.
 */
export type PinnedAgentProfile = Readonly<{
  installationId: string;
  agentDefinitionId: string;
  definitionRevision: number;
  displayName: string;
  role: string;
  purpose: string;
  instructions: string;
  skills: readonly PinnedAgentSkill[];
  grantedCapabilities: readonly string[];
}>;

type PinnedAgentProfileError = Readonly<{
  code:
    | "pinned_agent_installation_not_found"
    | "pinned_agent_selection_ambiguous"
    | "pinned_agent_selection_changed"
    | "pinned_agent_revision_missing"
    | "pinned_agent_skill_missing";
}>;

type PinnedAgentProfileResult =
  | Readonly<{ ok: true; value: PinnedAgentProfile }>
  | Readonly<{ ok: false; error: PinnedAgentProfileError }>;

/**
 * Reads the configuration one active installation runs, at the definition
 * revision the installation pins. A skill revision the definition names but
 * that no longer resolves fails the read rather than silently running a
 * partial instruction set.
 */
export async function resolvePinnedAgentProfile(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  installationId: string,
  skillRefs: readonly AgentSkillRef[],
  /**
   * The definition revision to run.
   *
   * A Case that recorded a pin passes the revision from that pin, so
   * activating an update does not rewrite the instructions of a conversation
   * already under way. Null adopts whatever the installation currently points
   * at, which is what a new assignment wants.
   */
  definitionRevision: number | null,
): Promise<PinnedAgentProfileResult> {
  const row = await db
    .prepare(
      `SELECT installation.installation_id AS installationId,
            installation.agent_definition_id AS agentDefinitionId,
            revision.revision AS definitionRevision,
            installation.granted_capabilities_json AS grantedCapabilities,
            definition.display_name AS displayName,
            definition.role AS role,
            definition.purpose AS purpose,
            revision.instructions AS instructions
       FROM agent_installation AS installation
       JOIN agent_definition AS definition
         ON definition.agent_definition_id = installation.agent_definition_id
        AND definition.organisation_id = installation.organisation_id
        AND definition.lifecycle = 'active'
       JOIN agent_definition_revision AS revision
         ON revision.agent_definition_id = installation.agent_definition_id
        AND revision.organisation_id = installation.organisation_id
        AND revision.revision = COALESCE(?, installation.definition_revision)
      WHERE installation.organisation_id = ? AND installation.installation_id = ?
        AND installation.lifecycle = 'active'`,
    )
    .bind(definitionRevision, organisationId, installationId)
    .first<{
      readonly installationId: unknown;
      readonly agentDefinitionId: unknown;
      readonly definitionRevision: unknown;
      readonly grantedCapabilities: unknown;
      readonly displayName: unknown;
      readonly role: unknown;
      readonly purpose: unknown;
      readonly instructions: unknown;
    }>();
  if (row === null) {
    return {
      ok: false,
      error: { code: "pinned_agent_installation_not_found" },
    };
  }
  const grantedCapabilities = parseStoredStrings(row.grantedCapabilities);
  if (
    typeof row.installationId !== "string" ||
    typeof row.agentDefinitionId !== "string" ||
    typeof row.definitionRevision !== "number" ||
    typeof row.displayName !== "string" ||
    typeof row.role !== "string" ||
    typeof row.purpose !== "string" ||
    typeof row.instructions !== "string" ||
    grantedCapabilities === null
  ) {
    return { ok: false, error: { code: "pinned_agent_revision_missing" } };
  }
  const skills = await readPinnedSkills(db, organisationId, skillRefs);
  if (!skills.ok) {
    return skills;
  }
  return {
    ok: true,
    value: {
      installationId: row.installationId,
      agentDefinitionId: row.agentDefinitionId,
      definitionRevision: row.definitionRevision,
      displayName: row.displayName,
      role: row.role,
      purpose: row.purpose,
      instructions: row.instructions,
      skills: skills.value,
      grantedCapabilities,
    },
  };
}

async function readPinnedSkills(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  skillRefs: readonly AgentSkillRef[],
): Promise<
  | Readonly<{ ok: true; value: readonly PinnedAgentSkill[] }>
  | Readonly<{ ok: false; error: PinnedAgentProfileError }>
> {
  if (skillRefs.length === 0) {
    return { ok: true, value: [] };
  }
  const predicate = skillRefs
    .map(() => "(revision.skill_id = ? AND revision.revision = ?)")
    .join(" OR ");
  const bindings = skillRefs.flatMap((ref) => [ref.skillId, ref.revision]);
  const rows = (
    await db
      .prepare(
        `SELECT revision.skill_id AS skillId, revision.revision AS revision,
            revision.markdown_body AS markdownBody, skill.title AS title
       FROM skill_revision AS revision
       JOIN skill
         ON skill.skill_id = revision.skill_id
        AND skill.organisation_id = revision.organisation_id
      WHERE revision.organisation_id = ? AND (${predicate})`,
      )
      .bind(organisationId, ...bindings)
      .all<{
        readonly skillId: unknown;
        readonly revision: unknown;
        readonly markdownBody: unknown;
        readonly title: unknown;
      }>()
  ).results;
  const byId = new Map<string, PinnedAgentSkill>();
  for (const row of rows) {
    if (
      typeof row.skillId !== "string" ||
      typeof row.revision !== "number" ||
      typeof row.markdownBody !== "string" ||
      typeof row.title !== "string"
    ) {
      return { ok: false, error: { code: "pinned_agent_skill_missing" } };
    }
    byId.set(row.skillId, {
      skillId: row.skillId,
      revision: row.revision,
      title: row.title,
      markdownBody: row.markdownBody,
    });
  }
  // Preserve the definition revision's order so the composed prompt is stable.
  const skills: PinnedAgentSkill[] = [];
  for (const ref of skillRefs) {
    const skill = byId.get(ref.skillId);
    if (skill === undefined || skill.revision !== ref.revision) {
      return { ok: false, error: { code: "pinned_agent_skill_missing" } };
    }
    skills.push(skill);
  }
  return { ok: true, value: skills };
}

/**
 * Composes the system prompt one turn runs: the platform's own harness rules
 * first, then the operator-published agent instructions, then each attached
 * skill. Platform rules lead so organisation-authored text extends them and never
 * appears to replace them.
 */
export function composeAgentInstructions(
  harnessInstructions: string,
  profile: PinnedAgentProfile | null,
): string {
  if (profile === null) {
    return harnessInstructions;
  }
  const sections = [
    harnessInstructions,
    `# ${profile.displayName}\n\nRole: ${profile.role}\nPurpose: ${profile.purpose}`,
    `## Instructions\n\n${profile.instructions}`,
    ...profile.skills.map(
      (skill) => `## Skill: ${skill.title}\n\n${skill.markdownBody}`,
    ),
  ];
  return sections.join("\n\n");
}

function parseStoredStrings(value: unknown): readonly string[] | null {
  if (typeof value !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed.every((entry) => typeof entry === "string")
    ? (parsed as readonly string[])
    : null;
}

export type CaseTurnAgentProfileResolution =
  | { readonly kind: "resolved"; readonly profile: PinnedAgentProfile }
  | { readonly kind: "unselected" }
  | { readonly kind: "unavailable"; readonly error: PinnedAgentProfileError };

export type AgentProfileSelection =
  | {
      readonly kind: "automatic";
      readonly displayName?: never;
      readonly installationId?: never;
    }
  | {
      readonly kind: "named";
      readonly displayName: string;
      readonly installationId?: never;
    }
  | {
      readonly kind: "installed";
      readonly installationId: string;
      readonly displayName?: never;
    };

export function parseAgentProfileSelection(
  text: string,
): AgentProfileSelection {
  const authored = text.trimStart().replace(/^(?:<@[A-Z0-9]+>\s*)+/u, "");
  const address = /^Agent ([^:\n]{1,128}):\s*/iu.exec(authored);
  const displayName = address?.[1]?.trim();
  if (displayName === undefined || displayName.length === 0) {
    return { kind: "automatic" };
  }
  return { kind: "named", displayName };
}

/**
 * What the agent profile of a Case turn is resolved from, and the rule that
 * decides which configuration an interactive Case runs under.
 *
 * An assignment keeps the configuration it started with, so later turns are
 * not silently re-pointed at a different agent or a different revision
 * mid-conversation, and replay restores what was recorded. That configuration
 * is one of two things:
 *
 * - A pin: installation, definition revision, and skills. A new assignment
 *   adopts the explicitly addressed installation or the organisation's sole
 *   active installation, and records that choice.
 * - Platform instructions alone. Without an explicit address, zero or
 *   multiple installations leave a new assignment on them, and nothing is
 *   recorded. The Case's own record of the assignment is the decision.
 *
 * So an assignment that exists and holds no pin stays on platform
 * instructions: an installation that becomes active later does not change
 * it. An explicit address in such a conversation names a configuration the
 * conversation does not run, and the turn is refused with
 * `pinned_agent_selection_changed`. The agent is used from a new conversation.
 */
type CaseTurnAgentProfileInput = Readonly<{
  caseId: string;
  assignmentId: string;
  /**
   * Whether the Case holds this assignment already. The Case owns that fact,
   * so the caller reads it there. A caller that pins its agent before the
   * Case holds the assignment passes `new`: its assignment with no pin
   * cannot have started.
   */
  assignment: "new" | "existing";
  selection: AgentProfileSelection;
  now: number;
}>;

/**
 * What a Case turn's agent profile resolves to, read without changing
 * anything. A first selection is not pinned yet: `pin` holds what to record.
 */
type CaseTurnAgentProfileRead =
  | {
      readonly kind: "settled";
      readonly resolution: CaseTurnAgentProfileResolution;
      readonly pin?: never;
    }
  | {
      readonly kind: "unpinned";
      readonly resolution: Variant<CaseTurnAgentProfileResolution, "resolved">;
      readonly pin: Parameters<typeof recordCaseAssignmentPin>[1];
    };

export async function resolveCaseTurnAgentProfile(
  scope: OrganisationExecutionScope,
  input: CaseTurnAgentProfileInput,
): Promise<CaseTurnAgentProfileResolution> {
  return pinCaseTurnAgentProfile(
    scope,
    await readCaseTurnAgentProfile(scope, input),
  );
}

/** Record a first selection so later turns of the Case keep its revision. */
export async function pinCaseTurnAgentProfile(
  scope: OrganisationExecutionScope,
  read: CaseTurnAgentProfileRead,
): Promise<CaseTurnAgentProfileResolution> {
  if (read.kind === "unpinned") await recordCaseAssignmentPin(scope, read.pin);
  return read.resolution;
}

/**
 * Read the agent profile for a Case turn. It changes nothing, so a caller may
 * run it beside other reads and pin the result once the turn is certain.
 */
export async function readCaseTurnAgentProfile(
  scope: OrganisationExecutionScope,
  input: CaseTurnAgentProfileInput,
): Promise<CaseTurnAgentProfileRead> {
  const db = scope.database;
  const organisationId = scope.organisationId;
  const pin = await readCaseAssignmentPin(
    db,
    organisationId,
    input.assignmentId,
  );
  if (pin !== null) {
    if (
      input.selection.kind === "installed" &&
      pin.installationId !== input.selection.installationId
    ) {
      return settledProfile({
        kind: "unavailable",
        error: { code: "pinned_agent_selection_changed" },
      });
    }
    // The recorded revision, not the installation's current one: activating an
    // update must not rewrite a conversation already under way.
    const pinned = await resolvePinnedAgentProfile(
      db,
      organisationId,
      pin.installationId,
      pin.skillRefs,
      pin.definitionRevision,
    );
    return settledProfile(
      pinned.ok
        ? { kind: "resolved", profile: pinned.value }
        : { kind: "unavailable", error: pinned.error },
    );
  }
  if (input.assignment === "existing") {
    // The assignment started on platform instructions and keeps them.
    return settledProfile(
      input.selection.kind === "automatic"
        ? { kind: "unselected" }
        : {
            kind: "unavailable",
            error: { code: "pinned_agent_selection_changed" },
          },
    );
  }
  const selected = await readInteractiveAgentInstallation(
    db,
    organisationId,
    input.selection,
  );
  if (!selected.ok) {
    return settledProfile({ kind: "unavailable", error: selected.error });
  }
  if (selected.value === null) {
    return settledProfile({ kind: "unselected" });
  }
  const resolved = await resolvePinnedAgentProfile(
    db,
    organisationId,
    selected.value.installationId,
    selected.value.skillRefs,
    null,
  );
  if (!resolved.ok) {
    return settledProfile({ kind: "unavailable", error: resolved.error });
  }
  return {
    kind: "unpinned",
    resolution: { kind: "resolved", profile: resolved.value },
    pin: {
      organisationId,
      assignmentId: input.assignmentId,
      caseId: input.caseId,
      installationId: resolved.value.installationId,
      agentDefinitionId: resolved.value.agentDefinitionId,
      definitionRevision: resolved.value.definitionRevision,
      policyRevision: selected.value.policyRevision,
      skillRefs: selected.value.skillRefs,
      grantedCapabilities: resolved.value.grantedCapabilities,
      maxSessionBudgetTokens: selected.value.maxSessionBudgetTokens,
      pinnedAt: input.now,
    },
  };
}

function settledProfile(
  resolution: CaseTurnAgentProfileResolution,
): CaseTurnAgentProfileRead {
  return { kind: "settled", resolution };
}

async function readInteractiveAgentInstallation(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  selection: AgentProfileSelection,
): Promise<
  Result<
    Readonly<{
      installationId: string;
      skillRefs: readonly AgentSkillRef[];
      policyRevision: number;
      maxSessionBudgetTokens: number | null;
    }> | null,
    PinnedAgentProfileError
  >
> {
  const rows = (
    await db
      .prepare(
        `SELECT installation.installation_id AS installationId,
            installation.policy_revision AS policyRevision,
            revision.skill_refs_json AS skillRefs,
            governance.max_session_budget_tokens AS maxSessionBudgetTokens
       FROM agent_installation AS installation
       JOIN agent_definition AS definition
         ON definition.agent_definition_id = installation.agent_definition_id
        AND definition.organisation_id = installation.organisation_id
        AND definition.lifecycle = 'active'
       JOIN agent_definition_revision AS revision
         ON revision.agent_definition_id = installation.agent_definition_id
        AND revision.organisation_id = installation.organisation_id
        AND revision.revision = installation.definition_revision
       LEFT JOIN agent_installation_governance AS governance
         ON governance.installation_id = installation.installation_id
      WHERE installation.organisation_id = ? AND installation.lifecycle = 'active'
        AND (? IS NULL OR definition.display_name = ? COLLATE NOCASE)
        AND (? IS NULL OR installation.installation_id = ?)
      LIMIT 2`,
      )
      .bind(
        organisationId,
        selection.kind === "named" ? selection.displayName : null,
        selection.kind === "named" ? selection.displayName : null,
        selection.kind === "installed" ? selection.installationId : null,
        selection.kind === "installed" ? selection.installationId : null,
      )
      .all<{
        readonly installationId: unknown;
        readonly policyRevision: unknown;
        readonly skillRefs: unknown;
        readonly maxSessionBudgetTokens: unknown;
      }>()
  ).results;
  if (rows.length !== 1) {
    if (selection.kind !== "automatic") {
      return {
        ok: false,
        error: {
          code:
            rows.length === 0
              ? "pinned_agent_installation_not_found"
              : "pinned_agent_selection_ambiguous",
        },
      };
    }
    return { ok: true, value: null };
  }
  const row = rows[0];
  if (
    row === undefined ||
    typeof row.installationId !== "string" ||
    typeof row.policyRevision !== "number"
  ) {
    return { ok: false, error: { code: "pinned_agent_revision_missing" } };
  }
  const skillRefs = parseStoredSkillRefs(row.skillRefs);
  if (skillRefs === null) {
    return { ok: false, error: { code: "pinned_agent_revision_missing" } };
  }
  return {
    ok: true,
    value: {
      installationId: row.installationId,
      skillRefs,
      policyRevision: row.policyRevision,
      maxSessionBudgetTokens:
        typeof row.maxSessionBudgetTokens === "number"
          ? row.maxSessionBudgetTokens
          : null,
    },
  };
}

function parseStoredSkillRefs(value: unknown): readonly AgentSkillRef[] | null {
  if (typeof value !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const refs: AgentSkillRef[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const { skillId, revision } = entry as Record<string, unknown>;
    if (typeof skillId !== "string" || typeof revision !== "number") {
      return null;
    }
    refs.push({ skillId, revision });
  }
  return refs;
}

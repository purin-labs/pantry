import type { OrganisationDatabase } from "../database-handles";
import {
  MERCHANT_AGENT_DISPLAY_NAME,
  MERCHANT_AGENT_INSTRUCTIONS,
  MERCHANT_AGENT_PURPOSE,
  MERCHANT_AGENT_ROLE,
  MERCHANT_AGENT_SKILL_NAMES,
  merchantAgentSkill,
  type MerchantAgentSkillName,
} from "./merchant-agent-skills";

import { organisationIdUniquePart, type OrganisationId } from "../ids";
import type { Result } from "../result";
import {
  applyAgentOperation,
  readAgentOperations,
  type AgentOperationsError,
} from "./agent-operations";
import type { AgentSkillRef } from "@seams/control-api";
/**
 * The capability Sous Chef requests and must be granted to read commerce records.
 * Reports and entity context share it, so one grant covers both read tools.
 */
export const MERCHANT_AGENT_READ_CAPABILITY = "commerce.entity_plane.context";

/**
 * Sous Chef's record identifiers, one set per organisation.
 *
 * The area, agent, installation and skill tables all key on a bare id rather
 * than on (organisation_id, id), so a fixed constant would let the first organisation's
 * install take the id and every later organisation's fail with a bare conflict.
 * Deriving from the organisation is preferred over a digest: a repeat install for
 * the same organisation then fails closed rather than quietly standing up a second
 * Sous Chef beside the first.
 */
function merchantAgentSuffix(organisationId: OrganisationId): string {
  return organisationIdUniquePart(organisationId).replaceAll("-", "_");
}

export function merchantAgentAreaId(organisationId: OrganisationId): string {
  return `area_urk_merchant_operations_${merchantAgentSuffix(organisationId)}`;
}

export function merchantAgentAgentId(organisationId: OrganisationId): string {
  return `agent_urk_${merchantAgentSuffix(organisationId)}`;
}

export function merchantAgentInstallationId(organisationId: OrganisationId): string {
  return `installation_urk_${merchantAgentSuffix(organisationId)}`;
}

export function merchantAgentSkillId(
  organisationId: OrganisationId,
  name: MerchantAgentSkillName,
): string {
  return `skill_urk_${name}_${merchantAgentSuffix(organisationId)}`;
}

export type MerchantAgentInstallInput = Readonly<{
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  /** The control identity performing the installation. */
  actorUserId: string;
  policyRevision: number;
  /** The merchant skills to attach, in the order Sous Chef should load them. */
  skills: readonly MerchantAgentSkillName[];
  now: number;
}>;

/**
 * Installs Sous Chef through the ordinary agent configuration commands.
 *
 * Every step is a command an operator could issue from the Portal, so an
 * installed Sous Chef is an ordinary agent with no privileged path of its own. The
 * read capability is requested by the definition and granted to the
 * installation explicitly; nothing here widens a grant on its own.
 */
export async function installMerchantAgent(
  input: MerchantAgentInstallInput,
): Promise<
  Result<
    Readonly<{ installationId: string; skillRefs: readonly AgentSkillRef[] }>,
    AgentOperationsError
  >
> {
  // Each step commits on its own, so an install interrupted midway leaves
  // some of its rows behind. Because every id is derived from the organisation, a
  // row that already exists is this install's own earlier progress, and the
  // step is skipped rather than refused — otherwise a partial install could
  // never be finished.
  const existing = await readAgentOperations(input.db, input.organisationId);
  const areaId = merchantAgentAreaId(input.organisationId);
  if (!existing.areas.some((area) => area.areaId === areaId)) {
    const area = await apply(
      input,
      {
        kind: "create_area",
        name: "Merchant operations",
        purpose:
          "Answer merchant operating questions and stage governed changes.",
      },
      areaId,
    );
    if (!area.ok) return area;
  }

  const skillRefs: AgentSkillRef[] = [];
  for (const name of input.skills) {
    const skill = merchantAgentSkill(name);
    const skillId = merchantAgentSkillId(input.organisationId, name);
    if (!existing.skills.some((entry) => entry.skillId === skillId)) {
      const created = await apply(
        input,
        {
          kind: "create_skill",
          title: skill.title,
          sensitivity: "ordinary",
          markdownBody: skill.markdownBody,
        },
        skillId,
      );
      if (!created.ok) return created;
    }
    skillRefs.push({ skillId, revision: 1 });
  }

  const agentId = merchantAgentAgentId(input.organisationId);
  const installationId = merchantAgentInstallationId(input.organisationId);
  if (
    existing.definitions.some((entry) => entry.agentDefinitionId === agentId)
  ) {
    if (
      existing.installations.some(
        (entry) => entry.installationId === installationId,
      )
    ) {
      return { ok: true, value: { installationId, skillRefs } };
    }
  } else {
    const definition = await apply(
      input,
      {
        kind: "create_agent_definition",
        displayName: MERCHANT_AGENT_DISPLAY_NAME,
        role: MERCHANT_AGENT_ROLE,
        purpose: MERCHANT_AGENT_PURPOSE,
        instructions: MERCHANT_AGENT_INSTRUCTIONS,
        requestedCapabilities: [MERCHANT_AGENT_READ_CAPABILITY],
        skillRefs,
      },
      agentId,
    );
    if (!definition.ok) return definition;
  }

  const installed = await apply(
    input,
    {
      kind: "install_agent",
      agentDefinitionId: agentId,
      definitionRevision: 1,
      areaId,
      responsibility: "Own merchant operating questions and staged changes.",
      scopeIds: [],
      policyRevision: input.policyRevision,
      grantedCapabilities: [MERCHANT_AGENT_READ_CAPABILITY],
    },
    installationId,
  );
  if (!installed.ok) return installed;

  return { ok: true, value: { installationId, skillRefs } };
}

/** All five merchant skills, in the order the parity target lists them. */
export function merchantAgentDefaultSkills(): readonly MerchantAgentSkillName[] {
  return MERCHANT_AGENT_SKILL_NAMES;
}

async function apply(
  input: MerchantAgentInstallInput,
  command: Parameters<typeof applyAgentOperation>[2] extends infer T
    ? T extends {
        operationId: string;
        actorUserId: string;
        now: number;
      }
      ? Omit<T, "operationId" | "actorUserId" | "now">
      : never
    : never,
  operationId: string,
): Promise<Result<true, AgentOperationsError>> {
  const result = await applyAgentOperation(input.db, input.organisationId, {
    ...command,
    operationId,
    actorUserId: input.actorUserId,
    now: input.now,
  });
  return result.ok ? { ok: true, value: true } : result;
}

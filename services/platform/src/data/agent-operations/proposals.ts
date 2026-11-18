import type { OrganisationDatabase } from "../../database-handles";
import type { OrganisationId } from "../../ids";
import type { Result } from "../../result";
import type { Variant } from "@seams/type-utils";
import type {
  AgentConfigurationProposal,
  AgentOperationCommand,
  ConfigurationProposalSubmission,
  ConfigurationProposalSubmissionError,
} from "../agent-operations";
import { publishDefinitionRevision } from "./definitions";
import { AgentOperationFailure, commitWithTrailing } from "./failure";
import { boundedString, positive, text } from "./input";
import {
  type RawConfigurationProposal,
  parseConfigurationProposalRow,
  parseStoredSkillRefs,
  parseStoredStringArray,
} from "./rows";
import { publishSkillRevision } from "./skills";

/**
 * Records an agent-authored configuration proposal. The proposing installation
 * may target only its own definition's instructions or a skill bound to
 * that definition or an assigned area; grants, budgets, approval thresholds,
 * and integrations are structurally impossible targets. Submission never
 * publishes a revision — an authorized merchant decides through
 * accept/dismiss commands. Identical replay returns the original proposal.
 */
export async function submitAgentConfigurationProposal(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  submission: ConfigurationProposalSubmission,
): Promise<
  Result<AgentConfigurationProposal, ConfigurationProposalSubmissionError>
> {
  const proposedBody = boundedString(
    submission.proposedBody,
    "proposedBody",
    1,
    50_000,
  );
  const rationale = boundedString(submission.rationale, "rationale", 2, 2_000);
  if (proposedBody === null || rationale === null) {
    return {
      ok: false,
      error: {
        code: "configuration_proposal_invalid",
        field: proposedBody === null ? "proposedBody" : "rationale",
      },
    };
  }
  const installation = await db
    .prepare(
      `SELECT agent_definition_id AS agentDefinitionId
     FROM agent_installation
     WHERE installation_id = ? AND organisation_id = ? AND lifecycle = 'active'`,
    )
    .bind(submission.installationId, organisationId)
    .first<{ readonly agentDefinitionId: unknown }>();
  if (installation === null) {
    return {
      ok: false,
      error: { code: "configuration_proposal_installation_unavailable" },
    };
  }
  const target = await resolveProposalTarget(
    db,
    organisationId,
    submission,
    text(installation.agentDefinitionId),
  );
  if (!target.ok) {
    return target;
  }
  if (target.value !== submission.expectedRevision) {
    return {
      ok: false,
      error: { code: "configuration_proposal_target_stale" },
    };
  }
  await db
    .prepare(
      `INSERT OR IGNORE INTO agent_configuration_proposal (
       proposal_id, organisation_id, installation_id, target_kind, target_id,
       expected_revision, proposed_body, rationale, status, created_at,
       decided_at, decided_by_user_id, published_revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL, NULL)`,
    )
    .bind(
      submission.proposalId,
      organisationId,
      submission.installationId,
      submission.targetKind,
      submission.targetId,
      submission.expectedRevision,
      proposedBody,
      rationale,
      submission.now,
    )
    .run();
  const stored = await db
    .prepare(
      `SELECT proposal_id AS proposalId, organisation_id AS organisationId,
            installation_id AS installationId, target_kind AS targetKind,
            target_id AS targetId, expected_revision AS expectedRevision,
            proposed_body AS proposedBody, rationale, status,
            created_at AS createdAt, decided_at AS decidedAt,
            published_revision AS publishedRevision
     FROM agent_configuration_proposal WHERE proposal_id = ? AND organisation_id = ?`,
    )
    .bind(submission.proposalId, organisationId)
    .first<RawConfigurationProposal>();
  if (stored === null) {
    return {
      ok: false,
      error: { code: "configuration_proposal_invalid", field: "proposalId" },
    };
  }
  return { ok: true, value: parseConfigurationProposalRow(stored) };
}

async function resolveProposalTarget(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  submission: ConfigurationProposalSubmission,
  installationDefinitionId: string,
): Promise<Result<number, ConfigurationProposalSubmissionError>> {
  if (submission.targetKind === "agent_instructions") {
    if (submission.targetId !== installationDefinitionId) {
      return {
        ok: false,
        error: { code: "configuration_proposal_target_forbidden" },
      };
    }
    const definition = await db
      .prepare(
        `SELECT current_revision AS currentRevision FROM agent_definition
       WHERE agent_definition_id = ? AND organisation_id = ? AND lifecycle = 'active'`,
      )
      .bind(submission.targetId, organisationId)
      .first<{ readonly currentRevision: unknown }>();
    return definition === null
      ? {
          ok: false,
          error: { code: "configuration_proposal_target_forbidden" },
        }
      : { ok: true, value: positive(definition.currentRevision) };
  }
  const skill = await db
    .prepare(
      `SELECT skill.current_revision AS currentRevision
     FROM skill
     WHERE skill.skill_id = ? AND skill.organisation_id = ?
       AND skill.lifecycle = 'published'
       AND EXISTS (
         SELECT 1 FROM skill_binding AS binding
         WHERE binding.organisation_id = skill.organisation_id
           AND binding.skill_id = skill.skill_id
           AND binding.target_kind = 'area'
           AND binding.target_id IN (
             SELECT assignment.area_id FROM agent_area_assignment AS assignment
             WHERE assignment.installation_id = ?
           )
       )`,
    )
    .bind(submission.targetId, organisationId, submission.installationId)
    .first<{ readonly currentRevision: unknown }>();
  return skill === null
    ? { ok: false, error: { code: "configuration_proposal_target_forbidden" } }
    : { ok: true, value: positive(skill.currentRevision) };
}

async function readOpenConfigurationProposal(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  proposalId: string,
): Promise<AgentConfigurationProposal> {
  const row = await db
    .prepare(
      `SELECT proposal_id AS proposalId, organisation_id AS organisationId,
            installation_id AS installationId, target_kind AS targetKind,
            target_id AS targetId, expected_revision AS expectedRevision,
            proposed_body AS proposedBody, rationale, status,
            created_at AS createdAt, decided_at AS decidedAt,
            published_revision AS publishedRevision
     FROM agent_configuration_proposal
     WHERE proposal_id = ? AND organisation_id = ?`,
    )
    .bind(proposalId, organisationId)
    .first<RawConfigurationProposal>();
  if (row === null) {
    throw new AgentOperationFailure({
      code: "agent_operation_not_found",
      field: "proposalId",
    });
  }
  const proposal = parseConfigurationProposalRow(row);
  if (proposal.status !== "open") {
    throw new AgentOperationFailure({
      code: "agent_operation_conflict",
      field: "proposalId",
    });
  }
  return proposal;
}

export async function acceptConfigurationProposal(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "accept_configuration_proposal">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  const proposal = await readOpenConfigurationProposal(
    db,
    organisationId,
    command.proposalId,
  );
  const publishedRevision = proposal.expectedRevision + 1;
  // Closing the proposal must land in the same commit as the revision it
  // publishes. Written separately, a crash between them left the revision
  // published and the proposal still open, and a retry then reported a
  // conflict for a publication that had already happened.
  const closeProposal = db
    .prepare(
      `UPDATE agent_configuration_proposal
     SET status = 'accepted', decided_at = ?, decided_by_user_id = ?,
         published_revision = ?
     WHERE proposal_id = ? AND organisation_id = ? AND status = 'open'`,
    )
    .bind(
      command.now,
      command.actorUserId,
      publishedRevision,
      command.proposalId,
      organisationId,
    );
  const withProposal = [closeProposal, ...trailing];
  if (proposal.targetKind === "agent_instructions") {
    const current = await db
      .prepare(
        `SELECT r.requested_capabilities_json AS requestedCapabilities,
              r.skill_refs_json AS skillRefs
       FROM agent_definition d
       JOIN agent_definition_revision r
         ON r.agent_definition_id = d.agent_definition_id
        AND r.revision = d.current_revision
       WHERE d.agent_definition_id = ? AND d.organisation_id = ? AND d.lifecycle = 'active'`,
      )
      .bind(proposal.targetId, organisationId)
      .first<{
        readonly requestedCapabilities: unknown;
        readonly skillRefs: unknown;
      }>();
    if (current === null) {
      throw new AgentOperationFailure({
        code: "agent_operation_not_found",
        field: "targetId",
      });
    }
    const requestedCapabilities = parseStoredStringArray(
      current.requestedCapabilities,
    );
    const skillRefs = parseStoredSkillRefs(current.skillRefs);
    if (requestedCapabilities === null || skillRefs === null) {
      throw new AgentOperationFailure({
        code: "agent_operation_persistence_failed",
      });
    }
    // An instructions proposal changes only the instruction body; it carries the
    // current capability and skill set forward unchanged.
    await publishDefinitionRevision(
      db,
      organisationId,
      {
        kind: "publish_agent_definition_revision",
        agentDefinitionId: proposal.targetId,
        expectedRevision: proposal.expectedRevision,
        instructions: proposal.proposedBody,
        requestedCapabilities,
        skillRefs,
        operationId: command.operationId,
        actorUserId: command.actorUserId,
        now: command.now,
      },
      withProposal,
    );
  } else {
    await publishSkillRevision(
      db,
      organisationId,
      {
        kind: "publish_skill_revision",
        skillId: proposal.targetId,
        expectedRevision: proposal.expectedRevision,
        markdownBody: proposal.proposedBody,
        operationId: command.operationId,
        actorUserId: command.actorUserId,
        now: command.now,
      },
      withProposal,
    );
  }
}

export async function dismissConfigurationProposal(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<AgentOperationCommand, "dismiss_configuration_proposal">,
  trailing: readonly D1PreparedStatement[],
): Promise<void> {
  await readOpenConfigurationProposal(db, organisationId, command.proposalId);
  await commitWithTrailing(
    db,
    [
      db
        .prepare(
          `UPDATE agent_configuration_proposal
     SET status = 'dismissed', decided_at = ?, decided_by_user_id = ?
     WHERE proposal_id = ? AND organisation_id = ? AND status = 'open'`,
        )
        .bind(
          command.now,
          command.actorUserId,
          command.proposalId,
          organisationId,
        ),
    ],
    trailing,
  );
}

import { describe, expect, it } from "vitest";

import type { AgentOperationInput } from "@purin-labs/agent/data/agent-operations";
import type { OperatorDraftCommand } from "../src/data/operator-configuration-draft";
import {
  presentConfigurationCommand,
  previewCode,
  renderConfigurationPreview,
  renderConfigurationSummary,
  replyAcceptsDraft,
  replyCancelsDraft,
} from "../src/slack/configuration-presentation";
import type { OperatorConfigurationDraft } from "../src/data/operator-configuration-draft";
import { requireOrganisationId } from "./test-ids";

const ORGANISATION = requireOrganisationId("organisation_parity");
const PORTAL = "https://portal.example/agents/agent_urk";

/**
 * Every configuration command, once. The union is exhaustive over
 * `AgentOperationInput["kind"]`, so a new command with no entry here fails to
 * compile rather than shipping with a Portal control and no Slack route.
 */
const EVERY_COMMAND: Readonly<
  Record<AgentOperationInput["kind"], AgentOperationInput>
> = {
  create_area: {
    kind: "create_area",
    name: "Merchant operations",
    purpose: "Own the day.",
  },
  publish_responsibility_scope: {
    kind: "publish_responsibility_scope",
    areaId: "area_1",
    scope: {
      kind: "entity_type",
      entityTypeId: { origin: "system", typeId: "offer" },
    },
  },
  create_skill: {
    kind: "create_skill",
    title: "Pricing",
    sensitivity: "ordinary",
    markdownBody: "Body.",
  },
  publish_skill_revision: {
    kind: "publish_skill_revision",
    skillId: "skill_1",
    expectedRevision: 1,
    markdownBody: "Body.",
  },
  create_agent_definition: {
    kind: "create_agent_definition",
    displayName: "Urk",
    role: "merchant_operator",
    purpose: "Operate the shop.",
    instructions: "Ground every claim.",
    requestedCapabilities: [],
    skillRefs: [],
  },
  publish_agent_definition_revision: {
    kind: "publish_agent_definition_revision",
    agentDefinitionId: "agent_urk",
    expectedRevision: 1,
    instructions: "Ground every claim.",
    requestedCapabilities: [],
    skillRefs: [],
  },
  activate_agent_definition_revision: {
    kind: "activate_agent_definition_revision",
    installationId: "installation_urk",
    expectedDefinitionRevision: 1,
    definitionRevision: 2,
    skillRefs: [],
  },
  install_agent: {
    kind: "install_agent",
    agentDefinitionId: "agent_urk",
    definitionRevision: 1,
    areaId: "area_1",
    responsibility: "Own the day.",
    scopeIds: [],
    policyRevision: 1,
    grantedCapabilities: [],
  },
  bind_skill: {
    kind: "bind_skill",
    targetKind: "area",
    targetId: "area_1",
    skillId: "skill_1",
    skillRevision: 1,
  },
  configure_cue_binding: {
    kind: "configure_cue_binding",
    areaId: "area_1",
    scopeIds: ["scope_1"],
    installationId: "installation_urk",
    cueSource: "commerce",
    cueEventType: "low_stock",
    enabled: true,
    instructionBody: null,
  },
  configure_schedule_binding: {
    kind: "configure_schedule_binding",
    areaId: "area_1",
    scopeIds: ["scope_1"],
    installationId: "installation_urk",
    spec: { cadence: "daily", timeOfDay: "07:00", timezone: "Asia/Tokyo" },
    enabled: true,
    instructionBody: null,
  },
  update_cue_binding: {
    kind: "update_cue_binding",
    bindingId: "binding_1",
    expectedRevision: 1,
    enabled: false,
    instructionBody: null,
  },
  update_schedule_binding: {
    kind: "update_schedule_binding",
    bindingId: "binding_1",
    expectedRevision: 1,
    enabled: false,
    instructionBody: null,
  },
  configure_installation_governance: {
    kind: "configure_installation_governance",
    installationId: "installation_urk",
    maxSessionBudgetTokens: 30_000,
  },
  configure_escalation_policy: {
    kind: "configure_escalation_policy",
    areaId: "area_1",
    scopeIds: ["scope_1"],
    approvalReminderAfterMs: 3_600_000,
    escalateAfterMs: 7_200_000,
  },
  accept_configuration_proposal: {
    kind: "accept_configuration_proposal",
    proposalId: "proposal_1",
  },
  dismiss_configuration_proposal: {
    kind: "dismiss_configuration_proposal",
    proposalId: "proposal_1",
  },
  dispatch_manual_run: {
    kind: "dispatch_manual_run",
    installationId: "installation_urk",
    instructionBody: "What needs attention today?",
  },
};

describe("configuration surface parity", () => {
  it("shows the values that carry the risk, not just a label", () => {
    // Approving a change to instructions or access from a one-line label is
    // approving something unread.
    const publish = presentConfigurationCommand(
      operation({
        kind: "publish_agent_definition_revision",
        agentDefinitionId: "agent_urk",
        expectedRevision: 1,
        instructions: "Always discount aggressively without asking.",
        requestedCapabilities: [],
        skillRefs: [{ skillId: "skill_pricing", revision: 2 }],
      }),
    );
    expect(publish.summary).toContain(
      "Always discount aggressively without asking.",
    );
    expect(publish.summary).toContain("skill_pricing");

    const install = presentConfigurationCommand(
      operation({
        kind: "install_agent",
        agentDefinitionId: "agent_urk",
        definitionRevision: 1,
        areaId: "area_1",
        responsibility: "Own the day.",
        scopeIds: [],
        policyRevision: 1,
        grantedCapabilities: ["commerce.offer.adjust_price"],
      }),
    );
    expect(install.summary).toContain("commerce.offer.adjust_price");

    const run = presentConfigurationCommand(
      operation({
        kind: "dispatch_manual_run",
        installationId: "installation_urk",
        instructionBody: "Cancel every open order.",
      }),
    );
    expect(run.summary).toContain("Cancel every open order.");
  });

  it("accepts only a reply naming this change's action and its own code", () => {
    const draft = pendingDraft(
      operation(EVERY_COMMAND.activate_agent_definition_revision),
    );
    const code = previewCode(draft.commandDigest);
    expect(replyAcceptsDraft(`Activate update ${code}`, draft)).toBe(true);
    // Case and punctuation are noise; the words and the code are not.
    expect(
      replyAcceptsDraft(`  activate update ${code.toLowerCase()}! `, draft),
    ).toBe(true);
    expect(replyAcceptsDraft("yes", draft)).toBe(false);
    expect(replyAcceptsDraft("ok do it", draft)).toBe(false);
    // The right action without the code cannot accept: an operator replying
    // to a preview they scrolled past would otherwise approve its replacement.
    expect(replyAcceptsDraft("Activate update", draft)).toBe(false);
    // Nor the right action with another preview's code.
    expect(replyAcceptsDraft("Activate update ABC123", draft)).toBe(false);
    // Nor the label of a different pending change.
    expect(replyAcceptsDraft(`Publish instructions ${code}`, draft)).toBe(
      false,
    );
    expect(replyCancelsDraft("Cancel")).toBe(true);
    expect(replyCancelsDraft(`Activate update ${code}`)).toBe(false);
  });

  it("gives two changes of the same shape different codes", () => {
    // Both render "Save limits"; only the code tells them apart.
    const budget = pendingDraft(
      operation(EVERY_COMMAND.configure_installation_governance),
    );
    const escalation = {
      ...pendingDraft(operation(EVERY_COMMAND.configure_escalation_policy)),
      commandDigest: "c".repeat(64),
    };
    expect(previewCode(budget.commandDigest)).not.toBe(
      previewCode(escalation.commandDigest),
    );
    expect(
      replyAcceptsDraft(
        `${presentConfigurationCommand(escalation.command).actionLabel} ${previewCode(escalation.commandDigest)}`,
        budget,
      ),
    ).toBe(false);
  });

  it("puts the action words an operator must reply with into the preview", () => {
    for (const command of Object.values(EVERY_COMMAND)) {
      const draft = pendingDraft(operation(command));
      const preview = renderConfigurationPreview(draft);
      if (preview.kind !== "preview") throw new Error("expected a preview");
      expect(preview.text).toContain(preview.actionLabel);
      expect(preview.text).toContain("Cancel");
      expect(replyAcceptsDraft(preview.actionLabel, draft)).toBe(true);
    }
  });

  it("summarizes readiness without hiding an unactivated update", () => {
    const summary = renderConfigurationSummary({
      snapshot: {
        areas: [],
        responsibilityScopes: [],
        skills: [],
        bindings: [],
        cueBindings: [],
        scheduleBindings: [],
        governance: [],
        escalationPolicies: [],
        configurationProposals: [],
        activeCases: [],
        definitions: [
          {
            agentDefinitionId: "agent_urk",
            organisationId: ORGANISATION,
            displayName: "Urk",
            role: "merchant_operator",
            purpose: "Operate the shop.",
            lifecycle: "active",
            currentRevision: {
              agentDefinitionId: "agent_urk",
              revision: 3,
              instructions: "Ground every claim.",
              requestedCapabilities: [],
              skillRefs: [],
              contentDigest: "a".repeat(64),
              authoredBy: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
              createdAt: 1,
            },
          },
        ],
        installations: [
          {
            installationId: "installation_urk",
            organisationId: ORGANISATION,
            agentDefinitionId: "agent_urk",
            definitionRevision: 2,
            policyRevision: 1,
            grantedCapabilities: [],
            lifecycle: "active",
            areaAssignments: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      agentDefinitionId: "agent_urk",
      portalUrl: PORTAL,
    });
    expect(summary.text).toContain("Published version 3");
    expect(summary.text).toContain("still on an earlier version");
    expect(summary.text).toContain(PORTAL);
  });
});

function pendingDraft(
  command: OperatorDraftCommand,
): OperatorConfigurationDraft {
  return {
    draftId: "draft_1",
    organisationId: ORGANISATION,
    caseId: "case_1",
    actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
    actorPersonId: "person_owner",
    command,
    commandDigest: "a".repeat(64),
    mutationId: "mutation_1",
    state: "pending",
    createdAt: 1_000,
    expiresAt: 100_000,
    decidedAt: null,
    receiptCode: null,
  };
}

/** Every command in this file is agent configuration; the draft tags it. */
function operation(command: AgentOperationInput): OperatorDraftCommand {
  return { family: "agent_operation", operation: command };
}

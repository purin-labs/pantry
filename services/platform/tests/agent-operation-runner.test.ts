import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { describe, expect, it, vi } from "vitest";

const caseMocks = vi.hoisted(() => ({ processDirectCaseCommand: vi.fn() }));
const membershipMocks = vi.hoisted(() => ({
  readActiveOrganisationMembershipRevision: vi.fn(),
}));

vi.mock(
  "@purin-labs/conversation/actors/case-direct-processing",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@purin-labs/conversation/actors/case-direct-processing")
    >()),
    processDirectCaseCommand: caseMocks.processDirectCaseCommand,
  }),
);
vi.mock("@purin-labs/tenancy/data/control-plane", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@purin-labs/tenancy/data/control-plane")
  >()),
  readActiveOrganisationMembershipRevision:
    membershipMocks.readActiveOrganisationMembershipRevision,
}));

import { runAgentOperation } from "@purin-labs/conversation/data/agent-operation-runner";
import { createOperatorConfigurationDraft } from "../src/data/operator-configuration-draft";
import {
  installMerchantAgent,
  merchantAgentDefaultSkills,
  merchantAgentInstallationId,
} from "../src/data/merchant-agent-preset";
import {
  createAgentOperationsDatabase,
  proposalFixtureAuthority,
} from "./agent-operations-database";
import { requireOrganisationId } from "./test-ids";

const ORGANISATION = requireOrganisationId("organisation_runner");
const NOW = 5_000;

describe("shared agent operation runner", () => {
  it("records a Slack-confirmed manual run under the confirmer's own role", async () => {
    const db = createAgentOperationsDatabase(ORGANISATION);
    const installed = await installMerchantAgent({
      db,
      organisationId: ORGANISATION,
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      policyRevision: 1,
      skills: merchantAgentDefaultSkills(),
      now: NOW,
    });
    if (!installed.ok)
      throw new Error(`install failed: ${installed.error.code}`);
    // The draft this confirmation must settle. A manual run opens a Case
    // rather than writing D1, so its record cannot ride in the effect's batch;
    // it used to be dropped on the floor, leaving the draft claimed forever.
    const draft = await createOperatorConfigurationDraft({
      ...(await proposalFixtureAuthority(db, ORGANISATION)),
      draftId: "draft_run",
      caseId: "case_run",
      actorUserId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
      actorPersonId: "person_owner",
      rawCommand: {
        kind: "dispatch_manual_run",
        installationId: merchantAgentInstallationId(ORGANISATION),
        instructionBody: "Check this morning's low stock.",
      },
      mutationId: "mutation_run",
      now: NOW,
      expiresAt: NOW + 60_000,
    });
    if (!draft.ok)
      throw new Error(`draft failed: ${JSON.stringify(draft.error)}`);
    await db
      .prepare(
        `UPDATE operator_configuration_draft SET state = 'confirmed', decided_at = ? WHERE draft_id = ?`,
      )
      .bind(NOW, "draft_run")
      .run();
    membershipMocks.readActiveOrganisationMembershipRevision.mockResolvedValue(
      1,
    );
    caseMocks.processDirectCaseCommand.mockResolvedValue({
      ok: true,
      value: {
        caseId: "case_manual",
        sessionId: "session_manual",
        assignmentId: "assignment_manual",
      },
    });

    const result = await runAgentOperation({
      env: { DB: db } as unknown as import("@purin-labs/kernel/env").Env,
      scope: (await proposalFixtureAuthority(db, ORGANISATION)).scope,
      operation: {
        kind: "dispatch_manual_run",
        installationId: merchantAgentInstallationId(ORGANISATION),
        instructionBody: "Check this morning's low stock.",
      },
      actor: {
        userId: "user_fbe449f6-7995-538c-a3a8-81b0623a641e",
        personId: "person_owner",
        role: "operator",
        origin: { kind: "slack" },
      },
      operationId: "mutation_run",
      now: NOW + 10,
      trailing: [
        db
          .prepare(
            `UPDATE operator_configuration_draft SET state = 'settled', receipt_code = 'accepted'
          WHERE draft_id = ? AND state = 'confirmed'`,
          )
          .bind("draft_run"),
      ],
    });

    expect(result.ok).toBe(true);
    const settled = await db
      .prepare(
        `SELECT state, receipt_code AS receiptCode FROM operator_configuration_draft WHERE draft_id = ?`,
      )
      .bind("draft_run")
      .first<{ state: string; receiptCode: string | null }>();
    expect(settled).toEqual({ state: "settled", receiptCode: "accepted" });

    // The Case opens under the role the confirmer holds now, not one assumed
    // for them: an owner is not downgraded and an operator is not promoted.
    const opened = caseMocks.processDirectCaseCommand.mock.calls[0]?.[1] as
      | {
          readonly requestAuthority: {
            readonly role: string;
            readonly kind: string;
          };
        }
      | undefined;
    expect(opened?.requestAuthority.kind).toBe("control");
    expect(opened?.requestAuthority.role).toBe("operator");
  });
});

void ((_: SingleDatabase) => undefined);

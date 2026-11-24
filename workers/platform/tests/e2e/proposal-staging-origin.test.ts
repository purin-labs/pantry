import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect, it, type TestContext } from "vitest";
import {
  installSlackActorFixture,
  ORGANISATION_ID,
  SLACK_ACTOR_USER_ID,
} from "./slack-journey-support";
import { issueControlSession } from "@purin-labs/tenancy/data/control-plane";
import { parseUserId } from "@purin-labs/control-api/ids";
import { authorizeSessionTurnExecution } from "@purin-labs/conversation/chat/turn-access";
import { createOperatorConfigurationDraft } from "@purin-labs/area-organisation/server/data/operator-configuration-draft";
import {
  admitOperatorControlTurnFixture,
  requireOrganisationExecutionScope,
} from "../organisation-execution-fixture";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

type Boundary = "origin" | "placement" | "release";
type Probe = {
  phase: "armed" | "paused" | "released";
  checks: number;
  pauseAt: number;
  boundary: Boundary;
};

it.for(["origin", "placement", "release"] as const)(
  "fences a configuration proposal at %s and preserves committed evidence",
  { timeout: 45_000 },
  proposalJourney,
);

async function proposalJourney(boundary: Boundary, { task }: TestContext) {
  await installSlackActorFixture();
  const userId = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!userId.ok) throw new Error(userId.error.code);
  const now = Date.now();
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "UPDATE service_role_grant SET role = 'operator' WHERE organisation_id = ? AND user_id = ?",
      )
      .bind(ORGANISATION_ID, SLACK_ACTOR_USER_ID),
    fixtureDatabase()
      .prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'proposal-fixture', activated_at = ? WHERE organisation_id = ?",
      )
      .bind(now, ORGANISATION_ID),
  ]);
  const session = await issueControlSession({
    db: env.DB,
    userId: userId.value,
    now,
    ttlMs: 600_000,
  });
  const execution = await admitOperatorControlTurnFixture(
    env,
    ORGANISATION_ID,
    userId.value,
    session.session.controlSessionId,
  );
  const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
  const probe: Probe = {
    phase: "armed",
    checks: 0,
    pauseAt: boundary === "release" ? 3 : 2,
    boundary,
  };
  const authorize = authorizeSessionTurnExecution.bind(
    null,
    env.DB,
    scope.database,
    ORGANISATION_ID,
    execution,
    scope.accountAccess,
  );
  const work = createProposal(
    scope,
    authorizeProposal.bind(null, probe, authorize),
    `denied_${boundary}`,
    userId.value,
    now,
  );
  const outcome = work.then(proposalOutcome, proposalRejection);
  try {
    await expect.poll(proposalPhase.bind(null, probe)).toBe("paused");
    if (boundary === "placement") {
      // Freeze after origin authorization completes, immediately before D1 dispatch.
      for (const database of [env.DB, fixtureDatabase()])
        await database
          .prepare(
            "UPDATE organisation_placement SET status = 'frozen', frozen_at = ? WHERE organisation_id = ? AND status = 'active'",
          )
          .bind(Date.now(), ORGANISATION_ID)
          .run();
    } else {
      await env.DB.prepare(
        "UPDATE control_session SET revoked_at = ? WHERE control_session_id = ?",
      )
        .bind(Date.now(), session.session.controlSessionId)
        .run();
    }
    probe.phase = "released";
    const result = await outcome;
    if (boundary === "placement") expect(result).toMatchObject({ ok: false });
    else expect(result).toEqual({ error: "proposal_origin_inactive" });
    expect(await proposalCount()).toBe(boundary === "release" ? 1 : 0);
    if (boundary === "placement") {
      for (const database of [env.DB, fixtureDatabase()])
        await database
          .prepare(
            "UPDATE organisation_placement SET status = 'active', frozen_at = NULL WHERE organisation_id = ?",
          )
          .bind(ORGANISATION_ID)
          .run();
    }
    const freshSession = await issueControlSession({
      db: env.DB,
      userId: userId.value,
      now: Date.now(),
      ttlMs: 600_000,
    });
    const freshExecution = await admitOperatorControlTurnFixture(
      env,
      ORGANISATION_ID,
      userId.value,
      freshSession.session.controlSessionId,
    );
    const freshAuthorize = authorizeSessionTurnExecution.bind(
      null,
      env.DB,
      scope.database,
      ORGANISATION_ID,
      freshExecution,
      scope.accountAccess,
    );
    const freshProbe: Probe = {
      phase: "released",
      checks: 0,
      pauseAt: 0,
      boundary,
    };
    expect(
      await createProposal(
        scope,
        authorizeProposal.bind(null, freshProbe, freshAuthorize),
        "fresh",
        userId.value,
        now + 1,
      ),
    ).toMatchObject({ ok: true });
    expect(await proposalCount()).toBe(boundary === "release" ? 2 : 1);
    Object.assign(task.meta, {
      proposalOrigin: {
        proposal: "configuration",
        boundary,
        protectedResultReleased: false,
        retainedIssuedDrafts: boundary === "release" ? 1 : 0,
        freshAuthorizedDraft: true,
      },
    });
  } finally {
    probe.phase = "released";
    await outcome;
  }
}

async function authorizeProposal(
  probe: Probe,
  authorize: () => Promise<boolean>,
): Promise<void> {
  probe.checks++;
  const captured = await authorize();
  // The placement case deliberately returns a captured authorization, so SQL
  // must reject the freeze that occurs after that asynchronous check.
  if (probe.checks === probe.pauseAt && probe.phase === "armed") {
    probe.phase = "paused";
    while (probe.phase === "paused") await scheduler.wait(5);
  }
  if (!captured || (probe.boundary !== "placement" && !(await authorize())))
    throw new Error("proposal_origin_inactive");
}
function proposalPhase(probe: Probe) {
  return probe.phase;
}
function proposalOutcome(result: unknown) {
  return result;
}
function proposalRejection(error: unknown) {
  if (!(error instanceof Error)) throw error;
  return { error: error.message };
}
async function proposalCount(): Promise<number> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT COUNT(*) AS count FROM operator_configuration_draft WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .first<{ count: number }>();
  if (row === null) throw new Error("Missing proposal count");
  return row.count;
}
function createProposal(
  scope: OrganisationExecutionScope,
  authorizeCommit: () => Promise<void>,
  id: string,
  actorUserId: string,
  now: number,
) {
  return createOperatorConfigurationDraft({
    scope,
    authorizeCommit,
    draftId: id,
    caseId: `case_${id}`,
    actorUserId,
    actorPersonId: "person_fixture",
    rawCommand: {
      kind: "create_area",
      name: "Operations",
      purpose: "Review the bakery workload.",
    },
    mutationId: `mutation_${id}`,
    now,
    expiresAt: now + 600_000,
  });
}

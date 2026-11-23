// The Worker the side Case browser journey runs against (Plan 74). Every /v1
// request uses production routing. The /test routes build the fixture, sign a
// person in and read the simulated model's record, which a browser cannot do
// on its own.
import gateway from "../../workers/platform/src/integration-gateway";
import { requireActiveOrganisationActor } from "../../foundation/actor-runtime/actors/actor-router";
import { CONTEXT_CASE_READ_CAPABILITY } from "../../foundation/authority/authorization/access-grants/turn-authority";
import { createAccessGrant } from "../../foundation/authority/data/access-grants";
import { parseWorkflowChanges } from "../../packages/bakery-workflow/src/changes";
import { prepareWorkflowProposal } from "../../areas/kitchen/server/bakery/workflow-proposals";
import { readCurrentWorkflow } from "../../areas/kitchen/server/bakery/workflow-revisions";
import { createOperatorConfigurationDraft } from "../../areas/organisation/server/data/operator-configuration-draft";
import { OrganisationExecutionScope } from "../../foundation/tenancy/organisation-execution-scope";
import type { Env } from "../../foundation/kernel/env";
import type { OrganisationId } from "../../foundation/kernel/ids";
import { compilePublishAndActivateOrganisationPolicy } from "../../foundation/authority/policy-snapshot";
import { fixturePeople } from "../plan-42J/account-authority";

export {
  OrganisationDO,
  SessionDO,
  CaseDO,
  ConnectorDO,
  CodeModePlatformGovernorActor,
} from "../../workers/platform/src/integration-gateway";

const names = ["Owner", "Other"] as const;
const { fixtureUser, admittedOrganisation, login } = fixturePeople(
  "side-case-",
  "plan74-browser",
);

export default {
  queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    return gateway.queue(batch, env);
  },
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/test/health")
      return new Response(null, { status: 204 });
    if (url.pathname === "/test/setup" && request.method === "POST")
      return Response.json(await seed(env));
    if (url.pathname === "/test/session" && request.method === "POST")
      return login(env, names, url.searchParams.get("user"));
    // Plan 84: what the agent's tool stores, without a model turn.
    if (url.pathname === "/test/propose" && request.method === "POST")
      return propose(env, await request.json());
    // What the simulated model was asked, from the provider process.
    if (url.pathname === "/test/model" && request.method === "GET")
      return fetch("https://side-case-fixture.internal/state");
    return gateway.fetch(request, env, context);
  },
};

/** The tool's own preparation and draft. A journey picks the words and the changes. */
async function propose(env: Env, raw: unknown): Promise<Response> {
  const input = raw as {
    organisationId: OrganisationId;
    changes: unknown;
    reason: string;
  };
  const execution = await OrganisationExecutionScope.resolve(
    env,
    input.organisationId,
  );
  if (!execution.ok) throw new Error("No execution scope");
  const scope = execution.value;
  const row = await scope.database
    .prepare(
      `SELECT workflow_id AS workflowId FROM bakery_workflow WHERE organisation_id = ? LIMIT 1`,
    )
    .bind(input.organisationId)
    .first<{ workflowId: string }>();
  if (row === null)
    return Response.json({ error: "no workflow" }, { status: 404 });
  const current = await readCurrentWorkflow(
    env,
    scope.database,
    input.organisationId,
    row.workflowId,
  );
  const changes = parseWorkflowChanges(input.changes);
  if (current === null || changes === null)
    return Response.json({ error: "invalid" }, { status: 422 });
  const owner = await fixtureUser(env, "Owner");
  const operationId = crypto.randomUUID();
  const prepared = await prepareWorkflowProposal(env, scope, {
    workflowId: row.workflowId,
    baseDigest: current.receipt.digest,
    changes,
    reason: input.reason,
    findingIds: [],
    sessionId: "session_journey",
    turnId: "turn_journey",
    operationId,
  });
  if (prepared.kind === "refused")
    return Response.json({ refused: prepared.message }, { status: 422 });
  const now = Date.now();
  const draftId = `draft_journey_${operationId}`;
  const created = await createOperatorConfigurationDraft({
    scope,
    authorizeCommit: () => Promise.resolve(),
    draftId,
    caseId: "case_journey",
    actorUserId: owner.userId,
    actorPersonId: "person_journey",
    rawCommand: { family: "workflow_change", change: prepared.command },
    mutationId: `mutation_${draftId}`,
    now,
    expiresAt: now + 3_600_000,
  });
  if (!created.ok) throw new Error(created.error.code);
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: input.organisationId,
    now,
  });
  organisation.bakeryWorkflowApplied(row.workflowId);
  return Response.json({ draftId });
}

/**
 * One active organisation with an owner, a second administrator and Pantry's
 * model route. Owners may read the Case context that a Portal chat reads.
 */
async function seed(env: Env) {
  const now = Date.now();
  const { organisationId, owner, other } = await admittedOrganisation(
    env,
    "Side Case acceptance",
  );
  const granted = await createAccessGrant({
    db: env.DB,
    organisationId,
    grantId: "grant_side_case_context",
    subject: { kind: "organisation_role", role: "owner" },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "plan74-browser",
    },
    now,
  });
  if (!granted.ok) throw new Error(granted.error.code);
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now,
  });
  await organisation.ensureOrganisation({
    organisationId,
    name: "Side Case acceptance",
    plan: "beta",
    status: "active",
    createdAt: now,
  });
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: env.DB, kv: env.POLICY_KV },
    organisationId,
    organisation,
    now,
  });
  if (!published.ok) throw new Error(published.error.code);
  return {
    organisationId,
    users: { Owner: owner.userId, Other: other.userId },
  };
}

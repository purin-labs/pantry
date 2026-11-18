// The Worker the side Case browser journey runs against (Plan 74). Every /v1
// request uses production routing. The /test routes build the fixture, sign a
// person in and read the simulated model's record, which a browser cannot do
// on its own.
import gateway from "../../services/platform/src/integration-gateway";
import { requireActiveOrganisationActor } from "../../services/platform/src/actors/actor-router";
import { CONTEXT_CASE_READ_CAPABILITY } from "../../services/platform/src/authorization/access-grants/turn-authority";
import { createAccessGrant } from "../../services/platform/src/data/access-grants";
import { newControlMutationIdentity } from "../../services/platform/src/data/control-mutation";
import {
  bootstrapOrganisation,
  issueControlSession,
  upsertUser,
  type User,
} from "../../services/platform/src/data/control-plane";
import { parseWorkflowChanges } from "../../packages/bakery-workflow/src/changes";
import { prepareWorkflowProposal } from "../../services/platform/src/commerce/bakery/workflow-proposals";
import { readCurrentWorkflow } from "../../services/platform/src/commerce/bakery/workflow-revisions";
import { createOperatorConfigurationDraft } from "../../services/platform/src/data/operator-configuration-draft";
import { OrganisationExecutionScope } from "../../services/platform/src/organisation-execution-scope";
import type { Env } from "../../services/platform/src/env";
import type { OrganisationId } from "../../services/platform/src/ids";
import { parseInitialOrganisationPlacement } from "../../services/platform/src/placement";
import { compilePublishAndActivateOrganisationPolicy } from "../../services/platform/src/policy-snapshot";
import {
  attachToAccountAuthority,
  type AccountPerson,
} from "../plan-42J/account-authority";

export {
  OrganisationDO,
  SessionDO,
  CaseDO,
  ConnectorDO,
  CodeModePlatformGovernorActor,
} from "../../services/platform/src/integration-gateway";

const names = ["Owner", "Other"] as const;

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
      return login(env, url.searchParams.get("user"));
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
  if (row === null) return Response.json({ error: "no workflow" }, { status: 404 });
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

function hasName(name: string | null, candidate: string): boolean {
  return name === candidate;
}

/** The account authority verifies a Google identity, so each person has one. */
async function fixtureUser(env: Env, name: string) {
  const subject = `side-case-${name.toLowerCase().replaceAll(" ", "-")}`;
  return upsertUser({
    db: env.DB,
    now: Date.now(),
    identity: {
      issuer: "https://accounts.google.com",
      subject,
      email: `${subject}@example.test`,
      displayName: name,
      emailVerified: true,
    },
  });
}

async function fixtureOrganisation(
  env: Env,
  owner: User,
  name: string,
): Promise<OrganisationId> {
  const now = Date.now();
  const placement = parseInitialOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "plan74-browser",
    locationHint: "wnam",
  });
  if (!placement.ok) throw new Error(placement.error.path);
  const created = await bootstrapOrganisation({
    env,
    owner,
    organisationName: name,
    environment: "development",
    placement: placement.value,
    now,
    mutation: {
      scope: {
        userId: owner.userId,
        organisationScope: "organisation:create",
        route: "/v1/control/organisations",
        operation: "organisation.create",
      },
      boundary: {
        kind: "unversioned",
        idempotencyKey: crypto.randomUUID(),
        requestHash: "plan74-browser",
      },
      identity: newControlMutationIdentity({
        portalSubjectHash: "plan74-browser",
        causationId: crypto.randomUUID(),
        now,
      }),
    },
  });
  if (!created.ok) throw new Error(created.error.code);
  return created.value.organisationId;
}

/** One person's role in an Organisation, with a control session of theirs. */
async function fixturePerson(
  env: Env,
  organisationId: OrganisationId,
  user: User,
): Promise<AccountPerson> {
  const grant = await env.DB.prepare(
    "SELECT person_id AS personId FROM service_role_grant WHERE organisation_id = ? AND user_id = ? AND status = 'active'",
  )
    .bind(organisationId, user.userId)
    .first<{ personId: string }>();
  if (grant === null) throw new Error("Fixture person has no role");
  const issued = await issueControlSession({
    db: env.DB,
    userId: user.userId,
    now: Date.now(),
    ttlMs: 3_600_000,
  });
  return { user, personId: grant.personId, session: issued.session };
}

/** A person of the account fixture who owns a separate organisation. */
async function auxiliaryOwner(env: Env, label: string) {
  const user = await fixtureUser(env, `Auxiliary ${label}`);
  const organisationId = await fixtureOrganisation(
    env,
    user,
    `Account fixture ${label}`,
  );
  return {
    organisationId,
    person: await fixturePerson(env, organisationId, user),
  };
}

async function login(env: Env, name: string | null): Promise<Response> {
  if (name === null || !names.some(hasName.bind(null, name)))
    return new Response(null, { status: 400 });
  const user = await fixtureUser(env, name);
  const issued = await issueControlSession({
    db: env.DB,
    userId: user.userId,
    now: Date.now(),
    ttlMs: 3_600_000,
  });
  const response = Response.json({ userId: user.userId });
  response.headers.append(
    "set-cookie",
    `satyr_control_session=${issued.token}; HttpOnly; Path=/; SameSite=Lax`,
  );
  response.headers.append(
    "set-cookie",
    `satyr_control_csrf=${issued.csrfToken}; Path=/; SameSite=Lax`,
  );
  return response;
}

/**
 * One active organisation with an owner and a second administrator, whom
 * the account authority admits, and Pantry's model route. Owners may read
 * the Case context that a Portal chat reads.
 */
async function seed(env: Env) {
  const now = Date.now();
  const owner = await fixtureUser(env, "Owner");
  const other = await fixtureUser(env, "Other");
  const organisationId = await fixtureOrganisation(
    env,
    owner,
    "Side Case acceptance",
  );
  const otherPersonId = `person_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'plan74-browser', activated_at = ?, updated_at = ? WHERE organisation_id = ?",
    ).bind(now, now, organisationId),
    env.DB.prepare(
      "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, 'Other')",
    ).bind(organisationId, otherPersonId),
    env.DB.prepare(
      "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)",
    ).bind(organisationId, other.userId, otherPersonId, now),
    env.DB.prepare(
      "INSERT INTO organisation_inference_selection (organisation_id, selection_kind, selected_by_user_id, selected_at) VALUES (?, 'satyr_platform', ?, ?)",
    ).bind(organisationId, owner.userId, now),
  ]);
  await attachToAccountAuthority(env, {
    organisationId,
    owner: await fixturePerson(env, organisationId, owner),
    administrator: await fixturePerson(env, organisationId, other),
    auxiliary: auxiliaryOwner.bind(null, env),
  });
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

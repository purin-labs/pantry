// The Worker the Kitchen run journey runs against (Plan 81). Every /v1
// request uses production routing. The /test routes build the fixture, sign a
// person in and read the simulated model's record, which a browser cannot do
// on its own.
import { sha256Hex } from "../../packages/std/src/index";
import { parseRunSnapshot } from "../../packages/bakery-model/src/bakery-run-snapshot";
import interrupted from "../../assets/bakery-mujoco/combined-bakery/rust-evidence/shared-run-interrupted.json";
import gateway from "../../services/platform/src/integration-gateway";
import { requireActiveOrganisationActor } from "../../services/platform/src/actors/actor-router";
import { CONTEXT_CASE_READ_CAPABILITY } from "../../services/platform/src/authorization/access-grants/turn-authority";
import { bakeryRunSnapshotPrefix } from "../../services/platform/src/commerce/bakery/saved-runs";
import { createAccessGrant } from "../../services/platform/src/data/access-grants";
import type { Env } from "../../services/platform/src/env";
import { compilePublishAndActivateOrganisationPolicy } from "../../services/platform/src/policy-snapshot";
import {
  attachToAccountAuthority,
  fixturePeople,
} from "../plan-42J/account-authority";

export {
  OrganisationDO,
  SessionDO,
  CaseDO,
  ConnectorDO,
  CodeModePlatformGovernorActor,
} from "../../services/platform/src/integration-gateway";

const names = ["Owner", "Other", "Member"] as const;
const {
  fixtureUser,
  fixtureOrganisation,
  fixturePerson,
  auxiliaryOwner,
  login,
} = fixturePeople("kitchen-", "plan81-browser");

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
    if (url.pathname === "/test/setup-menu" && request.method === "POST")
      return Response.json(await seedMenu(env));
    if (url.pathname === "/test/session" && request.method === "POST")
      return login(env, names, url.searchParams.get("user"), true);
    // What the simulated model was asked, from the provider process.
    if (url.pathname === "/test/model" && request.method === "GET")
      return fetch("https://kitchen-fixture.internal/state");
    if (url.pathname === "/test/model/release" && request.method === "POST")
      return fetch("https://kitchen-fixture.internal/release", {
        method: "POST",
      });
    return gateway.fetch(request, env, context);
  },
};

/**
 * The same Organisation, whose owners may let the agent read and edit the
 * menu and its boards.
 */
async function seedMenu(env: Env) {
  const seeded = await seed(env);
  for (const capabilityId of [
    "commerce.menu_draft.edit",
    "commerce.menu_draft.read",
  ]) {
    const granted = await createAccessGrant({
      db: env.DB,
      organisationId: seeded.organisationId,
      grantId: `grant_${capabilityId.replaceAll(".", "_")}`,
      subject: { kind: "organisation_role", role: "owner" },
      target: {
        kind: "platform_capability",
        capabilityId,
        capabilityVersion: 1,
      },
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: "plan81-browser",
      },
      now: Date.now(),
    });
    if (!granted.ok) throw new Error(granted.error.code);
  }
  // Plan 40B phase 7: the person who watches the board is a viewer, so the
  // board refuses the viewer's own edit.
  await env.DB.prepare(
    "UPDATE service_role_grant SET role = 'viewer' WHERE organisation_id = ? AND user_id = ?",
  )
    .bind(seeded.organisationId, seeded.users.Member)
    .run();
  return seeded;
}

/**
 * One active organisation with an owner and a second administrator, whom
 * the account authority admits, and Pantry's model route. Owners may read
 * the Case context that a Portal chat reads. Kitchen needs no other
 * grant: its browser controls follow the owner's role.
 */
async function seed(env: Env) {
  const now = Date.now();
  const owner = await fixtureUser(env, "Owner");
  const other = await fixtureUser(env, "Other");
  const member = await fixtureUser(env, "Member");
  const organisationId = await fixtureOrganisation(
    env,
    owner,
    "Satyr Kitchen acceptance",
  );
  const otherPersonId = `person_${crypto.randomUUID()}`;
  const memberPersonId = `person_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'plan81-browser', activated_at = ?, updated_at = ? WHERE organisation_id = ?",
    ).bind(now, now, organisationId),
    env.DB.prepare(
      "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, 'Other')",
    ).bind(organisationId, otherPersonId),
    env.DB.prepare(
      "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)",
    ).bind(organisationId, other.userId, otherPersonId, now),
    env.DB.prepare(
      "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, 'Member')",
    ).bind(organisationId, memberPersonId),
    env.DB.prepare(
      "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, 'operator', 'active', ?)",
    ).bind(organisationId, member.userId, memberPersonId, now),
    env.DB.prepare(
      "INSERT INTO organisation_inference_selection (organisation_id, selection_kind, selected_by_user_id, selected_at) VALUES (?, 'satyr_platform', ?, ?)",
    ).bind(organisationId, owner.userId, now),
  ]);
  await attachToAccountAuthority(env, {
    organisationId,
    owner: await fixturePerson(env, organisationId, owner),
    administrator: await fixturePerson(env, organisationId, other),
    member: await fixturePerson(env, organisationId, member),
    auxiliary: auxiliaryOwner.bind(null, env),
  });
  for (const [grantId, role] of [
    ["grant_kitchen_context", "owner"],
    ["grant_kitchen_context_operator", "operator"],
  ] as const) {
    const granted = await createAccessGrant({
      db: env.DB,
      organisationId,
      grantId,
      subject: { kind: "organisation_role", role },
      target: {
        kind: "platform_capability",
        capabilityId: CONTEXT_CASE_READ_CAPABILITY,
        capabilityVersion: 1,
      },
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: "plan81-browser",
      },
      now,
    });
    if (!granted.ok) throw new Error(granted.error.code);
  }
  const snapshot = parseRunSnapshot({
    name: "Shift canvas",
    document: interrupted,
  });
  if (snapshot === null) throw new Error("Invalid appliance fixture");
  const snapshotId = await sha256Hex(snapshot.content);
  await env.ARCHIVE.put(
    `${bakeryRunSnapshotPrefix(organisationId)}${snapshotId}`,
    snapshot.content,
    { customMetadata: { name: snapshot.name, kind: "appliance" } },
  );
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now,
  });
  await organisation.ensureOrganisation({
    organisationId,
    name: "Satyr Kitchen acceptance",
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
    canvasDocumentId: `run:${snapshotId}`,
    users: {
      Owner: owner.userId,
      Other: other.userId,
      Member: member.userId,
    },
  };
}

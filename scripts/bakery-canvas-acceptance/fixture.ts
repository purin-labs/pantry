import { isRecord, sha256Hex } from "../../packages/std/src/index";
import { parseRunSnapshot } from "../../packages/bakery-model/src/bakery-run-snapshot";
import {
  parseOrganisationId,
  parseUserId,
} from "../../services/platform/src/ids";
import { OrganisationExecutionScope } from "../../services/platform/src/organisation-execution-scope";
import { createAccessGrant } from "../../services/platform/src/data/access-grants";
import { writeOrganisationCapabilityPolicy } from "../../services/platform/src/data/capability-policy";
import { compilePublishAndActivateOrganisationPolicy } from "../../services/platform/src/policy-snapshot";
import { requireActiveOrganisationActor } from "../../services/platform/src/actors/actor-router";
import { bakeryRunSnapshotPrefix } from "../../services/platform/src/commerce/bakery/saved-runs";
import type { Env } from "../../services/platform/src/env";
import interrupted from "../../assets/bakery-mujoco/combined-bakery/rust-evidence/shared-run-interrupted.json";

/** Local acceptance data only. The browser uses production HTTP and WebSocket routes. */
export async function seedCanvasAcceptance(env: Env, raw: unknown) {
  if (!isRecord(raw) || !Array.isArray(raw.users))
    throw new Error("Missing browser fixture");
  const organisationId = parseOrganisationId(raw.organisationId);
  const owner = raw.users.find(isOwner);
  if (!organisationId.ok || !isRecord(owner))
    throw new Error("Missing fixture owner");
  const userId = parseUserId(owner.userId);
  if (!userId.ok) throw new Error(userId.error.code);
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) throw new Error(execution.error.code);
  const scope = execution.value;
  await scope.database
    .prepare(
      "UPDATE organisation SET organisation_handle = 'canvas-acceptance' WHERE organisation_id = ?",
    )
    .bind(scope.organisationId)
    .run();
  await scope.database.batch([
    scope.database
      .prepare(
        "INSERT INTO organisation_activation_attempt (activation_attempt_id, organisation_id, readiness_version, readiness_hash, status, started_at, updated_at, completed_at) VALUES ('attempt_canvas_browser', ?, 1, 'canvas-ready', 'completed', ?, ?, ?)",
      )
      .bind(scope.organisationId, Date.now(), Date.now(), Date.now()),
    scope.database
      .prepare(
        "INSERT INTO organisation_activation_receipt (activation_receipt_id, activation_attempt_id, organisation_id, readiness_hash, policy_snapshot_id, cue_snapshot_id, capability_profile, activated_at) VALUES ('receipt_browser', 'attempt_canvas_browser', ?, 'canvas-ready', 'policy_browser', 'cue_browser', 'read_and_propose', ?)",
      )
      .bind(scope.organisationId, Date.now()),
  ]);
  for (const user of raw.users) {
    if (!isRecord(user) || user.name !== "Viewer") continue;
    await scope.database
      .prepare(
        "UPDATE organisation_membership SET role = 'viewer' WHERE organisation_id = ? AND user_id = ?",
      )
      .bind(scope.organisationId, user.userId)
      .run();
  }
  for (const capabilityId of [
    "context.case.read",
    "commerce.entity_plane.context",
    "commerce.workflow_canvas.move",
    "workspace.query",
  ]) {
    const grant = await createAccessGrant({
      db: scope.database,
      organisationId: scope.organisationId,
      grantId: `grant_browser_canvas_${capabilityId}`,
      subject: { kind: "organisation_role", role: "admin" },
      target: {
        kind: "platform_capability",
        capabilityId,
        capabilityVersion: 1,
      },
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: "receipt_canvas_browser",
      },
      now: Date.now(),
    });
    if (!grant.ok) throw new Error(grant.error.code);
  }
  for (const capabilityId of [
    "commerce.entity_plane.context",
    "commerce.workflow_canvas.move",
    "workspace.query",
  ] as const) {
    const changed = await writeOrganisationCapabilityPolicy({
      scope,
      write: {
        kind: "change",
        capabilityId,
        expectedRevision: 1,
        mode: "enabled",
        provenance: {
          kind: "operator",
          userId: userId.value,
          mutationReceiptId: "receipt_canvas_browser",
        },
        now: Date.now(),
      },
    });
    if (!changed.ok) throw new Error(changed.error.code);
  }
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: scope.organisationId,
    now: Date.now(),
  });
  const policy = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: scope.database, kv: env.POLICY_KV },
    organisationId: scope.organisationId,
    organisation,
    now: Date.now(),
  });
  if (!policy.ok) throw new Error(policy.error.code);
  const snapshot = parseRunSnapshot({
    name: "Canvas acceptance recipe",
    document: interrupted,
  });
  if (snapshot === null) throw new Error("Invalid saved appliance run");
  const snapshotId = await sha256Hex(snapshot.content);
  await env.ARCHIVE.put(
    bakeryRunSnapshotPrefix(scope.organisationId) + snapshotId,
    snapshot.content,
    {
      customMetadata: { name: snapshot.name, kind: snapshot.kind },
      httpMetadata: { contentType: "application/json" },
    },
  );
  return {
    organisationId: scope.organisationId,
    documentId: `run:${snapshotId}`,
    objectId: interrupted.layout[0].objectId,
    portalPath: "/portal/canvas-acceptance/cafe-operations/workflow-simulator",
  };
}
function isOwner(user: unknown): boolean {
  return isRecord(user) && user.name === "Owner";
}

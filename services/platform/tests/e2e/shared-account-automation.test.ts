import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { opaqueSubjectReference } from "../../src/access-control/references";
import { createAccountPlatformClient } from "../../src/account-platform/client";
import { resolvePantryAccountBinding } from "../../src/account-platform/binding";
import { resolveAccountMembershipContext } from "../../src/account-platform/service-membership";
import {
  resolveLinkedPantryAccountAutomation,
  resolveLinkedPantryAccountUser,
} from "../../src/account-platform/identity";
import {
  accountInteger,
  accountObject,
} from "../../src/account-platform/types";
import { writeTierOneStripeSubscription } from "../../src/cues/engine";
import { newWorkspaceId, parseChannelId, parseThreadKey } from "../../src/ids";
import { buildWorkflowAuthority } from "../../src/request-authority";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceHeaders } from "./commerce-support";
import {
  accountFixtureJson,
  activateSharedAccountNativeTenant,
  applyAccountFixtureProvision,
  bootstrapSharedAccountNativeTenants,
  readSharedAccountFixture,
} from "./shared-account-platform-fixture";

declare module "vitest" {
  interface TaskMeta {
    sharedAccountAutomation?: Record<string, unknown>;
  }
}

it(
  "retains native automation revocation across lost replies, explicit regrant, and control replay",
  automationGrantJourney,
  60000,
);

async function automationGrantJourney(context: TestContext): Promise<void> {
  const evidence: Record<string, unknown> = {
    stage: "bootstrap",
    accountWorkerSha256: env.TEST_ACCOUNT_PLATFORM_WORKER_SHA256,
  };
  Object.assign(context.task.meta, { sharedAccountAutomation: evidence });
  const native = await bootstrapSharedAccountNativeTenants();
  const setup = readSharedAccountFixture(
    await accountFixtureJson("setup", native.setup),
  );
  await applyAccountFixtureProvision(setup.provisionEnvelopes.primary);
  await applyAccountFixtureProvision(setup.provisionEnvelopes.foreign);
  await activateSharedAccountNativeTenant(native.primary.organisationId);
  const scope = await requireOrganisationExecutionScope(
    env,
    native.primary.organisationId,
  );
  const channel = parseChannelId("C_SHARED_ACCOUNT_AUTOMATION");
  const thread = parseThreadKey("thread:shared_account_automation");
  if (!channel.ok || !thread.ok)
    throw new Error("Invalid native fixture surface");
  const workflowId = "shared_account_workflow";
  await writeTierOneStripeSubscription({
    db: scope.database,
    organisationId: scope.organisationId,
    subscriptionId: workflowId,
    workspaceId: newWorkspaceId(),
    channelId: channel.value,
    threadKey: thread.value,
    eventType: "charge.failed",
    template: "Inspect the failed payment.",
    delivery: { kind: "immediate" },
    debounceMs: 1000,
    maxPerHour: 10,
  });
  const current = await scope.database
    .prepare(
      "SELECT projection_revision AS revision FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(scope.organisationId)
    .first<unknown>();
  const projection = accountObject(current, ["revision"]);
  const subjectRefId = await opaqueSubjectReference(scope.organisationId, {
    kind: "workflow",
    firstId: workflowId,
    secondId: null,
    revision: 1,
  });
  const grantBody = {
    expectedRevision: accountInteger(projection.revision, 1),
    subjectRef: { subjectRefId, revision: 1 },
    target: {
      kind: "platform",
      capabilityRef: {
        capabilityId: "context.case.read",
        capabilityVersion: 1,
      },
    },
  };
  const headers = commerceHeaders(native.primary.owner.session);
  headers.set("idempotency-key", crypto.randomUUID());
  const grantUrl = `https://localhost/v1/control/organisations/${scope.organisationId}/access-control/grants`;
  const grantResponse = await exports.default.fetch(grantUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(grantBody),
  });
  expect(grantResponse.status, await grantResponse.clone().text()).toBe(200);
  const binding = await resolvePantryAccountBinding(env, scope.organisationId);
  const owner = await resolveLinkedPantryAccountUser(
    env,
    native.primary.owner.identity.userId,
  );
  const automation = await resolveLinkedPantryAccountAutomation(
    env,
    scope.organisationId,
    { kind: "workflow", nativeId: workflowId, revision: 1 },
  );
  const client = createAccountPlatformClient(env);
  if (!binding.ok || !owner.ok || !automation.ok || !client.ok)
    throw new Error("Actual automation grant is missing");
  expect(automation.value.accessRevision).toBe(1);
  const authority = buildWorkflowAuthority({
    organisationId: scope.organisationId,
    workflowId,
    workflowRevision: 1,
  }).requestAuthority;
  expect(
    (
      await scope.accountAccess.checkAutomation({
        authority,
        action: "execute",
      })
    ).ok,
  ).toBe(true);
  const membershipContext = await resolveAccountMembershipContext(
    env,
    scope.organisationId,
    native.primary.owner.session.session,
  );
  if (!membershipContext.ok)
    throw new Error("Actual account manager session is missing");
  const actor = membershipContext.value.actor;
  const revoked = await client.value.setAutomationGrant({
    binding: actor.binding,
    user: actor.user,
    authority: actor.authority,
    automationId: automation.value.automationId,
    grantId: automation.value.grantId,
    nativePrincipalId: automation.value.nativePrincipalId,
    access: "revoked",
    expectedAccessRevision: 1,
  });
  expect(revoked.ok).toBe(true);
  expect(
    (
      await scope.accountAccess.checkAutomation({
        authority,
        action: "execute",
      })
    ).ok,
  ).toBe(false);
  const oldInitialGrant = await client.value.setAutomationGrant({
    binding: actor.binding,
    user: actor.user,
    authority: actor.authority,
    automationId: automation.value.automationId,
    grantId: automation.value.grantId,
    nativePrincipalId: automation.value.nativePrincipalId,
    access: "allowed",
    expectedAccessRevision: 0,
  });
  expect(oldInitialGrant).toEqual({
    ok: false,
    error: { code: "operation_conflict" },
  });
  const regranted = await client.value.setAutomationGrant({
    binding: actor.binding,
    user: actor.user,
    authority: actor.authority,
    automationId: automation.value.automationId,
    grantId: automation.value.grantId,
    nativePrincipalId: automation.value.nativePrincipalId,
    access: "allowed",
    expectedAccessRevision: 1,
  });
  if (!regranted.ok)
    throw new Error(`Explicit regrant failed: ${regranted.error.code}`);
  expect(regranted.value.accessRevision).toBe(2);
  expect(
    (
      await scope.accountAccess.checkAutomation({
        authority,
        action: "execute",
      })
    ).ok,
  ).toBe(false);
  const replay = await exports.default.fetch(grantUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(grantBody),
  });
  expect(replay.status, await replay.clone().text()).toBe(403);
  const retained = await resolveLinkedPantryAccountAutomation(
    env,
    scope.organisationId,
    { kind: "workflow", nativeId: workflowId, revision: 1 },
  );
  expect(retained).toEqual(automation);
  const snapshot = await accountFixtureJson("snapshot", { version: 1 });
  evidence.stage = "complete";
  evidence.initial = automation.value;
  evidence.revoked = revoked;
  evidence.oldInitialGrant = oldInitialGrant;
  evidence.explicitRegrant = regranted.value;
  evidence.nativeReplayStatus = replay.status;
  evidence.retainedNativeRevision = 1;
  evidence.account = snapshot;
  context.task.meta.sharedAccountAutomation = JSON.parse(JSON.stringify(evidence));
}

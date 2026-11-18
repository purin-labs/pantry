import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";
import {
  readAccountOnboardingOptions,
  readAccountOnboardingRequest,
  readAccountOnboardingResult,
} from "@seams/control-api";
import { createAccountPlatformClient } from "../../src/account-platform/client";
import { registerPantryOnboardingIdentity } from "../../src/account-platform/identity";
import { runAccountInstanceRelease } from "../../src/account-platform/instance-release";
import { readPantryProvisionEnvelope } from "../../src/account-platform/provisioning-boundary";
import { publishOrganisationDirectoryRow } from "../../src/data/shared-rows/organisation-row";
import { parseOrganisationId } from "../../src/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceHeaders } from "./commerce-support";
import {
  accountFixtureJson,
  accountFixtureRequest,
  applyAccountFixtureProvision,
  bootstrapSharedAccountNativeTenants,
  nativeAccountRequest,
  readSharedAccountFixture,
} from "./shared-account-platform-fixture";

const path = "/v1/control/account-onboarding";

async function value(response: Response): Promise<unknown> {
  const raw: unknown = await response.json();
  if (!response.ok || !isRecord(raw) || raw.ok !== true)
    throw new Error(
      `Onboarding response ${response.status}: ${JSON.stringify(raw)}`,
    );
  return raw.value;
}

it(
  "Satyr onboarding selects or creates Platform projects and recovers accepted setup without widening access",
  onboardingJourney,
  180000,
);

async function onboardingJourney(context: TestContext): Promise<void> {
  if (!env.ACCOUNT_PLATFORM)
    throw new Error(
      "The onboarding journey requires its private account binding",
    );
  const native = await bootstrapSharedAccountNativeTenants();
  const setup = readSharedAccountFixture(
    await accountFixtureJson("setup", native.setup),
  );
  await applyAccountFixtureProvision(setup.provisionEnvelopes.primary);
  await applyAccountFixtureProvision(setup.provisionEnvelopes.foreign);
  const owner = native.primary.owner;
  const token = setup.googleIdTokens[owner.identity.userId];
  if (!token) throw new Error("Missing Google proof");
  const registered = await registerPantryOnboardingIdentity(
    env,
    owner.session.session,
    token,
  );
  expect(registered.ok).toBe(true);
  const foreignClient = createAccountPlatformClient(env);
  if (!foreignClient.ok) throw new Error("Missing private account binding");
  const mismatch = await foreignClient.value.registerOnboardingIdentity(
    native.foreign.owner.identity,
    native.foreign.owner.session.session,
    token,
  );
  expect(mismatch).toMatchObject({
    ok: false,
    error: { code: "scope_forbidden" },
  });
  const options = readAccountOnboardingOptions(
    await value(await nativeAccountRequest(owner, path, null)),
  );
  expect(options.organizations.map(organizationId)).toContain(
    setup.primary.scope.organizationId,
  );
  expect(options.organizations.map(organizationId)).not.toContain(
    setup.foreign.scope.organizationId,
  );
  const forbidden = readAccountOnboardingRequest({
    version: 1,
    operationId: "foreign-project",
    selection: {
      kind: "existing_project",
      organizationId: setup.foreign.scope.organizationId,
      projectId: setup.foreign.scope.projectId,
    },
  });
  expect((await nativeAccountRequest(owner, path, forbidden)).status).toBe(403);
  const request = readAccountOnboardingRequest({
    version: 1,
    operationId: "satyr-onboarding-lost-reply",
    selection: {
      kind: "new_project",
      organizationId: setup.primary.scope.organizationId,
      projectName: "Satyr onboarding project",
    },
  });
  await accountFixtureJson("fault", {
    version: 1,
    kind: "lose_onboarding_reply",
  });
  expect((await nativeAccountRequest(owner, path, request)).status).toBe(503);
  const pending = readAccountOnboardingResult(
    await value(await nativeAccountRequest(owner, path, request)),
  );
  if (pending.kind !== "pending")
    throw new Error("Expected pending provisioning");
  const delivered = await accountFixtureRequest("onboarding-delivery", {
    version: 1,
    operationId: pending.operationId,
  });
  expect(delivered.status).toBe(200);
  let envelope = readPantryProvisionEnvelope(await delivered.json());
  await accountFixtureJson("mutate", {
    version: 1,
    kind: "fail_service_provision",
    organisation: "primary",
    instanceId: pending.instanceId,
  });
  expect((await nativeAccountRequest(owner, path, request)).status).toBe(403);
  const retry = readAccountOnboardingRequest({
    version: 1,
    operationId: "retry-failed-setup",
    selection: {
      kind: "existing_project",
      organizationId: envelope.delivery.scope.organizationId,
      projectId: envelope.delivery.scope.projectId,
    },
  });
  const resumed = readAccountOnboardingResult(
    await value(await nativeAccountRequest(owner, path, retry)),
  );
  if (resumed.kind !== "pending")
    throw new Error("Expected resumed provisioning");
  expect(resumed.instanceId).toBe(pending.instanceId);
  const resumedDelivery = await accountFixtureRequest("onboarding-delivery", {
    version: 1,
    operationId: resumed.operationId,
  });
  envelope = readPantryProvisionEnvelope(await resumedDelivery.json());
  expect(envelope.delivery.command.desiredRevision).toBe(2);
  const provision = await applyAccountFixtureProvision(envelope);
  const replay = await applyAccountFixtureProvision(envelope);
  expect(replay.receipt).toEqual(provision.receipt);
  const ready = readAccountOnboardingResult(
    await value(await nativeAccountRequest(owner, path, request)),
  );
  expect(ready).toEqual({
    kind: "ready",
    nativeOrganizationId:
      provision.receipt.binding.nativeScope.nativeOrganizationId,
  });
  const reopened = readAccountOnboardingRequest({
    version: 1,
    operationId: "reopen-from-project-picker",
    selection: {
      kind: "existing_project",
      organizationId: envelope.delivery.scope.organizationId,
      projectId: envelope.delivery.scope.projectId,
    },
  });
  expect(
    await value(await nativeAccountRequest(owner, path, reopened)),
  ).toEqual(ready);
  // Until Pantry reports the deletion, the account platform's instance stays
  // active and the same project answers "ready" with the deleted
  // organisation. Setup refuses it.
  const firstOrganisationId =
    provision.receipt.binding.nativeScope.nativeOrganizationId;
  await deleteOrganisation(owner, firstOrganisationId);
  const afterDelete = await nativeAccountRequest(owner, path, reopened);
  expect(afterDelete.status).toBe(403);
  expect(await afterDelete.json()).toMatchObject({
    error: "account_setup_blocked",
  });
  // Pantry reports the deletion. The account platform answers with a disable
  // command and then an archive command; Pantry confirms each one.
  await releaseStep(pending.instanceId, "disable");
  await releaseStep(pending.instanceId, "archive");
  await runAccountInstanceRelease(env, Date.now());
  const released = await accountFixtureJson("snapshot", { version: 1 });
  expect(
    rows(released.platform_service_instances).find(
      matchesInstance.bind(null, pending.instanceId),
    ),
  ).toMatchObject({ phase: "archived", observed_state: "archived" });
  expect(
    rows(released.platform_provision_operations).filter(
      pendingFor.bind(null, pending.instanceId),
    ),
  ).toHaveLength(0);
  expect(
    await env.DB.prepare(
      "SELECT account_state FROM account_service_binding WHERE instance_id = ?",
    )
      .bind(pending.instanceId)
      .first("account_state"),
  ).toBe("archived");
  // The archived project leaves the setup options, and the account platform
  // itself now refuses it.
  const releasedOptions = readAccountOnboardingOptions(
    await value(await nativeAccountRequest(owner, path, null)),
  );
  expect(
    releasedOptions.organizations
      .find(
        (organization) =>
          organization.id === envelope.delivery.scope.organizationId,
      )
      ?.projects.map(organizationId),
  ).not.toContain(envelope.delivery.scope.projectId);
  const accountClient = createAccountPlatformClient(env);
  if (!accountClient.ok) throw new Error("Missing private account binding");
  expect(
    await accountClient.value.startOnboarding(
      owner.identity,
      owner.session.session,
      reopened,
    ),
  ).toMatchObject({ ok: false, error: { code: "instance_ineligible" } });
  const replacement = readAccountOnboardingRequest({
    version: 1,
    operationId: "satyr-onboarding-after-delete",
    selection: {
      kind: "new_project",
      organizationId: setup.primary.scope.organizationId,
      projectName: "Satyr after delete",
    },
  });
  const replacementPending = readAccountOnboardingResult(
    await value(await nativeAccountRequest(owner, path, replacement)),
  );
  if (replacementPending.kind !== "pending")
    throw new Error("Expected pending provisioning for the new project");
  const replacementDelivery = await accountFixtureRequest(
    "onboarding-delivery",
    { version: 1, operationId: replacementPending.operationId },
  );
  const replacementProvision = await applyAccountFixtureProvision(
    readPantryProvisionEnvelope(await replacementDelivery.json()),
  );
  const replacementOrganisationId =
    replacementProvision.receipt.binding.nativeScope.nativeOrganizationId;
  expect(replacementOrganisationId).not.toBe(firstOrganisationId);
  expect(
    readAccountOnboardingResult(
      await value(await nativeAccountRequest(owner, path, replacement)),
    ),
  ).toEqual({ kind: "ready", nativeOrganizationId: replacementOrganisationId });
  const opened = await nativeAccountRequest(
    owner,
    `/v1/control/organisations/${replacementOrganisationId}`,
    null,
  );
  expect(opened.status).toBe(200);

  const snapshot = await accountFixtureJson("snapshot", { version: 1 });
  const instances = rows(snapshot.platform_service_instances);
  expect(instances.filter(isWallet)).toHaveLength(1);
  expect(
    instances.filter(matchesInstance.bind(null, pending.instanceId)),
  ).toHaveLength(1);

  await accountFixtureJson("mutate", {
    version: 1,
    kind: "request_service_disable",
    organisation: "primary",
    instanceId: replacementPending.instanceId,
  });
  expect((await nativeAccountRequest(owner, path, replacement)).status).toBe(
    403,
  );
  await accountFixtureJson("fault", { version: 1, kind: "onboarding_outage" });
  expect((await nativeAccountRequest(owner, path, null)).status).toBe(503);
  await accountFixtureJson("fault", { version: 1, kind: "clear" });

  const newAccount = readAccountOnboardingRequest({
    version: 1,
    operationId: "satyr-onboarding-new-account",
    selection: {
      kind: "new_organization",
      organizationName: "New Satyr account",
      projectName: "Satyr",
    },
  });
  const created = readAccountOnboardingResult(
    await value(await nativeAccountRequest(owner, path, newAccount)),
  );
  expect(
    readAccountOnboardingResult(
      await value(await nativeAccountRequest(owner, path, newAccount)),
    ),
  ).toEqual(created);
  const unsigned = await env.ACCOUNT_PLATFORM.fetch(
    "https://account-platform.internal/account-platform/v1/onboarding/options",
    { method: "POST", body: JSON.stringify({ version: 1 }) },
  );
  expect(unsigned.status).toBe(403);
  const noSession = await exports.default.fetch(`https://localhost${path}`);
  expect(noSession.status).toBe(401);
  const evidence = {
    accountWorkerSha256: env.TEST_ACCOUNT_PLATFORM_WORKER_SHA256,
    operationId: pending.operationId,
    instanceId: pending.instanceId,
    nativeOrganizationId:
      provision.receipt.binding.nativeScope.nativeOrganizationId,
    checks: [
      "verified login",
      "foreign proof rejected",
      "existing account selection",
      "new project",
      "lost reply",
      "durable replay",
      "failed setup resumes on the same project",
      "deleted organisation refused for its project",
      "deletion reported: instance disabled, then archived",
      "archived project left the setup options",
      "new project after delete opens a new organisation",
      "one Satyr instance",
      "no Wallet provision",
      "disabled state preserved",
      "authority outage",
      "new account replay",
      "unsigned producer request rejected",
      "unauthenticated session rejected",
    ],
  };
  Object.assign(context.task.meta, { satyrOnboarding: evidence });
}

/** Archive, then delete, the organisation through the owner's control routes. */
async function deleteOrganisation(
  owner: Parameters<typeof nativeAccountRequest>[0],
  organisationIdRaw: string,
): Promise<void> {
  const organisationId = parseOrganisationId(organisationIdRaw);
  if (!organisationId.ok) throw new Error("Invalid organisation id");
  for (const step of [
    { method: "POST", suffix: "/archive", key: "archive-before-delete" },
    { method: "DELETE", suffix: "", key: "delete-after-archive" },
  ]) {
    const scope = await requireOrganisationExecutionScope(
      env,
      organisationId.value,
    );
    const row = await scope.database
      .prepare(
        "SELECT configuration_version AS version FROM organisation_onboarding WHERE organisation_id = ?",
      )
      .bind(organisationId.value)
      .first<{ version: number }>();
    if (row === null) throw new Error("Missing organisation onboarding row");
    const headers = commerceHeaders(owner.session);
    headers.set("idempotency-key", `satyr-onboarding-${step.key}`);
    headers.set("x-satyr-configuration-version", String(row.version));
    const response = await exports.default.fetch(
      `https://localhost/v1/control/organisations/${organisationId.value}${step.suffix}`,
      { method: step.method, headers, body: "{}" },
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  // A deletion writes the regional row only; the scheduled reconciliation
  // publishes it to the global directory within one run.
  const scope = await requireOrganisationExecutionScope(
    env,
    organisationId.value,
  );
  await publishOrganisationDirectoryRow({
    directory: env.DB,
    db: scope.database,
    organisationId: organisationId.value,
  });
}

/** Report the deletion, then deliver the one command that the report causes. */
async function releaseStep(
  instanceId: string,
  command: "disable" | "archive",
): Promise<void> {
  await runAccountInstanceRelease(env, Date.now());
  const snapshot = await accountFixtureJson("snapshot", { version: 1 });
  const operations = rows(snapshot.platform_provision_operations).filter(
    pendingFor.bind(null, instanceId),
  );
  expect(operations).toHaveLength(1);
  const operation = operations[0];
  expect(operation?.command).toBe(command);
  const delivered = await accountFixtureRequest("onboarding-delivery", {
    version: 1,
    operationId: operation?.id,
  });
  expect(delivered.status).toBe(200);
  const applied = await applyAccountFixtureProvision(
    readPantryProvisionEnvelope(await delivered.json()),
  );
  expect(applied.receipt.result).toBe(
    command === "disable" ? "disabled" : "archived",
  );
}

function pendingFor(id: string, operation: Record<string, unknown>): boolean {
  return operation.instance_id === id && operation.status === "pending";
}
function organizationId(organization: { readonly id: string }): string {
  return organization.id;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord))
    throw new Error("Invalid evidence rows");
  return value;
}
function isWallet(instance: Record<string, unknown>): boolean {
  return instance.service_id === "wallet";
}
function matchesInstance(
  id: string,
  instance: Record<string, unknown>,
): boolean {
  return instance.id === id;
}

import {
  createCurrentObservedSourceFlowLabel,
  integrationResourceScopeForGrant,
} from "../../src/policy/information-flow";
import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import type { AccessGrant } from "../../src/authorization/access-grants/types";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { parseCommerceGraphQuery } from "@purin-labs/commerce-client";
import {
  commerceClient,
  commerceWorkspace,
  commerceHeaders,
  connectCommerceFixture,
} from "./commerce-support";
import { activateOrganisation } from "./organisation-fixture";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { opaqueSubjectReference } from "../../src/access-control/references";
import { listAccessGrants } from "../../src/data/access-grants";
import {
  readActiveOrganisationMembershipRevision,
  readActiveOrganisationMembership,
} from "@purin-labs/tenancy/data/control-plane";
import { buildControlAuthority } from "../../src/request-authority";
import { readNamedCommerceQuery } from "../../src/commerce/entity-plane/context-read";
import { CommerceGraphReader } from "../../src/commerce/entity-plane/graph-reader";
import { CommerceEngineSource } from "../../src/commerce/entity-plane/commerce-source";
import { createCommerceEntityPlaneClient } from "../../src/commerce/contract/client";
import { resolveOrganisationCommerceSystemAuthority } from "../../src/data/organisation-commerce-system";
import { createFinancierSample } from "../../src/commerce/bakery/sample";

it(
  "grants a custom procedure source through Access, preserves replay, and refuses reads after revocation",
  procedureAccessJourney,
  60000,
);

async function procedureAccessJourney({ task }: TestContext): Promise<void> {
  const owner = await commerceClient("procedure-source-owner");
  const organisationId = await commerceWorkspace(
    owner,
    "Procedure source access",
  );
  await activateOrganisation(organisationId);
  const merchantId = "merchant_bakery_c3_cursor_source";
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const commerce = await resolveOrganisationCommerceSystemAuthority({
    db: scope.database,
    organisationId,
  });
  if (!commerce.ok || commerce.value.commerceSystem.kind !== "builtin_commerce")
    throw new Error("Missing commerce binding");
  const client = createCommerceEntityPlaneClient(env, undefined, {
    kind: "organisation",
    organisationId: String(organisationId),
  });
  if (client === null) throw new Error("Missing source client");
  const created = await createFinancierSample({
    client,
    organisationId,
    merchantId,
    principalId: owner.identity.userId,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  expect(created.ok).toBe(true);
  const membership = await readActiveOrganisationMembership(
    scope.database,
    organisationId,
    owner.identity.userId,
  );
  const membershipRevision = await readActiveOrganisationMembershipRevision({
    db: scope.database,
    organisationId,
  });
  if (membership === null || membershipRevision === null)
    throw new Error("Missing membership");
  const authority = buildControlAuthority({
    organisationId,
    userId: owner.identity.userId,
    requesterPersonId: membership.personId,
    membershipRevision,
    role: "owner",
  }).requestAuthority;
  const query = parseCommerceGraphQuery({
    kind: "entity_by_ref",
    reference: {
      origin: "custom",
      typeId: "bakery_procedure",
      entityId: "financier-finishing-cooling-sample",
    },
    traversal: { maxDepth: 0, resultLimit: 1 },
    filter: null,
  });
  const reader = new CommerceGraphReader({
    organisationId,
    merchantId,
    commerce: new CommerceEngineSource({
      organisationId,
      merchantId,
      integrationAccountId: commerce.value.integrationAccountId,
      client,
    }),
  });
  const source = {
    organisationId,
    merchantId,
    requestAuthority: authority,
    causationId: "procedure-access-journey",
    query,
    allowedSensitivity: "internal" as const,
    reader,
  };
  expect(await readSource(scope, source)).toMatchObject({
    ok: false,
    error: { code: "commerce_context_authority_denied" },
  });
  const base = `https://localhost/v1/control/organisations/${organisationId}/access-control`;
  const subjectRefId = await opaqueSubjectReference(organisationId, {
    kind: "organisation_role",
    firstId: "owner",
    secondId: null,
    revision: 1,
  });
  const projection = await scope.database
    .prepare(
      "SELECT projection_revision AS revision FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ revision: number }>();
  if (projection === null) throw new Error("Missing access revision");
  const body = {
    expectedRevision: projection.revision,
    subjectRef: { subjectRefId, revision: 1 },
    target: {
      kind: "commerce_entity_type",
      capabilityRef: {
        capabilityId: "commerce.entity.read",
        capabilityVersion: 1,
      },
      entityTypeId: { origin: "custom", typeId: "bakery_procedure" },
    },
  };
  const headers = commerceHeaders(owner.session);
  headers.set("idempotency-key", "procedure-source-grant");
  const granted = await exports.default.fetch(`${base}/grants`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const grantReply: unknown = await granted.json();
  expect(granted.status, JSON.stringify(grantReply)).toBe(200);
  const replayed = await exports.default.fetch(`${base}/grants`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  expect(await replayed.json()).toEqual(grantReply);
  const read = await readSource(scope, source);
  expect(read.ok).toBe(true);
  const grants = await listAccessGrants({ db: scope.database, organisationId });
  if (!grants.ok) throw new Error(grants.error.code);
  const selected = grants.value.filter(isProcedureGrant);
  expect(selected).toHaveLength(1);
  const grant = selected[0];
  if (grant === undefined) throw new Error("Missing granted source");
  await verifyEmptyRoleAudience(
    scope,
    owner.session,
    base,
    commerce.value.integrationAccountId,
    grant,
  );
  const current = await scope.database
    .prepare(
      "SELECT projection_revision AS revision FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ revision: number }>();
  if (current === null) throw new Error("Missing access revision");
  const revokeHeaders = commerceHeaders(owner.session);
  revokeHeaders.set("idempotency-key", "procedure-source-revoke");
  const revoked = await exports.default.fetch(
    `${base}/grants/${grant.grantId}/revoke`,
    {
      method: "POST",
      headers: revokeHeaders,
      body: JSON.stringify({
        expectedRevision: current.revision,
        grantRevision: grant.lifecycle.revision,
        reason: "End procedure acceptance",
      }),
    },
  );
  expect(revoked.status, await revoked.clone().text()).toBe(200);
  expect(await readSource(scope, source)).toMatchObject({
    ok: false,
    error: { code: "commerce_context_authority_denied" },
  });
  Object.assign(task.meta, {
    procedureAccess: {
      organisationId,
      merchantId,
      grantId: grant.grantId,
      before: "denied",
      after: "read accepted",
      replay: "same receipt, one grant",
      revoked: "read denied",
    },
  });
}

async function readSource(
  scope: OrganisationExecutionScope,
  source: Omit<Parameters<typeof readNamedCommerceQuery>[0], "grants" | "now">,
) {
  const grants = await listAccessGrants({
    db: scope.database,
    organisationId: scope.organisationId,
  });
  if (!grants.ok) throw new Error(grants.error.code);
  return readNamedCommerceQuery({
    ...source,
    grants: grants.value,
    now: new Date().toISOString(),
  });
}

function isProcedureGrant(grant: AccessGrant): boolean {
  return (
    grant.target.kind === "commerce_read" &&
    grant.target.scope.kind === "entity_type" &&
    grant.target.scope.entityTypeId.origin === "custom" &&
    grant.target.scope.entityTypeId.typeId === "bakery_procedure"
  );
}

async function verifyEmptyRoleAudience(
  scope: OrganisationExecutionScope,
  session: import("@purin-labs/tenancy/data/control-plane").IssuedControlSession,
  base: string,
  integrationAccountId: string,
  grant: AccessGrant,
): Promise<void> {
  const policyHeaders = commerceHeaders(session);
  policyHeaders.set("idempotency-key", "enable-procedure-source-read");
  const policy = await exports.default.fetch(
    `${base}/capabilities/commerce.entity.read`,
    {
      method: "POST",
      headers: policyHeaders,
      body: JSON.stringify({
        expectedRevision: await accessRevision(scope),
        capabilityRevision: 1,
        capabilityVersion: 1,
        mode: "enabled",
      }),
    },
  );
  expect(policy.status, await policy.clone().text()).toBe(200);
  const subjectRefId = await opaqueSubjectReference(scope.organisationId, {
    kind: "organisation_role",
    firstId: "viewer",
    secondId: null,
    revision: 1,
  });
  const headers = commerceHeaders(session);
  headers.set("idempotency-key", "grant-empty-viewer-procedure-source");
  const response = await exports.default.fetch(`${base}/grants`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      expectedRevision: await accessRevision(scope),
      subjectRef: { subjectRefId, revision: 1 },
      target: {
        kind: "commerce_entity_type",
        capabilityRef: {
          capabilityId: "commerce.entity.read",
          capabilityVersion: 1,
        },
        entityTypeId: { origin: "custom", typeId: "bakery_procedure" },
      },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const resourceScope = integrationResourceScopeForGrant(grant);
  if (resourceScope === null) throw new Error("Missing source scope");
  const label = await createCurrentObservedSourceFlowLabel(scope.database, {
    kind: "integration_resource",
    organisationId: scope.organisationId,
    integrationAccountId,
    resourceScope,
  });
  expect(label.ok).toBe(true);
  if (!label.ok) throw new Error(label.error.code);
  expect(label.value.policies[0]?.readers).toEqual(
    expect.arrayContaining([
      { kind: "organisation_role", role: "owner" },
      { kind: "organisation_role", role: "viewer" },
    ]),
  );
}

async function accessRevision(
  scope: OrganisationExecutionScope,
): Promise<number> {
  const current = await scope.database
    .prepare(
      "SELECT projection_revision AS revision FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(scope.organisationId)
    .first<{ revision: number }>();
  if (current === null) throw new Error("Missing access revision");
  return current.revision;
}

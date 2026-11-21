import { env } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import {
  COMMERCE_API_SCOPES,
  parseListEntryReadRequest,
} from "@purin-labs/commerce-client";
import { createCommerceEntityPlaneClient } from "../../src/commerce/contract/client";
import {
  commerceClient,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import { PRODUCTION, PlanJourney } from "./production-plan-support";

declare module "vitest" {
  interface TaskMeta {
    underclerkAppAccess?: Record<string, unknown>;
  }
}

const OPERATOR = "Bearer underclerk-e2e-token";

it(
  "runs Satyr's commerce commands on its own app installation, for its own organisation's merchant only",
  { timeout: 180_000 },
  appAccessJourney,
);

/**
 * Plan 76 phase 2. An operator plans production for a café through the
 * Portal. Pantry sends each command to Commerce with its installation token
 * for that merchant, and the first command installs Pantry there. A Pantry
 * client that acts for this organisation cannot reach a second shop's
 * merchant. When the operator of Commerce uninstalls Pantry, the next
 * command fails and Pantry does not install itself again; after a new
 * install the same command succeeds.
 */
async function appAccessJourney({ task }: TestContext): Promise<void> {
  const owner = await commerceClient(`app-access-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "App access café");
  const merchantId = `merchant_app_access_${crypto.randomUUID().replaceAll("-", "")}`;
  // A merchant from before Plan 76 phase 2: Pantry is not installed yet.
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
    { installSatyr: false },
  );
  const shop = new PlanJourney(organisationId, merchantId, owner.session);
  const provisioned = await shop.native.provisionDemo({
    schemaVersion: "underclerk.provision-demo.v2",
    externalReference: organisationId,
    merchantId,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  expect(provisioned.ok, JSON.stringify(provisioned)).toBe(true);

  // 1. No installation exists before Pantry's first command.
  expect(await credentials(merchantId)).toEqual([]);
  await shop.write(PRODUCTION, { kind: "setup" });
  const [firstRequest] = await shop.createRequests(1);
  expect(firstRequest).toBeDefined();
  const installed = await credentials(merchantId);
  expect(installed).toEqual([
    {
      kind: "app_installation",
      appId: "satyr",
      label: "Satyr",
      scopes: [...COMMERCE_API_SCOPES],
      revoked: false,
    },
  ]);

  // 2. A second shop of another organisation, on its own merchant.
  const neighbour = await commerceClient(
    `app-access-neighbour-${crypto.randomUUID()}`,
  );
  const neighbourOrganisation = await commerceWorkspace(
    neighbour,
    "Neighbour shop",
  );
  const neighbourMerchant = `merchant_app_access_neighbour_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    neighbourOrganisation,
    neighbour.identity.userId,
    neighbourMerchant,
    { installSatyr: false },
  );
  const crossClient = createCommerceEntityPlaneClient(env, undefined, {
    kind: "organisation",
    organisationId,
  });
  if (crossClient === null) throw new Error("Underclerk client missing");
  const cross = await crossClient.readListEntry(
    parseListEntryReadRequest({
      merchantId: neighbourMerchant,
      listId: "production_requests",
      entryId: firstRequest ?? "",
    }),
  );
  expect(cross.ok).toBe(false);
  const crossStatus =
    !cross.ok && cross.error.kind === "http" ? cross.error.status : null;
  expect(crossStatus).toBe(401);
  expect(await credentials(neighbourMerchant)).toEqual([]);

  // 3. Uninstalled, Pantry's next command fails and Pantry stays out.
  const uninstall = await env.UNDERCLERK.fetch(
    `http://underclerk.test/v1/admin/merchants/${merchantId}/app-installations/satyr/revocation`,
    { method: "POST", headers: { authorization: OPERATOR } },
  );
  expect(uninstall.status).toBe(200);
  const blocked = await shop.send(PRODUCTION);
  expect(blocked.status).not.toBe(200);
  expect((await credentials(merchantId)).map((entry) => entry.revoked)).toEqual(
    [true],
  );

  // 4. A new install by the operator lets the same read through again.
  const reinstall = await env.UNDERCLERK.fetch(
    `http://underclerk.test/v1/admin/merchants/${merchantId}/app-installations/satyr`,
    {
      method: "PUT",
      headers: { authorization: OPERATOR, "content-type": "application/json" },
      body: JSON.stringify({
        scopes: [...COMMERCE_API_SCOPES],
        externalReference: organisationId,
        label: "Satyr",
      }),
    },
  );
  expect(reinstall.status).toBe(200);
  const [secondRequest] = await shop.createRequests(1);
  expect(secondRequest).toBeDefined();

  task.meta.underclerkAppAccess = {
    beforeFirstCommand: [],
    afterFirstCommand: installed,
    otherOrganisationMerchant: { status: crossStatus, installations: 0 },
    afterUninstall: { portalStatus: blocked.status },
    afterReinstall: { requestCreated: secondRequest !== undefined },
  };
}

/** The operator's list of a merchant's credentials, without ids or times. */
async function credentials(merchantId: string): Promise<
  readonly Readonly<{
    kind: unknown;
    appId: unknown;
    label: unknown;
    scopes: unknown;
    revoked: boolean;
  }>[]
> {
  const response = await env.UNDERCLERK.fetch(
    `http://underclerk.test/v1/admin/merchants/${merchantId}/api-credentials`,
    { headers: { authorization: OPERATOR } },
  );
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.credentials))
    throw new Error(`Credential list failed: ${JSON.stringify(body)}`);
  return body.credentials.filter(isRecord).map((entry) => ({
    kind: entry.kind,
    appId: entry.appId,
    label: entry.label,
    scopes: entry.scopes,
    revoked: entry.revokedAt !== null,
  }));
}

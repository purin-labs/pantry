import { exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { CAPABILITY_KEYS } from "../../src/authorization/capability-catalogue";
import type { IssuedControlSession } from "../../src/data/control-plane";
import type { OrganisationId } from "../../src/ids";
import {
  accessControlPath,
  createGrant,
  enableCapability,
  revokeGrant,
} from "./access-route-support";
import {
  commerceClient,
  commerceHeaders,
  commerceWorkspace,
  connectCommerceFixture,
} from "./commerce-support";
import {
  activateSharedAccountNativeTenant,
  attachSharedAccountNativeOrganisation,
} from "./shared-account-platform-fixture";

declare module "vitest" {
  interface TaskMeta {
    portalSupplierPayoutRead?: Record<string, unknown>;
  }
}

/**
 * The Portal shows supplier payout figures only to a person whom a payout
 * read grant admits.
 *
 * A café owner opens the Suppliers page before anyone has allowed payout
 * reads: the payout list, the payout and its audit are refused. The owner
 * turns payout reads on and grants them to the Owner role on the Access
 * page, and then sees the outstanding flour payout. A viewer of the same
 * Organisation still gets the refusal and no figure. When the owner takes
 * the grant away, the owner's next read is refused too.
 */
it(
  "shows supplier payouts in the Portal only to a person whom a payout read grant admits",
  { timeout: 120_000 },
  portalPayoutReadJourney,
);

const MERCHANT_ID = "merchant_bakery_c3_portal_payout";
const SUPPLIER_ID = "supplier_flour_mill";
const PAYOUT_ID = "supplier_payout_flour";
const AMOUNT_MINOR = 186000;
const REFUSAL = {
  ok: false,
  error: "supplier_payout_read_unavailable",
} as const;

type Reads = Readonly<{
  list: Response;
  payout: Response;
  audit: Response;
  timeline: Response;
}>;

async function portalPayoutReadJourney(test: TestContext): Promise<void> {
  const owner = await commerceClient("payout-owner");
  const viewer = await commerceClient("payout-viewer");
  const organisationId = await commerceWorkspace(owner, "Pâtisserie payouts");
  await addViewer(organisationId, viewer.identity.userId);
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: { privateMember: viewer },
  });
  await activateSharedAccountNativeTenant(organisationId);
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    MERCHANT_ID,
  );
  await seedOutstandingPayout(organisationId);

  // 1. Nobody has allowed payout reads: the owner sees no figure.
  const before = await readPayouts(organisationId, owner.session);
  await expectRefused(before);

  // 2. The owner allows payout reads for the Owner role on the Access page.
  await enableCapability(
    organisationId,
    owner.session,
    CAPABILITY_KEYS.commerceSupplierPayoutRead,
  );
  await createGrant(organisationId, owner.session, {
    subjectRef: await ownerRoleSubject(organisationId, owner.session),
    target: {
      kind: "platform",
      capabilityRef: {
        capabilityId: CAPABILITY_KEYS.commerceSupplierPayoutRead,
        capabilityVersion: 1,
      },
    },
  });
  const granted = await readPayouts(organisationId, owner.session);
  expect(granted.list.status).toBe(200);
  const list: unknown = await granted.list.json();
  expect(list).toMatchObject({
    ok: true,
    supplierPayouts: [
      {
        payoutId: PAYOUT_ID,
        supplierId: SUPPLIER_ID,
        recipientAmountMinor: AMOUNT_MINOR,
      },
    ],
  });
  // The timeline finds the same payout in its month, and a longer window is
  // refused.
  const base = `https://localhost/v1/control/organisations/${organisationId}/commerce/supplier-payouts`;
  const now = Date.now();
  const month = await exports.default.fetch(
    `${base}?view=timeline&from=${String(now - 30 * 86_400_000)}&to=${String(now + 86_400_000)}`,
    { headers: commerceHeaders(owner.session) },
  );
  expect(month.status).toBe(200);
  expect(await month.json()).toMatchObject({
    truncated: false,
    supplierPayouts: [
      {
        payoutId: PAYOUT_ID,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    ],
  });
  const earlier = await exports.default.fetch(
    `${base}?view=timeline&from=0&to=86400000`,
    { headers: commerceHeaders(owner.session) },
  );
  expect(await earlier.json()).toMatchObject({ supplierPayouts: [] });
  const tooLong = await exports.default.fetch(
    `${base}?view=timeline&from=0&to=${String(now)}`,
    { headers: commerceHeaders(owner.session) },
  );
  expect(tooLong.status).toBe(422);
  expect(granted.payout.status).toBe(200);
  expect(await granted.payout.json()).toMatchObject({
    supplierPayout: { payoutId: PAYOUT_ID },
  });
  expect(granted.audit.status).toBe(200);
  expect(await granted.audit.json()).toMatchObject({
    supplierPayout: { recipientAmountMinor: AMOUNT_MINOR },
  });

  // 3. A viewer of the same Organisation holds no grant: still refused.
  const viewerReads = await readPayouts(organisationId, viewer.session);
  await expectRefused(viewerReads);

  // 4. The owner takes the grant away: the owner's next read is refused.
  await revokeGrant(
    organisationId,
    owner.session,
    CAPABILITY_KEYS.commerceSupplierPayoutRead,
    "organisation_role",
  );
  const revoked = await readPayouts(organisationId, owner.session);
  await expectRefused(revoked);

  Object.assign(test.task.meta, {
    portalSupplierPayoutRead: {
      ownerBeforeGrant: before.list.status,
      ownerWithGrant: list,
      viewer: viewerReads.list.status,
      ownerAfterRevoke: revoked.list.status,
    },
  });
}

/** The three payout reads of the Suppliers page and its audit download. */
async function readPayouts(
  organisationId: OrganisationId,
  session: IssuedControlSession,
): Promise<Reads> {
  const base = `https://localhost/v1/control/organisations/${organisationId}/commerce/supplier-payouts`;
  const headers = commerceHeaders(session);
  return {
    list: await exports.default.fetch(base, { headers }),
    payout: await exports.default.fetch(`${base}/${PAYOUT_ID}`, { headers }),
    audit: await exports.default.fetch(`${base}/${PAYOUT_ID}/audit`, {
      headers,
    }),
    timeline: await exports.default.fetch(
      `${base}?view=timeline&from=${String(Date.now() - 86_400_000)}&to=${String(Date.now())}`,
      { headers },
    ),
  };
}

/** Each read is refused, and no answer names the supplier or the amount. */
async function expectRefused(reads: Reads): Promise<void> {
  for (const response of [
    reads.list,
    reads.payout,
    reads.audit,
    reads.timeline,
  ]) {
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual(REFUSAL);
    expect(body).not.toContain(SUPPLIER_ID);
    expect(body).not.toContain(String(AMOUNT_MINOR));
  }
}

/** The Owner role as the Access page's grant dialog offers it. */
async function ownerRoleSubject(
  organisationId: OrganisationId,
  session: IssuedControlSession,
): Promise<Readonly<{ subjectRefId: string; revision: number }>> {
  const response = await exports.default.fetch(
    `${accessControlPath(organisationId)}/options?kind=subjects&query=owner`,
    { headers: commerceHeaders(session) },
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  const items =
    isRecord(body) &&
    isRecord(body.options) &&
    Array.isArray(body.options.items)
      ? body.options.items
      : [];
  const option: unknown = items.find(
    (item: unknown) => isRecord(item) && item.label === "Owner role",
  );
  if (
    !isRecord(option) ||
    typeof option.refId !== "string" ||
    typeof option.revision !== "number"
  )
    throw new Error("Owner role subject missing");
  return { subjectRefId: option.refId, revision: option.revision };
}

async function addViewer(
  organisationId: OrganisationId,
  userId: string,
): Promise<void> {
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, 'person_payout_viewer', 'Viewer')",
      )
      .bind(organisationId),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, 'person_payout_viewer', 'viewer', 'active', ?, NULL)",
      )
      .bind(organisationId, userId, Date.now()),
  ]);
}

/** A flour payout whose outcome Pantry does not know, so it is outstanding. */
async function seedOutstandingPayout(
  organisationId: OrganisationId,
): Promise<void> {
  const now = Date.now();
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        `INSERT INTO supplier_payable (
         organisation_id, payable_id, merchant_id, supplier_id, purchase_request_id,
         currency, gross_amount_minor, in_flight_minor, settled_minor,
         lifecycle, revision, payable_json, updated_at
       ) VALUES (?, 'supplier_payable_flour', ?, ?, 'purchase_request_flour',
         'JPY', ?, ?, 0, 'approved', 1, '{}', ?)`,
      )
      .bind(
        organisationId,
        MERCHANT_ID,
        SUPPLIER_ID,
        AMOUNT_MINOR,
        AMOUNT_MINOR,
        now,
      ),
    fixtureDatabase()
      .prepare(
        `INSERT INTO supplier_payout (
         organisation_id, payout_id, payable_id, supplier_id, purchase_request_id,
         rail, integration_account_id, destination_revision_id, currency,
         recipient_amount_minor, fee_ceiling_minor, idempotency_key,
         state_kind, approval_digest, payout_json, revision, created_at, updated_at
       ) VALUES (?, ?, 'supplier_payable_flour', ?, 'purchase_request_flour',
         'gmo_aozora_private', 'integration_gmo', 'destination_revision_flour',
         'JPY', ?, 500, 'payout-flour-1', 'indeterminate', ?, '{}', 2, ?, ?)`,
      )
      .bind(
        organisationId,
        PAYOUT_ID,
        SUPPLIER_ID,
        AMOUNT_MINOR,
        "ab".repeat(32),
        now,
        now,
      ),
  ]);
}

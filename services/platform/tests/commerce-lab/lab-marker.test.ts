import type { SingleDatabase } from "../../src/database-handles";
import { describe, expect, it } from "vitest";

import {
  markCommerceLabOrganisation,
  requireCommerceLabOrganisationMarker,
} from "../../src/commerce-lab/lab-metadata";
import { createMigratedDatabase } from "../sqlite-d1";
import { requireOrganisationId } from "../test-ids";

describe("commerce lab reset marker", function commerceLabMarkerSuite() {
  it("requires an explicit marker and exact namespace before lab mutation", async function markerFence() {
    const db = createMigratedDatabase();
    const organisationId = requireOrganisationId("organisation_T0BGQSSG45N");

    await insertOrganisation(db, organisationId);

    await expect(
      requireCommerceLabOrganisationMarker({
        db,
        organisationId,
        labNamespace: "lab_acceptance",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "commerce_lab_not_marked" },
    });

    await expect(
      markCommerceLabOrganisation({
        db,
        organisationId,
        labNamespace: "ordinary_organisation",
        markedAt: 1_000,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "commerce_lab_namespace_mismatch" },
    });

    const marked = await markCommerceLabOrganisation({
      db,
      organisationId,
      labNamespace: "lab_acceptance",
      markedAt: 1_000,
    });

    expect(marked.ok).toBe(true);
    await expect(
      requireCommerceLabOrganisationMarker({
        db,
        organisationId,
        labNamespace: "lab_other",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "commerce_lab_namespace_mismatch" },
    });
    await expect(
      requireCommerceLabOrganisationMarker({
        db,
        organisationId,
        labNamespace: "lab_acceptance",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        organisationId,
        labNamespace: "lab_acceptance",
        markedAt: 1_000,
      },
    });
  });
});

async function insertOrganisation(
  db: SingleDatabase,
  organisationId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
       VALUES (?, 'Commerce lab', 'beta', 1, 'active')`,
    )
    .bind(organisationId)
    .run();
}

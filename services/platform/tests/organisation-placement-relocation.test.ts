/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "../src/database-handles";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  freezeOrganisationPlacementMove,
  reserveOrganisationPlacementMove,
} from "../src/data/shared-rows/placement-row";
import { resolveActiveOrganisationPlacement } from "../src/data/organisation-placement";
import { parseOrganisationId } from "../src/ids";
import { parseOrganisationPlacement } from "../src/placement";
import { d1Database, readMigration } from "./sqlite-d1";
import { parseActorRelocationId } from "../src/actors/actor-relocation";

describe("organisation placement relocation", function organisationPlacementRelocationSuite() {
  it("reserves the next epoch and freezes source admission", async function publishesMove() {
    const fixture = placementFixture();
    const reserved = await reserveOrganisationPlacementMove({
      db: fixture.db,
      organisationId: fixture.organisationId,
      target: fixture.target,
      now: 100,
    });

    if (!reserved.ok) {
      throw new Error("placement reservation fixture failed");
    }

    expect(reserved.value).toMatchObject({
      source: { status: "active", placement: { placementEpoch: 1 } },
      target: { status: "reserved", placement: { placementEpoch: 2 } },
    });

    const relocationId = parseActorRelocationId(
      "dor_move_00000000-0000-4000-8000-000000000055",
    );
    if (!relocationId.ok) throw new Error(relocationId.error.code);
    await fixture.db
      .prepare(
        `INSERT INTO state_object_relocation (relocation_id, organisation_id,
       source_placement_epoch, target_placement_epoch, status, created_at)
       VALUES (?, ?, 1, 2, 'reserved', 100)`,
      )
      .bind(relocationId.value, fixture.organisationId)
      .run();
    const frozen = await freezeOrganisationPlacementMove(
      fixture.db,
      reserved.value,
      { kind: "relocation", operationId: relocationId.value },
      110,
      fixture.db,
    );

    if (!frozen.ok) {
      throw new Error("placement freeze fixture failed");
    }

    const unavailable = await resolveActiveOrganisationPlacement(
      fixture.db,
      fixture.organisationId,
    );
    expect(unavailable).toEqual({
      ok: false,
      error: {
        code: "organisation_placement_missing",
        organisationId: fixture.organisationId,
      },
    });
  });
});

type PlacementFixture = {
  readonly db: SingleDatabase;
  readonly organisationId: ReturnType<typeof requiredOrganisationId>;
  readonly target: {
    readonly kind: "residency";
    readonly placementCellId: ReturnType<
      typeof requiredTargetPlacement
    >["placementCellId"];
    readonly locationHint: ReturnType<
      typeof requiredTargetPlacement
    >["locationHint"];
    readonly residencyJurisdiction: "eu";
  };
};

function placementFixture(): PlacementFixture {
  const database = new DatabaseSync(":memory:");
  database.exec(readMigration("0001_current_schema.sql"));
  const organisationId = requiredOrganisationId();
  const source = requiredSourcePlacement();
  const targetPlacement = requiredTargetPlacement();

  database
    .prepare(
      `INSERT INTO organisation (organisation_id, name, plan, created_at, status)
     VALUES (?, 'Placement Test', 'beta', 1, 'active')`,
    )
    .run(organisationId);
  database
    .prepare(
      `INSERT INTO organisation_placement (
       organisation_id,
       placement_epoch,
       placement_kind,
       placement_cell_id,
       location_hint,
       residency_jurisdiction,
       status,
       fence_token,
       created_at,
       activated_at
     )
     VALUES (?, ?, ?, ?, ?, NULL, 'active', ?, 1, 1)`,
    )
    .run(
      organisationId,
      source.placementEpoch,
      source.kind,
      source.placementCellId,
      source.locationHint,
      "tpf_source",
    );

  return {
    db: d1Database(database),
    organisationId,
    target: {
      kind: "residency",
      placementCellId: targetPlacement.placementCellId,
      locationHint: targetPlacement.locationHint,
      residencyJurisdiction: "eu",
    },
  };
}

function requiredOrganisationId() {
  const parsed = parseOrganisationId("organisation_placement_move_test");

  if (!parsed.ok) {
    throw new Error("organisation id fixture invariant failed");
  }

  return parsed.value;
}

function requiredSourcePlacement() {
  const parsed = parseOrganisationPlacement({
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "multi-region-preview",
    locationHint: "wnam",
  });

  if (!parsed.ok) {
    throw new Error("source placement fixture invariant failed");
  }

  return parsed.value;
}

function requiredTargetPlacement() {
  const parsed = parseOrganisationPlacement({
    kind: "residency",
    placementEpoch: 2,
    placementCellId: "eu-preview",
    locationHint: "weur",
    residencyJurisdiction: "eu",
  });

  if (!parsed.ok || parsed.value.kind !== "residency") {
    throw new Error("target placement fixture invariant failed");
  }

  return parsed.value;
}

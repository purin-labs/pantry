import { fixtureDatabase } from "./organisation-database";
import { expect, it } from "vitest";
import { isRecord, sha256Hex } from "@seams/std";
import { parseRunSnapshot } from "@seams/bakery-model/bakery-run-snapshot";
import { readEspressoRun } from "@seams/bakery-model/espresso-rehearsal-file";
import {
  accountFixtureJson,
  applyAccountFixtureProvision,
  bootstrapSharedAccountNativeTenants,
  linkAccountFixtureMember,
  readSharedAccountFixture,
  nativeAccountRequest,
} from "./shared-account-platform-fixture";
import scheduled from "../fixtures/linea-scheduled-paused.json";
import activeDose from "../fixtures/linea-active-dose.json";

it(
  "shares a saved active Linea dose, refuses foreign access and follows revocation",
  sharedLineaJourney,
);

async function sharedLineaJourney(): Promise<void> {
  await sharedEspressoJourney("linea", activeDose, scheduled);
}
async function sharedEspressoJourney(
  kind: "linea",
  captured: unknown,
  productionSave: Readonly<{
    document: unknown;
    artifacts: readonly Readonly<{
      role: string;
      digest: string;
      content: string;
    }>[];
  }>,
): Promise<void> {
  const native = await bootstrapSharedAccountNativeTenants();
  const setup = readSharedAccountFixture(
    await accountFixtureJson("setup", native.setup),
  );
  await applyAccountFixtureProvision(setup.provisionEnvelopes.primary);
  await applyAccountFixtureProvision(setup.provisionEnvelopes.foreign);
  const organisation = native.primary.organisationId;
  const owner = native.primary.owner;
  const viewer = native.operator;
  const foreign = native.foreign.owner;
  await linkAccountFixtureMember(organisation, owner, setup);
  await linkAccountFixtureMember(organisation, viewer, setup);
  await linkAccountFixtureMember(native.foreign.organisationId, foreign, setup);
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = 'viewer' WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(organisation, viewer.identity.userId)
    .run();
  const snapshot = parseRunSnapshot({
    name: "Espresso station after three seconds",
    document: captured,
  });
  if (snapshot === null) throw new Error("Invalid captured Linea run");
  const id = await sha256Hex(snapshot.content);
  const path = `/v1/control/organisations/${organisation}/bakery/runs`;
  const body = {
    expectedId: id,
    name: snapshot.name,
    document: JSON.parse(snapshot.file),
  };
  expect((await nativeAccountRequest(foreign, path, body)).status).toBe(404);
  const refused = await nativeAccountRequest(viewer, path, body);
  // The control boundary conceals resources when the required role is absent.
  expect(refused.status).toBe(404);
  const saved = await nativeAccountRequest(owner, path, body);
  expect(saved.status, await saved.clone().text()).toBe(201);
  expect((await nativeAccountRequest(owner, path, body)).status).toBe(200);
  const reopened = await nativeAccountRequest(viewer, `${path}/${id}`, null);
  expect(reopened.status).toBe(200);
  const text = await reopened.text();
  expect(text).toBe(snapshot.content);
  const parsed: unknown = JSON.parse(text);
  const validated = parseRunSnapshot(parsed);
  if (validated === null || validated.kind !== kind)
    throw new Error("Shared Linea file unavailable");
  const run = readEspressoRun(validated.file);
  expect(run.telemetry.at(-1)?.hotWaterDose).toBe(8);
  expect(run.telemetry.at(-1)?.cups[2]?.mass_g).toBeCloseTo(30, 6);
  expect(
    (await nativeAccountRequest(foreign, `${path}/${id}`, null)).status,
  ).toBe(404);
  const listed: unknown = await (
    await nativeAccountRequest(viewer, `${path}?kind=${kind}`, null)
  ).json();
  if (!isRecord(listed) || !Array.isArray(listed.snapshots))
    throw new Error("Missing archive list");
  expect(listed.snapshots).toHaveLength(1);
  const mislabeled = {
    ...JSON.parse(snapshot.file),
    kind: "eagle-rehearsal",
  };
  expect(
    (await nativeAccountRequest(owner, path, { ...body, document: mislabeled }))
      .status,
  ).toBe(422);
  const production = parseRunSnapshot({
    name: "Paused espresso service",
    document: {
      kind: "saved",
      document: productionSave.document,
      artifacts: [],
    },
  });
  if (production === null)
    throw new Error("Invalid captured espresso workflow");
  const productionId = await sha256Hex(production.content);
  const productionBody = {
    expectedId: productionId,
    name: production.name,
    document: JSON.parse(production.file),
  };
  expect((await nativeAccountRequest(owner, path, productionBody)).status).toBe(
    409,
  );
  const preparedPath = `${path}/prepared/${productionId}`;
  const prepared = await nativeAccountRequest(
    owner,
    preparedPath,
    productionBody,
  );
  expect(prepared.status, await prepared.clone().text()).toBe(200);
  expect((await nativeAccountRequest(viewer, preparedPath, null)).status).toBe(
    404,
  );
  for (const artifact of productionSave.artifacts) {
    const uploaded = await nativeAccountRequest(
      owner,
      `${preparedPath}/artifacts/${artifact.digest}`,
      { content: artifact.content },
    );
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
  }
  const published = await nativeAccountRequest(owner, path, productionBody);
  expect(published.status, await published.clone().text()).toBe(201);
  expect(
    await (
      await nativeAccountRequest(viewer, `${path}/${productionId}`, null)
    ).text(),
  ).toBe(production.content);
  const checkpointArtifact =
    productionSave.artifacts.find(isCheckpointArtifact);
  if (checkpointArtifact === undefined)
    throw new Error("Missing checkpoint artifact");
  const artifactPath = `${path}/${productionId}/artifacts/${checkpointArtifact.digest}`;
  const sharedArtifact = await nativeAccountRequest(viewer, artifactPath, null);
  expect(sharedArtifact.status).toBe(200);
  const artifactReply: unknown = await sharedArtifact.json();
  if (!isRecord(artifactReply) || typeof artifactReply.content !== "string")
    throw new Error("Missing shared checkpoint");
  expect(await sha256Hex(artifactReply.content)).toBe(
    checkpointArtifact.digest,
  );
  expect((await nativeAccountRequest(foreign, artifactPath, null)).status).toBe(
    404,
  );
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET status = 'revoked', revoked_at = ? WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(Date.now(), organisation, viewer.identity.userId)
    .run();
  expect(
    (await nativeAccountRequest(viewer, `${path}/${id}`, null)).status,
  ).toBe(404);
  expect((await nativeAccountRequest(viewer, artifactPath, null)).status).toBe(
    404,
  );
  const catalogue: unknown = await (
    await nativeAccountRequest(owner, path, null)
  ).json();
  if (!isRecord(catalogue) || !Array.isArray(catalogue.snapshots))
    throw new Error("Missing shared run catalogue");
  expect(catalogue.snapshots).toHaveLength(2);
  expect((await nativeAccountRequest(viewer, artifactPath, null)).status).toBe(
    404,
  );
  console.log(
    JSON.stringify({
      artifact: `${kind}-shared-run`,
      passed: true,
      id,
      cupMassG: 30,
      presetSeconds: 8,
      scheduledRunId: productionId,
      privateArtifactPublication: true,
      foreignRefused: true,
      viewerWriteRefused: true,
      revokedReadRefused: true,
    }),
  );
}
function isCheckpointArtifact(artifact: { role: string }): boolean {
  return artifact.role === "cell-checkpoint";
}

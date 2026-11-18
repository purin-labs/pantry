import { exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect, it } from "vitest";
import { isRecord, sha256Hex } from "@seams/std";
import { parseRunSnapshot } from "@seams/bakery-model/bakery-run-snapshot";
import { readEspressoRun } from "@seams/bakery-model/espresso-rehearsal-file";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { commerceHeaders } from "./commerce-support";
import {
  accountFixtureJson,
  applyAccountFixtureProvision,
  bootstrapSharedAccountNativeTenants,
  linkAccountFixtureMember,
  readSharedAccountFixture,
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
  expect((await write(path, foreign.session, body)).status).toBe(404);
  const refused = await write(path, viewer.session, body);
  // The control boundary conceals resources when the required role is absent.
  expect(refused.status).toBe(404);
  const saved = await write(path, owner.session, body);
  expect(saved.status, await saved.clone().text()).toBe(201);
  expect((await write(path, owner.session, body)).status).toBe(200);
  const reopened = await read(`${path}/${id}`, viewer.session);
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
  expect((await read(`${path}/${id}`, foreign.session)).status).toBe(404);
  const listed: unknown = await (
    await read(`${path}?kind=${kind}`, viewer.session)
  ).json();
  if (!isRecord(listed) || !Array.isArray(listed.snapshots))
    throw new Error("Missing archive list");
  expect(listed.snapshots).toHaveLength(1);
  const mislabeled = {
    ...JSON.parse(snapshot.file),
    kind: "eagle-rehearsal",
  };
  expect(
    (await write(path, owner.session, { ...body, document: mislabeled }))
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
  expect((await write(path, owner.session, productionBody)).status).toBe(409);
  const preparedPath = `${path}/prepared/${productionId}`;
  const prepared = await write(preparedPath, owner.session, productionBody);
  expect(prepared.status, await prepared.clone().text()).toBe(200);
  expect((await read(preparedPath, viewer.session)).status).toBe(404);
  for (const artifact of productionSave.artifacts) {
    const uploaded = await write(
      `${preparedPath}/artifacts/${artifact.digest}`,
      owner.session,
      { content: artifact.content },
    );
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
  }
  const published = await write(path, owner.session, productionBody);
  expect(published.status, await published.clone().text()).toBe(201);
  expect(
    await (await read(`${path}/${productionId}`, viewer.session)).text(),
  ).toBe(production.content);
  const checkpointArtifact =
    productionSave.artifacts.find(isCheckpointArtifact);
  if (checkpointArtifact === undefined)
    throw new Error("Missing checkpoint artifact");
  const artifactPath = `${path}/${productionId}/artifacts/${checkpointArtifact.digest}`;
  const sharedArtifact = await read(artifactPath, viewer.session);
  expect(sharedArtifact.status).toBe(200);
  const artifactReply: unknown = await sharedArtifact.json();
  if (!isRecord(artifactReply) || typeof artifactReply.content !== "string")
    throw new Error("Missing shared checkpoint");
  expect(await sha256Hex(artifactReply.content)).toBe(
    checkpointArtifact.digest,
  );
  expect((await read(artifactPath, foreign.session)).status).toBe(404);
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET status = 'revoked', revoked_at = ? WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(Date.now(), organisation, viewer.identity.userId)
    .run();
  expect((await read(`${path}/${id}`, viewer.session)).status).toBe(404);
  expect((await read(artifactPath, viewer.session)).status).toBe(404);
  const catalogue: unknown = await (await read(path, owner.session)).json();
  if (!isRecord(catalogue) || !Array.isArray(catalogue.snapshots))
    throw new Error("Missing shared run catalogue");
  expect(catalogue.snapshots).toHaveLength(2);
  expect((await read(artifactPath, viewer.session)).status).toBe(404);
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
function read(path: string, session: IssuedControlSession): Promise<Response> {
  return exports.default.fetch(`https://localhost${path}`, {
    headers: commerceHeaders(session),
  });
}
function write(
  path: string,
  session: IssuedControlSession,
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(`https://localhost${path}`, {
    method: "POST",
    headers: commerceHeaders(session),
    body: JSON.stringify(body),
  });
}

function isCheckpointArtifact(artifact: { role: string }): boolean {
  return artifact.role === "cell-checkpoint";
}

import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect, it } from "vitest";
import { isRecord, sha256Hex } from "@purin-labs/std";
import { parseRunSnapshot } from "@purin-labs/bakery-model/bakery-run-snapshot";
import { commerceClient, commerceWorkspace } from "./commerce-support";
import {
  attachSharedAccountNativeOrganisation,
  nativeAccountRequest,
} from "./shared-account-platform-fixture";
import failed from "../fixtures/bakery-persistent-failure.json";
import { bakeryRunSnapshotPrefix } from "../../src/commerce/bakery/saved-runs";

it(
  "publishes a failed native factory only after complete private staging, then fences artifact access and survives lost replies",
  artifactJourney,
);

async function artifactJourney(): Promise<void> {
  const owner = await commerceClient("artifact-owner");
  const reviewer = await commerceClient("artifact-reviewer");
  const foreign = await commerceClient("artifact-foreign");
  const organisation = await commerceWorkspace(owner, "Native factory archive");
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(organisation, "artifact-reviewer-person", "Reviewer"),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, ?, 'owner', 'active', ?, NULL)",
      )
      .bind(
        organisation,
        reviewer.identity.userId,
        "artifact-reviewer-person",
        Date.now(),
      ),
  ]);
  await attachSharedAccountNativeOrganisation({
    organisationId: organisation,
    owner,
    members: { operator: reviewer },
  });
  const snapshot = parseRunSnapshot({
    name: "Failed cell at 30 seconds",
    document: { kind: "saved", document: failed.document, artifacts: [] },
  });
  if (snapshot === null) throw new Error("Invalid native acceptance fixture");
  const id = await sha256Hex(snapshot.content);
  const path = `/v1/control/organisations/${organisation}/bakery/runs`;
  const stage = `${path}/prepared/${id}`;
  const body = {
    expectedId: id,
    name: snapshot.name,
    document: JSON.parse(snapshot.file),
  };
  expect((await nativeAccountRequest(owner, path, body)).status).toBe(409);
  const prepared = await nativeAccountRequest(owner, stage, body);
  expect(prepared.status, await prepared.clone().text()).toBe(200);
  const missing = await prepared.json();
  if (!isRecord(missing) || !Array.isArray(missing.missing))
    throw new Error("Missing artifact list");
  expect(missing.missing.length).toBe(failed.artifacts.length);
  const first = failed.artifacts[0];
  if (first === undefined) throw new Error("Fixture contains no physics");
  const firstStage = `${stage}/artifacts/${first.digest}`;
  expect((await nativeAccountRequest(reviewer, stage, null)).status).toBe(404);
  expect((await nativeAccountRequest(foreign, stage, null)).status).toBe(404);
  expect(
    (
      await nativeAccountRequest(owner, firstStage, {
        content: first.content + " ",
      })
    ).status,
  ).toBe(409);
  expect(
    (await nativeAccountRequest(owner, firstStage, { content: first.content }))
      .status,
  ).toBe(200);
  expect(
    (
      await nativeAccountRequest(
        reviewer,
        `${path}/${id}/artifacts/${first.digest}`,
        null,
      )
    ).status,
  ).toBe(404);
  expect((await nativeAccountRequest(reviewer, firstStage, null)).status).toBe(
    404,
  );
  expect((await nativeAccountRequest(owner, path, body)).status).toBe(409);
  expect(
    (await nativeAccountRequest(owner, `${path}/${id}`, null)).status,
  ).toBe(404);
  // A replacement uploader recovers the exact preparation after losing its reply.
  const resumed = await nativeAccountRequest(owner, stage, body);
  const remaining = await resumed.json();
  if (!isRecord(remaining) || !Array.isArray(remaining.missing))
    throw new Error("Missing resumed index");
  expect(remaining.missing).not.toContain(first.digest);
  for (const artifact of failed.artifacts) {
    if (!remaining.missing.includes(artifact.digest)) continue;
    const uploaded = await nativeAccountRequest(
      owner,
      `${stage}/artifacts/${artifact.digest}`,
      { content: artifact.content },
    );
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
  }
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET status = 'revoked', revoked_at = ? WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(Date.now(), organisation, owner.identity.userId)
    .run();
  expect((await nativeAccountRequest(owner, path, body)).status).toBe(404);
  expect((await nativeAccountRequest(owner, firstStage, null)).status).toBe(
    404,
  );
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET status = 'active', revoked_at = NULL WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(organisation, owner.identity.userId)
    .run();
  const published = await nativeAccountRequest(owner, path, body);
  expect(published.status, await published.clone().text()).toBe(201);
  // Exact retry finds the immutable publication after its response is lost.
  expect((await nativeAccountRequest(owner, path, body)).status).toBe(200);
  const saved = await nativeAccountRequest(reviewer, `${path}/${id}`, null);
  expect(await saved.text()).toBe(snapshot.content);
  for (const artifact of failed.artifacts) {
    const response = await nativeAccountRequest(
      reviewer,
      `${path}/${id}/artifacts/${artifact.digest}`,
      null,
    );
    expect(response.status).toBe(200);
    const received = await response.json();
    if (!isRecord(received) || typeof received.content !== "string")
      throw new Error("Invalid artifact reply");
    expect(await sha256Hex(received.content)).toBe(artifact.digest);
    expect(received.content).toBe(artifact.content);
  }
  // A warm parsed-document cache must follow the current referring object.
  const publishedKey = bakeryRunSnapshotPrefix(organisation) + id;
  const publishedObject = await env.ARCHIVE.get(publishedKey);
  if (publishedObject === null) throw new Error("Published document missing");
  await publishedObject.body.cancel();
  await env.ARCHIVE.put(publishedKey, snapshot.content + " ", {
    customMetadata: publishedObject.customMetadata,
  });
  expect(
    (
      await nativeAccountRequest(
        reviewer,
        `${path}/${id}/artifacts/${first.digest}`,
        null,
      )
    ).status,
  ).toBe(422);
  await env.ARCHIVE.put(publishedKey, snapshot.content, {
    customMetadata: publishedObject.customMetadata,
  });
  expect(
    (
      await nativeAccountRequest(
        reviewer,
        `${path}/${id}/artifacts/${first.digest}`,
        null,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await nativeAccountRequest(
        foreign,
        `${path}/${id}/artifacts/${first.digest}`,
        null,
      )
    ).status,
  ).toBe(404);
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET status = 'revoked', revoked_at = ? WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(Date.now(), organisation, reviewer.identity.userId)
    .run();
  expect(
    (
      await nativeAccountRequest(
        reviewer,
        `${path}/${id}/artifacts/${first.digest}`,
        null,
      )
    ).status,
  ).toBe(404);
  expect(
    (await nativeAccountRequest(reviewer, `${path}/${id}`, null)).status,
  ).toBe(404);
  const catalogue = await (
    await nativeAccountRequest(owner, path, null)
  ).json();
  if (!isRecord(catalogue) || !Array.isArray(catalogue.snapshots))
    throw new Error("Missing catalogue");
  expect(catalogue.snapshots.length).toBe(1);
}

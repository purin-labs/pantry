import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { commerceHeaders } from "./commerce-support";
import {
  installMemoryFixture,
  post,
  postJson,
  type Member,
} from "./memory-support";

it(
  "lets an administrator publish the case context policy, and refuses a viewer's read, change and review",
  { timeout: 60_000 },
  caseContextDiscoveryAccessJourney,
);

async function caseContextDiscoveryAccessJourney(): Promise<void> {
  const { author, reviewer, viewer, paths } = await installMemoryFixture();
  const configuration = `${paths.organisation}/case-context-discovery`;
  const disabled = (commandId: string, expectedRevision: number) => ({
    commandId,
    expectedRevision,
    policy: { mode: "disabled" },
  });

  // A viewer's role carries no admin right: the read, the change and the
  // review of a relationship are refused, and the policy does not move.
  expect((await post(viewer, configuration, null)).status).toBe(404);
  expect(
    (await put(viewer, configuration, disabled("viewer-disable", 0))).status,
  ).toBe(404);
  expect(
    (
      await post(
        viewer,
        `${configuration}/caseContextCollections/case_context_collection_one/review`,
        {
          commandId: "viewer-review",
          expectedRevision: 1,
          decision: { kind: "reject", relationshipId: "relationship_one" },
        },
      )
    ).status,
  ).toBe(404);
  expect(await postJson(author, configuration, null)).toMatchObject({
    status: 200,
    body: { ok: true, value: { revision: 0 } },
  });

  // The second administrator publishes, and the owner reads that revision.
  expect(
    (await put(reviewer, configuration, disabled("admin-disable", 0))).status,
  ).toBe(200);
  expect(await postJson(author, configuration, null)).toMatchObject({
    status: 200,
    body: { ok: true, value: { revision: 1, policy: { mode: "disabled" } } },
  });
  // A body that does not parse changes nothing.
  expect(
    (await put(author, configuration, { data: "x".repeat(16_384) })).status,
  ).toBe(400);
}

function put(user: Member, path: string, body: unknown): Promise<Response> {
  return exports.default.fetch(`https://localhost${path}`, {
    method: "PUT",
    headers: commerceHeaders(user.session),
    body: JSON.stringify(body),
  });
}

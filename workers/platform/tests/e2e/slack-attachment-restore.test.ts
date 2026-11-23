import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { evictDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import { network } from "./network";
import {
  inspectSlackActors,
  installSlackActorFixture,
  modelSimulator,
  signedSlackRequest,
  slackEnvelope,
  slackFileSimulator,
  slackSimulator,
} from "./slack-journey-support";

const PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.7\n1 0 obj\n<< /Length 40 >>\nstream\nBT (Quote for 200 units) Tj ET\nendstream\nendobj\n%%EOF\n",
);

// Eviction leaves activation state that a following fixture install conflicts
// with, so this journey owns its file rather than sharing one.

/**
 * Restore must reproduce the exact canonical message.
 *
 * The three actors are evicted after the attachment is admitted, so the
 * follow-up turn runs against rehydrated state. The attachment's identity,
 * digest, and class have to survive that round trip; a message that came back
 * as prose about a file would pass a weaker assertion.
 */
it("preserves the exact canonical message across actor eviction", async () => {
  const fixture = await installSlackActorFixture();
  const model = modelSimulator();
  const slack = slackSimulator();
  const files = slackFileSimulator([
    {
      id: "F0E2ERESTORE",
      name: "quote.pdf",
      mimetype: "application/pdf",
      bytes: PDF_BYTES,
    },
  ]);

  network.use(
    model.handler,
    slack.handler,
    files.infoHandler,
    files.downloadHandler,
  );

  const rootTs = "1787590000.000001";
  await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0E2ERESTORE",
        messageTs: rootTs,
        threadTs: rootTs,
        text: "<@U0PANTRY> read this",
        files: [
          {
            id: "F0E2ERESTORE",
            name: "quote.pdf",
            mimetype: "application/pdf",
            size: PDF_BYTES.byteLength,
            timestamp: 1_787_590_000,
          },
        ],
      }),
    ),
  );

  model.releaseRoot.resolve(undefined);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);

  const before = await inspectSlackActors(fixture.connectorId);
  const storedBefore = await env.ARCHIVE.list({ prefix: "attachments/" });
  const keysBefore = storedBefore.objects
    .map(function key(object) {
      return object.key;
    })
    .sort();

  // Evict every actor in the chain, so nothing answers from memory.
  await evictAllSlackActors(fixture.connectorId);

  const after = await inspectSlackActors(fixture.connectorId);

  // The session came back as itself, not as a fresh lineage.
  expect(after.sessionId).toBe(before.sessionId);
  expect(after.connector).toMatchObject({
    ok: true,
    value: { ingressCount: 1, deliveryCount: 1 },
  });

  // The bytes are still exactly where the canonical message says they are.
  const storedAfter = await env.ARCHIVE.list({ prefix: "attachments/" });
  expect(
    storedAfter.objects
      .map(function key(object) {
        return object.key;
      })
      .sort(),
  ).toEqual(keysBefore);

  // A follow-up turn runs against rehydrated history and still sees the file.
  await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "message",
        eventId: "Ev0E2ERESTOREFOLLOWUP",
        messageTs: "1787590000.000002",
        threadTs: rootTs,
        text: "what did that quote say",
      }),
    ),
  );

  await expect
    .poll(
      function modelCalls() {
        return model.requests.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(1);

  const restoredPrompt = JSON.stringify(model.requests[1]);
  expect(restoredPrompt).toContain("quote.pdf");
  expect(restoredPrompt).toContain("class=document");
  // The follow-up answer reaches the thread. The turn then ends inside the
  // test, and not while the test environment closes.
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(2);
});

/** Evicts the connector, case, and session so the next read must rehydrate. */
async function evictAllSlackActors(connectorId: string): Promise<void> {
  const rows = await fixtureDatabase()
    .prepare(
      `SELECT object_kind AS objectKind,
            logical_object_id AS logicalObjectId,
            physical_object_name AS physicalObjectName
       FROM durable_object_registry
      WHERE organisation_id = ? AND lifecycle_status = 'active'`,
    )
    .bind("organisation_e2e_slack_actor")
    .all<{
      readonly objectKind: string;
      readonly logicalObjectId: string;
      readonly physicalObjectName: string;
    }>();

  for (const row of rows.results) {
    const namespace =
      row.objectKind === "connector"
        ? env.CONNECTOR
        : row.objectKind === "case"
          ? env.CASE
          : row.objectKind === "session"
            ? env.SESSION
            : null;

    if (namespace === null) {
      continue;
    }

    if (row.objectKind === "connector" && row.logicalObjectId !== connectorId) {
      continue;
    }

    try {
      await evictDurableObject(namespace.getByName(row.physicalObjectName));
    } catch {
      // Already idle. That is the state this is trying to reach, so an object
      // that got there on its own is not a failure.
    }
  }
}

import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";

import { HttpResponse, http } from "msw";

import { docxArchive, h264Fixture, waveHeader } from "../media-fixtures";
import { network } from "./network";
import {
  CHANNEL_ID,
  inspectSlackActors,
  installSlackActorFixture,
  modelSimulator,
  signedSlackRequest,
  slackEnvelope,
  slackFileSimulator,
  slackSimulator,
} from "./slack-journey-support";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.7\n1 0 obj\n<< /Length 40 >>\nstream\nBT (Quote for 200 units) Tj ET\nendstream\nendobj\n%%EOF\n",
);
const CAD_BYTES = new Uint8Array([
  0x4d, 0x4d, 0x00, 0x2a, 0x01, 0x02, 0x03, 0x04,
]);

/**
 * A file-only message carries no authored text at all. Before Plan 37 the
 * boundary refused it outright for having empty text.
 *
 * It still has to be addressed: an ambient root post is not agent work, so the
 * journey opens a Case with a mention and then replies with nothing but a file.
 */
it("carries a file-only Slack reply to an addressed receipt", async () => {
  const fixture = await installSlackActorFixture();
  const model = modelSimulator();
  const slack = slackSimulator();
  const files = slackFileSimulator([
    {
      id: "F0E2EPDF",
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

  const rootTs = "1787510000.000001";
  const opened = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0E2EFILEROOT",
        messageTs: rootTs,
        threadTs: rootTs,
        text: "<@U0PANTRY> opening this case",
      }),
    ),
  );

  expect(opened.status).toBe(200);

  // The reply can only join a Case that exists, so let the root turn settle
  // before the file arrives.
  model.releaseRoot.resolve(undefined);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);

  const accepted = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "message",
        subtype: "file_share",
        eventId: "Ev0E2EFILEONLY",
        messageTs: "1787510000.000002",
        threadTs: rootTs,
        text: "",
        files: [
          {
            id: "F0E2EPDF",
            name: "quote.pdf",
            mimetype: "application/pdf",
            size: PDF_BYTES.byteLength,
            timestamp: 1_787_510_000,
          },
        ],
      }),
    ),
  );

  expect(accepted.status).toBe(200);
  await expect(accepted.json()).resolves.toMatchObject({
    ok: true,
    durableMode: "case_accepted",
  });

  await expect
    .poll(
      function modelCalls() {
        return model.requests.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(1);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(2);

  expect(files.downloads).toEqual(["F0E2EPDF"]);
  expect(slack.messages[1]).toMatchObject({
    channel: CHANNEL_ID,
    thread_ts: rootTs,
  });

  // The file reached the model as a canonical attachment, described by its
  // verified identity rather than by Slack's claim about it.
  const prompt = JSON.stringify(model.requests[1]);
  expect(prompt).toContain("quote.pdf");
  expect(prompt).toContain("class=document");

  const actorState = await inspectSlackActors(fixture.connectorId);
  expect(actorState.connector).toMatchObject({ ok: true });

  // Bytes live in organisation-scoped, content-addressed storage and nowhere else.
  const stored = await env.ARCHIVE.list({ prefix: "attachments/" });
  expect(stored.objects.length).toBeGreaterThan(0);
  for (const object of stored.objects) {
    expect(
      object.key.startsWith("attachments/organisation_e2e_slack_actor/"),
    ).toBe(true);
    // Staging never outlives the batch.
    expect(object.key).not.toContain("/staging/");
  }
});

/**
 * Text, a link, and two files of different classes in one message. The journey
 * proves canonical order survives and that every class is admitted, including
 * a format Pantry has no handler for.
 */
it("carries a mixed text, link, and multi-file Slack message", async () => {
  const fixture = await installSlackActorFixture();
  const model = modelSimulator();
  const slack = slackSimulator();
  const files = slackFileSimulator([
    {
      id: "F0E2EIMG",
      name: "diagram.png",
      mimetype: "image/png",
      bytes: PNG_BYTES,
    },
    {
      id: "F0E2ECAD",
      name: "turbine.3ds",
      mimetype: "application/x-3ds",
      bytes: CAD_BYTES,
    },
  ]);

  network.use(
    model.handler,
    slack.handler,
    files.infoHandler,
    files.downloadHandler,
  );

  const rootTs = "1787520000.000001";
  const accepted = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0E2EMIXED",
        messageTs: rootTs,
        threadTs: rootTs,
        text: "<@U0PANTRY> price this against <https://example.com/spec|the spec>",
        files: [
          {
            id: "F0E2EIMG",
            name: "diagram.png",
            mimetype: "image/png",
            size: PNG_BYTES.byteLength,
            timestamp: 1_787_520_000,
          },
          {
            id: "F0E2ECAD",
            name: "turbine.3ds",
            mimetype: "application/x-3ds",
            size: CAD_BYTES.byteLength,
            timestamp: 1_787_520_000,
          },
        ],
      }),
    ),
  );

  expect(accepted.status).toBe(200);
  await expect(accepted.json()).resolves.toMatchObject({
    ok: true,
    durableMode: "case_accepted",
  });

  model.releaseRoot.resolve(undefined);
  await expect
    .poll(
      function modelCalls() {
        return model.requests.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);

  // Both files were transferred; neither class was refused.
  expect(files.downloads.sort()).toEqual(["F0E2ECAD", "F0E2EIMG"]);

  const prompt = JSON.stringify(model.requests[0]);
  expect(prompt).toContain("price this against");
  expect(prompt).toContain("https://example.com/spec");
  expect(prompt).toContain("turbine.3ds");

  const actorState = await inspectSlackActors(fixture.connectorId);
  expect(actorState.connector).toMatchObject({
    ok: true,
    value: { ingressCount: 1, deliveryCount: 1 },
  });
});

/**
 * A batch is atomic for agent admission. One file beyond the per-file limit
 * refuses the whole message, and no partial batch reaches the agent.
 */
it("refuses an oversized batch without running the agent on partial input", async () => {
  await installSlackActorFixture();
  const model = modelSimulator();
  const slack = slackSimulator();
  const files = slackFileSimulator([
    {
      id: "F0E2EOK",
      name: "small.pdf",
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

  const rootTs = "1787530000.000001";
  const accepted = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0E2EOVERSIZED",
        messageTs: rootTs,
        threadTs: rootTs,
        text: "<@U0PANTRY> read these",
        files: [
          {
            id: "F0E2EOK",
            name: "small.pdf",
            mimetype: "application/pdf",
            size: PDF_BYTES.byteLength,
            timestamp: 1_787_530_000,
          },
          {
            id: "F0E2EHUGE",
            name: "huge.bin",
            mimetype: "application/octet-stream",
            // Beyond the per-file policy limit, and refused on the declared size
            // before any byte is transferred.
            size: 512 * 1024 * 1024,
            timestamp: 1_787_530_000,
          },
        ],
      }),
    ),
  );

  expect(accepted.status).toBe(200);

  // The person who sent the files reads why the batch was refused, once, in
  // the thread of the message: the rule and its limit.
  await expect
    .poll(
      function threadNotices() {
        return slack.messages.filter(
          (message) =>
            message.channel === CHANNEL_ID && message.thread_ts === rootTs,
        ).length;
      },
      { timeout: 15_000 },
    )
    .toBe(1);
  const notice = slack.messages.find((message) => message.thread_ts === rootTs);
  expect(notice?.text).toContain("huge.bin");
  expect(notice?.text).toContain("25 MiB");
  // The good file is never fetched, because the batch was already refused.
  expect(files.downloads).toHaveLength(0);
  expect(model.requests).toHaveLength(0);
});

/**
 * A link-only message: no text, no files, one URL.
 *
 * The link survives as a typed part rather than as characters, and ingress
 * fetches nothing — reading it is a separate, explicitly governed act.
 */
it("carries a link-only Slack reply without fetching the link", async () => {
  await installSlackActorFixture();
  const model = modelSimulator();
  const slack = slackSimulator();
  let linkFetched = false;

  network.use(
    model.handler,
    slack.handler,
    http.get("https://example.com/spec", function refuseIngressFetch() {
      linkFetched = true;
      return HttpResponse.text("should never be fetched during ingress");
    }),
  );

  const rootTs = "1787540000.000001";
  await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0E2ELINKROOT",
        messageTs: rootTs,
        threadTs: rootTs,
        text: "<@U0PANTRY> opening this case",
      }),
    ),
  );

  model.releaseRoot.resolve(undefined);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);

  const accepted = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "message",
        eventId: "Ev0E2ELINKONLY",
        messageTs: "1787540000.000002",
        threadTs: rootTs,
        text: "<https://example.com/spec>",
      }),
    ),
  );

  expect(accepted.status).toBe(200);
  await expect
    .poll(
      function modelCalls() {
        return model.requests.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(1);

  expect(JSON.stringify(model.requests[1])).toContain(
    "https://example.com/spec",
  );
  // Ingress never dereferences a link.
  expect(linkFetched).toBe(false);
});

/**
 * A document reaches the model as text it can actually read, not as a note
 * saying a file arrived.
 */
it("delivers extracted document text to the model", async () => {
  await installSlackActorFixture();
  const model = modelSimulator();
  const slack = slackSimulator();
  const docx = await docxArchive("Espresso 3.50 per unit, minimum 200 units");
  const files = slackFileSimulator([
    {
      id: "F0E2EDOCX",
      name: "terms.docx",
      mimetype:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: docx,
    },
  ]);

  network.use(
    model.handler,
    slack.handler,
    files.infoHandler,
    files.downloadHandler,
  );

  const rootTs = "1787550000.000001";
  await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0E2EDOCX",
        messageTs: rootTs,
        threadTs: rootTs,
        text: "<@U0PANTRY> what does this say",
        files: [
          {
            id: "F0E2EDOCX",
            name: "terms.docx",
            mimetype:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size: docx.byteLength,
            timestamp: 1_787_550_000,
          },
        ],
      }),
    ),
  );

  model.releaseRoot.resolve(undefined);
  await expect
    .poll(
      function modelCalls() {
        return model.requests.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  // The document's words reached the model, not merely its filename.
  const prompt = JSON.stringify(model.requests[0]);
  expect(prompt).toContain("Espresso 3.50 per unit");
  // The model read the file, so no line that names it says otherwise.
  const fileLines = prompt
    .split("\\n")
    .filter((line) => line.includes("terms.docx"));
  expect(fileLines.length).toBeGreaterThan(0);
  expect(
    fileLines.filter((line) => line.includes("contents not read")),
  ).toEqual([]);
});

/**
 * Attachment preparation completes before the model receives the turn. A
 * held download makes the ordering observable without coupling the test to
 * the actor's internal storage implementation.
 */
it("waits for attachment preparation before starting the model", async () => {
  await installSlackActorFixture();
  const model = modelSimulator();
  const slack = slackSimulator();
  const releaseDownload = Promise.withResolvers<void>();
  const text = new TextEncoder().encode("Preparation must finish first.");
  const files = slackFileSimulator([
    {
      id: "F0E2EPREP",
      name: "prepared.txt",
      mimetype: "text/plain",
      bytes: text,
    },
  ]);

  network.use(
    model.handler,
    slack.handler,
    files.infoHandler,
    http.get(
      "https://files.slack.com/files-pri/:fileId/download",
      async function holdFileDownload({ params }) {
        expect(params.fileId).toBe("F0E2EPREP");
        files.downloads.push(String(params.fileId));
        await releaseDownload.promise;
        return new HttpResponse(text.slice() as unknown as BodyInit, {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-length": String(text.byteLength),
          },
        });
      },
    ),
  );

  const rootTs = "1787555000.000001";
  const accepted = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0E2EPREPORDER",
        messageTs: rootTs,
        threadTs: rootTs,
        text: "<@U0PANTRY> prepare this",
        files: [
          {
            id: "F0E2EPREP",
            name: "prepared.txt",
            mimetype: "text/plain",
            size: text.byteLength,
            timestamp: 1_787_555_000,
          },
        ],
      }),
    ),
  );

  expect(accepted.status).toBe(200);
  await expect
    .poll(
      function downloadsStarted() {
        return files.downloads.length;
      },
      { timeout: 15_000 },
    )
    .toBe(1);
  expect(model.requests).toHaveLength(0);

  releaseDownload.resolve(undefined);
  await expect
    .poll(
      function modelCalls() {
        return model.requests.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  model.releaseRoot.resolve(undefined);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  expect(JSON.stringify(model.requests[0])).toContain(
    "Preparation must finish first.",
  );
});

/**
 * Audio and video are admitted and described by deterministic container facts.
 * Nothing is transcribed and no claim is made about what was said or shown.
 */
it("describes audio and video by technical facts without interpreting them", async () => {
  await installSlackActorFixture();
  const model = modelSimulator();
  const slack = slackSimulator();
  const wave = waveHeader();
  const video = h264Fixture();
  const files = slackFileSimulator([
    { id: "F0E2EWAV", name: "call.wav", mimetype: "audio/wav", bytes: wave },
    { id: "F0E2EMP4", name: "line.mp4", mimetype: "video/mp4", bytes: video },
  ]);

  network.use(
    model.handler,
    slack.handler,
    files.infoHandler,
    files.downloadHandler,
  );

  const rootTs = "1787560000.000001";
  await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0E2EMEDIA",
        messageTs: rootTs,
        threadTs: rootTs,
        text: "<@U0PANTRY> here is the line",
        files: [
          {
            id: "F0E2EWAV",
            name: "call.wav",
            mimetype: "audio/wav",
            size: wave.byteLength,
            timestamp: 1_787_560_000,
          },
          {
            id: "F0E2EMP4",
            name: "line.mp4",
            mimetype: "video/mp4",
            size: video.byteLength,
            timestamp: 1_787_560_000,
          },
        ],
      }),
    ),
  );

  model.releaseRoot.resolve(undefined);
  await expect
    .poll(
      function modelCalls() {
        return model.requests.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  const prompt = JSON.stringify(model.requests[0]);

  expect(files.downloads.sort()).toEqual(["F0E2EMP4", "F0E2EWAV"]);
  expect(prompt).toContain("call.wav");
  expect(prompt).toContain("line.mp4");
  expect(prompt).toContain("class=audio");
  expect(prompt).toContain("class=video");
  // The limitation is stated rather than papered over.
  expect(prompt).toContain("contents not interpreted");
  // H.264 stills need a decoder this runtime does not have, and the prompt
  // says which codec rather than going quiet.
  expect(prompt).toContain("decoder_required");
});

/**
 * A duplicate Slack delivery returns the original receipt. The agent runs once
 * and the file transfers once.
 */
it("returns the original receipt for a duplicate delivery", async () => {
  await installSlackActorFixture();
  const model = modelSimulator();
  const slack = slackSimulator();
  const files = slackFileSimulator([
    {
      id: "F0E2EDUP",
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

  const rootTs = "1787570000.000001";
  const envelope = slackEnvelope({
    eventType: "app_mention",
    eventId: "Ev0E2EDUPLICATE",
    messageTs: rootTs,
    threadTs: rootTs,
    text: "<@U0PANTRY> read this",
    files: [
      {
        id: "F0E2EDUP",
        name: "quote.pdf",
        mimetype: "application/pdf",
        size: PDF_BYTES.byteLength,
        timestamp: 1_787_570_000,
      },
    ],
  });

  const first = await exports.default.fetch(await signedSlackRequest(envelope));
  const second = await exports.default.fetch(
    await signedSlackRequest(envelope),
  );

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);

  model.releaseRoot.resolve(undefined);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);

  // One agent run, one transfer, one visible reply.
  expect(model.requests).toHaveLength(1);
  expect(files.downloads).toEqual(["F0E2EDUP"]);
  expect(slack.visibleMessageCount()).toBe(1);
});

/**
 * A transient download failure retries the exact batch under Connector
 * ownership. The message is not lost and the agent is not run on partial input.
 */
it("retries the exact batch after a transient download failure", async () => {
  await installSlackActorFixture();
  const model = modelSimulator();
  const slack = slackSimulator();
  const files = slackFileSimulator([
    {
      id: "F0E2ERETRY",
      name: "quote.pdf",
      mimetype: "application/pdf",
      bytes: PDF_BYTES,
    },
  ]);
  let attempts = 0;

  network.use(
    model.handler,
    slack.handler,
    files.infoHandler,
    // The first transfer fails the way a flaky upstream does; the second
    // succeeds. Nothing about the message changes between them.
    http.get(
      "https://files.slack.com/files-pri/:fileId/download",
      function flakyDownload() {
        attempts += 1;

        return attempts === 1
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.arrayBuffer(PDF_BYTES.slice().buffer, {
              headers: { "content-type": "application/pdf" },
            });
      },
    ),
  );

  const rootTs = "1787580000.000001";
  const accepted = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0E2ERETRY",
        messageTs: rootTs,
        threadTs: rootTs,
        text: "<@U0PANTRY> read this",
        files: [
          {
            id: "F0E2ERETRY",
            name: "quote.pdf",
            mimetype: "application/pdf",
            size: PDF_BYTES.byteLength,
            timestamp: 1_787_580_000,
          },
        ],
      }),
    ),
  );

  expect(accepted.status).toBe(200);
  model.releaseRoot.resolve(undefined);

  await expect
    .poll(
      function transferAttempts() {
        return attempts;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(1);
  await expect.poll(slack.visibleMessageCount, { timeout: 20_000 }).toBe(1);

  // The retry produced exactly one agent run and one reply.
  expect(model.requests).toHaveLength(1);
  expect(JSON.stringify(model.requests[0])).toContain("quote.pdf");

  // Staging from the failed attempt did not survive the retry.
  const stored = await env.ARCHIVE.list({ prefix: "attachments/" });
  for (const object of stored.objects) {
    expect(object.key).not.toContain("/staging/");
  }
});

/**
 * An attachment whose bytes are gone produces an explicit limitation.
 *
 * This is the failure mode worth pinning: the record still names a file, so
 * the tempting behaviour is to describe it as if it had been read. Expiry has
 * to surface as an unavailability the agent can see.
 */
it("reports an expired attachment instead of describing it as read", async () => {
  await installSlackActorFixture();
  const model = modelSimulator();
  const slack = slackSimulator();
  const files = slackFileSimulator([
    {
      id: "F0E2EEXPIRE",
      name: "terms.pdf",
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

  const rootTs = "1787600000.000001";
  await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0E2EEXPIREROOT",
        messageTs: rootTs,
        threadTs: rootTs,
        text: "<@U0PANTRY> read this",
        files: [
          {
            id: "F0E2EEXPIRE",
            name: "terms.pdf",
            mimetype: "application/pdf",
            size: PDF_BYTES.byteLength,
            timestamp: 1_787_600_000,
          },
        ],
      }),
    ),
  );

  model.releaseRoot.resolve(undefined);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);

  // Retention collected the object while the Case still references it.
  const stored = await env.ARCHIVE.list({ prefix: "attachments/" });
  for (const object of stored.objects) {
    await env.ARCHIVE.delete(object.key);
  }
  expect(
    (await env.ARCHIVE.list({ prefix: "attachments/" })).objects,
  ).toHaveLength(0);

  await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "message",
        eventId: "Ev0E2EEXPIREFOLLOWUP",
        messageTs: "1787600000.000002",
        threadTs: rootTs,
        text: "summarize the terms",
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

  // The turn still completes, and the file is named as unavailable rather
  // than summarized from nothing.
  const prompt = JSON.stringify(model.requests[1]);
  expect(prompt).toContain("terms.pdf");
  expect(prompt).toContain("unavailable");
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(2);
});

/**
 * A stop command cancels the turn. The batch is already committed, so the
 * bytes stay addressable, but no further agent work runs and no staging key
 * outlives the cancellation.
 */
it("cancels an in-flight turn without stranding staged bytes", async () => {
  await installSlackActorFixture();
  const model = modelSimulator();
  const slack = slackSimulator();
  const files = slackFileSimulator([
    {
      id: "F0E2ECANCEL",
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

  const rootTs = "1787610000.000001";
  await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0E2ECANCELROOT",
        messageTs: rootTs,
        threadTs: rootTs,
        text: "<@U0PANTRY> read this",
        files: [
          {
            id: "F0E2ECANCEL",
            name: "quote.pdf",
            mimetype: "application/pdf",
            size: PDF_BYTES.byteLength,
            timestamp: 1_787_610_000,
          },
        ],
      }),
    ),
  );

  // Hold the model mid-turn, then ask for a stop while it is still running.
  await model.rootStarted.promise;

  const stopped = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "message",
        eventId: "Ev0E2ECANCELSTOP",
        messageTs: "1787610000.000002",
        threadTs: rootTs,
        text: "<@U0PANTRY> stop",
      }),
    ),
  );

  expect(stopped.status).toBe(200);
  model.releaseRoot.resolve(undefined);

  await expect
    .poll(slack.visibleMessageCount, { timeout: 15_000 })
    .toBeGreaterThan(0);

  // The stop did not start a second agent run.
  expect(model.requests).toHaveLength(1);

  // Committed bytes remain addressable; staging does not survive.
  const stored = await env.ARCHIVE.list({ prefix: "attachments/" });
  expect(stored.objects.length).toBeGreaterThan(0);
  for (const object of stored.objects) {
    expect(object.key).not.toContain("/staging/");
  }
});

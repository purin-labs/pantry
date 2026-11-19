/**
 * Plan 37 attachment canary.
 *
 * P37-6 requires one literal Actor journey and one addressed Slack receipt for
 * every supported message class, against a real Slack workspace and a deployed
 * Worker. That evidence cannot be produced from a test runner: container
 * Durable Object bindings are undefined locally, and a simulated Slack proves
 * nothing about the real one.
 *
 * This script produces it. It posts one root message per class — with the
 * files attached to that same message, so a reply can only be a reply to a
 * message that carried them — waits for the app's threaded reply, and writes
 * a machine-readable evidence file naming what was sent, what came back, and
 * how long it took.
 *
 * It refuses to run without real credentials. There is no dry-run mode and no
 * simulated fallback, because a canary that can pass without touching the
 * system it is meant to exercise is worse than no canary.
 *
 * Fixtures are disposable by construction. Most are generated here; the H.264
 * case reuses the checked-in real keyframe fixture so decoder evidence has
 * actual pixels to inspect.
 *
 *   SLACK_CANARY_USER_TOKEN=xoxp-... \
 *   SLACK_CANARY_CHANNEL=C0123456789 \
 *   SLACK_APP_USER_ID=U0SATYRBOT \
 *   node --experimental-strip-types scripts/plan37-attachment-canary.ts
 */

import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { isRecord, sleep } from "@purin-labs/std";

type CanaryCase = {
  readonly name: string;
  readonly text: string;
  readonly files: readonly CanaryFile[];
  readonly replyChecks: readonly ReplyCheck[];
};

type CanaryFile = {
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
};

type ReplyCheck = {
  readonly label: string;
  readonly token: string;
};

type CanaryFailure = "send_failed" | "reply_failed" | "timed_out";

type CanaryOutcome =
  | {
      readonly name: string;
      readonly messageTs: string | null;
      readonly replyTs: null;
      readonly replyText: null;
      readonly elapsedMs: number;
      readonly status: "failed";
      readonly failure: CanaryFailure;
      readonly detail: string | null;
    }
  | {
      readonly name: string;
      readonly messageTs: string;
      readonly replyTs: string;
      readonly replyText: string;
      readonly elapsedMs: number;
      /** A reply arrived, but one or more fixture checks were absent. */
      readonly status: "observed";
      readonly matchedChecks: readonly string[];
      readonly missingChecks: readonly string[];
    }
  | {
      readonly name: string;
      readonly messageTs: string;
      readonly replyTs: string;
      readonly replyText: string;
      readonly elapsedMs: number;
      /** Every nonce and fixture-specific check matched the app's reply. */
      readonly status: "verified";
      readonly matchedChecks: readonly string[];
    };

type ReplyVerification =
  | {
      readonly status: "observed";
      readonly matchedChecks: readonly string[];
      readonly missingChecks: readonly string[];
    }
  | {
      readonly status: "verified";
      readonly matchedChecks: readonly string[];
    };

type CaseDefinition = {
  readonly name: string;
  readonly instruction: string;
  readonly nonce: string;
  readonly files: readonly CanaryFile[];
  readonly replyChecks: readonly ReplyCheck[];
};

const SLACK_API = "https://slack.com/api";
const REPLY_TIMEOUT_MS = 180_000;
const REPLY_POLL_MS = 3_000;

async function main(): Promise<void> {
  const config = readConfig();
  const identity = await slackJson(config.token, "auth.test", {});
  if (
    typeof identity.user_id !== "string" ||
    identity.bot_id !== undefined ||
    identity.user_id === config.appUserId
  ) {
    throw new Error(
      "plan37 canary requires a human user token; Satyr ignores bot-authored messages",
    );
  }
  const cases = await canaryCases();
  const outcomes: CanaryOutcome[] = [];

  for (const canaryCase of cases) {
    process.stdout.write(`${canaryCase.name}: `);

    const outcome = await runCase(config, canaryCase);

    outcomes.push(outcome);
    process.stdout.write(`${outcome.status} (${outcome.elapsedMs}ms)\n`);
  }

  const observed = outcomes.filter(isReplyObserved);
  const verified = outcomes.filter(isVerified);
  const failed = outcomes.filter(isFailed);
  const evidence = {
    kind: "satyr.plan37.attachment-canary.v2",
    channel: config.channel,
    // The run is identified by the first message it posted, so the evidence
    // points at a real conversation rather than a wall-clock guess.
    runAnchorTs: outcomes[0]?.messageTs ?? null,
    cases: outcomes,
    // A reply is observed before its content is considered verified.
    observed: observed.length,
    verified: verified.length,
    failed: failed.length,
    interpretation: {
      verified:
        "The app's addressed Slack reply contained the case nonce and every fixture check.",
      observed:
        "A reply arrived from the configured app identity, but at least one fixture check was absent.",
      failed:
        "The message could not be sent, the reply lookup failed, or no reply arrived before the deadline.",
      h264: "The decodedStills count and orange visual assertion are reply-content evidence only; executor receipts and decoded pixels require separate runtime evidence.",
    },
    total: outcomes.length,
  };

  await writeFile(
    config.evidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`\nevidence: ${config.evidencePath}\n`);
  process.stdout.write(
    `${verified.length}/${outcomes.length} message classes verified (${observed.length} replied, ${failed.length} failed)\n`,
  );

  if (verified.length !== outcomes.length) {
    process.exitCode = 1;
  }
}

function readConfig(): {
  readonly token: string;
  readonly channel: string;
  readonly appUserId: string;
  readonly evidencePath: string;
} {
  const token = process.env.SLACK_CANARY_USER_TOKEN;
  const channel = process.env.SLACK_CANARY_CHANNEL;
  const appUserId = process.env.SLACK_APP_USER_ID;

  if (
    token === undefined ||
    token.length === 0 ||
    channel === undefined ||
    channel.length === 0 ||
    appUserId === undefined ||
    appUserId.length === 0
  ) {
    // Fail closed and say exactly what is missing.
    throw new Error(
      "plan37 canary requires SLACK_CANARY_USER_TOKEN, SLACK_CANARY_CHANNEL, and SLACK_APP_USER_ID",
    );
  }

  return {
    token,
    channel,
    appUserId,
    evidencePath:
      process.env.PLAN37_CANARY_EVIDENCE ?? "plan37-canary-evidence.json",
  };
}

async function runCase(
  config: ReturnType<typeof readConfig>,
  canaryCase: CanaryCase,
): Promise<CanaryOutcome> {
  const startedAt = Date.now();
  let messageTs: string | null;

  try {
    messageTs = await postCase(config, canaryCase);
  } catch (error) {
    return {
      name: canaryCase.name,
      messageTs: null,
      replyTs: null,
      replyText: null,
      elapsedMs: Date.now() - startedAt,
      status: "failed",
      failure: "send_failed",
      detail: errorDetail(error),
    };
  }

  let reply: { readonly ts: string; readonly text: string } | null;

  try {
    reply = await awaitReply(config, messageTs, startedAt);
  } catch (error) {
    return {
      name: canaryCase.name,
      messageTs,
      replyTs: null,
      replyText: null,
      elapsedMs: Date.now() - startedAt,
      status: "failed",
      failure: "reply_failed",
      detail: errorDetail(error),
    };
  }

  if (reply === null) {
    return {
      name: canaryCase.name,
      messageTs,
      replyTs: null,
      replyText: null,
      elapsedMs: Date.now() - startedAt,
      status: "failed",
      failure: "timed_out",
      detail: null,
    };
  }

  const verification = verifyReply(reply.text, canaryCase);

  return verification.status === "verified"
    ? {
        name: canaryCase.name,
        messageTs,
        replyTs: reply.ts,
        replyText: reply.text,
        elapsedMs: Date.now() - startedAt,
        status: "verified",
        matchedChecks: verification.matchedChecks,
      }
    : {
        name: canaryCase.name,
        messageTs,
        replyTs: reply.ts,
        replyText: reply.text,
        elapsedMs: Date.now() - startedAt,
        status: "observed",
        matchedChecks: verification.matchedChecks,
        missingChecks: verification.missingChecks,
      };
}

/**
 * Posts one case as a single root message that carries its files.
 *
 * Order matters for what the run proves. A text mention followed by files in
 * the thread would let the app's reply to the text count as success while the
 * attachment path failed silently. So a case with files is posted through
 * `files.completeUploadExternal` with the mention as its initial comment: one
 * message, files attached, and the only reply that can arrive is to it.
 */
async function postCase(
  config: ReturnType<typeof readConfig>,
  canaryCase: CanaryCase,
): Promise<string> {
  const text = `<@${config.appUserId}> ${canaryCase.text}`.trim();

  if (canaryCase.files.length === 0) {
    const posted = await slackJson(config.token, "chat.postMessage", {
      channel: config.channel,
      text,
    });
    const ts = posted.ts;

    if (typeof ts !== "string") {
      throw new Error(
        `${canaryCase.name}: chat.postMessage returned no timestamp`,
      );
    }

    return ts;
  }

  const uploaded: string[] = [];

  for (const file of canaryCase.files) {
    uploaded.push(await uploadFile(config, file));
  }

  const completed = await slackJson(
    config.token,
    "files.completeUploadExternal",
    {
      files: uploaded.map(function reference(id) {
        return { id };
      }),
      channel_id: config.channel,
      initial_comment: text,
    },
  );
  const ts = sharedMessageTs(completed, config.channel);

  if (ts !== null) {
    return ts;
  }

  // Older API shapes omit the share timestamp; find the message by its files.
  const history = await slackJson(
    config.token,
    "conversations.history",
    {
      channel: config.channel,
      limit: 20,
    },
    "GET",
  );
  const messages = Array.isArray(history.messages) ? history.messages : [];

  for (const message of messages) {
    if (
      !isRecord(message) ||
      !Array.isArray(message.files) ||
      typeof message.ts !== "string"
    ) {
      continue;
    }

    const ids = message.files
      .map(function id(file) {
        return isRecord(file) ? file.id : undefined;
      })
      .filter(function isString(value): value is string {
        return typeof value === "string";
      });

    if (
      uploaded.every(function shared(id) {
        return ids.includes(id);
      })
    ) {
      return message.ts;
    }
  }

  throw new Error(
    `${canaryCase.name}: could not locate the message that carried its files`,
  );
}

function sharedMessageTs(
  completed: Record<string, unknown>,
  channel: string,
): string | null {
  const files = Array.isArray(completed.files) ? completed.files : [];

  for (const file of files) {
    if (!isRecord(file) || !isRecord(file.shares)) continue;
    for (const scope of ["public", "private"]) {
      const shares = file.shares[scope];
      if (!isRecord(shares)) continue;
      const entries = shares[channel];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (isRecord(entry) && typeof entry.ts === "string") return entry.ts;
      }
    }
  }

  return null;
}

async function uploadFile(
  config: ReturnType<typeof readConfig>,
  file: CanaryFile,
): Promise<string> {
  const reserved = await slackJson(config.token, "files.getUploadURLExternal", {
    filename: file.filename,
    length: file.bytes.byteLength,
  });
  const uploadUrl = reserved.upload_url;
  const fileId = reserved.file_id;

  if (typeof uploadUrl !== "string" || typeof fileId !== "string") {
    throw new Error(`${file.filename}: Slack did not reserve an upload`);
  }

  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: { "content-type": file.mediaType },
    body: arrayBufferForUpload(file.bytes),
  });

  if (!upload.ok) {
    throw new Error(`${file.filename}: upload failed with ${upload.status}`);
  }

  return fileId;
}

function arrayBufferForUpload(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function awaitReply(
  config: ReturnType<typeof readConfig>,
  threadTs: string,
  startedAt: number,
): Promise<{ readonly ts: string; readonly text: string } | null> {
  while (Date.now() - startedAt < REPLY_TIMEOUT_MS) {
    await sleep(REPLY_POLL_MS);

    const replies = await slackJson(
      config.token,
      "conversations.replies",
      {
        channel: config.channel,
        ts: threadTs,
      },
      "GET",
    );
    const messages = Array.isArray(replies.messages) ? replies.messages : [];

    for (const message of messages) {
      if (!isRecord(message) || message.ts === threadTs) {
        continue;
      }

      // Only the configured app identity can produce the receipt. The thread
      // lookup supplies the parent binding; honor an explicit thread field too
      // when Slack includes it in the response.
      const isApp = message.user === config.appUserId;
      const isInThread =
        message.thread_ts === undefined || message.thread_ts === threadTs;

      if (
        isApp &&
        isInThread &&
        typeof message.text === "string" &&
        typeof message.ts === "string"
      ) {
        return { ts: message.ts, text: message.text };
      }
    }
  }

  return null;
}

function verifyReply(
  replyText: string,
  canaryCase: CanaryCase,
): ReplyVerification {
  const normalizedReply = replyText.toLowerCase();
  const matchedChecks: string[] = [];
  const missingChecks: string[] = [];

  for (const check of canaryCase.replyChecks) {
    if (containsReplyToken(normalizedReply, check.token)) {
      matchedChecks.push(check.label);
    } else {
      missingChecks.push(check.label);
    }
  }

  return missingChecks.length === 0
    ? { status: "verified", matchedChecks }
    : { status: "observed", matchedChecks, missingChecks };
}

function containsReplyToken(normalizedReply: string, token: string): boolean {
  const normalizedToken = token.toLowerCase();
  const escaped = normalizedToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "u").test(
    normalizedReply,
  );
}

function isReplyObserved(outcome: CanaryOutcome): boolean {
  return outcome.status === "observed" || outcome.status === "verified";
}

function isVerified(outcome: CanaryOutcome): boolean {
  return outcome.status === "verified";
}

function isFailed(outcome: CanaryOutcome): boolean {
  return outcome.status === "failed";
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : "unknown_error";
}

async function slackJson(
  token: string,
  method: string,
  body: Record<string, unknown>,
  verb: "GET" | "POST" = "POST",
): Promise<Record<string, unknown>> {
  const url = new URL(`${SLACK_API}/${method}`);
  let response: Response;

  if (verb === "GET") {
    for (const [key, value] of Object.entries(body)) {
      url.searchParams.set(key, String(value));
    }

    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
  } else {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
  }

  const parsed: unknown = await response.json();

  if (!isRecord(parsed) || parsed.ok !== true) {
    const detail = isRecord(parsed) ? String(parsed.error) : "unparseable";
    throw new Error(`${method} failed: ${detail}`);
  }

  return parsed;
}

/**
 * One case per supported message class, matching the plan's list.
 *
 * The generated fixtures carry deterministic markers. The H.264 case uses the
 * checked-in decoder fixture so a reply can report decoded stills and color.
 */
export async function canaryCases(): Promise<readonly CanaryCase[]> {
  const { docxArchive, waveHeader } =
    await import("../tests/media-fixtures.ts");
  const h264 = new Uint8Array(
    await readFile(
      new URL("../tests/fixtures/keyframes-h264.mp4", import.meta.url),
    ),
  );
  const png = solidRedPng();
  const cad = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0x01, 0x02, 0x03, 0x04]);
  const pdfNonce = canaryNonce("pdf");
  const pdfMarker = `P37-PDF-${pdfNonce}`;
  const docxNonce = canaryNonce("docx");
  const docxMarker = `P37-DOCX-${docxNonce}`;
  const mixedNonce = canaryNonce("mixed");
  const mixedPdfMarker = `P37-MIXED-PDF-${mixedNonce}`;

  return [
    createCanaryCase({
      name: "text_only",
      nonce: canaryNonce("text"),
      instruction: "Reply with the word OK and repeat the nonce exactly.",
      files: [],
      replyChecks: [{ label: "text acknowledgement", token: "OK" }],
    }),
    createCanaryCase({
      name: "link_only",
      nonce: canaryNonce("link"),
      instruction:
        "Use read_message_link for <https://example.com/|the spec>. Report its page title and repeat the nonce exactly.",
      files: [],
      replyChecks: [
        { label: "linked fixture content", token: "Example Domain" },
      ],
    }),
    createCanaryCase({
      name: "image",
      nonce: canaryNonce("image"),
      instruction:
        "Examine the attached image itself as native visual input. Report its dominant color and repeat the nonce exactly. Describe the boundary of any evidence in the Slack reply.",
      files: [{ filename: "canary.png", mediaType: "image/png", bytes: png }],
      replyChecks: [{ label: "image visual color", token: "red" }],
    }),
    createCanaryCase({
      name: "document_pdf",
      nonce: pdfNonce,
      instruction:
        "Call inspect_message_attachment for the attached PDF. Extract and repeat the fixture marker embedded in its quote, include the filename, and repeat the nonce exactly.",
      files: [
        {
          filename: "canary-quote.pdf",
          mediaType: "application/pdf",
          bytes: pdfFixture(pdfMarker),
        },
      ],
      replyChecks: [
        { label: "PDF filename", token: "canary-quote.pdf" },
        { label: "PDF extracted fixture marker", token: pdfMarker },
      ],
    }),
    createCanaryCase({
      name: "document_docx",
      nonce: docxNonce,
      instruction:
        "Call inspect_message_attachment for the attached DOCX. Extract and repeat the fixture marker embedded in its text, include the filename, and repeat the nonce exactly.",
      files: [
        {
          filename: "canary-terms.docx",
          mediaType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          bytes: await docxArchive(
            `Canary espresso 3.50 per unit ${docxMarker}`,
          ),
        },
      ],
      replyChecks: [
        { label: "DOCX filename", token: "canary-terms.docx" },
        { label: "DOCX extracted fixture marker", token: docxMarker },
      ],
    }),
    createCanaryCase({
      name: "audio",
      nonce: canaryNonce("audio"),
      instruction:
        "Call inspect_message_attachment for the attached WAV. Report its exact metadata using sampleRateHz=<value> and channels=<value>, plus the filename; repeat the nonce exactly and make no transcription claim.",
      files: [
        { filename: "canary.wav", mediaType: "audio/wav", bytes: waveHeader() },
      ],
      replyChecks: [
        { label: "audio filename", token: "canary.wav" },
        { label: "audio sample rate", token: "sampleRateHz=44100" },
        { label: "audio channel count", token: "channels=2" },
      ],
    }),
    createCanaryCase({
      name: "video",
      nonce: canaryNonce("video"),
      instruction:
        "Inspect the prepared input for the attached H.264 video. Report exact fields using video=<codec> and decodedStills=<count>, plus the filename and dominant visual color; then repeat the nonce. Treat executor receipts and decoded pixels as separate runtime evidence from this Slack reply.",
      files: [{ filename: "canary.mp4", mediaType: "video/mp4", bytes: h264 }],
      replyChecks: [
        { label: "video filename", token: "canary.mp4" },
        { label: "video codec", token: "video=avc1" },
        { label: "video decoded still count", token: "decodedStills=4" },
        { label: "video visual color", token: "orange" },
      ],
    }),
    createCanaryCase({
      name: "opaque_cad",
      nonce: canaryNonce("cad"),
      instruction:
        "Call inspect_message_attachment for the attached CAD file. Report the manifest filename and class=opaque, state that its contents were not read, and repeat the nonce exactly.",
      files: [
        { filename: "canary.3ds", mediaType: "application/x-3ds", bytes: cad },
      ],
      replyChecks: [
        { label: "opaque filename", token: "canary.3ds" },
        { label: "opaque media class", token: "class=opaque" },
      ],
    }),
    createCanaryCase({
      name: "mixed_text_link_files",
      nonce: mixedNonce,
      instruction:
        "Use read_message_link for <https://example.com/|the spec> and inspect_message_attachment for both files. Report the page title, the PDF fixture marker, the CAD filename and opaque class, then repeat the nonce exactly.",
      files: [
        {
          filename: "canary-mixed.pdf",
          mediaType: "application/pdf",
          bytes: pdfFixture(mixedPdfMarker),
        },
        {
          filename: "canary-mixed.3ds",
          mediaType: "application/x-3ds",
          bytes: cad,
        },
      ],
      replyChecks: [
        { label: "mixed linked fixture content", token: "Example Domain" },
        { label: "mixed PDF extracted fixture marker", token: mixedPdfMarker },
        { label: "mixed CAD filename", token: "canary-mixed.3ds" },
        { label: "mixed opaque media class", token: "class=opaque" },
      ],
    }),
  ];
}

function createCanaryCase(definition: CaseDefinition): CanaryCase {
  return {
    name: definition.name,
    text: `canary nonce ${definition.nonce}. ${definition.instruction} Repeat the nonce exactly in the reply.`,
    files: definition.files,
    replyChecks: [
      { label: "case nonce", token: definition.nonce },
      ...definition.replyChecks,
    ],
  };
}

function canaryNonce(name: string): string {
  return `p37-${name}-${randomUUID().replaceAll("-", "")}`;
}

function pdfFixture(marker: string): Uint8Array {
  const encoder = new TextEncoder();
  const stream = `BT (Canary quote for 200 units ${marker}) Tj ET\n`;
  const streamLength = encoder.encode(stream).byteLength;
  const pdf = [
    "%PDF-1.7",
    "1 0 obj",
    `<< /Length ${streamLength} >>`,
    "stream",
    stream,
    "endstream",
    "endobj",
    "%%EOF",
    "",
  ].join("\n");

  return encoder.encode(pdf);
}

function solidRedPng(): Uint8Array {
  return new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAlElEQVR4nO3QMREAMBDDsPAn/YWhoR60+7zb7mfTAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA3QAVoDdIDWAB2gNUAHaA9DiOHSbdjxEgAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
}

if (import.meta.main) await main();

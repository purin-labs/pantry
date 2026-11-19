import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { fixtureDatabase } from "./organisation-database";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { sha256Hex } from "@purin-labs/std";
import { parseOrganisationId, parseIntegrationAccountId } from "../../src/ids";
import { acquireSlackAttachmentBatch } from "../../src/slack/attachments";
import { parseSlackEnvelope } from "../../src/slack/events";
import {
  collectOrganisationAttachments,
  ATTACHMENT_COLLECTION_GRACE_MS,
} from "../../src/messages/attachment-collection";
import {
  chatForkHistoryDigest,
  type ChatForkHistory,
  parseChatForkHistory,
} from "../../src/chat/fork-history";
import { readChatForkHistoryForCase } from "../../src/chat/forks";
import {
  RecordingBoundary,
  sdkInput,
  prepareSdkOrganisation,
} from "./pi-sdk-support";
import { slackEnvelope, slackFileSimulator } from "./slack-journey-support";
import { network } from "./network";

it("retains prepared and restored fork files, blocks missing content, and collects after erasure", async ({
  task,
}) => {
  const parsedOrganisation = parseOrganisationId("organisation_compaction");
  if (!parsedOrganisation.ok) throw new Error(parsedOrganisation.error.code);
  const organisationId = parsedOrganisation.value;
  await prepareSdkOrganisation();
  const bytes = new TextEncoder().encode(
    "Retained bakery brief: proofing capacity is twelve trays.",
  );
  const sha256 = await sha256Hex(bytes);
  const objectKey = `attachments/${organisationId}/slack/${sha256}`;
  const files = slackFileSimulator([
    { id: "F0FORKBRIEF", name: "brief.txt", mimetype: "text/plain", bytes },
  ]);
  network.use(files.infoHandler, files.downloadHandler);
  const envelope = parseSlackEnvelope(
    JSON.stringify(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0FORKBRIEF",
        messageTs: "1700000000.000100",
        threadTs: "1700000000.000100",
        text: "Retain this bakery brief.",
        files: [
          {
            id: "F0FORKBRIEF",
            name: "brief.txt",
            mimetype: "text/plain",
            size: bytes.length,
            timestamp: 1,
          },
        ],
      }),
    ),
  );
  if (!envelope.ok || envelope.value.kind !== "message")
    throw new Error("Invalid retained-file envelope");
  const account = parseIntegrationAccountId(
    "integration_account_fork_retention",
  );
  if (!account.ok) throw new Error(account.error.code);
  const batch = await acquireSlackAttachmentBatch({
    bucket: env.ARCHIVE,
    organisationId,
    integrationAccountId: account.value,
    event: envelope.value.event,
    token: "fork-retention-fixture-token",
    now: 1,
  });
  if (batch.state !== "committed" || batch.attachments.length !== 1)
    throw new Error("Retained-file acquisition failed");
  const attachment = batch.attachments[0];
  if (attachment === undefined) throw new Error("Missing retained file");
  expect(files.downloads).toEqual(["F0FORKBRIEF"]);
  expect(attachment.objectKey).toBe(objectKey);
  const base = sdkInput(new RecordingBoundary(), [], "direct");
  const history = await parseChatForkHistory({
    entries: [
      {
        kind: "user_input",
        turn: base.turnLease.turn,
        input: base.acceptedInput,
        content: [{ kind: "attachment", attachment }],
        acceptedAt: 1,
      },
      {
        kind: "assistant_message",
        turn: base.turnLease.turn,
        model: base.model,
        content: [
          {
            kind: "text",
            text: "The bakery brief is accepted.",
            continuation: { kind: "none" },
          },
        ],
        stopReason: "completed",
        usage: {
          modelCalls: 1,
          callsWithUsage: 1,
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
          totalTokens: 20,
        },
        acceptedAt: 2,
      },
    ],
    bindings: [],
  } satisfies ChatForkHistory);
  const digest = await chatForkHistoryDigest(history);
  const orphanKey = `attachments/${organisationId}/slack/${"b".repeat(64)}`;
  await env.ARCHIVE.put(orphanKey, "unreferenced");
  await fixtureDatabase()
    .prepare(
      "INSERT INTO portal_chat_fork (organisation_id, user_id, operation_id, source_conversation_id, source_message_id, destination_conversation_id, destination_case_id, status, history_json, conversation_json, digest, failure_code) VALUES (?, 'user_00000000-0000-4000-8000-000000000001', 'fork_retention', 'conv_00000000-0000-4000-8000-000000000001', 'response', 'conv_00000000-0000-4000-8000-000000000002', 'case_fork_retention', 'prepared', ?, '{}', ?, NULL)",
    )
    .bind(organisationId, JSON.stringify(history), digest)
    .run();
  const now = Date.now() + ATTACHMENT_COLLECTION_GRACE_MS + 1_000;
  const prepared = await collectOrganisationAttachments({
    scope: await requireOrganisationExecutionScope(env, organisationId),
    archive: env.ARCHIVE,
    namespaces: env,

    now,
  });
  expect(prepared).toMatchObject({
    kind: "collected",
    receipt: { deleted: [orphanKey] },
  });
  expect(await env.ARCHIVE.get(objectKey)).not.toBeNull();
  await fixtureDatabase()
    .prepare(
      "UPDATE portal_chat_fork SET status = 'ready', conversation_json = NULL WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .run();
  expect(
    await readChatForkHistoryForCase(
      env,
      await requireOrganisationExecutionScope(env, organisationId),
      "case_fork_retention",
    ),
  ).toEqual(history);
  const first = history.entries[0];
  if (first?.kind !== "user_input") throw new Error("Missing inherited input");
  for (const conflicting of [
    { ...attachment, byteLength: attachment.byteLength + 1 },
    { ...attachment, sha256: "0".repeat(64) },
  ]) {
    const inconsistent = await parseChatForkHistory({
      entries: [
        {
          kind: "user_input",
          turn: first.turn,
          input: first.input,
          content: [
            ...first.content,
            { kind: "attachment", attachment: conflicting },
          ],
          acceptedAt: first.acceptedAt,
        },
        ...history.entries.slice(1),
      ],
      bindings: history.bindings,
    });
    await fixtureDatabase()
      .prepare(
        "UPDATE portal_chat_fork SET history_json = ?, digest = ? WHERE organisation_id = ?",
      )
      .bind(
        JSON.stringify(inconsistent),
        await chatForkHistoryDigest(inconsistent),
        organisationId,
      )
      .run();
    await expect(
      readChatForkHistoryForCase(
        env,
        await requireOrganisationExecutionScope(env, organisationId),
        "case_fork_retention",
      ),
    ).rejects.toThrow("chat_fork_attachment_unavailable");
  }
  await fixtureDatabase()
    .prepare(
      "UPDATE portal_chat_fork SET history_json = ?, digest = ? WHERE organisation_id = ?",
    )
    .bind(JSON.stringify(history), digest, organisationId)
    .run();
  await env.ARCHIVE.delete(objectKey);
  await expect(
    readChatForkHistoryForCase(
      env,
      await requireOrganisationExecutionScope(env, organisationId),
      "case_fork_retention",
    ),
  ).rejects.toThrow("chat_fork_attachment_unavailable");
  await env.ARCHIVE.put(objectKey, bytes);
  expect(
    await readChatForkHistoryForCase(
      env,
      await requireOrganisationExecutionScope(env, organisationId),
      "case_fork_retention",
    ),
  ).toEqual(history);
  const unresolved = {
    entries: [
      history.entries[0],
      {
        kind: "assistant_message",
        turn: base.turnLease.turn,
        model: base.model,
        content: [
          {
            kind: "tool_call",
            callId: "call_unsettled",
            tool: "inventory_read",
            arguments: {},
            continuation: { kind: "none" },
          },
        ],
        stopReason: "tool_use",
        usage: {
          modelCalls: 1,
          callsWithUsage: 1,
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
          totalTokens: 20,
        },
        acceptedAt: 2,
      },
      history.entries[1],
    ],
    bindings: [],
  };
  await fixtureDatabase()
    .prepare(
      "UPDATE portal_chat_fork SET history_json = ? WHERE organisation_id = ?",
    )
    .bind(JSON.stringify(unresolved), organisationId)
    .run();
  await expect(
    readChatForkHistoryForCase(
      env,
      await requireOrganisationExecutionScope(env, organisationId),
      "case_fork_retention",
    ),
  ).rejects.toThrow("chat_fork_unsettled_tools");
  await fixtureDatabase()
    .prepare(
      "UPDATE portal_chat_fork SET history_json = ? WHERE organisation_id = ?",
    )
    .bind(JSON.stringify(history), organisationId)
    .run();
  await fixtureDatabase()
    .prepare("UPDATE portal_chat_fork SET digest = ? WHERE organisation_id = ?")
    .bind("0".repeat(64), organisationId)
    .run();
  const invalid = await collectOrganisationAttachments({
    scope: await requireOrganisationExecutionScope(env, organisationId),
    archive: env.ARCHIVE,
    namespaces: env,

    now,
  });
  expect(invalid).toMatchObject({
    kind: "skipped",
    reason: "fork_history_unavailable",
  });
  expect(await env.ARCHIVE.get(objectKey)).not.toBeNull();
  await fixtureDatabase()
    .prepare(
      "UPDATE portal_chat_fork SET status = 'erased', history_json = NULL, digest = NULL WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .run();
  const erased = await collectOrganisationAttachments({
    scope: await requireOrganisationExecutionScope(env, organisationId),
    archive: env.ARCHIVE,
    namespaces: env,

    now,
  });
  expect(erased).toMatchObject({
    kind: "collected",
    receipt: { deleted: expect.arrayContaining([objectKey]) },
  });
  expect(await env.ARCHIVE.get(objectKey)).toBeNull();
  expect(
    (await env.ARCHIVE.list({ prefix: `attachments/${organisationId}/` }))
      .objects,
  ).toEqual([]);
  Object.assign(task.meta, {
    forkRetentionEvidence: {
      sourceIngestion: {
        downloads: files.downloads,
        attachmentId: attachment.id,
        descriptor: attachment.descriptor,
      },
      digest,
      objectKey,
      prepared,
      invalid,
      erased,
      missingContentRejected: true,
      unresolvedToolPairRejected: true,
      restoredContentReadable: true,
      conflictingDescriptorForSameObjectRejected: true,
    },
  });
});

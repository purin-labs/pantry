import type { AttachmentId } from "@purin-labs/contracts";

import { buildStoredMessageAttachment } from "@purin-labs/agent/messages/message-wasm";

const SOURCE_SHA256 = "a".repeat(64);

const attachment = buildStoredMessageAttachment({
  attachmentId: `att_${"a".repeat(32)}`,
  displayName: "fixture.txt",
  declaredMediaType: "text/plain",
  byteLength: 13,
  sha256: SOURCE_SHA256,
  objectKey: `attachments/organisation_1/slack/${SOURCE_SHA256}`,
  header: [],
  storedAt: 1_700_000_000,
  source: {
    kind: "slack",
    integrationAccountId: "account_1",
    workspaceId: "T1",
    channelId: "C1",
    messageTs: "1700000000.000100",
    fileId: "F1",
    revision: "1700000000",
  },
});

if (!attachment.ok) {
  throw new Error(
    `failed to build executor fixture: ${attachment.error.reason}`,
  );
}

export const WORKSPACE_EXECUTOR_ATTACHMENT_ID: AttachmentId =
  attachment.value.id;

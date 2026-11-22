import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { ConversationId } from "@purin-labs/control-api";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { StoredMessageAttachment, UserMessage } from "@purin-labs/contracts";
import { assertNever, sha256Hex } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";
import { readJsonRecord } from "@purin-labs/control/worker/http";
import { MESSAGE_ATTACHMENT_POLICY } from "@purin-labs/control-api";
import {
  buildStoredMessageAttachment,
  deriveUserMessageViews,
  validateStoredMessageAttachment,
} from "@purin-labs/agent/messages/message-wasm";
import type { Result } from "@purin-labs/kernel/result";
import {
  parseChatCommand,
  parseConversation,
  type ChatCommand,
} from "./conversation";
import type { ConversationScope } from "./store";
import {
  attachmentParts,
  surfaceObservationField,
  type ChatAttachmentPart,
} from "./timeline";

type ChatSubmission = {
  readonly command: ChatCommand;
  readonly files: readonly File[];
};

export async function readChatSubmission(
  request: Request,
): Promise<Result<ChatSubmission, string>> {
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) {
    const body = await readJsonRecord(request);
    if (!body.ok) return { ok: false, error: "chat_request_invalid" };
    const command = parseChatCommand(body.value);
    return command.ok
      ? { ok: true, value: { command: command.value, files: [] } }
      : command;
  }
  if (request.body === null)
    return { ok: false, error: "chat_request_invalid" };
  const limit = new ChatUploadBodyLimit();
  try {
    const body = await new Response(
      request.body.pipeThrough(
        new TransformStream({ transform: limit.transform.bind(limit) }),
      ),
      { headers: request.headers },
    ).formData();
    const raw = body.getAll("command");
    if (raw.length !== 1 || typeof raw[0] !== "string")
      return { ok: false, error: "chat_request_invalid" };
    for (const key of body.keys())
      if (key !== "command" && key !== "files")
        return { ok: false, error: "chat_request_invalid" };
    const command = parseChatCommand(JSON.parse(raw[0]));
    if (!command.ok) return command;
    const files: File[] = [];
    let bytes = 0;
    for (const file of body.getAll("files")) {
      if (
        typeof file === "string" ||
        file.size === 0 ||
        file.size > MESSAGE_ATTACHMENT_POLICY.maxFileBytes
      )
        return { ok: false, error: "chat_attachment_limit" };
      files.push(file);
      bytes += file.size;
    }
    if (
      files.length > MESSAGE_ATTACHMENT_POLICY.maxFilesPerMessage ||
      bytes > MESSAGE_ATTACHMENT_POLICY.maxBatchBytes
    )
      return { ok: false, error: "chat_attachment_limit" };
    if (
      command.value.kind === "retry" ||
      command.value.kind === "withdraw" ||
      command.value.kind === "steer_queued"
    )
      return { ok: false, error: "chat_request_invalid" };
    return { ok: true, value: { command: command.value, files } };
  } catch {
    return {
      ok: false,
      error: limit.exceeded ? "chat_attachment_limit" : "chat_request_invalid",
    };
  }
}

class ChatUploadBodyLimit {
  private bytes = 0;
  exceeded = false;

  transform(
    chunk: Uint8Array,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > MESSAGE_ATTACHMENT_POLICY.maxBatchBytes + 64 * 1024) {
      this.exceeded = true;
      throw new Error("chat_attachment_limit");
    }
    controller.enqueue(chunk);
  }
}

function chatAttachmentPointerKey(
  organisationId: OrganisationId,
  attachmentId: string,
): string {
  return `attachments/${organisationId}/portalref/${attachmentId}`;
}

export async function retainChatFiles(
  bucket: R2Bucket,
  scope: ConversationScope,
  conversationId: ConversationId,
  files: readonly File[],
): Promise<Result<readonly ChatAttachmentPart[], string>> {
  const parts: ChatAttachmentPart[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = await sha256Hex(bytes);
    const identity = await sha256Hex(
      JSON.stringify([
        scope.organisationId,
        scope.userId,
        conversationId,
        file.name,
        file.type || null,
        digest,
      ]),
    );
    const attachmentId = `att_${identity.slice(0, 32)}`;
    const objectKey = `attachments/${scope.organisationId}/portal/${digest}`;
    const pointerKey = chatAttachmentPointerKey(
      scope.organisationId,
      attachmentId,
    );
    const built = buildStoredMessageAttachment({
      attachmentId,
      displayName: file.name,
      declaredMediaType: file.type || null,
      byteLength: bytes.length,
      sha256: digest,
      objectKey,
      header: Array.from(
        bytes.slice(0, MESSAGE_ATTACHMENT_POLICY.signatureHeaderBytes),
      ),
      storedAt: Date.now(),
      source: {
        kind: "portal",
        userId: scope.userId,
        conversationId,
        uploadId: attachmentId,
      },
    });
    if (!built.ok) return { ok: false, error: "chat_attachment_invalid" };
    await bucket.put(objectKey, bytes);
    if ((await bucket.head(pointerKey)) === null)
      await bucket.put(pointerKey, JSON.stringify(built.value));
    parts.push({
      kind: "attachment",
      attachmentId,
      filename: built.value.displayName,
      mediaType: attachmentMediaType(built.value),
      preparation: "ready",
    });
  }
  return { ok: true, value: parts };
}

function attachmentMediaType(attachment: StoredMessageAttachment): string {
  return attachment.descriptor.media.mediaType;
}

async function readChatAttachment(
  bucket: R2Bucket,
  organisationId: OrganisationId,
  part: ChatAttachmentPart,
): Promise<StoredMessageAttachment> {
  const object = await bucket.get(
    chatAttachmentPointerKey(organisationId, part.attachmentId),
  );
  if (object === null) throw new Error("chat_attachment_missing");
  const parsed = validateStoredMessageAttachment(await object.json());
  if (
    !parsed.ok ||
    parsed.value.id !== part.attachmentId ||
    parsed.value.displayName !== part.filename ||
    attachmentMediaType(parsed.value) !== part.mediaType ||
    parsed.value.source.kind !== "portal" ||
    !parsed.value.objectKey.startsWith(`attachments/${organisationId}/portal/`)
  )
    throw new Error("chat_attachment_invalid");
  return parsed.value;
}

export async function chatUserMessage(
  bucket: R2Bucket,
  organisationId: OrganisationId,
  text: string,
  parts: readonly ChatAttachmentPart[],
): Promise<UserMessage> {
  const remainingParts = [];
  for (const part of parts)
    remainingParts.push({
      kind: "attachment",
      attachment: await readChatAttachment(bucket, organisationId, part),
    });
  const message = deriveUserMessageViews({
    firstPart: { kind: "text", text },
    remainingParts,
  });
  if (!message.ok) throw new Error("chat_attachment_invalid");
  return message.value.message;
}

export async function readPortalChatAttachmentKeys(
  db: OrganisationDatabase,
  bucket: R2Bucket,
  organisationId: OrganisationId,
): Promise<readonly string[]> {
  const rows = await db
    .prepare(
      "SELECT state_json FROM portal_conversation WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .all<{ state_json: string }>();
  const keys = new Set<string>();
  for (const row of rows.results) {
    const conversation = parseConversation(JSON.parse(row.state_json));
    for (const part of conversationAttachmentParts(conversation)) {
      const attachment = await readChatAttachment(bucket, organisationId, part);
      keys.add(chatAttachmentPointerKey(organisationId, part.attachmentId));
      keys.add(attachment.objectKey);
    }
  }
  return [...keys];
}

export function withChatAttachments(
  command: Variant<ChatCommand, "message" | "next" | "steer">,
  attachments: readonly ChatAttachmentPart[],
): Variant<ChatCommand, "message" | "next" | "steer"> {
  switch (command.kind) {
    case "message":
      return {
        kind: "message",
        conversationId: command.conversationId,
        requestId: command.requestId,
        model: command.model,
        text: command.text,
        browserContext: command.browserContext,
        surfaceContext: command.surfaceContext,
        attachments,
        ...(command.effort === undefined ? {} : { effort: command.effort }),
        ...(command.inputMode === undefined
          ? {}
          : { inputMode: command.inputMode }),
        ...surfaceObservationField(command.surfaceObservation),
      };
    case "next":
      return {
        kind: "next",
        conversationId: command.conversationId,
        requestId: command.requestId,
        inputId: command.inputId,
        model: command.model,
        text: command.text,
        browserContext: command.browserContext,
        surfaceContext: command.surfaceContext,
        attachments,
        ...(command.effort === undefined ? {} : { effort: command.effort }),
        ...(command.inputMode === undefined
          ? {}
          : { inputMode: command.inputMode }),
        ...surfaceObservationField(command.surfaceObservation),
      };
    case "steer":
      return {
        kind: "steer",
        conversationId: command.conversationId,
        requestId: command.requestId,
        inputId: command.inputId,
        cancellationId: command.cancellationId,
        model: command.model,
        text: command.text,
        browserContext: command.browserContext,
        surfaceContext: command.surfaceContext,
        attachments,
        ...(command.effort === undefined ? {} : { effort: command.effort }),
        ...(command.inputMode === undefined
          ? {}
          : { inputMode: command.inputMode }),
        ...surfaceObservationField(command.surfaceObservation),
      };
    default:
      return assertNever(command);
  }
}

function conversationAttachmentParts(
  conversation: import("./conversation").Conversation,
): readonly ChatAttachmentPart[] {
  const parts: ChatAttachmentPart[] = [];
  for (const event of conversation.timeline)
    if (event.kind === "user") parts.push(...attachmentParts(event.parts));
  for (const pending of conversation.pendingInputs)
    parts.push(...attachmentParts(pending.parts));
  return parts;
}

import type { SurfaceKind } from "@purin-labs/contracts";

import type { JsonObject } from "../http";
import {
  parseChannelId,
  parseSlackAppId,
  parseSessionId,
  parseThreadKey,
  parseWorkspaceId,
  type ChannelId,
  type SlackAppId,
  type SessionId,
  type ThreadKey,
  type WorkspaceId,
} from "../ids";
import { readRequiredObject, readRequiredString } from "../queue-fields";
import type { Result } from "../result";
import type { VariantBy } from "@purin-labs/type-utils";
import { isNonEmptyString, isRecord } from "@purin-labs/std";

declare const slackEventIdBrand: unique symbol;
declare const slackUserIdBrand: unique symbol;

export type SlackEventId = string & {
  readonly [slackEventIdBrand]: "SlackEventId";
};
export type SlackUserId = string & {
  readonly [slackUserIdBrand]: "SlackUserId";
};

/**
 * One element of the authored content, in the order Slack wrote it inside the
 * selected representation.
 *
 * Slack exposes `text`, `blocks`, and `files` as separate fields and defines no
 * order across them, so this covers authored text and links only. Files are
 * appended after authored content by the canonicalization rule below.
 */
export type SlackAuthoredPart =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "link";
      readonly url: string;
      readonly label: string | null;
    };

export type SlackHostedFileMetadata = {
  readonly fileId: string;
  readonly displayName: string;
  readonly declaredMediaType: string;
  readonly declaredByteLength: number;
  readonly revision: string;
};

/**
 * A file reference as the message delivered it.
 *
 * `needs_info` keeps a placeholder that only `files.info` can complete — a
 * Slack Connect delivery, or metadata too incomplete to trust — instead of
 * rejecting the whole raw event. `remote_link` is a file Slack does not host;
 * it becomes a link part, never admitted bytes.
 */
export type SlackFileCandidate =
  | { readonly kind: "hosted"; readonly file: SlackHostedFileMetadata }
  | { readonly kind: "needs_info"; readonly fileId: string }
  | {
      readonly kind: "remote_link";
      readonly fileId: string;
      readonly url: string;
      readonly label: string;
    };

export type SlackMessageEvent = {
  surfaceKind: Extract<SurfaceKind, "slack">;
  appId: SlackAppId;
  trigger: SlackMessageTrigger;
  workspaceId: WorkspaceId;
  channelId: ChannelId;
  sessionId: SessionId;
  threadKey: ThreadKey;
  eventId: SlackEventId;
  eventTs: string;
  messageTs: string;
  threadTs: string;
  author: SlackUserId;
  authored: readonly SlackAuthoredPart[];
  files: readonly SlackFileCandidate[];
};

export type SlackMessageTrigger = "mention" | "message" | "edit";

export type SlackEnvelope =
  | { kind: "url_verification"; challenge: string }
  | { kind: "message"; event: SlackMessageEvent }
  | {
      kind: "installation_revoked";
      event: {
        readonly eventId: SlackEventId;
        readonly workspaceId: WorkspaceId;
        readonly appId: SlackAppId;
        readonly occurredAt: number;
        readonly reason: "app_uninstalled" | "bot_token_revoked";
      };
    }
  | { kind: "ignored"; reason: SlackIgnoredReason };

export type SlackIgnoredReason =
  | "unsupported_envelope"
  | "unsupported_event"
  | "message_subtype"
  | "bot_message"
  | "empty_message"
  | "unsupported_message_content";

export type SlackPayloadError =
  | { code: "invalid_json" }
  | { code: "object_required" }
  | { code: "missing_field"; field: string }
  | { code: "invalid_field"; field: string };

type SlackFieldError = VariantBy<SlackPayloadError, "code", "invalid_field">;

const SLACK_SURFACE_KIND = "slack" as const;

/**
 * `file_share` is an allowed subtype on the ordinary message path, not a
 * parallel lifecycle. Every other non-empty subtype stays out of agent
 * admission.
 */
const ADMITTED_MESSAGE_SUBTYPES = new Set(["file_share"]);

export function parseSlackEnvelope(
  rawBody: string,
): Result<SlackEnvelope, SlackPayloadError> {
  const parsed = parseJsonObject(rawBody);

  if (!parsed.ok) {
    return parsed;
  }

  const envelopeType = readRequiredString(parsed.value, "type");

  if (!envelopeType.ok) {
    return envelopeType;
  }

  if (envelopeType.value === "url_verification") {
    return parseUrlVerificationEnvelope(parsed.value);
  }

  if (envelopeType.value !== "event_callback") {
    return {
      ok: true,
      value: { kind: "ignored", reason: "unsupported_envelope" },
    };
  }

  return parseEventCallbackEnvelope(parsed.value);
}

function parseJsonObject(
  rawBody: string,
): Result<JsonObject, SlackPayloadError> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: { code: "invalid_json" } };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: { code: "object_required" } };
  }

  return { ok: true, value: parsed };
}

function parseUrlVerificationEnvelope(
  body: JsonObject,
): Result<SlackEnvelope, SlackPayloadError> {
  const challenge = readRequiredString(body, "challenge");

  if (!challenge.ok) {
    return challenge;
  }

  return {
    ok: true,
    value: { kind: "url_verification", challenge: challenge.value },
  };
}

function parseEventCallbackEnvelope(
  body: JsonObject,
): Result<SlackEnvelope, SlackPayloadError> {
  const eventId = readSlackEventId(body);

  if (!eventId.ok) {
    return eventId;
  }

  const workspaceId = readWorkspaceId(body);

  if (!workspaceId.ok) {
    return workspaceId;
  }

  const appIdRaw = readRequiredString(body, "api_app_id");
  if (!appIdRaw.ok) return appIdRaw;
  const appId = parseSlackAppId(appIdRaw.value);
  if (!appId.ok) {
    return { ok: false, error: { code: "invalid_field", field: "api_app_id" } };
  }

  const event = readRequiredObject(body, "event");

  if (!event.ok) {
    return event;
  }

  const eventType = readRequiredString(event.value, "type");

  if (!eventType.ok) {
    return eventType;
  }

  if (eventType.value === "app_uninstalled") {
    return parseSlackInstallationRevocation(
      body,
      eventId.value,
      workspaceId.value,
      appId.value,
      "app_uninstalled",
    );
  }

  if (
    eventType.value === "tokens_revoked" &&
    slackBotTokenWasRevoked(event.value)
  ) {
    return parseSlackInstallationRevocation(
      body,
      eventId.value,
      workspaceId.value,
      appId.value,
      "bot_token_revoked",
    );
  }

  if (!isSlackMessageEventType(eventType.value)) {
    return {
      ok: true,
      value: { kind: "ignored", reason: "unsupported_event" },
    };
  }

  const subtype = readOptionalStringMember(event.value, "subtype");

  if (subtype === "message_changed") {
    return parseSlackChangedMessageEvent(
      event.value,
      eventId.value,
      workspaceId.value,
      appId.value,
    );
  }

  if (isBotAuthoredSlackMessage(event.value)) {
    return { ok: true, value: { kind: "ignored", reason: "bot_message" } };
  }

  if (subtype !== undefined && !ADMITTED_MESSAGE_SUBTYPES.has(subtype)) {
    return { ok: true, value: { kind: "ignored", reason: "message_subtype" } };
  }

  const trigger = slackMessageTrigger(eventType.value);

  return parseSlackMessageEvent(
    event.value,
    eventId.value,
    workspaceId.value,
    appId.value,
    trigger,
  );
}

function parseSlackInstallationRevocation(
  body: JsonObject,
  eventId: SlackEventId,
  workspaceId: WorkspaceId,
  appId: SlackAppId,
  reason: "app_uninstalled" | "bot_token_revoked",
): Result<SlackEnvelope, SlackPayloadError> {
  const occurredAt = body.event_time;
  if (
    typeof occurredAt !== "number" ||
    !Number.isSafeInteger(occurredAt) ||
    occurredAt < 0
  ) {
    return { ok: false, error: { code: "invalid_field", field: "event_time" } };
  }
  return {
    ok: true,
    value: {
      kind: "installation_revoked",
      event: {
        eventId,
        workspaceId,
        appId,
        occurredAt: occurredAt * 1_000,
        reason,
      },
    },
  };
}

function slackBotTokenWasRevoked(event: JsonObject): boolean {
  const tokens = event.tokens;
  if (!isRecord(tokens) || !Array.isArray(tokens.bot)) return false;
  return tokens.bot.some(isNonEmptyString);
}

function parseSlackChangedMessageEvent(
  event: JsonObject,
  eventId: SlackEventId,
  workspaceId: WorkspaceId,
  appId: SlackAppId,
): Result<SlackEnvelope, SlackPayloadError> {
  const channelId = readChannelId(event);

  if (!channelId.ok) {
    return channelId;
  }

  const message = readRequiredObject(event, "message");

  if (!message.ok) {
    return message;
  }

  if (isBotAuthoredSlackMessage(message.value)) {
    return { ok: true, value: { kind: "ignored", reason: "bot_message" } };
  }

  // Slack puts `event_ts` on the outer change event; the edited message itself
  // carries only its original `ts`.
  const eventTs = readRequiredString(event, "event_ts");

  if (!eventTs.ok) {
    return eventTs;
  }

  return parseSlackMessageEvent(
    message.value,
    eventId,
    workspaceId,
    appId,
    "edit",
    channelId.value,
    eventTs.value,
  );
}

function isBotAuthoredSlackMessage(event: JsonObject): boolean {
  return (
    readOptionalStringMember(event, "bot_id") !== undefined ||
    readOptionalStringMember(event, "app_id") !== undefined
  );
}

function parseSlackMessageEvent(
  event: JsonObject,
  eventId: SlackEventId,
  workspaceId: WorkspaceId,
  appId: SlackAppId,
  trigger: SlackMessageTrigger,
  outerChannelId?: ChannelId,
  outerEventTs?: string,
): Result<SlackEnvelope, SlackPayloadError> {
  const channelId = resolveSlackMessageChannel(event, outerChannelId);

  if (!channelId.ok) {
    return channelId;
  }

  const author = readSlackUserId(event);

  if (!author.ok) {
    return author;
  }

  const messageTs = readRequiredString(event, "ts");

  if (!messageTs.ok) {
    return messageTs;
  }

  const eventTs =
    outerEventTs === undefined
      ? readRequiredString(event, "event_ts")
      : ({ ok: true, value: outerEventTs } as const);

  if (!eventTs.ok) {
    return eventTs;
  }

  const threadTs =
    readOptionalStringMember(event, "thread_ts") ?? messageTs.value;
  const files = parseSlackFileCandidates(event, messageTs.value);

  if (!files.ok) {
    return files;
  }

  const authored = parseSlackAuthoredContent(event);

  if (!authored.ok) {
    return authored;
  }

  if (authored.value.kind === "unsupported") {
    return {
      ok: true,
      value: { kind: "ignored", reason: "unsupported_message_content" },
    };
  }

  // A message must carry something. Text, a link, or a file each suffice; a
  // delivery with none of them has nothing to admit.
  if (authored.value.parts.length === 0 && files.value.length === 0) {
    return { ok: true, value: { kind: "ignored", reason: "empty_message" } };
  }

  const sessionId = deriveSlackSessionId(
    workspaceId,
    channelId.value,
    threadTs,
  );

  if (!sessionId.ok) {
    return sessionId;
  }

  const threadKey = deriveSlackThreadKey(
    workspaceId,
    channelId.value,
    threadTs,
  );

  if (!threadKey.ok) {
    return threadKey;
  }

  return {
    ok: true,
    value: {
      kind: "message",
      event: {
        surfaceKind: SLACK_SURFACE_KIND,
        appId,
        trigger,
        workspaceId,
        channelId: channelId.value,
        sessionId: sessionId.value,
        threadKey: threadKey.value,
        eventId,
        eventTs: eventTs.value,
        messageTs: messageTs.value,
        threadTs,
        author: author.value,
        authored: authored.value.parts,
        files: files.value,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Authored content canonicalization
// ---------------------------------------------------------------------------

type SlackAuthoredContent =
  | { readonly kind: "parsed"; readonly parts: readonly SlackAuthoredPart[] }
  | { readonly kind: "unsupported" };

/**
 * Selects one authored representation and parses it.
 *
 * `rich_text` is what Slack's composer produces, so it wins when every block is
 * supported. Top-level `text` is the fallback and is never concatenated with
 * blocks — it commonly duplicates them. When neither representation can carry
 * the user-visible content, the caller refuses the message rather than
 * admitting a lossy version of it.
 */
function parseSlackAuthoredContent(
  event: JsonObject,
): Result<SlackAuthoredContent, SlackPayloadError> {
  const richText = parseSlackRichTextBlocks(event.blocks);

  if (!richText.ok) {
    return richText;
  }

  if (richText.value.kind === "supported" && richText.value.parts.length > 0) {
    return { ok: true, value: { kind: "parsed", parts: richText.value.parts } };
  }

  const text = readOptionalStringMember(event, "text");

  if (text !== undefined) {
    return {
      ok: true,
      value: { kind: "parsed", parts: parseSlackMrkdwnParts(text) },
    };
  }

  // Blocks existed but could not be represented, and there is no fallback text.
  if (richText.value.kind === "unsupported") {
    return { ok: true, value: { kind: "unsupported" } };
  }

  return { ok: true, value: { kind: "parsed", parts: [] } };
}

type SlackRichTextParse =
  | { readonly kind: "absent" }
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "supported";
      readonly parts: readonly SlackAuthoredPart[];
    };

function parseSlackRichTextBlocks(
  rawBlocks: unknown,
): Result<SlackRichTextParse, SlackPayloadError> {
  if (rawBlocks === undefined || rawBlocks === null) {
    return { ok: true, value: { kind: "absent" } };
  }

  if (!Array.isArray(rawBlocks)) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "event.blocks" },
    };
  }

  if (rawBlocks.length === 0) {
    return { ok: true, value: { kind: "absent" } };
  }

  const collector = new SlackPartCollector();

  for (const rawBlock of rawBlocks) {
    if (!isRecord(rawBlock) || rawBlock.type !== "rich_text") {
      return { ok: true, value: { kind: "unsupported" } };
    }

    const elements = rawBlock.elements;

    if (!Array.isArray(elements)) {
      return { ok: true, value: { kind: "unsupported" } };
    }

    for (const element of elements) {
      if (!appendSlackRichTextContainer(element, collector)) {
        return { ok: true, value: { kind: "unsupported" } };
      }
    }
  }

  return { ok: true, value: { kind: "supported", parts: collector.finish() } };
}

function appendSlackRichTextContainer(
  raw: unknown,
  collector: SlackPartCollector,
): boolean {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return false;
  }

  if (
    raw.type !== "rich_text_section" &&
    raw.type !== "rich_text_list" &&
    raw.type !== "rich_text_quote" &&
    raw.type !== "rich_text_preformatted"
  ) {
    return false;
  }

  const elements = raw.elements;

  if (!Array.isArray(elements)) {
    return false;
  }

  if (raw.type === "rich_text_list") {
    for (const item of elements) {
      if (!appendSlackRichTextContainer(item, collector)) {
        return false;
      }

      collector.appendText("\n");
    }

    return true;
  }

  for (const element of elements) {
    if (!appendSlackRichTextLeaf(element, collector)) {
      return false;
    }
  }

  // Sections, quotes, and code blocks each end a visual line.
  collector.appendText("\n");

  return true;
}

function appendSlackRichTextLeaf(
  raw: unknown,
  collector: SlackPartCollector,
): boolean {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return false;
  }

  switch (raw.type) {
    case "text": {
      if (typeof raw.text !== "string") {
        return false;
      }

      collector.appendText(raw.text);
      return true;
    }
    case "link": {
      if (typeof raw.url !== "string") {
        return false;
      }

      const label =
        typeof raw.text === "string" && raw.text.length > 0 ? raw.text : null;

      collector.appendLink(raw.url, label);
      return true;
    }
    case "emoji": {
      if (typeof raw.name !== "string") {
        return false;
      }

      collector.appendText(`:${raw.name}:`);
      return true;
    }
    case "user": {
      if (typeof raw.user_id !== "string") {
        return false;
      }

      collector.appendText(`<@${raw.user_id}>`);
      return true;
    }
    case "usergroup": {
      if (typeof raw.usergroup_id !== "string") {
        return false;
      }

      collector.appendText(`<!subteam^${raw.usergroup_id}>`);
      return true;
    }
    case "channel": {
      if (typeof raw.channel_id !== "string") {
        return false;
      }

      collector.appendText(`<#${raw.channel_id}>`);
      return true;
    }
    case "broadcast": {
      if (typeof raw.range !== "string") {
        return false;
      }

      collector.appendText(`<!${raw.range}>`);
      return true;
    }
    case "date": {
      const fallback = typeof raw.fallback === "string" ? raw.fallback : null;

      if (fallback === null) {
        return false;
      }

      collector.appendText(fallback);
      return true;
    }
    default:
      // An unrecognized element is user-visible content this parser cannot
      // reproduce. Refusing the representation is what forces the text
      // fallback instead of silently dropping it.
      return false;
  }
}

/**
 * Accumulates ordered parts, merging adjacent text runs so a message never
 * carries two touching text parts.
 */
class SlackPartCollector {
  private readonly parts: SlackAuthoredPart[] = [];
  private pendingText = "";

  appendText(text: string): void {
    this.pendingText += text;
  }

  appendLink(url: string, label: string | null): void {
    this.flushText();
    this.parts.push({ kind: "link", url, label });
  }

  finish(): readonly SlackAuthoredPart[] {
    this.flushText();
    return this.parts;
  }

  private flushText(): void {
    const text = this.pendingText;

    this.pendingText = "";

    if (text.trim().length > 0) {
      this.parts.push({ kind: "text", text: text.trim() });
    }
  }
}

const SLACK_ANGLE_TOKEN = /<([^<>]*)>/gu;

/**
 * Parses Slack's mrkdwn fallback text into ordered parts.
 *
 * Only `<http…>` and `<https…>` tokens become links. Every other angle
 * construct — user, channel, broadcast, mailto — stays literal text, matching
 * what the author sees.
 */
function parseSlackMrkdwnParts(text: string): readonly SlackAuthoredPart[] {
  const collector = new SlackPartCollector();
  let cursor = 0;

  for (const match of text.matchAll(SLACK_ANGLE_TOKEN)) {
    const index = match.index ?? 0;
    const inner = match[1] ?? "";
    const separator = inner.indexOf("|");
    const target = separator === -1 ? inner : inner.slice(0, separator);
    const label = separator === -1 ? null : inner.slice(separator + 1);

    if (!isHttpUrlCandidate(target)) {
      continue;
    }

    collector.appendText(unescapeSlackText(text.slice(cursor, index)));
    collector.appendLink(
      target,
      label !== null && label.length > 0 ? label : null,
    );
    cursor = index + match[0].length;
  }

  collector.appendText(unescapeSlackText(text.slice(cursor)));

  return collector.finish();
}

function isHttpUrlCandidate(value: string): boolean {
  const lowered = value.toLowerCase();

  return lowered.startsWith("http://") || lowered.startsWith("https://");
}

function unescapeSlackText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * Reconstructs plain text from ordered authored parts.
 *
 * Callers that still consume a single text field use this until the canonical
 * `UserMessage` reaches them.
 */
export function slackAuthoredText(parts: readonly SlackAuthoredPart[]): string {
  return parts
    .map((part) =>
      part.kind === "text" ? part.text : (part.label ?? part.url),
    )
    .join(" ")
    .trim();
}

// ---------------------------------------------------------------------------
// File candidates
// ---------------------------------------------------------------------------

function parseSlackFileCandidates(
  event: JsonObject,
  messageTs: string,
): Result<readonly SlackFileCandidate[], SlackPayloadError> {
  const rawFiles = event.files;

  if (rawFiles === undefined) {
    return { ok: true, value: [] };
  }

  if (!Array.isArray(rawFiles)) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "event.files" },
    };
  }

  const files: SlackFileCandidate[] = [];

  for (let index = 0; index < rawFiles.length; index += 1) {
    const parsed = parseSlackFileCandidate(rawFiles[index], messageTs, index);

    if (!parsed.ok) {
      return parsed;
    }

    files.push(parsed.value);
  }

  return { ok: true, value: files };
}

function parseSlackFileCandidate(
  raw: unknown,
  messageTs: string,
  index: number,
): Result<SlackFileCandidate, SlackPayloadError> {
  const field = `event.files.${index}`;

  if (!isRecord(raw)) {
    return { ok: false, error: { code: "invalid_field", field } };
  }

  const fileId = readRequiredString(raw, "id");

  if (!fileId.ok) {
    return { ok: false, error: { code: "invalid_field", field } };
  }

  // A Slack Connect delivery hides everything but the identity until the app
  // calls files.info.
  if (readOptionalStringMember(raw, "file_access") === "check_file_info") {
    return { ok: true, value: { kind: "needs_info", fileId: fileId.value } };
  }

  if (isRemoteSlackFile(raw)) {
    return parseRemoteSlackFile(raw, fileId.value);
  }

  const displayName = readRequiredString(raw, "name");
  const declaredMediaType = readRequiredString(raw, "mimetype");
  const declaredByteLength = raw.size;
  const timestamp = raw.timestamp;

  if (
    timestamp !== undefined &&
    !(
      typeof timestamp === "number" &&
      Number.isSafeInteger(timestamp) &&
      timestamp > 0
    )
  ) {
    return { ok: false, error: { code: "invalid_field", field } };
  }

  // Incomplete metadata is a placeholder, not a malformed event. files.info
  // completes it rather than the whole delivery failing.
  if (
    !displayName.ok ||
    !declaredMediaType.ok ||
    !Number.isSafeInteger(declaredByteLength) ||
    Number(declaredByteLength) <= 0 ||
    Number(declaredByteLength) > 0xffff_ffff
  ) {
    return { ok: true, value: { kind: "needs_info", fileId: fileId.value } };
  }

  return {
    ok: true,
    value: {
      kind: "hosted",
      file: {
        fileId: fileId.value,
        displayName: displayName.value,
        declaredMediaType: declaredMediaType.value,
        declaredByteLength: Number(declaredByteLength),
        revision: timestamp === undefined ? messageTs : String(timestamp),
      },
    },
  };
}

function isRemoteSlackFile(raw: JsonObject): boolean {
  return (
    raw.is_external === true ||
    readOptionalStringMember(raw, "mode") === "external"
  );
}

function parseRemoteSlackFile(
  raw: JsonObject,
  fileId: string,
): Result<SlackFileCandidate, SlackPayloadError> {
  const url =
    readOptionalStringMember(raw, "url_private") ??
    readOptionalStringMember(raw, "permalink");
  const label = readOptionalStringMember(raw, "name") ?? fileId;

  // A remote file Slack cannot address becomes a placeholder rather than a
  // link to nowhere.
  if (url === undefined || !isHttpUrlCandidate(url)) {
    return { ok: true, value: { kind: "needs_info", fileId } };
  }

  return { ok: true, value: { kind: "remote_link", fileId, url, label } };
}

function resolveSlackMessageChannel(
  event: JsonObject,
  outerChannelId: ChannelId | undefined,
): Result<ChannelId, SlackPayloadError> {
  if (outerChannelId !== undefined) {
    return { ok: true, value: outerChannelId };
  }

  return readChannelId(event);
}

function isSlackMessageEventType(value: string): boolean {
  return value === "app_mention" || value === "message";
}

function slackMessageTrigger(eventType: string): SlackMessageTrigger {
  if (eventType === "app_mention") {
    return "mention";
  }

  return "message";
}

export function parseSlackMessageTrigger(
  raw: string,
  field: string,
): Result<SlackMessageTrigger, SlackFieldError> {
  if (raw === "mention" || raw === "message" || raw === "edit") {
    return { ok: true, value: raw };
  }

  return { ok: false, error: { code: "invalid_field", field } };
}

export function parseSlackEventId(
  raw: string,
  field: string,
): Result<SlackEventId, SlackFieldError> {
  const value = raw.trim();

  if (value.length === 0) {
    return { ok: false, error: { code: "invalid_field", field } };
  }

  return { ok: true, value: value as SlackEventId };
}

export function parseSlackUserId(
  raw: string,
  field: string,
): Result<SlackUserId, SlackFieldError> {
  const value = raw.trim();

  if (!/^[A-Z][A-Z0-9]+$/.test(value)) {
    return { ok: false, error: { code: "invalid_field", field } };
  }

  return { ok: true, value: value as SlackUserId };
}

function readSlackEventId(
  body: JsonObject,
): Result<SlackEventId, SlackPayloadError> {
  const raw = readRequiredString(body, "event_id");

  if (!raw.ok) {
    return raw;
  }

  return parseSlackEventId(raw.value, "event_id");
}

function readSlackUserId(
  body: JsonObject,
): Result<SlackUserId, SlackPayloadError> {
  const raw = readRequiredString(body, "user");

  if (!raw.ok) {
    return raw;
  }

  return parseSlackUserId(raw.value, "user");
}

function readWorkspaceId(
  body: JsonObject,
): Result<WorkspaceId, SlackPayloadError> {
  const raw = readRequiredString(body, "team_id");

  if (!raw.ok) {
    return raw;
  }

  const parsed = parseWorkspaceId(raw.value);

  if (!parsed.ok) {
    return { ok: false, error: { code: "invalid_field", field: "team_id" } };
  }

  return parsed;
}

function readChannelId(body: JsonObject): Result<ChannelId, SlackPayloadError> {
  const raw = readRequiredString(body, "channel");

  if (!raw.ok) {
    return raw;
  }

  const parsed = parseChannelId(raw.value);

  if (!parsed.ok) {
    return { ok: false, error: { code: "invalid_field", field: "channel" } };
  }

  return parsed;
}

export function deriveSlackSessionId(
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  threadTs: string,
): Result<SessionId, SlackPayloadError> {
  const normalizedThreadTs = threadTs.replaceAll(".", "_");
  const parsed = parseSessionId(
    `slack_${workspaceId}_${channelId}_${normalizedThreadTs}`,
  );

  if (!parsed.ok) {
    return { ok: false, error: { code: "invalid_field", field: "event.ts" } };
  }

  return parsed;
}

export function deriveSlackThreadKey(
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  threadTs: string,
): Result<ThreadKey, SlackPayloadError> {
  const parsed = parseThreadKey(
    `slack:${workspaceId}:${channelId}:${threadTs}`,
  );

  if (!parsed.ok) {
    return { ok: false, error: { code: "invalid_field", field: "thread_ts" } };
  }

  return parsed;
}

function readOptionalStringMember(
  body: JsonObject,
  field: string,
): string | undefined {
  const value = body[field];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

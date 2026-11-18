import { RequestDeadline } from "../request-deadline";
import type { Result } from "../result";
import { decodeBase64, isRecord } from "@seams/std";
import type {
  MailInboxMessage,
  MailInboxThreadMessage,
} from "@seams/control-api";

/**
 * Stateless trusted Gmail adapter. Every call takes an already resolved
 * access token and an injected fetcher, performs exactly one bounded Gmail
 * API operation, and returns typed metadata. The adapter owns no cursor or
 * lifecycle state, and nothing here persists message content.
 */

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_UPLOAD_BASE =
  "https://gmail.googleapis.com/upload/gmail/v1/users/me";
const GMAIL_API_TIMEOUT_MS = 15_000;
const RESPONSE_LIMIT = 1024 * 1024;
const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 10;
const MAX_MAILBOX_SEARCH_RESULTS = 10;

export type GmailApiError =
  | { readonly code: "gmail_unauthorized" }
  | { readonly code: "gmail_rate_limited"; readonly retryAfterMs: number }
  | { readonly code: "gmail_history_expired" }
  | { readonly code: "gmail_not_found" }
  | { readonly code: "gmail_unavailable"; readonly status: number }
  | { readonly code: "gmail_response_invalid" };

export type GmailProfile = {
  readonly emailAddress: string;
  readonly historyId: string;
};

export type GmailWatch = {
  readonly historyId: string;
  readonly expiration: number;
};

export type GmailHistoryMessage = {
  readonly messageId: string;
  readonly threadId: string;
  readonly historyId: string;
};

/**
 * How a message came into the Inbox in a history read: Gmail delivered it
 * there, or a person moved it there out of Spam with "Not spam".
 */
export type GmailInboxEntry = "delivered" | "rescued_from_spam";

export type GmailInboxAddition = GmailHistoryMessage & {
  readonly entry: GmailInboxEntry;
};

export type GmailHistoryPage = {
  readonly messages: readonly GmailInboxAddition[];
  /**
   * The history id that the read reached. After the last page it is the
   * mailbox's current history id. When the page limit stopped the read, it is
   * the id of the last record read, and the next read starts after it.
   */
  readonly latestHistoryId: string;
  readonly truncated: boolean;
};

export type GmailMessageMetadata = {
  readonly messageId: string;
  readonly threadId: string;
  readonly sizeEstimate: number;
  readonly labelIds: readonly string[];
  readonly internalDate: number;
  /** The From header as Gmail returned it, or null when the message has none. */
  readonly from: string | null;
  /** The Reply-To header as Gmail returned it, or null when it has none. */
  readonly replyTo: string | null;
  /** The Subject header, which names the Case it admits to. */
  readonly subject: string | null;
};

export async function gmailGetProfile(
  input: Readonly<{
    accessToken: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<GmailProfile, GmailApiError>> {
  const raw = await gmailRequest(input, `${GMAIL_BASE}/profile`, {
    method: "GET",
  });
  if (!raw.ok) return raw;
  return typeof raw.value.emailAddress === "string" &&
    historyIdString(raw.value.historyId) !== null
    ? {
        ok: true,
        value: {
          emailAddress: raw.value.emailAddress,
          historyId: requireHistoryId(raw.value.historyId),
        },
      }
    : { ok: false, error: { code: "gmail_response_invalid" } };
}

export async function gmailStartWatch(
  input: Readonly<{
    accessToken: string;
    topicName: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<GmailWatch, GmailApiError>> {
  const raw = await gmailRequest(input, `${GMAIL_BASE}/watch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topicName: input.topicName,
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    }),
  });
  if (!raw.ok) return raw;
  const expiration = expirationMs(raw.value.expiration);
  return historyIdString(raw.value.historyId) !== null && expiration !== null
    ? {
        ok: true,
        value: { historyId: requireHistoryId(raw.value.historyId), expiration },
      }
    : { ok: false, error: { code: "gmail_response_invalid" } };
}

export async function gmailStopWatch(
  input: Readonly<{
    accessToken: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<null, GmailApiError>> {
  const response = await gmailFetch(input, `${GMAIL_BASE}/stop`, {
    method: "POST",
  });
  if (!response.ok) return response;
  return { ok: true, value: null };
}

/** The history types that can bring a message into the Inbox. */
const INBOX_HISTORY_TYPES = [
  "messageAdded",
  "labelAdded",
  "labelRemoved",
] as const;

/**
 * Lists the messages that came into the Inbox after startHistoryId, bounded
 * to MAX_HISTORY_PAGES. A 404 means Gmail expired the cursor; the caller must
 * degrade to a new activation floor rather than guessing at an import.
 *
 * A message comes into the Inbox in two ways. Gmail delivers it there
 * (`messagesAdded`), or a person presses "Not spam" on it. That press is one
 * label change on the message: INBOX added and SPAM removed. Only that pair,
 * on the same message, names a rescue. INBOX added alone is a person moving
 * mail that was never in Spam back to the Inbox (unarchive, "Move to Inbox"),
 * and it names nothing.
 *
 * Gmail writes the label changes of one action into one history record, but
 * the API reference does not promise it. So the pair counts when its two
 * changes come from any records of the same read. A pair that two reads
 * split is missed: the mail is then not answered, and never answered wrongly.
 */
export async function gmailListInboxAdditions(
  input: Readonly<{
    accessToken: string;
    startHistoryId: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<GmailHistoryPage, GmailApiError>> {
  const changes: InboxHistoryChanges = {
    delivered: new Map(),
    inboxAdded: new Map(),
    spamRemoved: new Map(),
  };
  let latestHistoryId = input.startHistoryId;
  // The last record read. A read that the page limit stops ends there.
  let readThrough = input.startHistoryId;
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const url = new URL(`${GMAIL_BASE}/history`);
    url.searchParams.set("startHistoryId", input.startHistoryId);
    for (const historyType of INBOX_HISTORY_TYPES)
      url.searchParams.append("historyTypes", historyType);
    url.searchParams.set("labelId", "INBOX");
    url.searchParams.set("maxResults", String(HISTORY_PAGE_SIZE));
    if (pageToken !== null) url.searchParams.set("pageToken", pageToken);
    const raw = await gmailRequest(input, url.toString(), { method: "GET" });
    if (!raw.ok) {
      return raw.error.code === "gmail_not_found"
        ? { ok: false, error: { code: "gmail_history_expired" } }
        : raw;
    }
    const observed = historyIdString(raw.value.historyId);
    if (observed !== null) latestHistoryId = observed;
    const entries = Array.isArray(raw.value.history) ? raw.value.history : [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const eventHistoryId = historyIdString(entry.id);
      if (eventHistoryId === null) {
        if (hasInboxHistoryChange(entry)) return invalidInboxResponse();
        continue;
      }
      if (compareGmailHistoryIds(eventHistoryId, readThrough) > 0)
        readThrough = eventHistoryId;
      collectInboxHistoryChanges(changes, entry, eventHistoryId);
    }
    pageToken =
      typeof raw.value.nextPageToken === "string" &&
      raw.value.nextPageToken.length > 0
        ? raw.value.nextPageToken
        : null;
    if (pageToken === null) {
      return {
        ok: true,
        value: {
          messages: inboxAdditions(changes),
          latestHistoryId,
          truncated: false,
        },
      };
    }
  }
  return {
    ok: true,
    value: {
      messages: inboxAdditions(changes),
      latestHistoryId: readThrough,
      truncated: true,
    },
  };
}

type InboxHistoryChanges = {
  readonly delivered: Map<string, GmailHistoryMessage>;
  readonly inboxAdded: Map<string, GmailHistoryMessage>;
  /** The record that removed SPAM, by message id. */
  readonly spamRemoved: Map<string, string>;
};

function hasInboxHistoryChange(entry: Record<string, unknown>): boolean {
  return (
    Array.isArray(entry.messagesAdded) ||
    Array.isArray(entry.labelsAdded) ||
    Array.isArray(entry.labelsRemoved)
  );
}

function collectInboxHistoryChanges(
  changes: InboxHistoryChanges,
  entry: Record<string, unknown>,
  historyId: string,
): void {
  const delivered = Array.isArray(entry.messagesAdded)
    ? entry.messagesAdded
    : [];
  for (const added of delivered) {
    const message = isRecord(added) ? historyMessage(added.message) : null;
    if (message !== null)
      changes.delivered.set(message.id, {
        messageId: message.id,
        threadId: message.threadId,
        historyId,
      });
  }
  const labelsAdded = Array.isArray(entry.labelsAdded) ? entry.labelsAdded : [];
  for (const change of labelsAdded) {
    const message = labelChangeMessage(change, "INBOX");
    if (message !== null)
      changes.inboxAdded.set(message.id, {
        messageId: message.id,
        threadId: message.threadId,
        historyId,
      });
  }
  const labelsRemoved = Array.isArray(entry.labelsRemoved)
    ? entry.labelsRemoved
    : [];
  for (const change of labelsRemoved) {
    const message = labelChangeMessage(change, "SPAM");
    if (message !== null) changes.spamRemoved.set(message.id, historyId);
  }
}

/**
 * The delivered messages, then the messages rescued from Spam. A message
 * that Gmail delivered in the same read counts as delivered. A rescue is
 * named by the later of its two records.
 */
function inboxAdditions(
  changes: InboxHistoryChanges,
): readonly GmailInboxAddition[] {
  const additions: GmailInboxAddition[] = [];
  for (const message of changes.delivered.values())
    additions.push({ ...message, entry: "delivered" });
  for (const [messageId, message] of changes.inboxAdded) {
    const spamRemovedAt = changes.spamRemoved.get(messageId);
    if (spamRemovedAt === undefined || changes.delivered.has(messageId))
      continue;
    additions.push({
      ...message,
      historyId:
        compareGmailHistoryIds(spamRemovedAt, message.historyId) > 0
          ? spamRemovedAt
          : message.historyId,
      entry: "rescued_from_spam",
    });
  }
  return additions;
}

/** The message of a label change, when the change names the label. */
function labelChangeMessage(
  change: unknown,
  label: string,
): { readonly id: string; readonly threadId: string } | null {
  if (
    !isRecord(change) ||
    !Array.isArray(change.labelIds) ||
    !change.labelIds.includes(label)
  )
    return null;
  return historyMessage(change.message);
}

function historyMessage(
  value: unknown,
): { readonly id: string; readonly threadId: string } | null {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.threadId === "string"
    ? { id: value.id, threadId: value.threadId }
    : null;
}

export async function gmailReadInboxHistoryPage(
  input: Readonly<{
    accessToken: string;
    startHistoryId: string;
    pageToken: string | null;
    fetcher: typeof fetch;
  }>,
): Promise<
  Result<
    Readonly<{
      messages: readonly GmailHistoryMessage[];
      latestHistoryId: string;
      nextPageToken: string | null;
    }>,
    GmailApiError
  >
> {
  const url = new URL(`${GMAIL_BASE}/history`);
  url.searchParams.set("startHistoryId", input.startHistoryId);
  url.searchParams.set("historyTypes", "messageAdded");
  url.searchParams.set("labelId", "INBOX");
  url.searchParams.set("maxResults", "50");
  if (input.pageToken !== null)
    url.searchParams.set("pageToken", input.pageToken);
  const raw = await gmailRequest(input, url.toString(), { method: "GET" });
  if (!raw.ok)
    return raw.error.code === "gmail_not_found"
      ? { ok: false, error: { code: "gmail_history_expired" } }
      : raw;
  const latestHistoryId = historyIdString(raw.value.historyId);
  const entries = raw.value.history ?? [];
  const nextPageToken = raw.value.nextPageToken ?? null;
  if (
    latestHistoryId === null ||
    !Array.isArray(entries) ||
    entries.length > 50 ||
    (nextPageToken !== null &&
      (typeof nextPageToken !== "string" ||
        nextPageToken.length === 0 ||
        nextPageToken.length > 2048))
  )
    return invalidInboxResponse();
  const messages: GmailHistoryMessage[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) return invalidInboxResponse();
    const eventHistoryId = historyIdString(entry.id);
    if (eventHistoryId === null) return invalidInboxResponse();
    const additions = entry.messagesAdded ?? [];
    if (!Array.isArray(additions)) return invalidInboxResponse();
    for (const added of additions) {
      if (!isRecord(added) || !isGmailMessageReference(added.message))
        return invalidInboxResponse();
      if (!seen.has(added.message.id)) {
        seen.add(added.message.id);
        messages.push({
          messageId: added.message.id,
          threadId: added.message.threadId,
          historyId: eventHistoryId,
        });
      }
    }
  }
  if (messages.length > 50) return invalidInboxResponse();
  return { ok: true, value: { messages, latestHistoryId, nextPageToken } };
}

export async function gmailGetMessageMetadata(
  input: Readonly<{
    accessToken: string;
    messageId: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<GmailMessageMetadata, GmailApiError>> {
  const url = new URL(
    `${GMAIL_BASE}/messages/${encodeURIComponent(input.messageId)}`,
  );
  // Metadata with the headers that say who sent the message, where a reply
  // goes and what it is about. No body or other header is read.
  url.searchParams.set("format", "metadata");
  url.searchParams.append("metadataHeaders", "From");
  url.searchParams.append("metadataHeaders", "Reply-To");
  url.searchParams.append("metadataHeaders", "Subject");
  const raw = await gmailRequest(input, url.toString(), { method: "GET" });
  if (!raw.ok) return raw;
  const headers: readonly unknown[] =
    isRecord(raw.value.payload) && Array.isArray(raw.value.payload.headers)
      ? raw.value.payload.headers
      : [];
  const headerValue = (name: string): string | null => {
    const header = headers.find(
      (candidate) =>
        isRecord(candidate) &&
        typeof candidate.name === "string" &&
        candidate.name.toLowerCase() === name,
    );
    return isRecord(header) && typeof header.value === "string"
      ? header.value
      : null;
  };
  const internalDate =
    typeof raw.value.internalDate === "string"
      ? Number.parseInt(raw.value.internalDate, 10)
      : Number.NaN;
  if (
    typeof raw.value.id !== "string" ||
    typeof raw.value.threadId !== "string" ||
    typeof raw.value.sizeEstimate !== "number" ||
    !Number.isFinite(internalDate)
  ) {
    return { ok: false, error: { code: "gmail_response_invalid" } };
  }
  return {
    ok: true,
    value: {
      messageId: raw.value.id,
      threadId: raw.value.threadId,
      sizeEstimate: raw.value.sizeEstimate,
      labelIds: Array.isArray(raw.value.labelIds)
        ? raw.value.labelIds.filter(
            (label): label is string => typeof label === "string",
          )
        : [],
      internalDate,
      from: headerValue("from"),
      replyTo: headerValue("reply-to"),
      subject: headerValue("subject"),
    },
  };
}

async function gmailRequest(
  input: Readonly<{ accessToken: string; fetcher: typeof fetch }>,
  url: string,
  init: RequestInit,
): Promise<Result<Record<string, unknown>, GmailApiError>> {
  const response = await gmailFetch(input, url, init);
  if (!response.ok) return response;
  try {
    const reader = response.value.body?.getReader();
    if (reader === undefined)
      return { ok: false, error: { code: "gmail_response_invalid" } };
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > RESPONSE_LIMIT)
          return { ok: false, error: { code: "gmail_response_invalid" } };
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const raw: unknown = JSON.parse(text);
    return isRecord(raw)
      ? { ok: true, value: raw }
      : { ok: false, error: { code: "gmail_response_invalid" } };
  } catch {
    return { ok: false, error: { code: "gmail_response_invalid" } };
  }
}

async function gmailFetch(
  input: Readonly<{ accessToken: string; fetcher: typeof fetch }>,
  url: string,
  init: RequestInit,
): Promise<Result<Response, GmailApiError>> {
  // The body is read inside the deadline, which then ends: a pending timer
  // would keep the calling Actor in memory.
  const deadline = new RequestDeadline(GMAIL_API_TIMEOUT_MS);
  let response: Response;
  try {
    const fetched = await input.fetcher.call(
      globalThis,
      new Request(url, {
        ...init,
        signal: deadline.signal,
        headers: {
          ...Object.fromEntries(new Headers(init.headers).entries()),
          authorization: `Bearer ${input.accessToken}`,
        },
      }),
    );
    const body =
      fetched.status === 204 || fetched.status === 304
        ? null
        : await fetched.arrayBuffer();
    response = new Response(body, {
      status: fetched.status,
      statusText: fetched.statusText,
      headers: fetched.headers,
    });
  } catch {
    return { ok: false, error: { code: "gmail_unavailable", status: 503 } };
  } finally {
    deadline.end();
  }
  if (response.ok) return { ok: true, value: response };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: { code: "gmail_unauthorized" } };
  }
  if (response.status === 429) {
    const retryAfter = Number.parseInt(
      response.headers.get("retry-after") ?? "",
      10,
    );
    return {
      ok: false,
      error: {
        code: "gmail_rate_limited",
        retryAfterMs:
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 60_000,
      },
    };
  }
  if (response.status === 404) {
    return { ok: false, error: { code: "gmail_not_found" } };
  }
  return {
    ok: false,
    error: { code: "gmail_unavailable", status: response.status },
  };
}

function historyIdString(value: unknown): string | null {
  return typeof value === "string" && /^[0-9]+$/u.test(value) ? value : null;
}

function requireHistoryId(value: unknown): string {
  const parsed = historyIdString(value);
  if (parsed === null) throw new Error("gmail history id invariant failed");
  return parsed;
}

function expirationMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function compareGmailHistoryIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Exact-message content read for an admitted Case. The decoded plain-text
 * body and attachment inventory exist only in the returned value; callers
 * hold them in turn-scoped memory and never persist them.
 */
export type GmailMessageContent = {
  readonly messageId: string;
  readonly threadId: string;
  readonly headers: GmailMessageHeaders;
  readonly bodyText: string;
  readonly decodedBodyBytes: number;
  readonly attachments: readonly GmailAttachmentRef[];
};

export type GmailMailboxSearchResult = {
  readonly messages: readonly GmailMessageContent[];
  readonly truncated: boolean;
};

/**
 * Searches one connected mailbox and exact-hydrates a small result page.
 * Gmail owns query semantics; Pantry bounds both the query and returned content.
 */
export async function gmailSearchMessages(
  input: Readonly<{
    accessToken: string;
    query: string;
    limit: number;
    fetcher: typeof fetch;
  }>,
): Promise<Result<GmailMailboxSearchResult, GmailApiError>> {
  const query = input.query.trim();
  if (
    query.length === 0 ||
    Array.from(query.normalize("NFKC")).length > 256 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_MAILBOX_SEARCH_RESULTS
  ) {
    return { ok: false, error: { code: "gmail_response_invalid" } };
  }
  const url = new URL(`${GMAIL_BASE}/messages`);
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", String(input.limit));
  const listed = await gmailRequest(input, url.toString(), { method: "GET" });
  if (!listed.ok) return listed;
  const references = Array.isArray(listed.value.messages)
    ? listed.value.messages.filter(isGmailMessageReference)
    : [];
  if (references.length > input.limit) {
    return { ok: false, error: { code: "gmail_response_invalid" } };
  }
  const hydrated = await Promise.all(
    references.map(
      hydrateGmailSearchMessage.bind(null, input.accessToken, input.fetcher),
    ),
  );
  const messages: GmailMessageContent[] = [];
  for (const result of hydrated) {
    if (!result.ok) return result;
    messages.push(result.value);
  }
  return {
    ok: true,
    value: {
      messages,
      truncated:
        typeof listed.value.nextPageToken === "string" &&
        listed.value.nextPageToken.length > 0,
    },
  };
}

/**
 * The Gmail labels that a person browses in the Inbox. The agent reads only
 * INBOX mail; SPAM is listed for the person and never read by the agent.
 */
export type GmailBrowseLabel = "INBOX" | "SPAM";

export async function gmailBrowseInbox(
  input: Readonly<{
    accessToken: string;
    label: GmailBrowseLabel;
    query: string;
    pageToken: string | null;
    fetcher: typeof fetch;
  }>,
): Promise<
  Result<
    Readonly<{
      messages: readonly MailInboxMessage[];
      nextPageToken: string | null;
    }>,
    GmailApiError
  >
> {
  const url = new URL(`${GMAIL_BASE}/messages`);
  url.searchParams.set("labelIds", input.label);
  // Gmail leaves Spam out of a list unless the request asks for it.
  if (input.label === "SPAM") url.searchParams.set("includeSpamTrash", "true");
  url.searchParams.set("maxResults", "20");
  if (input.query.length > 0) url.searchParams.set("q", input.query);
  if (input.pageToken !== null)
    url.searchParams.set("pageToken", input.pageToken);
  const listed = await gmailRequest(input, url.toString(), { method: "GET" });
  if (!listed.ok) return listed;
  const references = listed.value.messages ?? [];
  if (!Array.isArray(references) || references.length > 20)
    return invalidInboxResponse();
  const selected: { messageId: string; threadId: string }[] = [];
  for (const reference of references) {
    if (!isGmailMessageReference(reference)) return invalidInboxResponse();
    selected.push({ messageId: reference.id, threadId: reference.threadId });
  }
  const hydrated = await gmailReadInboxReferences({
    ...input,
    references: selected,
  });
  if (!hydrated.ok) return hydrated;
  const nextPageToken = listed.value.nextPageToken ?? null;
  if (
    nextPageToken !== null &&
    (typeof nextPageToken !== "string" ||
      nextPageToken.length === 0 ||
      nextPageToken.length > 2048)
  )
    return invalidInboxResponse();
  return { ok: true, value: { messages: hydrated.value, nextPageToken } };
}

export async function gmailReadInboxReferences(
  input: Readonly<{
    accessToken: string;
    label: GmailBrowseLabel;
    references: readonly Readonly<{ messageId: string; threadId: string }>[];
    fetcher: typeof fetch;
  }>,
): Promise<Result<readonly MailInboxMessage[], GmailApiError>> {
  if (input.references.length > 20) return invalidInboxResponse();
  // The reads run together: one at a time, a page of 20 took seconds.
  const reads = await Promise.all(
    input.references.map(readInboxReference.bind(null, input)),
  );
  const messages: MailInboxMessage[] = [];
  for (const read of reads) {
    if (!read.ok) return read;
    if (read.value !== null) messages.push(read.value);
  }
  return { ok: true, value: messages };
}

/** One listed message, or null when Gmail no longer holds it under the label. */
async function readInboxReference(
  input: Readonly<{
    accessToken: string;
    label: GmailBrowseLabel;
    fetcher: typeof fetch;
  }>,
  reference: Readonly<{ messageId: string; threadId: string }>,
): Promise<Result<MailInboxMessage | null, GmailApiError>> {
  const url = new URL(
    `${GMAIL_BASE}/messages/${encodeURIComponent(reference.messageId)}`,
  );
  url.searchParams.set("format", "metadata");
  url.searchParams.append("metadataHeaders", "From");
  url.searchParams.append("metadataHeaders", "Subject");
  const raw = await gmailRequest(input, url.toString(), { method: "GET" });
  if (!raw.ok)
    return raw.error.code === "gmail_not_found"
      ? { ok: true, value: null }
      : raw;
  const message = inboxMessage(raw.value);
  if (
    message === null ||
    message.messageId !== reference.messageId ||
    message.threadId !== reference.threadId
  )
    return invalidInboxResponse();
  return {
    ok: true,
    value:
      Array.isArray(raw.value.labelIds) &&
      raw.value.labelIds.includes(input.label)
        ? message
        : null,
  };
}

export async function gmailReadInboxThread(
  input: Readonly<{
    accessToken: string;
    threadId: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<readonly MailInboxThreadMessage[], GmailApiError>> {
  const url = new URL(
    `${GMAIL_BASE}/threads/${encodeURIComponent(input.threadId)}`,
  );
  url.searchParams.set("format", "full");
  const raw = await gmailRequest(input, url.toString(), { method: "GET" });
  if (!raw.ok) return raw;
  if (
    raw.value.id !== input.threadId ||
    !Array.isArray(raw.value.messages) ||
    raw.value.messages.length > 50
  )
    return invalidInboxResponse();
  const messages: MailInboxThreadMessage[] = [];
  for (const item of raw.value.messages) {
    const message = inboxMessage(item);
    if (
      message === null ||
      message.threadId !== input.threadId ||
      !isRecord(item) ||
      !isRecord(item.payload)
    )
      return invalidInboxResponse();
    const attachmentNames: string[] = [];
    for (const attachment of collectAttachments(item.payload))
      attachmentNames.push(attachment.filename);
    messages.push({
      ...message,
      body: extractPlainTextBody(item.payload).text,
      attachmentNames,
    });
  }
  messages.sort(compareInboxMessages);
  return { ok: true, value: messages };
}

/**
 * The headers of the newest message of a thread that the mailbox did not
 * write. Gmail labels the mailbox's own mail SENT and its drafts DRAFT. Null
 * when Gmail holds no such message or no such thread.
 */
export async function gmailReadThreadHeadline(
  input: Readonly<{
    accessToken: string;
    threadId: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<MailInboxMessage | null, GmailApiError>> {
  const url = new URL(
    `${GMAIL_BASE}/threads/${encodeURIComponent(input.threadId)}`,
  );
  url.searchParams.set("format", "metadata");
  url.searchParams.append("metadataHeaders", "From");
  url.searchParams.append("metadataHeaders", "Subject");
  const raw = await gmailRequest(input, url.toString(), { method: "GET" });
  if (!raw.ok)
    return raw.error.code === "gmail_not_found"
      ? { ok: true, value: null }
      : raw;
  if (
    raw.value.id !== input.threadId ||
    !Array.isArray(raw.value.messages) ||
    raw.value.messages.length > 100
  )
    return invalidInboxResponse();
  let newest: MailInboxMessage | null = null;
  for (const item of raw.value.messages) {
    const message = inboxMessage(item);
    if (
      message === null ||
      message.threadId !== input.threadId ||
      !isRecord(item) ||
      !Array.isArray(item.labelIds)
    )
      return invalidInboxResponse();
    if (item.labelIds.includes("SENT") || item.labelIds.includes("DRAFT"))
      continue;
    if (newest === null || compareInboxMessages(newest, message) < 0)
      newest = message;
  }
  return { ok: true, value: newest };
}

function compareInboxMessages(
  left: MailInboxMessage,
  right: MailInboxMessage,
): number {
  return (
    left.receivedAt - right.receivedAt ||
    left.messageId.localeCompare(right.messageId)
  );
}

function inboxMessage(raw: unknown): MailInboxMessage | null {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    raw.id.length === 0 ||
    typeof raw.threadId !== "string" ||
    raw.threadId.length === 0 ||
    !isRecord(raw.payload) ||
    typeof raw.internalDate !== "string" ||
    !Array.isArray(raw.labelIds)
  )
    return null;
  const receivedAt = Number(raw.internalDate);
  if (
    !Number.isSafeInteger(receivedAt) ||
    receivedAt < 0 ||
    receivedAt > 8_640_000_000_000_000
  )
    return null;
  return {
    messageId: raw.id,
    threadId: raw.threadId,
    from: readHeader(raw.payload, "From") ?? "",
    subject: readHeader(raw.payload, "Subject") ?? "",
    receivedAt,
    unread: raw.labelIds.includes("UNREAD"),
  };
}

function invalidInboxResponse(): Result<never, GmailApiError> {
  return { ok: false, error: { code: "gmail_response_invalid" } };
}

function hydrateGmailSearchMessage(
  accessToken: string,
  fetcher: typeof fetch,
  reference: { readonly id: string },
): Promise<Result<GmailMessageContent, GmailApiError>> {
  return gmailGetMessageContent({
    accessToken,
    messageId: reference.id,
    fetcher,
  });
}

function isGmailMessageReference(
  value: unknown,
): value is { readonly id: string; readonly threadId: string } {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.threadId === "string" &&
    value.threadId.length > 0
  );
}

export type GmailMessageHeaders = {
  readonly messageIdHeader: string | null;
  readonly from: string | null;
  readonly replyTo: string | null;
  readonly subject: string;
  readonly references: string | null;
  readonly date: string | null;
};

export type GmailAttachmentRef = {
  readonly attachmentId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly declaredBytes: number;
};

export async function gmailGetMessageContent(
  input: Readonly<{
    accessToken: string;
    messageId: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<GmailMessageContent, GmailApiError>> {
  const url = new URL(
    `${GMAIL_BASE}/messages/${encodeURIComponent(input.messageId)}`,
  );
  url.searchParams.set("format", "full");
  const raw = await gmailRequest(input, url.toString(), { method: "GET" });
  if (!raw.ok) return raw;
  if (
    typeof raw.value.id !== "string" ||
    typeof raw.value.threadId !== "string" ||
    !isRecord(raw.value.payload)
  ) {
    return { ok: false, error: { code: "gmail_response_invalid" } };
  }
  const headers = readMessageHeaders(raw.value.payload);
  const body = extractPlainTextBody(raw.value.payload);
  const attachments = collectAttachments(raw.value.payload);
  return {
    ok: true,
    value: {
      messageId: raw.value.id,
      threadId: raw.value.threadId,
      headers,
      bodyText: body.text,
      decodedBodyBytes: body.decodedBytes,
      attachments,
    },
  };
}

export async function gmailGetAttachment(
  input: Readonly<{
    accessToken: string;
    messageId: string;
    attachmentId: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<{ readonly bytes: Uint8Array }, GmailApiError>> {
  const url =
    `${GMAIL_BASE}/messages/${encodeURIComponent(input.messageId)}` +
    `/attachments/${encodeURIComponent(input.attachmentId)}`;
  const raw = await gmailRequest(input, url, { method: "GET" });
  if (!raw.ok) return raw;
  if (typeof raw.value.data !== "string") {
    return { ok: false, error: { code: "gmail_response_invalid" } };
  }
  const bytes = decodeBase64UrlBytes(raw.value.data);
  return bytes === null
    ? { ok: false, error: { code: "gmail_response_invalid" } }
    : { ok: true, value: { bytes } };
}

export type GmailDraft = {
  readonly draftId: string;
  readonly draftMessageId: string;
  readonly threadId: string;
  readonly headers: GmailMessageHeaders;
  readonly bodyText: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly hasAttachments: boolean;
  readonly mimeTypes: readonly string[];
};

export async function gmailCreateDraft(
  input: Readonly<{
    accessToken: string;
    raw: string;
    threadId: string;
    fetcher: typeof fetch;
  }>,
): Promise<
  Result<
    { readonly draftId: string; readonly draftMessageId: string },
    GmailApiError
  >
> {
  const response = await gmailRequest(input, `${GMAIL_BASE}/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: { raw: input.raw, threadId: input.threadId },
    }),
  });
  if (!response.ok) return response;
  const message = isRecord(response.value.message)
    ? response.value.message
    : null;
  return typeof response.value.id === "string" &&
    message !== null &&
    typeof message.id === "string"
    ? {
        ok: true,
        value: { draftId: response.value.id, draftMessageId: message.id },
      }
    : { ok: false, error: { code: "gmail_response_invalid" } };
}

export async function gmailUpdateDraft(
  input: Readonly<{
    accessToken: string;
    draftId: string;
    raw: string;
    threadId: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<{ readonly draftMessageId: string }, GmailApiError>> {
  const response = await gmailRequest(
    input,
    `${GMAIL_BASE}/drafts/${encodeURIComponent(input.draftId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { raw: input.raw, threadId: input.threadId },
      }),
    },
  );
  if (!response.ok) return response;
  const message = response.value.message;
  return response.value.id === input.draftId &&
    isRecord(message) &&
    typeof message.id === "string"
    ? { ok: true, value: { draftMessageId: message.id } }
    : { ok: false, error: { code: "gmail_response_invalid" } };
}

export async function gmailGetDraft(
  input: Readonly<{
    accessToken: string;
    draftId: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<GmailDraft, GmailApiError>> {
  const url = new URL(
    `${GMAIL_BASE}/drafts/${encodeURIComponent(input.draftId)}`,
  );
  url.searchParams.set("format", "full");
  const raw = await gmailRequest(input, url.toString(), { method: "GET" });
  if (!raw.ok) return raw;
  const message = isRecord(raw.value.message) ? raw.value.message : null;
  if (
    typeof raw.value.id !== "string" ||
    message === null ||
    typeof message.id !== "string" ||
    typeof message.threadId !== "string" ||
    !isRecord(message.payload)
  ) {
    return { ok: false, error: { code: "gmail_response_invalid" } };
  }
  const headers = readMessageHeaders(message.payload);
  const body = extractPlainTextBody(message.payload);
  return {
    ok: true,
    value: {
      draftId: raw.value.id,
      draftMessageId: message.id,
      threadId: message.threadId,
      headers,
      bodyText: body.text,
      to: readAddressHeader(message.payload, "To"),
      cc: readAddressHeader(message.payload, "Cc"),
      bcc: readAddressHeader(message.payload, "Bcc"),
      hasAttachments: collectAttachments(message.payload).length > 0,
      mimeTypes: collectMimeTypes(message.payload),
    },
  };
}

export async function gmailDeleteDraft(
  input: Readonly<{
    accessToken: string;
    draftId: string;
    fetcher: typeof fetch;
  }>,
): Promise<
  Result<{ readonly kind: "deleted" | "already_absent" }, GmailApiError>
> {
  const response = await gmailFetch(
    input,
    `${GMAIL_BASE}/drafts/${encodeURIComponent(input.draftId)}`,
    { method: "DELETE" },
  );
  if (response.ok) return { ok: true, value: { kind: "deleted" } };
  return response.error.code === "gmail_not_found"
    ? { ok: true, value: { kind: "already_absent" } }
    : response;
}

/**
 * Gmail's JSON send takes a few megabytes. A larger message, such as a reply
 * with files, goes to the upload endpoint as the message itself.
 */
const RAW_SEND_LIMIT = 4_000_000;

async function gmailUploadSend(
  input: Readonly<{
    accessToken: string;
    raw: string;
    threadId: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<Record<string, unknown>, GmailApiError>> {
  const message = decodeBase64(
    input.raw.replaceAll("-", "+").replaceAll("_", "/"),
  );
  if (message === null)
    return { ok: false, error: { code: "gmail_response_invalid" } };
  const boundary = `satyr_upload_${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ threadId: input.threadId })}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(
    head.byteLength + message.byteLength + tail.byteLength,
  );
  body.set(head, 0);
  body.set(message, head.byteLength);
  body.set(tail, head.byteLength + message.byteLength);
  return gmailRequest(
    input,
    `${GMAIL_UPLOAD_BASE}/messages/send?uploadType=multipart`,
    {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body,
    },
  );
}

export async function gmailSendRaw(
  input: Readonly<{
    accessToken: string;
    raw: string;
    threadId: string;
    fetcher: typeof fetch;
  }>,
): Promise<
  Result<
    { readonly messageId: string; readonly threadId: string },
    GmailApiError
  >
> {
  const response =
    input.raw.length > RAW_SEND_LIMIT
      ? await gmailUploadSend(input)
      : await gmailRequest(input, `${GMAIL_BASE}/messages/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ raw: input.raw, threadId: input.threadId }),
        });
  if (!response.ok) return response;
  return typeof response.value.id === "string" &&
    typeof response.value.threadId === "string"
    ? {
        ok: true,
        value: {
          messageId: response.value.id,
          threadId: response.value.threadId,
        },
      }
    : { ok: false, error: { code: "gmail_response_invalid" } };
}

/**
 * Send-only Gmail operation. The request intentionally has no thread id and
 * is kept separate from reply delivery so a send-only credential cannot be
 * accidentally widened into a mailbox operation by a caller.
 */
export async function gmailSendRawMessage(
  input: Readonly<{
    accessToken: string;
    raw: string;
    fetcher: typeof fetch;
  }>,
): Promise<
  Result<
    { readonly messageId: string; readonly threadId: string },
    GmailApiError
  >
> {
  const response = await gmailRequest(input, `${GMAIL_BASE}/messages/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw: input.raw }),
  });
  if (!response.ok) return response;
  return typeof response.value.id === "string" &&
    typeof response.value.threadId === "string"
    ? {
        ok: true,
        value: {
          messageId: response.value.id,
          threadId: response.value.threadId,
        },
      }
    : { ok: false, error: { code: "gmail_response_invalid" } };
}

function readMessageHeaders(
  payload: Record<string, unknown>,
): GmailMessageHeaders {
  return {
    messageIdHeader:
      readHeader(payload, "Message-ID") ?? readHeader(payload, "Message-Id"),
    from: readHeader(payload, "From"),
    replyTo: readHeader(payload, "Reply-To"),
    subject: readHeader(payload, "Subject") ?? "",
    references: readHeader(payload, "References"),
    date: readHeader(payload, "Date"),
  };
}

function readHeader(
  payload: Record<string, unknown>,
  name: string,
): string | null {
  if (!Array.isArray(payload.headers)) return null;
  for (const header of payload.headers) {
    if (
      isRecord(header) &&
      typeof header.name === "string" &&
      header.name.toLowerCase() === name.toLowerCase() &&
      typeof header.value === "string"
    ) {
      return header.value;
    }
  }
  return null;
}

function readAddressHeader(
  payload: Record<string, unknown>,
  name: string,
): readonly string[] {
  const value = readHeader(payload, name);
  if (value === null) return [];
  return value
    .split(",")
    .map((entry) => extractMailbox(entry))
    .filter((entry): entry is string => entry !== null);
}

function extractPlainTextBody(payload: Record<string, unknown>): {
  readonly text: string;
  readonly decodedBytes: number;
} {
  const plain = findPart(payload, "text/plain");
  if (plain !== null) {
    const decoded = decodePartText(plain);
    if (decoded !== null) return decoded;
  }
  const html = findPart(payload, "text/html");
  if (html !== null) {
    const decoded = decodePartText(html);
    if (decoded !== null) {
      return {
        text: stripHtml(decoded.text),
        decodedBytes: decoded.decodedBytes,
      };
    }
  }
  return { text: "", decodedBytes: 0 };
}

function findPart(
  payload: Record<string, unknown>,
  mimeType: string,
): Record<string, unknown> | null {
  if (payload.mimeType === mimeType && isRecord(payload.body)) return payload;
  if (!Array.isArray(payload.parts)) return null;
  for (const part of payload.parts) {
    if (!isRecord(part)) continue;
    const found = findPart(part, mimeType);
    if (found !== null) return found;
  }
  return null;
}

function decodePartText(
  part: Record<string, unknown>,
): { readonly text: string; readonly decodedBytes: number } | null {
  if (!isRecord(part.body) || typeof part.body.data !== "string") return null;
  const bytes = decodeBase64UrlBytes(part.body.data);
  if (bytes === null) return null;
  return { text: new TextDecoder().decode(bytes), decodedBytes: bytes.length };
}

function collectAttachments(
  payload: Record<string, unknown>,
): GmailAttachmentRef[] {
  const attachments: GmailAttachmentRef[] = [];
  walkParts(payload, (part) => {
    const body = isRecord(part.body) ? part.body : null;
    if (
      body !== null &&
      typeof body.attachmentId === "string" &&
      typeof part.filename === "string" &&
      part.filename.length > 0
    ) {
      attachments.push({
        attachmentId: body.attachmentId,
        filename: part.filename,
        mimeType:
          typeof part.mimeType === "string"
            ? part.mimeType
            : "application/octet-stream",
        declaredBytes: typeof body.size === "number" ? body.size : 0,
      });
    }
  });
  return attachments;
}

function collectMimeTypes(payload: Record<string, unknown>): string[] {
  const types = new Set<string>();
  walkParts(payload, (part) => {
    if (typeof part.mimeType === "string") types.add(part.mimeType);
  });
  return [...types];
}

function walkParts(
  payload: Record<string, unknown>,
  visit: (part: Record<string, unknown>) => void,
): void {
  visit(payload);
  if (!Array.isArray(payload.parts)) return;
  for (const part of payload.parts) {
    if (isRecord(part)) walkParts(part, visit);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<br\s*\/?>(\r?\n)?/giu, "\n")
    .replace(/<\/p>/giu, "\n\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function extractMailbox(raw: string): string | null {
  const angled = /<([^<>\s]+@[^<>\s]+)>/u.exec(raw);
  if (angled?.[1] !== undefined) return angled[1].toLowerCase();
  const bare = raw.trim();
  return /^[^<>\s]+@[^<>\s]+$/u.test(bare) ? bare.toLowerCase() : null;
}

function decodeBase64UrlBytes(segment: string): Uint8Array | null {
  try {
    const normalized = segment.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Deterministic send reconciliation: finds a message by its exact RFC 5322
 * Message-ID. An ambiguous send result must be reconciled through this
 * lookup before any retry; Pantry never blindly issues a second send.
 */
export async function gmailFindByRfcMessageId(
  input: Readonly<{
    accessToken: string;
    rfcMessageId: string;
    fetcher: typeof fetch;
  }>,
): Promise<
  Result<
    { readonly messageId: string; readonly threadId: string } | null,
    GmailApiError
  >
> {
  const url = new URL(`${GMAIL_BASE}/messages`);
  url.searchParams.set("q", `rfc822msgid:${input.rfcMessageId}`);
  url.searchParams.set("maxResults", "2");
  const raw = await gmailRequest(input, url.toString(), { method: "GET" });
  if (!raw.ok) return raw;
  const messages = Array.isArray(raw.value.messages) ? raw.value.messages : [];
  const first = messages[0];
  if (first === undefined) return { ok: true, value: null };
  if (
    !isRecord(first) ||
    typeof first.id !== "string" ||
    typeof first.threadId !== "string"
  ) {
    return { ok: false, error: { code: "gmail_response_invalid" } };
  }
  return { ok: true, value: { messageId: first.id, threadId: first.threadId } };
}

export async function gmailFindDraftByRfcMessageId(
  input: Readonly<{
    accessToken: string;
    rfcMessageId: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<{ draftId: string } | null, GmailApiError>> {
  const url = new URL(`${GMAIL_BASE}/drafts`);
  url.searchParams.set("q", `rfc822msgid:${input.rfcMessageId}`);
  url.searchParams.set("maxResults", "2");
  const raw = await gmailRequest(input, url.toString(), { method: "GET" });
  if (!raw.ok) return raw;
  if (raw.value.drafts === undefined) return { ok: true, value: null };
  if (
    !Array.isArray(raw.value.drafts) ||
    raw.value.drafts.length > 1 ||
    raw.value.nextPageToken !== undefined
  ) {
    return { ok: false, error: { code: "gmail_response_invalid" } };
  }
  const draft = raw.value.drafts[0];
  if (draft === undefined) return { ok: true, value: null };
  if (!isRecord(draft) || typeof draft.id !== "string" || draft.id.length === 0)
    return { ok: false, error: { code: "gmail_response_invalid" } };
  return { ok: true, value: { draftId: draft.id } };
}

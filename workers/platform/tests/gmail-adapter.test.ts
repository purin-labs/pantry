import { describe, expect, it } from "vitest";

import {
  compareGmailHistoryIds,
  gmailGetMessageMetadata,
  gmailGetProfile,
  gmailListInboxAdditions,
  gmailSearchMessages,
  gmailSendRawMessage,
  gmailStartWatch,
} from "@purin-labs/area-inbox/server/mail/gmail-adapter";

describe("gmail adapter", gmailAdapterSuite);

function gmailAdapterSuite(): void {
  it(
    "reads the profile history floor and starts an INBOX watch",
    profileAndWatchTest,
  );
  it("paginates Inbox additions and reports expired cursors", historyTest);
  it("parses minimal message metadata for limit checks", metadataTest);
  it("searches and exact-hydrates a bounded mailbox page", mailboxSearchTest);
  it(
    "sends one raw message without accepting mailbox operation fields",
    sendTest,
  );
  it("orders numeric history ids of any length", compareTest);
}

async function profileAndWatchTest(): Promise<void> {
  const profile = await gmailGetProfile({
    accessToken: "token-1",
    fetcher: profileFetcher as typeof fetch,
  });
  expect(profile).toEqual({
    ok: true,
    value: { emailAddress: "owner@example.com", historyId: "4200" },
  });

  const watch = await gmailStartWatch({
    accessToken: "token-1",
    topicName: "projects/pantry/topics/gmail",
    fetcher: (async (request: RequestInfo | URL) => {
      const normalized = new Request(request as Request);
      const body = (await normalized.json()) as Record<string, unknown>;
      expect(body).toEqual({
        topicName: "projects/pantry/topics/gmail",
        labelIds: ["INBOX"],
        labelFilterBehavior: "INCLUDE",
      });
      return Response.json({ historyId: "4200", expiration: "1784621125277" });
    }) as typeof fetch,
  });
  expect(watch).toEqual({
    ok: true,
    value: { historyId: "4200", expiration: 1_784_621_125_277 },
  });
}

async function profileFetcher(
  this: unknown,
  request: RequestInfo | URL,
): Promise<Response> {
  expect(this).toBe(globalThis);
  const normalized = new Request(request as Request);
  expect(normalized.headers.get("authorization")).toBe("Bearer token-1");
  expect(normalized.url).toContain("/profile");
  return Response.json({
    emailAddress: "owner@example.com",
    historyId: "4200",
  });
}

async function historyTest(): Promise<void> {
  let calls = 0;
  const paged = await gmailListInboxAdditions({
    accessToken: "token-1",
    startHistoryId: "4200",
    fetcher: (async (request: RequestInfo | URL) => {
      const url = new URL(new Request(request as Request).url);
      expect(url.searchParams.get("startHistoryId")).toBe("4200");
      expect(url.searchParams.get("historyTypes")).toBe("messageAdded");
      expect(url.searchParams.get("labelId")).toBe("INBOX");
      calls += 1;
      if (calls === 1) {
        return Response.json({
          historyId: "4290",
          nextPageToken: "page-2",
          history: [
            {
              id: "4280",
              messagesAdded: [{ message: { id: "m1", threadId: "t1" } }],
            },
            {
              id: "4290",
              messagesAdded: [{ message: { id: "m2", threadId: "t1" } }],
            },
          ],
        });
      }
      expect(url.searchParams.get("pageToken")).toBe("page-2");
      return Response.json({
        historyId: "4300",
        history: [
          {
            id: "4290",
            messagesAdded: [{ message: { id: "m2", threadId: "t1" } }],
          },
          {
            id: "4300",
            messagesAdded: [{ message: { id: "m3", threadId: "t2" } }],
          },
        ],
      });
    }) as typeof fetch,
  });
  expect(paged).toEqual({
    ok: true,
    value: {
      messages: [
        {
          messageId: "m1",
          threadId: "t1",
          historyId: "4280",
          entry: "delivered",
        },
        {
          messageId: "m2",
          threadId: "t1",
          historyId: "4290",
          entry: "delivered",
        },
        {
          messageId: "m3",
          threadId: "t2",
          historyId: "4300",
          entry: "delivered",
        },
      ],
      latestHistoryId: "4300",
      truncated: false,
    },
  });

  const expired = await gmailListInboxAdditions({
    accessToken: "token-1",
    startHistoryId: "10",
    fetcher: (async () =>
      new Response("not found", { status: 404 })) as typeof fetch,
  });
  expect(expired).toEqual({
    ok: false,
    error: { code: "gmail_history_expired" },
  });

  const throttled = await gmailListInboxAdditions({
    accessToken: "token-1",
    startHistoryId: "10",
    fetcher: (async () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "7" },
      })) as typeof fetch,
  });
  expect(throttled).toEqual({
    ok: false,
    error: { code: "gmail_rate_limited", retryAfterMs: 7_000 },
  });
}

async function metadataTest(): Promise<void> {
  const metadata = await gmailGetMessageMetadata({
    accessToken: "token-1",
    messageId: "m1",
    fetcher: (async (request: RequestInfo | URL) => {
      const url = new URL(new Request(request as Request).url);
      expect(url.pathname.endsWith("/messages/m1")).toBe(true);
      expect(url.searchParams.get("format")).toBe("metadata");
      expect(url.searchParams.getAll("metadataHeaders")).toEqual([
        "From",
        "Reply-To",
        "Subject",
      ]);
      return Response.json({
        id: "m1",
        threadId: "t1",
        sizeEstimate: 2048,
        labelIds: ["INBOX", "UNREAD"],
        internalDate: "1784016325000",
        payload: {
          headers: [
            { name: "From", value: "Supplier <s@example.test>" },
            { name: "Reply-To", value: "orders@example.test" },
            { name: "Subject", value: "Tomorrow's order" },
          ],
        },
      });
    }) as typeof fetch,
  });
  expect(metadata).toEqual({
    ok: true,
    value: {
      messageId: "m1",
      threadId: "t1",
      sizeEstimate: 2048,
      labelIds: ["INBOX", "UNREAD"],
      internalDate: 1_784_016_325_000,
      from: "Supplier <s@example.test>",
      replyTo: "orders@example.test",
      subject: "Tomorrow's order",
    },
  });

  const unauthorized = await gmailGetMessageMetadata({
    accessToken: "token-1",
    messageId: "m1",
    fetcher: (async () => new Response("no", { status: 401 })) as typeof fetch,
  });
  expect(unauthorized).toEqual({
    ok: false,
    error: { code: "gmail_unauthorized" },
  });
}

async function sendTest(): Promise<void> {
  let calls = 0;
  const sent = await gmailSendRawMessage({
    accessToken: "token-1",
    raw: "encoded-message",
    fetcher: (async (request: RequestInfo | URL) => {
      calls += 1;
      const normalized = new Request(request as Request);
      const url = new URL(normalized.url);
      expect(url.pathname.endsWith("/messages/send")).toBe(true);
      expect(normalized.method).toBe("POST");
      expect(normalized.headers.get("content-type")).toBe("application/json");
      expect(normalized.headers.get("authorization")).toBe("Bearer token-1");
      expect(await normalized.json()).toEqual({ raw: "encoded-message" });
      return Response.json({ id: "m-send", threadId: "t-send" });
    }) as typeof fetch,
  });
  expect(sent).toEqual({
    ok: true,
    value: { messageId: "m-send", threadId: "t-send" },
  });
  expect(calls).toBe(1);
}

function compareTest(): void {
  expect(compareGmailHistoryIds("99", "100")).toBeLessThan(0);
  expect(compareGmailHistoryIds("100", "100")).toBe(0);
  expect(compareGmailHistoryIds("101", "100")).toBeGreaterThan(0);
  expect(compareGmailHistoryIds("2000", "300")).toBeGreaterThan(0);
}

async function mailboxSearchTest(): Promise<void> {
  const search = await gmailSearchMessages({
    accessToken: "token-1",
    query: "from:supplier@example.com newer_than:30d",
    limit: 2,
    fetcher: (async (request: RequestInfo | URL) => {
      const url = new URL(new Request(request as Request).url);
      if (url.pathname.endsWith("/messages")) {
        expect(url.searchParams.get("q")).toBe(
          "from:supplier@example.com newer_than:30d",
        );
        expect(url.searchParams.get("maxResults")).toBe("2");
        return Response.json({
          messages: [{ id: "m1", threadId: "t1" }],
          nextPageToken: "more",
        });
      }
      expect(url.pathname.endsWith("/messages/m1")).toBe(true);
      expect(url.searchParams.get("format")).toBe("full");
      return Response.json({
        id: "m1",
        threadId: "t1",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Supplier <supplier@example.com>" },
            { name: "Subject", value: "Friday delivery" },
            { name: "Date", value: "Fri, 04 Sep 2026 09:00:00 +0000" },
          ],
          body: { data: btoa("Delivery is confirmed.") },
        },
      });
    }) as typeof fetch,
  });
  expect(search).toEqual({
    ok: true,
    value: {
      messages: [
        {
          messageId: "m1",
          threadId: "t1",
          headers: {
            messageIdHeader: null,
            from: "Supplier <supplier@example.com>",
            replyTo: null,
            subject: "Friday delivery",
            references: null,
            date: "Fri, 04 Sep 2026 09:00:00 +0000",
          },
          bodyText: "Delivery is confirmed.",
          decodedBodyBytes: 22,
          attachments: [],
        },
      ],
      truncated: true,
    },
  });
}

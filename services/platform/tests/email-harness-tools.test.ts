import type { UnitTestEnv } from "./worker-fakes";
import { describe, expect, it, vi } from "vitest";

const accessMocks = vi.hoisted(() => ({
  resolveConnectorGmailAccess: vi.fn(),
}));

vi.mock("../src/actors/connector-email-evaluation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/actors/connector-email-evaluation")
  >()),
  resolveConnectorGmailAccess: accessMocks.resolveConnectorGmailAccess,
}));

import type { AuthorizedHarnessToolResult } from "@purin-labs/contracts";

import {
  createEmailHarnessToolHost,
  type EmailCaseManifest,
} from "../src/actors/email-harness-tools";
import { EmailTurnInformationFlow } from "../src/actors/email-case-context-collection-evidence";

const NOW = 1_784_016_325_277;

describe("purpose-bound email tools", emailHarnessToolSuite);

function emailHarnessToolSuite(): void {
  it("reads only admitted messages and inventories attachments", readCaseTest);
  it("blocks oversized decoded bodies and reports the breach", bodyBreachTest);
  it("enforces attachment manifest, size, and mime rules", attachmentTest);
  it("records exactly one typed Cue outcome", cueOutcomeTest);
  it("refuses everything after the manifest expires", expiryTest);
}

function manifest(
  overrides: Partial<EmailCaseManifest> = {},
): EmailCaseManifest {
  return {
    integrationAccountId: "integration_gmail_tools",
    messageIds: ["m1"],
    maxMessageBytes: 10_000,
    maxAttachmentBytes: 1_000,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

type FakeMessage = {
  readonly bodyText: string;
  readonly attachments: readonly {
    readonly attachmentId: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly size: number;
    readonly data?: string;
  }[];
};

function gmailFetcher(
  messages: Readonly<Record<string, FakeMessage>>,
): typeof fetch {
  return (async (request: RequestInfo | URL) => {
    const url = new URL(new Request(request as Request).url);
    const segments = url.pathname.split("/");
    if (segments.includes("attachments")) {
      const messageId = segments.at(-3) ?? "";
      const attachmentId = segments.at(-1) ?? "";
      const attachment = messages[messageId]?.attachments.find(
        (entry) => entry.attachmentId === attachmentId,
      );
      if (attachment?.data === undefined)
        return new Response("missing", { status: 404 });
      return Response.json({
        data: btoa(attachment.data).replaceAll("+", "-").replaceAll("/", "_"),
      });
    }
    const messageId = segments.at(-1) ?? "";
    const message = messages[messageId];
    if (message === undefined) return new Response("missing", { status: 404 });
    return Response.json({
      id: messageId,
      threadId: "t1",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Customer <customer@sender.example>" },
          { name: "Subject", value: "Order status" },
          { name: "Date", value: "Mon, 24 Aug 2026 10:00:00 +0000" },
          { name: "Message-ID", value: `<${messageId}@sender.example>` },
        ],
        parts: [
          {
            mimeType: "text/plain",
            body: {
              data: btoa(message.bodyText)
                .replaceAll("+", "-")
                .replaceAll("/", "_"),
            },
          },
          ...message.attachments.map((attachment) => ({
            mimeType: attachment.mimeType,
            filename: attachment.filename,
            body: {
              attachmentId: attachment.attachmentId,
              size: attachment.size,
            },
          })),
        ],
      },
    });
  }) as typeof fetch;
}

async function host(
  manifestValue: EmailCaseManifest,
  messages: Readonly<Record<string, FakeMessage>>,
  now: number = NOW,
) {
  accessMocks.resolveConnectorGmailAccess.mockResolvedValue({
    ok: true,
    value: "token",
  });
  const informationFlow = await EmailTurnInformationFlow.create({
    env: {} as UnitTestEnv,
    authority: {
      kind: "agent_mailbox",
      organisationId: "organisation_tools",
      integrationAccountId: "integration_gmail_tools",
      mailboxBindingId: "binding_email_tools",
      bindingRevision: 1,
      mailboxPolicyVersion: 1,
    },
    caseId: "case_email_tools",
    dependency: { kind: "source_only" },
    sessionId: "session_email_tools",
    turnId: "turn_email_tools",
    authorityPartitionDigest: "a".repeat(64),
  });
  if (!informationFlow.ok) throw new Error(informationFlow.error.code);
  return createEmailHarnessToolHost({
    informationFlow: informationFlow.value,
    authority: {
      kind: "agent_mailbox",
      organisationId: "organisation_tools",
      integrationAccountId: "integration_gmail_tools",
      mailboxBindingId: "binding_email_tools",
      bindingRevision: 1,
      mailboxPolicyVersion: 1,
    },
    caseId: "case_email_tools",
    env: {} as UnitTestEnv,
    organisationId: "organisation_tools",
    manifest: manifestValue,
    responsePolicy: "cue_routed",
    now: () => now,
    fetcher: gmailFetcher(messages),
  });
}

function inlineText(result: AuthorizedHarnessToolResult): string {
  if (result.kind !== "read" || result.output.kind !== "inline")
    throw new Error("unexpected result");
  const first = result.output.content[0];
  if (first === undefined || first.kind !== "text")
    throw new Error("unexpected content");
  return first.text;
}

async function readCaseTest(): Promise<void> {
  const tools = await host(manifest({ messageIds: ["m1", "m2"] }), {
    m1: {
      bodyText: "Where is my order?",
      attachments: [
        {
          attachmentId: "a1",
          filename: "invoice.txt",
          mimeType: "text/plain",
          size: 400,
        },
      ],
    },
  });
  const result = await tools.executeTool("read_email_case", "{}", "call-1");
  expect(result.status).toBe("succeeded");
  const text = inlineText(result);
  expect(text).toContain("[message m1]");
  expect(text).toContain("From: Customer <customer@sender.example>");
  expect(text).toContain("Where is my order?");
  expect(text).toContain("invoice.txt (text/plain, 400 bytes, id: a1)");
  expect(text).toContain("[message m2] unavailable: gmail_not_found");
  expect(tools.breaches()).toEqual([]);
}

async function bodyBreachTest(): Promise<void> {
  const tools = await host(manifest({ maxMessageBytes: 8 }), {
    m1: {
      bodyText: "This body is definitely longer than eight bytes.",
      attachments: [],
    },
  });
  const result = await tools.executeTool("read_email_case", "{}", "call-1");
  const text = inlineText(result);
  expect(text).toContain(
    "blocked: decoded body exceeds the published message size limit",
  );
  expect(text).not.toContain("longer than eight bytes");
  expect(tools.breaches()).toEqual([
    {
      kind: "message_too_large",
      providerMessageId: "m1",
      providerAttachmentId: null,
      observedBytes: 48,
      limitBytes: 8,
    },
  ]);
}

async function attachmentTest(): Promise<void> {
  const tools = await host(manifest(), {
    m1: {
      bodyText: "See attached.",
      attachments: [
        {
          attachmentId: "a1",
          filename: "notes.txt",
          mimeType: "text/plain",
          size: 500,
          data: "attached notes",
        },
        {
          attachmentId: "a2",
          filename: "big.txt",
          mimeType: "text/plain",
          size: 5_000,
        },
        {
          attachmentId: "a3",
          filename: "photo.png",
          mimeType: "image/png",
          size: 500,
        },
      ],
    },
  });
  const foreign = await tools.executeTool(
    "read_email_attachment",
    JSON.stringify({ messageId: "m9", attachmentId: "a1" }),
    "call-1",
  );
  expect(foreign.status).toBe("failed");
  expect(inlineText(foreign)).toContain("email_message_not_admitted");

  const oversized = await tools.executeTool(
    "read_email_attachment",
    JSON.stringify({ messageId: "m1", attachmentId: "a2" }),
    "call-2",
  );
  expect(oversized.status).toBe("failed");
  expect(
    tools
      .breaches()
      .some(
        (breach) =>
          breach.kind === "attachment_too_large" &&
          breach.providerAttachmentId === "a2",
      ),
  ).toBe(true);

  const binary = await tools.executeTool(
    "read_email_attachment",
    JSON.stringify({ messageId: "m1", attachmentId: "a3" }),
    "call-3",
  );
  expect(binary.status).toBe("failed");
  expect(inlineText(binary)).toContain("not textual");

  const textual = await tools.executeTool(
    "read_email_attachment",
    JSON.stringify({ messageId: "m1", attachmentId: "a1" }),
    "call-4",
  );
  expect(textual.status).toBe("succeeded");
  expect(inlineText(textual)).toBe("attached notes");
}

async function expiryTest(): Promise<void> {
  const tools = await host(manifest({ expiresAt: NOW - 1 }), {
    m1: { bodyText: "late", attachments: [] },
  });
  const result = await tools.executeTool("read_email_case", "{}", "call-1");
  expect(inlineText(result)).toContain("email_manifest_expired");
}

async function cueOutcomeTest(): Promise<void> {
  const tools = await host(manifest(), {
    m1: { bodyText: "Can you confirm my order status?", attachments: [] },
  });
  expect(tools.outcome()).toEqual({ kind: "none" });
  const premature = await tools.executeTool(
    "email_reply_now",
    JSON.stringify({ body: "Your order is ready for collection." }),
    "call-0",
  );
  expect(premature.status).toBe("failed");
  expect(tools.outcome()).toEqual({ kind: "none" });
  await tools.executeTool("read_email_case", "{}", "call-read");
  const selected = await tools.executeTool(
    "email_reply_now",
    JSON.stringify({ body: "Your order is ready for collection." }),
    "call-1",
  );
  expect(selected.status).toBe("succeeded");
  expect(tools.outcome()).toEqual({
    kind: "reply_now",
    body: "Your order is ready for collection.",
  });
  const duplicate = await tools.executeTool(
    "email_reply_for_approval",
    JSON.stringify({ body: "A different response." }),
    "call-2",
  );
  expect(duplicate.status).toBe("failed");
  expect(tools.outcome()).toEqual({
    kind: "reply_now",
    body: "Your order is ready for collection.",
  });

  const ignored = await host(manifest(), {
    m1: { bodyText: "Automated delivery notification.", attachments: [] },
  });
  await ignored.executeTool("read_email_case", "{}", "call-read-ignore");
  const noReply = await ignored.executeTool("email_no_reply", "{}", "call-3");
  expect(noReply.status).toBe("succeeded");
  expect(ignored.outcome()).toEqual({ kind: "ignore" });
}

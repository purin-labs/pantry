/**
 * ?scenario=drafts: one Slack draft, one operational email draft and one
 * Gmail reply with cited sources in the selected conversation, with stand-in
 * routes for their cards. Send, Edit and Discard change this page's copy
 * only, until a reload.
 */
import type { SlackDraftView } from "@seams/control-api/portal/slack-drafts";
import { sleep } from "@seams/std";

const DIGEST = "a".repeat(64);
const params = new URLSearchParams(window.location.search);
let slackReadFailed = false;
let emailReadFailed = false;

type PreviewSlackDraft = {
  proposalId: string;
  version: number;
  workspaceName: string;
  channelId: string | null;
  channelName: string | null;
  channelHint: string | null;
  body: string;
  bodyDigest: string;
  lifecycle: SlackDraftView["lifecycle"];
  failureCode: string | null;
  failureMessage: string | null;
  messageTs: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

const channels = [
  { channelId: "C0KITCHEN01", name: "kitchen" },
  { channelId: "C0GENERAL01", name: "general" },
  { channelId: "C0SHOPFLOOR", name: "shop-floor" },
];

let slackDraft: PreviewSlackDraft = {
  proposalId: "proposal_slack_message_preview",
  version: 1,
  workspaceName: "Noix de Beurre",
  channelId: "C0KITCHEN01",
  channelName: "kitchen",
  channelHint: "kitchen",
  body: [
    "Morning team, two changes for Friday:",
    "",
    "1. Almond croissants: bake 48 instead of 36. The Ginza shop sold out by 10:00 last week.",
    "2. Butter: the mill moves our delivery to Thursday 15:00. Keep the Wednesday stock for the laminated doughs.",
    "",
    "> Lamination starts at 05:30 as usual. Ask Camille if the walk-in is short on space.",
    "",
    "The gift boxes for the Matsuya order ship on Saturday. Packing starts at 08:00.",
    "",
    "Thank you!",
  ].join("\n"),
  bodyDigest: DIGEST,
  lifecycle: previewSlackState(params.get("slackState")),
  failureCode: null,
  failureMessage: null,
  messageTs: null,
  createdAt: 4,
  updatedAt: 4,
  expiresAt: Date.now() + 86_400_000,
};

let emailLifecycle = previewEmailState(params.get("emailState"));
let emailVersion = 1;
let emailBody = [
  "Bonjour Marie,",
  "",
  "Please move this week's butter delivery from Wednesday to Thursday at 15:00, and add 10 kg to the order.",
  "",
  "Thank you,",
  "Noix de Beurre",
].join("\n");

let replyLifecycle = "awaiting_approval";
let replyVersion = 1;
let replyBody = [
  "Hi Aiko,",
  "",
  "Thank you for your order of 24 hazelnut financiers. Your box leaves our kitchen on Thursday, and gift wrap is free for every order this month.",
  "",
  "Could you confirm the delivery address?",
  "",
  "Noix de Beurre",
].join("\n");
// Sample sources. Each names the words of the reply that it supports; the
// spans are found again in the current text, as the server does after an edit.
const replySources = [
  {
    number: 1,
    record: { kind: "order", orderId: "order_2207" },
    title: "Order #2207",
    detail: "24 × Hazelnut financier, placed Mon 26 Oct.",
    words: [
      "your order of 24 hazelnut financiers",
      "Your box leaves our kitchen on Thursday",
    ],
  },
  {
    number: null,
    record: { kind: "memory", memoryId: "memory_gift_wrap", revision: 2 },
    title: "Preference",
    detail: "Wrap gift boxes in the autumn paper until November.",
    words: [],
  },
];

export function draftsPreviewEnabled(): boolean {
  return (
    new URLSearchParams(window.location.search).get("scenario") === "drafts"
  );
}

export function previewDraftPageData(): Record<string, unknown> {
  return {
    slackDrafts: [slackDraft],
    emailReviews: [
      {
        kind: "gmail_reply",
        proposal_id: "proposal_reply_email_preview",
        integration_account_id: "integration_preview_gmail",
        case_id: "case_preview",
        version: replyVersion,
        lifecycle_kind: replyLifecycle,
        created_at: 5,
        updated_at: 5,
        backing: {
          kind: "gmail_draft",
          gmail_thread_id: "thread_preview_aiko",
        },
      },
      {
        kind: "operational_new_message",
        proposal_id: "proposal_operational_email_preview",
        integration_account_id: "integration_preview_gmail",
        case_id: "case_preview",
        version: emailVersion,
        lifecycle_kind: emailLifecycle,
        created_at: 4,
        updated_at: 4,
        backing: {
          kind: "encrypted_connector",
          target: {
            kind: "supplier_contact",
            supplierId: "supplier_moulin",
            contactId: "contact_marie",
            contactRevision: 1,
          },
          snapshot_digest: DIGEST,
          indeterminate_rfc_message_id:
            emailLifecycle === "send_indeterminate"
              ? "<preview-delivery@noixdebeurre.example>"
              : null,
        },
      },
    ],
  };
}

export async function previewDraftResponse(
  url: URL,
  init: RequestInit | undefined,
): Promise<Response | null> {
  const slack = /\/slack-messages\/[^/]+(?:\/(send|discard|edit))?$/u.exec(
    url.pathname,
  );
  if (slack !== null) {
    await sleep(450);
    if (
      params.get("draftFault") === "slack-read" &&
      slack[1] === undefined &&
      !slackReadFailed
    ) {
      slackReadFailed = true;
      return Response.json(
        { error: "Draft read unavailable" },
        { status: 503 },
      );
    }
    if (params.get("draftFault") === "write" && slack[1] !== undefined)
      return Response.json(
        { error: "Preview changes are unavailable. Try again." },
        { status: 503 },
      );
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const record =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : {};
    switch (slack[1]) {
      case "send":
        slackDraft = {
          ...slackDraft,
          lifecycle: "sent",
          channelId: String(record.channelId),
          channelName:
            channels.find((channel) => channel.channelId === record.channelId)
              ?.name ?? null,
          messageTs: "1760000000.000100",
        };
        break;
      case "discard":
        slackDraft = { ...slackDraft, lifecycle: "rejected" };
        break;
      case "edit":
        slackDraft = {
          ...slackDraft,
          version: slackDraft.version + 1,
          body: String(record.text),
        };
        break;
      default:
        return Response.json({ ok: true, draft: slackDraft, channels });
    }
    return Response.json({ ok: true, draft: slackDraft });
  }
  const reply = /\/email-replies\/[^/]+(?:\/(approve|reject|edit))?$/u.exec(
    url.pathname,
  );
  if (reply !== null) return previewReplyResponse(reply[1], init);
  const email =
    /\/email-operational\/[^/]+(?:\/(approve|reject|edit|attest-present|attest-absent))?$/u.exec(
      url.pathname,
    );
  if (email === null) return null;
  await sleep(450);
  if (
    params.get("draftFault") === "email-read" &&
    email[1] === undefined &&
    !emailReadFailed
  ) {
    emailReadFailed = true;
    return Response.json({ error: "Draft read unavailable" }, { status: 503 });
  }
  if (params.get("draftFault") === "write" && email[1] !== undefined)
    return Response.json(
      { error: "Preview changes are unavailable. Try again." },
      { status: 503 },
    );
  switch (email[1]) {
    case "attest-present":
      emailLifecycle = "operator_attested_present";
      return Response.json({ ok: true });
    case "attest-absent":
      emailLifecycle = "operator_attested_absent";
      return Response.json({ ok: true });
    case "approve":
      emailLifecycle = "sent";
      return Response.json({ ok: true, kind: "sent" });
    case "reject":
      emailLifecycle = "rejected";
      return Response.json({ ok: true, kind: "rejected" });
    case "edit": {
      const body: unknown =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (typeof body === "object" && body !== null && "body" in body)
        emailBody = String(body.body);
      emailVersion += 1;
      return Response.json({ ok: true, kind: "edited" });
    }
    default:
      if (params.get("emailPreview") === "target_changed")
        return Response.json({ ok: true, kind: "target_changed" });
      return Response.json({
        ok: true,
        kind: "current",
        challenge: "preview-challenge",
        proposal: {
          proposal_id: "proposal_operational_email_preview",
          version: emailVersion,
          case_id: "case_preview",
          integration_account_id: "integration_preview_gmail",
          target: {
            kind: "supplier_contact",
            supplierId: "supplier_moulin",
            contactId: "contact_marie",
            contactRevision: 1,
          },
          from: "orders@noixdebeurre.example",
          to: "marie@moulin.example",
          recipient_display_name: "Marie Dubois",
          subject: "Butter delivery for this week",
          body: emailBody,
          target_digest: DIGEST,
          snapshot_digest: DIGEST,
          expires_at: Date.now() + 900_000,
        },
      });
  }
}

async function previewReplyResponse(
  step: string | undefined,
  init: RequestInit | undefined,
): Promise<Response> {
  await sleep(450);
  switch (step) {
    case "approve":
      replyLifecycle = "sent";
      return Response.json({ ok: true, kind: "sent" });
    case "reject":
      replyLifecycle = "rejected";
      return Response.json({ ok: true, kind: "rejected" });
    case "edit": {
      const body: unknown =
        typeof init?.body === "string" ? JSON.parse(init.body) : null;
      if (typeof body === "object" && body !== null && "body" in body)
        replyBody = String(body.body);
      replyVersion += 1;
      return Response.json({ ok: true, kind: "edited" });
    }
    default:
      return Response.json({
        ok: true,
        kind: "current",
        challenge: "preview-challenge",
        proposal: {
          proposal_id: "proposal_reply_email_preview",
          version: replyVersion,
          body_edited: replyVersion > 1,
          to: "aiko.mori@example.test",
          subject: "Re: Hazelnut financiers for Saturday",
          gmail_thread_id: "thread_preview_aiko",
          body: replyBody,
          snapshot_digest: DIGEST,
          expires_at: Date.now() + 900_000,
        },
        memory: [],
        sources: replySources.flatMap((source) => {
          const spans = source.words.flatMap((words) => {
            const start = replyBody.indexOf(words);
            return start < 0 ? [] : [{ start, end: start + words.length }];
          });
          if (source.number !== null && spans.length === 0) return [];
          return [
            {
              number: source.number,
              record: source.record,
              title: source.title,
              detail: source.detail,
              spans,
            },
          ];
        }),
      });
  }
}

function previewSlackState(raw: string | null): SlackDraftView["lifecycle"] {
  switch (raw) {
    case "sending":
    case "sent":
    case "send_failed":
    case "rejected":
    case "expired":
      return raw;
    default:
      return "awaiting_approval";
  }
}

function previewEmailState(raw: string | null): string {
  switch (raw) {
    case "sent":
    case "rejected":
    case "expired":
    case "revoked":
    case "send_indeterminate":
    case "operator_attested_present":
    case "operator_attested_absent":
      return raw;
    default:
      return "awaiting_approval";
  }
}

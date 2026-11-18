import { isPlanQuantity } from "@seams/production-plan-crdt";
import { parseReplyCitations } from "../../mail-inbox/reply-sources";
import { parseIntegrationAccountReference } from "../../access-control/integration-discovery";
import { parseIntegrationAccountId } from "../../ids";
import { parseOperationalEmailTarget } from "../../data/email-operational";
import {
  parseEmailSelfTestRequest,
  validEmailSelfTestContent,
} from "../../data/email-self-test";
import { hasExactKeys, isRecord } from "@seams/std";
import type {
  HarnessEmailMailboxSearch,
  HarnessEmailOperationalPropose,
  HarnessEmailReplyDraftEdit,
  HarnessEmailReplyDraftRead,
  HarnessEmailReplyPropose,
  HarnessProductionPlanEdit,
  HarnessProductionPlanRead,
  HarnessSlackMessagePropose,
  HarnessWhatsAppSupportRead,
  HarnessWhatsAppSupportReplySend,
} from "../catalog/types";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import { defineTool, jsonSchema } from "../define-tool";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const emailMailboxSearch = defineTool({
  name: "email_mailbox_search",
  description:
    "Search and read a bounded page from one connected Gmail mailbox granted to this turn. " +
    "Use Gmail query syntax. Results include exact message and thread ids for follow-up proposals.",
  input: jsonSchema({
    type: "object",
    properties: {
      integrationAccountId: { type: "string", minLength: 1 },
      query: { type: "string", minLength: 1, maxLength: 256 },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["integrationAccountId", "query", "limit"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseEmailMailboxSearchArgs([input]),
  effect: "read",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.emailMailboxRead,
  },
  unavailable: "email mailbox search is unavailable",
  handler:
    ({ searchEmailMailbox }) =>
    (request) =>
      searchEmailMailbox(request),
});

export const emailReplyProposal = defineTool({
  name: "email_reply_propose",
  description:
    "Create a visible Gmail reply draft for human approval. Use exact message and thread ids " +
    "returned by email_mailbox_search. This tool never sends the email. " +
    "In sources, name the records behind the reply's statements for the person who reviews it: " +
    "for each statement that rests on a record read in this chat, give the record's reference and " +
    "the exact words of the body that it supports. An order read with commerce_entity_context is " +
    "order:<order entityId>; accepted memory is listed as memory:<id>. Give at most 12, or null.",
  input: jsonSchema({
    type: "object",
    properties: {
      integrationAccountId: { type: "string", minLength: 1 },
      messageId: { type: "string", minLength: 1, maxLength: 256 },
      threadId: { type: "string", minLength: 1, maxLength: 256 },
      body: { type: "string", minLength: 1, maxLength: 20000 },
      sources: {
        type: ["array", "null"],
        items: {
          type: "object",
          properties: {
            source: { type: "string" },
            text: { type: "string" },
          },
          required: ["source", "text"],
          additionalProperties: false,
        },
      },
    },
    required: [
      "integrationAccountId",
      "messageId",
      "threadId",
      "body",
      "sources",
    ],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseEmailReplyProposeArgs([input]),
  effect: "receipt",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.emailReplyPropose,
  },
  unavailable: "email reply propose is unavailable",
  handler:
    ({ proposeEmailReply }) =>
    (request) =>
      proposeEmailReply(request),
  readReceipt: readEmailProposalReceiptId,
});

export const emailReplyDraftRead = defineTool({
  name: "email_reply_draft_read",
  description:
    "Read the shared draft of one Gmail reply that waits for review, with the Gmail version it was last saved as. " +
    "People may edit the same draft while you work. Use the proposalId of a reply in this mailbox.",
  input: jsonSchema({
    type: "object",
    properties: {
      integrationAccountId: { type: "string", minLength: 1 },
      proposalId: {
        type: "string",
        pattern: "^proposal_[A-Za-z0-9_:.-]{1,500}$",
      },
    },
    required: ["integrationAccountId", "proposalId"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseEmailReplyDraftReadArgs([input]),
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.emailMailboxRead,
  },
  unavailable: "email reply draft read is unavailable",
  handler:
    ({ readEmailReplyDraft }) =>
    (request) =>
      readEmailReplyDraft(request),
});

export const emailReplyDraftEdit = defineTool({
  name: "email_reply_draft_edit",
  description:
    "Replace one exact, unique passage in the shared draft of a Gmail reply. Use the exact text returned by " +
    "email_reply_draft_read; people may change other passages at the same time, and the draft rejects a passage " +
    "that is missing or not unique. The edit is not saved to Gmail and never sends: a person saves and approves the reply.",
  input: jsonSchema({
    type: "object",
    properties: {
      integrationAccountId: { type: "string", minLength: 1 },
      proposalId: {
        type: "string",
        pattern: "^proposal_[A-Za-z0-9_:.-]{1,500}$",
      },
      oldText: { type: "string", maxLength: 20000 },
      newText: { type: "string", maxLength: 20000 },
    },
    required: ["integrationAccountId", "proposalId", "oldText", "newText"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseEmailReplyDraftEditArgs([input]),
  effect: "draft",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.emailReplyPropose,
  },
  unavailable: "email reply draft edit is unavailable",
  handler:
    ({ editEmailReplyDraft }) =>
    (request, call) =>
      editEmailReplyDraft(request, call.operationId, call.execution),
});

export const productionPlanRead = defineTool({
  name: "production_plan_read",
  description:
    "Read one location's shared production plan: each production request that waits for acceptance, its requested quantity, " +
    "and the planned quantity in the shared plan. People may edit the plan while you work.",
  input: jsonSchema({
    type: "object",
    properties: {
      locationId: { type: "string", pattern: "^[A-Za-z0-9_:.-]{1,200}$" },
    },
    required: ["locationId"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseProductionPlanReadArgs([input]),
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceProductionPlanEdit,
  },
  unavailable: "production plan read is unavailable",
  handler:
    ({ readProductionPlan }) =>
    (request) =>
      readProductionPlan(request),
});

export const productionPlanEdit = defineTool({
  name: "production_plan_edit",
  description:
    "Set the planned quantity of one production request in a location's shared plan. Use a requestId from production_plan_read. " +
    "The quantity is a positive decimal in the request's unit; pieces take whole numbers. " +
    "This changes the shared draft only: a person reviews the plan and accepts it.",
  input: jsonSchema({
    type: "object",
    properties: {
      locationId: { type: "string", pattern: "^[A-Za-z0-9_:.-]{1,200}$" },
      requestId: { type: "string", pattern: "^[A-Za-z0-9_:.-]{1,200}$" },
      quantity: {
        type: "string",
        pattern: "^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,6})?$",
      },
    },
    required: ["locationId", "requestId", "quantity"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseProductionPlanEditArgs([input]),
  effect: "draft",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceProductionPlanEdit,
  },
  unavailable: "production plan edit is unavailable",
  handler:
    ({ editProductionPlan }) =>
    (request, call) =>
      editProductionPlan(request, call.operationId, call.execution),
});

export const emailOperationalProposal = defineTool({
  name: "email_operational_propose",
  description:
    "Prepare one plain-text operational email for human approval using the exact Gmail accountRef returned by integration_list. Use an existing Customer or Supplier contact identity and revision from authorized context. A raw address alone is ineligible: ask for an existing contact or explain that it must be registered through the contact workflow. Never invent relationships, contact IDs, revisions or verification. " +
    "For an explicitly requested self-test to the user's own address, use target {kind: 'self_test', address: '...'}, subject 'Satyr Gmail canary' and body \"This is a synthetic test of Satyr's email drafting and approval workflow. No action is required.\". It creates a temporary test recipient; ownership confirmation and approval remain pending. Never claim ownership was independently verified. " +
    "The platform resolves sender and recipient and never sends through this tool. Tell the user to review the conversation's email approval card. Custom connector creation, direct Gmail API calls, mailbox search and inbox activation cannot replace this workflow.",
  input: jsonSchema({
    type: "object",
    properties: {
      accountRef: {
        type: "string",
        pattern: "^integration_ref_[0-9a-f]{64}$",
      },
      target: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["customer_contact", "supplier_contact"],
              },
              customerId: { type: ["string", "null"] },
              supplierId: { type: ["string", "null"] },
              contactId: { type: "string", minLength: 1 },
              contactRevision: { type: "integer", minimum: 1 },
            },
            required: [
              "kind",
              "customerId",
              "supplierId",
              "contactId",
              "contactRevision",
            ],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["self_test"] },
              address: { type: "string", minLength: 3, maxLength: 320 },
            },
            required: ["kind", "address"],
            additionalProperties: false,
          },
        ],
      },
      subject: { type: "string", minLength: 1, maxLength: 998 },
      body: { type: "string", minLength: 1, maxLength: 20000 },
    },
    required: ["accountRef", "target", "subject", "body"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseEmailOperationalProposeArgs([input]),
  effect: "receipt",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.emailOperationalPropose,
  },
  unavailable: "email operational propose is unavailable",
  handler:
    ({ proposeEmailOperational }) =>
    (request) =>
      proposeEmailOperational(request),
  readReceipt: readEmailOperationalProposalReceiptId,
});

export const slackMessageProposal = defineTool({
  name: "slack_message_propose",
  description:
    "Draft one plain-text Slack message for a person to send, using the exact Slack accountRef returned by integration_list. " +
    "Set channel to a connected channel's name (such as 'general') or ID when the user named one; otherwise set null and the person chooses on the card. " +
    "If the user did not say where the message goes, ask them first. The platform never posts through this tool: the conversation shows the draft on a card, where a person can edit it, send it or discard it. " +
    "After you call it, tell the user that the draft is ready on the card and do not repeat the whole text.",
  input: jsonSchema({
    type: "object",
    properties: {
      accountRef: {
        type: "string",
        pattern: "^integration_ref_[0-9a-f]{64}$",
      },
      channel: { type: ["string", "null"], maxLength: 200 },
      text: { type: "string", minLength: 1, maxLength: 8000 },
    },
    required: ["accountRef", "channel", "text"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseSlackMessageProposeArgs([input]),
  effect: "receipt",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.slackMessagePropose,
  },
  unavailable: "slack message propose is unavailable",
  handler:
    ({ proposeSlackMessage }) =>
    (request) =>
      proposeSlackMessage(request),
  readReceipt: readSlackMessageProposalReceiptId,
});

export const whatsAppSupportRead = defineTool({
  name: "whatsapp_support_read",
  description:
    "Read the newest active WhatsApp support Cases from phone-number accounts granted to this turn. " +
    "Content is limited to each Case's temporary 24-hour envelope. An empty result means there are " +
    "no currently active retained Cases and says nothing about older WhatsApp history.",
  input: jsonSchema({
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["limit"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseWhatsAppSupportReadArgs([input]),
  effect: "read",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.whatsappSupportRead,
  },
  unavailable: "whatsapp support read is unavailable",
  handler:
    ({ readWhatsAppSupport }) =>
    (request) =>
      readWhatsAppSupport(request),
});

export const whatsAppSupportReplySend = defineTool({
  name: "whatsapp_support_reply_send",
  description:
    "Send one reply to an active WhatsApp support Case. The Case determines the recipient. " +
    "The body must appear verbatim in the current Slack request, so ask the requester for exact text when needed.",
  input: jsonSchema({
    type: "object",
    properties: {
      caseId: { type: "string", minLength: 1 },
      body: { type: "string", minLength: 1, maxLength: 4000 },
    },
    required: ["caseId", "body"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseWhatsAppSupportReplySendArgs([input]),
  effect: "receipt",
  rerun: { kind: "none" },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.whatsappSupportReplySend,
  },
  unavailable: "whatsapp support reply send is unavailable",
  handler:
    ({ sendWhatsAppSupportReply }) =>
    (request) =>
      sendWhatsAppSupportReply(request),
  readReceipt: readWhatsAppReceiptId,
});

function parseEmailMailboxSearchArgs(
  args: readonly unknown[],
): HarnessEmailMailboxSearch {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["integrationAccountId", "query", "limit"]) ||
    typeof args[0].integrationAccountId !== "string" ||
    typeof args[0].query !== "string" ||
    args[0].query.trim().length === 0 ||
    Array.from(args[0].query.normalize("NFKC")).length > 256 ||
    typeof args[0].limit !== "number" ||
    !Number.isSafeInteger(args[0].limit) ||
    args[0].limit < 1 ||
    args[0].limit > 10
  ) {
    throw new TypeError("email_mailbox_search arguments are invalid");
  }
  const integrationAccountId = parseIntegrationAccountId(
    args[0].integrationAccountId,
  );
  if (!integrationAccountId.ok) {
    throw new TypeError("email_mailbox_search account is invalid");
  }
  return {
    integrationAccountId: integrationAccountId.value,
    query: args[0].query.trim(),
    limit: args[0].limit,
  };
}

function parseEmailReplyProposeArgs(
  args: readonly unknown[],
): HarnessEmailReplyPropose {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], [
      "integrationAccountId",
      "messageId",
      "threadId",
      "body",
      "sources",
    ]) ||
    typeof args[0].integrationAccountId !== "string" ||
    typeof args[0].messageId !== "string" ||
    args[0].messageId.length === 0 ||
    args[0].messageId.length > 256 ||
    typeof args[0].threadId !== "string" ||
    args[0].threadId.length === 0 ||
    args[0].threadId.length > 256 ||
    typeof args[0].body !== "string" ||
    args[0].body.trim().length === 0 ||
    Array.from(args[0].body).length > 20_000
  ) {
    throw new TypeError("email_reply_propose arguments are invalid");
  }
  const integrationAccountId = parseIntegrationAccountId(
    args[0].integrationAccountId,
  );
  if (!integrationAccountId.ok) {
    throw new TypeError("email_reply_propose account is invalid");
  }
  // A malformed citation is dropped and counted, as for a mailbox draft.
  const cited = parseReplyCitations(args[0].sources);
  return {
    integrationAccountId: integrationAccountId.value,
    messageId: args[0].messageId,
    threadId: args[0].threadId,
    body: args[0].body.trim(),
    citations: cited.citations,
    malformedCitations: cited.malformed,
  };
}

const PLAN_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,200}$/u;

function parseProductionPlanReadArgs(
  args: readonly unknown[],
): HarnessProductionPlanRead {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["locationId"]) ||
    typeof args[0].locationId !== "string" ||
    !PLAN_ID_PATTERN.test(args[0].locationId)
  ) {
    throw new TypeError("production_plan_read arguments are invalid");
  }
  return { locationId: args[0].locationId };
}

function parseProductionPlanEditArgs(
  args: readonly unknown[],
): HarnessProductionPlanEdit {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["locationId", "requestId", "quantity"]) ||
    typeof args[0].locationId !== "string" ||
    !PLAN_ID_PATTERN.test(args[0].locationId) ||
    typeof args[0].requestId !== "string" ||
    !PLAN_ID_PATTERN.test(args[0].requestId) ||
    !isPlanQuantity(args[0].quantity)
  ) {
    throw new TypeError("production_plan_edit arguments are invalid");
  }
  return {
    locationId: args[0].locationId,
    requestId: args[0].requestId,
    quantity: args[0].quantity,
  };
}

function parseEmailReplyDraftReadArgs(
  args: readonly unknown[],
): HarnessEmailReplyDraftRead {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["integrationAccountId", "proposalId"]) ||
    typeof args[0].integrationAccountId !== "string" ||
    typeof args[0].proposalId !== "string" ||
    !EMAIL_REPLY_PROPOSAL_PATTERN.test(args[0].proposalId)
  ) {
    throw new TypeError("email_reply_draft_read arguments are invalid");
  }
  const integrationAccountId = parseIntegrationAccountId(
    args[0].integrationAccountId,
  );
  if (!integrationAccountId.ok) {
    throw new TypeError("email_reply_draft_read account is invalid");
  }
  return {
    integrationAccountId: integrationAccountId.value,
    proposalId: args[0].proposalId,
  };
}

function parseEmailReplyDraftEditArgs(
  args: readonly unknown[],
): HarnessEmailReplyDraftEdit {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], [
      "integrationAccountId",
      "proposalId",
      "oldText",
      "newText",
    ]) ||
    typeof args[0].oldText !== "string" ||
    args[0].oldText.length > 20_000 ||
    typeof args[0].newText !== "string" ||
    args[0].newText.length > 20_000
  ) {
    throw new TypeError("email_reply_draft_edit arguments are invalid");
  }
  const target = parseEmailReplyDraftReadArgs([
    {
      integrationAccountId: args[0].integrationAccountId,
      proposalId: args[0].proposalId,
    },
  ]);
  return { ...target, oldText: args[0].oldText, newText: args[0].newText };
}

const EMAIL_REPLY_PROPOSAL_PATTERN = /^proposal_[A-Za-z0-9_:.-]{1,500}$/u;

function parseEmailOperationalProposeArgs(
  args: readonly unknown[],
): HarnessEmailOperationalPropose {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["accountRef", "target", "subject", "body"]) ||
    typeof args[0].subject !== "string" ||
    args[0].subject.trim().length === 0 ||
    args[0].subject.length > 998 ||
    typeof args[0].body !== "string" ||
    args[0].body.trim().length === 0 ||
    args[0].body.length > 20_000 ||
    !isRecord(args[0].target)
  ) {
    throw new TypeError("email_operational_propose arguments are invalid");
  }
  const accountRef = parseIntegrationAccountReference(args[0].accountRef);
  if (accountRef === null) {
    throw new TypeError("email_operational_propose account is invalid");
  }
  const target =
    parseOperationalEmailTarget(args[0].target) ??
    parseEmailSelfTestRequest(args[0].target);
  if (target === null) {
    throw new TypeError("email_operational_propose target is invalid");
  }
  if (
    !validEmailSelfTestContent(
      target,
      args[0].subject.trim(),
      args[0].body.trim(),
    )
  ) {
    throw new TypeError(
      "Self-test email requires the fixed synthetic subject and body",
    );
  }
  return {
    accountRef,
    target,
    subject: args[0].subject.trim(),
    body: args[0].body.trim(),
  };
}

function parseSlackMessageProposeArgs(
  args: readonly unknown[],
): HarnessSlackMessagePropose {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["accountRef", "channel", "text"]) ||
    typeof args[0].text !== "string" ||
    args[0].text.trim().length === 0 ||
    args[0].text.length > 8000 ||
    (args[0].channel !== null &&
      (typeof args[0].channel !== "string" || args[0].channel.length > 200))
  ) {
    throw new TypeError("slack_message_propose arguments are invalid");
  }
  const accountRef = parseIntegrationAccountReference(args[0].accountRef);
  if (accountRef === null) {
    throw new TypeError("slack_message_propose account is invalid");
  }
  const channel =
    args[0].channel === null ? "" : args[0].channel.trim().replace(/^#/u, "");
  return {
    accountRef,
    channel: channel.length === 0 ? null : channel,
    text: args[0].text.trim(),
  };
}

function parseWhatsAppSupportReadArgs(
  args: readonly unknown[],
): HarnessWhatsAppSupportRead {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["limit"]) ||
    typeof args[0].limit !== "number" ||
    !Number.isSafeInteger(args[0].limit) ||
    args[0].limit < 1 ||
    args[0].limit > 20
  ) {
    throw new TypeError("whatsapp_support_read arguments are invalid");
  }
  return { limit: args[0].limit };
}

function parseWhatsAppSupportReplySendArgs(
  args: readonly unknown[],
): HarnessWhatsAppSupportReplySend {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    !hasExactKeys(args[0], ["caseId", "body"]) ||
    typeof args[0].caseId !== "string" ||
    args[0].caseId.length === 0 ||
    typeof args[0].body !== "string" ||
    args[0].body.trim().length === 0 ||
    Array.from(args[0].body).length > 4000
  ) {
    throw new TypeError("whatsapp_support_reply_send arguments are invalid");
  }
  return { caseId: args[0].caseId, body: args[0].body.trim() };
}

function readWhatsAppReceiptId(value: unknown): string {
  if (
    !isRecord(value) ||
    value.kind !== "sent" ||
    typeof value.receiptId !== "string" ||
    value.receiptId.length === 0
  ) {
    throw new TypeError("WhatsApp support reply receipt is invalid");
  }
  return value.receiptId;
}

function readEmailProposalReceiptId(value: unknown): string {
  if (
    !isRecord(value) ||
    value.kind !== "proposed" ||
    typeof value.proposalId !== "string" ||
    value.proposalId.length === 0 ||
    typeof value.providerDraftId !== "string" ||
    value.providerDraftId.length === 0
  ) {
    throw new TypeError("Email reply proposal receipt is invalid");
  }
  return value.proposalId;
}

function readEmailOperationalProposalReceiptId(value: unknown): string {
  if (
    !isRecord(value) ||
    value.kind !== "proposed" ||
    typeof value.proposalId !== "string" ||
    value.proposalId.length === 0 ||
    typeof value.snapshotDigest !== "string" ||
    !SHA256_PATTERN.test(value.snapshotDigest)
  ) {
    throw new TypeError("Operational email proposal receipt is invalid");
  }
  return value.proposalId;
}

function readSlackMessageProposalReceiptId(value: unknown): string {
  if (
    !isRecord(value) ||
    value.kind !== "proposed" ||
    typeof value.proposalId !== "string" ||
    value.proposalId.length === 0
  ) {
    throw new TypeError("Slack message proposal receipt is invalid");
  }
  return value.proposalId;
}

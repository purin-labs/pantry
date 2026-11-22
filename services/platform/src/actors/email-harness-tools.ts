import { GMAIL_MAILBOX } from "@purin-labs/connections/mail/gmail-mail-adapter";
import type {
  AuthorizedHarnessToolResult,
  HarnessToolOutput,
  RequestAuthority,
} from "@purin-labs/contracts";

import type { Env } from "@purin-labs/kernel/env";
import {
  EmailTurnInformationFlow,
  validateCaseContextCollectionEmailMessage,
} from "./email-case-context-collection-evidence";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { SerializedFlowBinding } from "@purin-labs/authority/policy/information-flow/index";
import type {
  GmailAttachmentRef,
  GmailMessageContent,
} from "@purin-labs/connections/mail/gmail-adapter";
import type { Result } from "@purin-labs/kernel/result";
import { digestCanonical } from "@purin-labs/authority/policy/index";
import { resolveConnectorGmailAccess } from "./connector-email-evaluation";
import type { HarnessToolHost } from "./embedded-harness";
import {
  type CatalogToolAuthority,
  executeCatalogTool,
} from "../agent-tools/catalog/execute";
import { createToolRegistry } from "../agent-tools/catalog/tool-registry";
import type { HarnessCapabilityClaim } from "../agent-tools/catalog/types";
import {
  mailboxAttachmentRead,
  mailboxCaseRead,
  mailboxEvidenceRead,
  mailboxMemoryPropose,
  mailboxNoMemory,
  mailboxNoReply,
  mailboxOrderRead,
  mailboxReplyForApproval,
  mailboxReplyNow,
  mailboxReviewDraftSave,
  mailboxSupplierContextRead,
  type MailboxAgentToolServices,
} from "../agent-tools/channels/mailbox-agent";
import {
  modelToolDefinition,
  type AnyRegisteredTool,
} from "../agent-tools/define-tool";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, isRecord } from "@purin-labs/std";
import {
  EmailSupplierContext,
  validateEmailCommerceEvidence,
  type EmailCommerceEvidence,
} from "../mail-inbox/supplier-context";
import { EmailOrderContext } from "../mail-inbox/order-context";
import {
  parseReplyCitations,
  replySourceReference,
  type EmailReplyCitation,
  type EmailReplySourceRecord,
} from "../mail-inbox/reply-sources";

/**
 * Purpose-bound email tools for one admitted Case. The manifest lists the
 * exact Gmail message identifiers this Case may read; anything else is
 * rejected without a provider call. Content is fetched just in time from
 * Gmail, held only in the tool result, and size limits are enforced against
 * exact decoded bytes before any content reaches the agent. There is no
 * inbox list, search, draft, or send tool here.
 */

export type EmailCaseManifest = {
  readonly integrationAccountId: string;
  readonly messageIds: readonly string[];
  readonly maxMessageBytes: number;
  readonly maxAttachmentBytes: number;
  readonly expiresAt: number;
};

/** One admitted message as a fixture supplies it, by its manifest identity. */
type EmailCaseFixture = (
  messageId: string,
) => Promise<Result<GmailMessageContent, { readonly code: string }>>;

export type EmailSizeBreach = {
  readonly kind:
    "message_too_large" | "attachment_too_large" | "attachment_total_too_large";
  readonly providerMessageId: string;
  readonly providerAttachmentId: string | null;
  readonly observedBytes: number;
  readonly limitBytes: number;
};

type EmailHarnessToolHost = HarnessToolHost & {
  breaches(): readonly EmailSizeBreach[];
  outcome(): EmailCueOutcome;
  commerceEvidence(): readonly EmailCommerceEvidence[];
  /**
   * The commerce records that this turn's tools read, by the reference the
   * model cites them with. Only a successful read adds one.
   */
  recordReads(): ReadonlyMap<string, EmailReplySourceRecord>;
  flowBinding(): SerializedFlowBinding;
};

export type EmailCueOutcome =
  | { readonly kind: "reply_now"; readonly body: string }
  | {
      readonly kind: "approval_required";
      readonly body: string;
      /** What the model claims supports the body. Nothing here is verified. */
      readonly citations: readonly EmailReplyCitation[];
      readonly malformedCitations: number;
    }
  /**
   * One reusable fact the agent proposes to remember, and when it wrote one,
   * a short message that tests the fact. A person decides both.
   */
  | {
      readonly kind: "memory_candidate";
      readonly statement: string;
      readonly check: EmailLearningCheck | null;
    }
  | { readonly kind: "ignore" }
  | { readonly kind: "none" };

/**
 * What a mailbox turn may conclude with. A `correction_learning` turn drafts
 * and sends nothing: it may only propose one Memory candidate or decline.
 */
export type EmailResponsePolicy =
  "cue_routed" | "draft_only" | "correction_learning";

const MAX_MEMORY_CANDIDATE_CHARS = 600;

/**
 * A message the agent wrote, in its own words, that the sender could send
 * later and that the learned fact changes the right answer to. It becomes
 * the first scenario of a candidate Eval.
 */
type EmailLearningCheck = Readonly<{ subject: string; body: string }>;

const MAX_CHECK_SUBJECT_CHARS = 200;
const MAX_CHECK_BODY_CHARS = 2_000;

const TEXTUAL_MIME_PREFIXES = ["text/"];
const TEXTUAL_MIME_TYPES = new Set(["application/json", "application/xml"]);
export async function createEmailHarnessToolHost(
  input: Readonly<{
    env: Env;
    organisationId: string;
    manifest: EmailCaseManifest;
    responsePolicy: EmailResponsePolicy;
    authority: Variant<RequestAuthority, "agent_mailbox">;
    caseId: string;
    now: () => number;
    fetcher: typeof fetch;
    informationFlow: EmailTurnInformationFlow;
    /**
     * Supplies the admitted messages in place of the mailbox. An eval turn
     * passes its reviewed scenario here: the turn then reads no mail, and
     * has no attachment to fetch.
     */
    fixture?: EmailCaseFixture;
  }>,
): Promise<EmailHarnessToolHost> {
  // The tools of this turn, in the order that the model gets: the list of the
  // response policy, then the tools that the turn's evidence admits.
  const tools: AnyRegisteredTool[] = [
    ...mailboxAgentTools(input.responsePolicy),
  ];
  const dependency = input.informationFlow.dependency;
  if (
    input.responsePolicy === "draft_only" &&
    dependency.kind === "source_only"
  )
    tools.push(mailboxSupplierContextRead);
  if (dependency.kind === "case_context_collection_evidence")
    tools.push(mailboxEvidenceRead);
  // An eval turn reads a reviewed scenario, not a customer's mail, so it
  // reads no order.
  if (
    input.responsePolicy !== "correction_learning" &&
    dependency.kind === "source_only" &&
    input.fixture === undefined
  )
    tools.push(mailboxOrderRead);
  const registry = createToolRegistry(tools);
  const definitions = tools.map(modelToolDefinition);
  const commerce = new EmailSupplierContext(
    input.env,
    input.authority,
    input.caseId,
  );
  const orders = new EmailOrderContext(
    input.env,
    input.authority,
    input.caseId,
  );
  const commerceReceipts = (): readonly EmailCommerceEvidence[] => [
    ...commerce.receipts(),
    ...orders.receipts(),
  ];
  const recordReads = (): ReadonlyMap<string, EmailReplySourceRecord> => {
    const reads = new Map<string, EmailReplySourceRecord>();
    const request = commerce.purchaseRequest();
    const records: EmailReplySourceRecord[] = orders
      .orders()
      .map((order) => ({ kind: "order" as const, ...order }));
    if (request !== null)
      records.push({ kind: "purchase_request", ...request });
    for (const record of records)
      reads.set(replySourceReference(record), record);
    return reads;
  };
  const catalogDigest = await digestCanonical({
    kind: "pantry_email_tool_catalog_v1",
    definitions,
    messageIds: input.manifest.messageIds,
  });
  const breaches: EmailSizeBreach[] = [];
  let outcome: EmailCueOutcome = { kind: "none" };
  let caseContentComplete = false;
  let cachedToken: string | null = null;

  const accessToken = async (): Promise<
    Result<string, { readonly code: string }>
  > => {
    if (cachedToken !== null) return { ok: true, value: cachedToken };
    const resolved = await resolveConnectorGmailAccess({
      env: input.env,
      organisationId: input.organisationId,
      integrationAccountId: input.manifest.integrationAccountId,
      now: input.now(),
      fetcher: input.fetcher,
    });
    if (resolved.ok) cachedToken = resolved.value;
    return resolved;
  };

  const admittedContent = async (
    messageId: string,
  ): Promise<Result<GmailMessageContent, { readonly code: string }>> => {
    const mailOperations = GMAIL_MAILBOX;
    if (
      !input.manifest.messageIds.includes(messageId) &&
      !(
        dependency.kind === "case_context_collection_evidence" &&
        dependency.selections.some(selectionHasMessage.bind(null, messageId))
      )
    ) {
      return { ok: false, error: { code: "email_message_not_admitted" } };
    }
    if (input.now() > input.manifest.expiresAt) {
      return { ok: false, error: { code: "email_manifest_expired" } };
    }
    if (input.fixture !== undefined) return input.fixture(messageId);
    const token = await accessToken();
    if (!token.ok) return token;
    const content = await mailOperations.reads.readMessage({
      accessToken: token.value,
      messageId,
      fetcher: input.fetcher,
    });
    if (dependency.kind === "case_context_collection_evidence") {
      if (!content.ok && content.error.code === "gmail_not_found") {
        const organisationId = parseOrganisationId(input.organisationId);
        const selection = dependency.selections.find(
          selectionHasMessage.bind(null, messageId),
        );
        if (organisationId.ok && selection !== undefined) {
          const organisation = await requireActiveOrganisationActor({
            env: input.env,
            organisationId: organisationId.value,
            now: input.now(),
          });
          await organisation.eraseCaseContextCollectionSource({
            organisationId: organisationId.value,
            selection: selection.source,
          });
        }
      }
      if (
        !content.ok ||
        !(
          await validateCaseContextCollectionEmailMessage(
            input.env,
            dependency,
            messageId,
            content.value,
          )
        ).ok
      )
        return {
          ok: false,
          error: { code: "case_context_collection_evidence_stale" },
        };
    }
    return content.ok
      ? content
      : { ok: false, error: { code: content.error.code } };
  };

  const needsCompleteCase = (
    refusal: string,
  ): Promise<AuthorizedHarnessToolResult> | null =>
    !caseContentComplete || breaches.length > 0
      ? authorizedRead(refusal, "failed")
      : null;
  const selectReply = async (
    name: "email_reply_now" | "email_reply_for_approval",
    inputJson: string,
  ): Promise<AuthorizedHarnessToolResult> => {
    const incomplete = needsCompleteCase(
      "Read the complete admitted email Case before choosing a Cue outcome.",
    );
    if (incomplete !== null) return incomplete;
    if (outcome.kind !== "none") {
      return authorizedRead(
        "This email turn already produced a Cue outcome.",
        "failed",
      );
    }
    const body = readReplyBody(inputJson);
    if (body === null) return authorizedRead("Invalid reply body.", "failed");
    if (
      !(
        await validateEmailCommerceEvidence(
          input.env,
          input.organisationId,
          commerceReceipts(),
        )
      ).ok
    )
      return authorizedRead(
        "Commerce evidence changed. Stop this turn for operator review.",
        "failed",
      );
    if (name === "email_reply_now") outcome = { kind: "reply_now", body };
    else {
      const cited = readReplyCitations(inputJson);
      outcome = {
        kind: "approval_required",
        body,
        citations: cited.citations,
        malformedCitations: cited.malformed,
      };
    }
    return authorizedRead(
      replySelectionText(outcome.kind, input.responsePolicy),
    );
  };
  const decideMemory = async (
    name: "propose_memory" | "no_memory",
    inputJson: string,
  ): Promise<AuthorizedHarnessToolResult> => {
    const incomplete = needsCompleteCase(
      "Read the complete admitted email Case before deciding what the correction shows.",
    );
    if (incomplete !== null) return incomplete;
    if (outcome.kind !== "none") {
      return authorizedRead(
        "This turn already decided what the correction shows.",
        "failed",
      );
    }
    if (name === "no_memory") {
      outcome = { kind: "ignore" };
      return authorizedRead("No Memory proposed for this correction.");
    }
    const statement = readMemoryStatement(inputJson);
    if (statement === null)
      return authorizedRead("Invalid Memory statement.", "failed");
    outcome = {
      kind: "memory_candidate",
      statement,
      check: readLearningCheck(inputJson),
    };
    return authorizedRead(
      "Memory candidate recorded for operator review. It is not in use.",
    );
  };
  // What each tool of the mailbox agent does. The executor of
  // agent-tools/catalog selects the tool and calls its service.
  const services: MailboxAgentToolServices = {
    readCase: async () => {
      const read = await readEmailCase(
        input.manifest,
        admittedContent,
        breaches,
      );
      caseContentComplete = read.complete;
      return read.result;
    },
    readEvidence: async () => {
      if (dependency.kind !== "case_context_collection_evidence")
        return authorizedRead(
          `Unknown tool: ${mailboxEvidenceRead.name}`,
          "failed",
        );
      const read = await readEmailCase(
        {
          integrationAccountId: input.manifest.integrationAccountId,
          messageIds: dependency.selections.map(selectionMessageId),
          maxMessageBytes: input.manifest.maxMessageBytes,
          maxAttachmentBytes: input.manifest.maxAttachmentBytes,
          expiresAt: input.manifest.expiresAt,
        },
        admittedContent,
        breaches,
      );
      return read.result;
    },
    readAttachment: async (inputJson) => {
      if (input.fixture !== undefined)
        return authorizedRead("This message has no attachments.", "failed");
      return readEmailAttachment(
        input.manifest,
        admittedContent,
        breaches,
        accessToken,
        input.fetcher,
        inputJson,
      );
    },
    readSupplierContext: async (inputJson) => {
      const incomplete = needsCompleteCase(
        "Read the complete admitted email Case first.",
      );
      if (incomplete !== null) return incomplete;
      const newest = input.manifest.messageIds.at(-1);
      if (newest === undefined)
        return authorizedRead("No triggering email is available.", "failed");
      const content = await admittedContent(newest);
      if (!content.ok)
        return authorizedRead("The triggering email is unavailable.", "failed");
      const result = await commerce.read(content.value, inputJson);
      return result.ok
        ? authorizedRead(result.value)
        : authorizedRead(result.error.code, "failed");
    },
    readOrder: async (inputJson) => {
      const incomplete = needsCompleteCase(
        "Read the complete admitted email Case first.",
      );
      if (incomplete !== null) return incomplete;
      const messages: GmailMessageContent[] = [];
      for (const messageId of input.manifest.messageIds) {
        const content = await admittedContent(messageId);
        if (content.ok) messages.push(content.value);
      }
      const result = await orders.read(messages, inputJson);
      return result.ok
        ? authorizedRead(result.value)
        : authorizedRead(result.error.code, "failed");
    },
    replyNow: async (inputJson) => {
      if (input.responsePolicy === "draft_only")
        return authorizedRead(
          "This turn permits review drafts only.",
          "failed",
        );
      if (orders.orders().length > 0)
        return authorizedRead(
          "This turn read an order. A reply that uses an order needs human review: choose email_reply_for_approval.",
          "failed",
        );
      return selectReply("email_reply_now", inputJson);
    },
    replyForApproval: (inputJson) =>
      selectReply("email_reply_for_approval", inputJson),
    proposeMemory: (inputJson) => decideMemory("propose_memory", inputJson),
    noMemory: (inputJson) => decideMemory("no_memory", inputJson),
    noReply: async () => {
      const incomplete = needsCompleteCase(
        "Read the complete admitted email Case before choosing a Cue outcome.",
      );
      if (incomplete !== null) return incomplete;
      if (outcome.kind !== "none") {
        return authorizedRead(
          "This email turn already produced a Cue outcome.",
          "failed",
        );
      }
      outcome = { kind: "ignore" };
      return authorizedRead("No reply selected for this email Case.");
    },
  };
  const authority: CatalogToolAuthority = {
    registry,
    definitions,
    turnTools: [],
    services: { mailbox_agent: services },
    claimCapability: refuseCapabilityClaim,
    profile: {
      // A service returns the host's own result, also for a refusal.
      envelope: {
        success: async (value) => value as AuthorizedHarnessToolResult,
        failure: (detail) => authorizedRead(detail, "failed"),
      },
      outsideCatalog: (name) => `Unknown tool: ${name}`,
    },
  };
  return {
    mode: "hybrid",
    catalogDigest,
    definitions,
    codeMode: { kind: "disabled" },
    breaches: () => [...breaches],
    outcome: () => outcome,
    commerceEvidence: commerceReceipts,
    recordReads,
    flowBinding: input.informationFlow.binding.bind(input.informationFlow),
    async executeTool(
      name: string,
      inputJson: string,
    ): Promise<AuthorizedHarnessToolResult> {
      const result = await executeCatalogTool(
        authority,
        { kind: "direct" },
        name,
        inputJson,
        "",
      );
      // Evidence that a person selected for this issue is observed before the
      // model reads a result that depends on it.
      if (
        result.status === "failed" ||
        input.informationFlow.dependency.kind === "source_only"
      )
        return result;
      const admitted = await input.informationFlow.observe(
        result.output.digest,
      );
      return admitted.ok
        ? result
        : authorizedRead(
            "The selected evidence is no longer authorized. Stop this turn.",
            "failed",
          );
    },
  };
}

/** No tool of this host claims a capability: the turn holds its authority. */
async function refuseCapabilityClaim(): ReturnType<HarnessCapabilityClaim> {
  return {
    ok: false,
    error: {
      code: "embedded_harness_capability_claim_rejected",
      detail: "The mailbox agent host has no capability to claim",
    },
  };
}

function selectionHasMessage(
  messageId: string,
  selection: import("../case-context-discovery/evidence").CaseContextCollectionEvidenceSelection,
): boolean {
  return selection.source.reference === messageId;
}
function selectionMessageId(
  selection: import("../case-context-discovery/evidence").CaseContextCollectionEvidenceSelection,
): string {
  return selection.source.reference;
}

/** The tools that each response policy gives, in the order of the model. */
function mailboxAgentTools(
  policy: EmailResponsePolicy,
): readonly AnyRegisteredTool[] {
  switch (policy) {
    case "cue_routed":
      return [
        mailboxCaseRead,
        mailboxAttachmentRead,
        mailboxReplyNow,
        mailboxReplyForApproval,
        mailboxNoReply,
      ];
    case "draft_only":
      return [
        mailboxCaseRead,
        mailboxAttachmentRead,
        mailboxReviewDraftSave,
        mailboxNoReply,
      ];
    case "correction_learning":
      return [mailboxCaseRead, mailboxMemoryPropose, mailboxNoMemory];
    default:
      return assertNever(policy);
  }
}

function replySelectionText(
  kind: "reply_now" | "approval_required",
  policy: EmailResponsePolicy,
): string {
  if (kind === "reply_now")
    return "Immediate reply selected. Purin Pantry will revalidate policy and delivery authority.";
  if (policy === "draft_only")
    return "Review draft selected. Purin Pantry will save it without sending mail.";
  return "Human approval selected. Purin Pantry will acknowledge receipt and queue the draft for review.";
}

function readMemoryStatement(inputJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const statement = (parsed as Record<string, unknown>).statement;
  if (typeof statement !== "string") return null;
  const trimmed = statement.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_MEMORY_CANDIDATE_CHARS
    ? trimmed
    : null;
}

/**
 * The test message a Memory proposal carries, or null. A missing or unusable
 * one does not refuse the proposal: the fact is still proposed without it.
 */
function readLearningCheck(inputJson: string): EmailLearningCheck | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("check" in parsed))
    return null;
  const check = parsed.check;
  if (
    typeof check !== "object" ||
    check === null ||
    !("subject" in check) ||
    !("body" in check) ||
    typeof check.subject !== "string" ||
    typeof check.body !== "string"
  )
    return null;
  const subject = check.subject.trim();
  const body = check.body.trim();
  return subject.length > 0 &&
    subject.length <= MAX_CHECK_SUBJECT_CHARS &&
    body.length > 0 &&
    body.length <= MAX_CHECK_BODY_CHARS
    ? { subject, body }
    : null;
}

/** The citations of a reply for approval. Pantry verifies them later. */
function readReplyCitations(
  inputJson: string,
): ReturnType<typeof parseReplyCitations> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return { citations: [], malformed: 0 };
  }
  return isRecord(parsed)
    ? parseReplyCitations(parsed.sources)
    : { citations: [], malformed: 0 };
}

function readReplyBody(inputJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const body = (parsed as Record<string, unknown>).body;
  if (typeof body !== "string") return null;
  const trimmed = body.trim();
  return trimmed.length > 0 && trimmed.length <= 20_000 ? trimmed : null;
}

async function readEmailCase(
  manifest: EmailCaseManifest,
  admittedContent: (
    id: string,
  ) => Promise<Result<GmailMessageContent, { readonly code: string }>>,
  breaches: EmailSizeBreach[],
): Promise<
  Readonly<{ result: AuthorizedHarnessToolResult; complete: boolean }>
> {
  const sections: string[] = [];
  let complete = true;
  for (const messageId of manifest.messageIds) {
    const content = await admittedContent(messageId);
    if (!content.ok) {
      complete = false;
      sections.push(
        `[message ${messageId}] unavailable: ${content.error.code}`,
      );
      continue;
    }
    if (content.value.decodedBodyBytes > manifest.maxMessageBytes) {
      complete = false;
      breaches.push({
        kind: "message_too_large",
        providerMessageId: messageId,
        providerAttachmentId: null,
        observedBytes: content.value.decodedBodyBytes,
        limitBytes: manifest.maxMessageBytes,
      });
      sections.push(
        `[message ${messageId}] blocked: decoded body exceeds the published message size limit.`,
      );
      continue;
    }
    const attachmentBreach = detectAttachmentBreaches(
      messageId,
      content.value.attachments,
      manifest,
    );
    if (attachmentBreach.length > 0) complete = false;
    breaches.push(...attachmentBreach);
    sections.push(
      renderMessage(messageId, content.value, attachmentBreach.length > 0),
    );
  }
  return {
    result: await authorizedRead(sections.join("\n\n---\n\n")),
    complete,
  };
}

async function readEmailAttachment(
  manifest: EmailCaseManifest,
  admittedContent: (
    id: string,
  ) => Promise<Result<GmailMessageContent, { readonly code: string }>>,
  breaches: EmailSizeBreach[],
  accessToken: () => Promise<Result<string, { readonly code: string }>>,
  fetcher: typeof fetch,
  inputJson: string,
): Promise<AuthorizedHarnessToolResult> {
  const mailOperations = GMAIL_MAILBOX;
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return authorizedRead("Invalid tool arguments.", "failed");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return authorizedRead("Invalid tool arguments.", "failed");
  }
  const record = parsed as Record<string, unknown>;
  const messageId = record.messageId;
  const attachmentId = record.attachmentId;
  if (typeof messageId !== "string" || typeof attachmentId !== "string") {
    return authorizedRead("Invalid tool arguments.", "failed");
  }
  const content = await admittedContent(messageId);
  if (!content.ok)
    return authorizedRead(
      `Attachment unavailable: ${content.error.code}`,
      "failed",
    );
  const attachment = content.value.attachments.find(
    (entry) => entry.attachmentId === attachmentId,
  );
  if (attachment === undefined) {
    return authorizedRead(
      "Attachment does not belong to an admitted message.",
      "failed",
    );
  }
  if (attachment.declaredBytes > manifest.maxAttachmentBytes) {
    breaches.push({
      kind: "attachment_too_large",
      providerMessageId: messageId,
      providerAttachmentId: attachmentId,
      observedBytes: attachment.declaredBytes,
      limitBytes: manifest.maxAttachmentBytes,
    });
    return authorizedRead(
      "Attachment exceeds the published attachment size limit.",
      "failed",
    );
  }
  if (!isTextualMime(attachment.mimeType)) {
    return authorizedRead(
      `Attachment ${attachment.filename} (${attachment.mimeType}, ${attachment.declaredBytes} bytes) is not textual and cannot be read as text.`,
      "failed",
    );
  }
  const token = await accessToken();
  if (!token.ok)
    return authorizedRead(
      `Attachment unavailable: ${token.error.code}`,
      "failed",
    );
  const bytes = await mailOperations.reads.readAttachment({
    accessToken: token.value,
    messageId,
    attachmentId,
    fetcher,
  });
  if (!bytes.ok)
    return authorizedRead(
      `Attachment unavailable: ${bytes.error.code}`,
      "failed",
    );
  if (bytes.value.bytes.length > manifest.maxAttachmentBytes) {
    breaches.push({
      kind: "attachment_too_large",
      providerMessageId: messageId,
      providerAttachmentId: attachmentId,
      observedBytes: bytes.value.bytes.length,
      limitBytes: manifest.maxAttachmentBytes,
    });
    return authorizedRead(
      "Attachment exceeds the published attachment size limit.",
      "failed",
    );
  }
  return authorizedRead(new TextDecoder().decode(bytes.value.bytes));
}

function detectAttachmentBreaches(
  messageId: string,
  attachments: readonly GmailAttachmentRef[],
  manifest: EmailCaseManifest,
): EmailSizeBreach[] {
  const found: EmailSizeBreach[] = [];
  let total = 0;
  for (const attachment of attachments) {
    total += attachment.declaredBytes;
    if (attachment.declaredBytes > manifest.maxAttachmentBytes) {
      found.push({
        kind: "attachment_too_large",
        providerMessageId: messageId,
        providerAttachmentId: attachment.attachmentId,
        observedBytes: attachment.declaredBytes,
        limitBytes: manifest.maxAttachmentBytes,
      });
    }
  }
  if (total > manifest.maxAttachmentBytes && attachments.length > 1) {
    found.push({
      kind: "attachment_total_too_large",
      providerMessageId: messageId,
      providerAttachmentId: null,
      observedBytes: total,
      limitBytes: manifest.maxAttachmentBytes,
    });
  }
  return found;
}

function renderMessage(
  messageId: string,
  content: GmailMessageContent,
  attachmentsBlocked: boolean,
): string {
  const attachmentLines = content.attachments.map(
    (attachment) =>
      `- ${attachment.filename} (${attachment.mimeType}, ${attachment.declaredBytes} bytes, id: ${attachment.attachmentId})`,
  );
  return [
    `[message ${messageId}]`,
    `From: ${content.headers.from ?? "(unknown)"}`,
    `Subject: ${content.headers.subject}`,
    `Date: ${content.headers.date ?? "(unknown)"}`,
    content.attachments.length === 0
      ? "Attachments: none"
      : `Attachments:${attachmentsBlocked ? " (some exceed the size policy)" : ""}\n${attachmentLines.join("\n")}`,
    "",
    content.bodyText,
  ].join("\n");
}

function isTextualMime(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return (
    TEXTUAL_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    TEXTUAL_MIME_TYPES.has(normalized.split(";")[0] ?? normalized)
  );
}

async function authorizedRead(
  output: string,
  status: "succeeded" | "failed" = "succeeded",
): Promise<AuthorizedHarnessToolResult> {
  const value = await inlineToolOutput(output);
  return {
    kind: "read",
    output: value,
    authority: { kind: "read", resultDigest: value.digest },
    status,
  };
}

async function inlineToolOutput(
  output: string,
): Promise<Variant<HarnessToolOutput, "inline">> {
  const digest = await digestCanonical({
    kind: "pantry_email_tool_output_v1",
    output,
  });
  return {
    kind: "inline",
    content: [{ kind: "text", text: output }],
    digest,
  };
}

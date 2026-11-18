import type { EmailOperationalPreviewResult, EmailReplyPreviewResult } from "@seams/control-api/portal/agent-mailbox";
import type { MailReplyEdit } from "@seams/control-api";
import {
  ControlApiError,
  controlRead,
  controlWrite,
} from "../../control-client";
import { isRecord } from "@seams/std";
import {
  parseEmailOperationalPreviewResponse,
  parseEmailReplyPreviewResponse,
} from "@seams/control-api/portal/email-review";

export type EmailReviewActions = Readonly<{
  loadEmailReply: (proposalId: string) => Promise<EmailReplyPreviewResult>;
  editEmailReply: (proposalId: string, edit: MailReplyEdit) => Promise<void>;
  /** Plan 40D: saves the reply's shared draft as the next Gmail version. */
  saveEmailReplyDraft: (proposalId: string) => Promise<void>;
  /** Plan 40D: starts the shared draft again from the current Gmail version. */
  reloadEmailReplyDraft: (proposalId: string) => Promise<void>;
  approveEmailReply: (
    proposalId: string,
    approval: Readonly<{
      version: number;
      snapshotDigest: string;
      challenge: string;
    }>,
  ) => Promise<void>;
  rejectEmailReply: (proposalId: string) => Promise<void>;
  resolveEmailReply: (
    proposalId: string,
    dispatchVersion: number,
  ) => Promise<void>;
  loadEmailOperational: (
    proposalId: string,
  ) => Promise<EmailOperationalPreviewResult>;
  approveEmailOperational: (
    proposalId: string,
    approval: Readonly<{
      version: number;
      snapshotDigest: string;
      challenge: string;
      selfTestOwnershipConfirmed?: true;
    }>,
  ) => Promise<void>;
  rejectEmailOperational: (proposalId: string) => Promise<void>;
  editEmailOperational: (
    proposalId: string,
    subject: string,
    body: string,
    version?: number,
  ) => Promise<void>;
  attestEmailOperational: (
    proposalId: string,
    attestation: "present" | "absent",
  ) => Promise<void>;
}>;

export function createEmailReviewActions(
  organisationId: string,
): EmailReviewActions {
  return {
    loadEmailReply: readEmailReplyPreview.bind(null, organisationId),
    editEmailReply: editEmailReply.bind(null, organisationId),
    saveEmailReplyDraft: saveEmailReplyDraft.bind(null, organisationId),
    reloadEmailReplyDraft: reloadEmailReplyDraft.bind(null, organisationId),
    approveEmailReply: approveEmailReply.bind(null, organisationId),
    rejectEmailReply: rejectEmailReply.bind(null, organisationId),
    resolveEmailReply: resolveEmailReply.bind(null, organisationId),
    loadEmailOperational: readEmailOperationalPreview.bind(
      null,
      organisationId,
    ),
    approveEmailOperational: approveEmailOperational.bind(null, organisationId),
    rejectEmailOperational: rejectEmailOperational.bind(null, organisationId),
    editEmailOperational: editEmailOperational.bind(null, organisationId),
    attestEmailOperational: attestEmailOperational.bind(null, organisationId),
  };
}

export async function readEmailReplyPreview(
  organisationId: string,
  proposalId: string,
  signal?: AbortSignal,
): Promise<EmailReplyPreviewResult> {
  return parseEmailReplyPreviewResponse(
    await emailReviewResult(
      controlRead(emailReplyPath(organisationId, proposalId), signal),
    ),
  );
}

async function readEmailOperationalPreview(
  organisationId: string,
  proposalId: string,
): Promise<EmailOperationalPreviewResult> {
  return parseEmailOperationalPreviewResponse(
    await emailReviewResult(
      controlRead(emailOperationalPath(organisationId, proposalId)),
    ),
  );
}

async function approveEmailReply(
  organisationId: string,
  proposalId: string,
  approval: Readonly<{
    version: number;
    snapshotDigest: string;
    challenge: string;
  }>,
): Promise<void> {
  await emailReviewMutation(
    `${emailReplyPath(organisationId, proposalId)}/approve`,
    approval,
  );
}

export async function editEmailReply(
  organisationId: string,
  proposalId: string,
  edit: MailReplyEdit,
): Promise<void> {
  await emailReviewMutation(
    `${emailReplyPath(organisationId, proposalId)}/edit`,
    edit,
  );
}

export async function saveEmailReplyDraft(
  organisationId: string,
  proposalId: string,
): Promise<void> {
  await emailReviewMutation(
    `${emailReplyPath(organisationId, proposalId)}/draft-save`,
    {},
  );
}

export async function reloadEmailReplyDraft(
  organisationId: string,
  proposalId: string,
): Promise<void> {
  await emailReviewMutation(
    `${emailReplyPath(organisationId, proposalId)}/draft-reload`,
    {},
  );
}

/** A save found a newer version in Gmail than the shared draft started from. */
export class EmailReplyDraftStaleError extends Error {}

async function rejectEmailReply(
  organisationId: string,
  proposalId: string,
): Promise<void> {
  await emailReviewMutation(
    `${emailReplyPath(organisationId, proposalId)}/reject`,
    {},
  );
}

async function resolveEmailReply(
  organisationId: string,
  proposalId: string,
  dispatchVersion: number,
): Promise<void> {
  await emailReviewMutation(
    `${emailReplyPath(organisationId, proposalId)}/resolve`,
    {
      dispatchVersion,
    },
  );
}

async function approveEmailOperational(
  organisationId: string,
  proposalId: string,
  approval: Readonly<{
    version: number;
    snapshotDigest: string;
    challenge: string;
    selfTestOwnershipConfirmed?: true;
  }>,
): Promise<void> {
  await emailReviewMutation(
    `${emailOperationalPath(organisationId, proposalId)}/approve`,
    approval,
  );
}

async function rejectEmailOperational(
  organisationId: string,
  proposalId: string,
): Promise<void> {
  await emailReviewMutation(
    `${emailOperationalPath(organisationId, proposalId)}/reject`,
    {},
  );
}

async function editEmailOperational(
  organisationId: string,
  proposalId: string,
  subject: string,
  body: string,
  version?: number,
): Promise<void> {
  await emailReviewMutation(
    `${emailOperationalPath(organisationId, proposalId)}/edit`,
    {
      subject,
      body,
      ...(version === undefined ? {} : { version }),
    },
  );
}

async function attestEmailOperational(
  organisationId: string,
  proposalId: string,
  attestation: "present" | "absent",
): Promise<void> {
  await emailReviewMutation(
    `${emailOperationalPath(organisationId, proposalId)}/attest-${attestation}`,
    {},
  );
}

async function emailReviewMutation(path: string, body: unknown): Promise<void> {
  const csrf = readCookie("satyr_control_csrf");
  if (csrf === null) {
    throw new Error("Your control session expired. Sign in again.");
  }
  await emailReviewResult(controlWrite(path, "POST", body));
}

async function emailReviewResult(
  request: Promise<unknown>,
): Promise<Record<string, unknown>> {
  let raw: unknown;
  let ok = true;
  try {
    raw = await request;
  } catch (error) {
    if (!(error instanceof ControlApiError)) throw error;
    // An answer that is not JSON: an accepted one has no status of its own.
    if (error.details === null)
      throw new Error(
        `The email review request failed (HTTP ${error.status ?? 200}).`,
      );
    raw = error.details;
    ok = false;
  }
  if (!isRecord(raw))
    throw new Error("Could not read the email review response.");
  if (!ok) {
    if (
      raw.error === "email_reply_approval_stale" ||
      raw.error === "email_reply_challenge_stale" ||
      raw.error === "email_reply_edit_stale"
    )
      throw new Error(
        "This draft changed. Review its latest version before saving or sending.",
      );
    if (raw.error === "email_reply_draft_stale")
      throw new EmailReplyDraftStaleError(
        "Gmail has a newer version of this reply. Load it to continue. The unsaved shared changes are then dropped.",
      );
    if (raw.error === "email_reply_draft_unsaved")
      throw new Error(
        "The shared draft has changes that are not saved. Select Edit, check them, and save before you send.",
      );
    if (
      raw.error === "email_reply_draft_closed" ||
      raw.error === "draft_closed"
    )
      throw new Error("This reply is closed. Refresh conversation work.");
    if (
      raw.error === "email_reply_draft_missing" ||
      raw.error === "mail_reply_draft_unavailable"
    )
      throw new Error(
        "The shared draft is not available now. Try again in a moment.",
      );
    if (raw.error === "email_reply_edit_unconfirmed")
      throw new Error(
        "Gmail did not confirm this save. Reload the draft to check its current text before editing again.",
      );
    if (raw.error === "email_reply_edit_unavailable")
      throw new Error(
        "This reply cannot be edited in its current state. Refresh conversation work.",
      );
    if (
      raw.error === "email_reply_unavailable" ||
      raw.error === "email_commerce_unavailable" ||
      raw.error === "email_source_unavailable" ||
      raw.error === "email_reply_not_found"
    )
      throw new Error(
        "This reply is no longer available to you. Refresh conversation work.",
      );
    if (raw.error === "email_commerce_changed")
      throw new Error(
        "Purchasing information changed. A fresh investigation is needed before this reply can be sent.",
      );
    if (raw.error === "email_memory_changed")
      throw new Error(
        "A memory this draft used was changed or removed. A fresh draft is needed before this reply can be sent.",
      );
    if (raw.error === "email_memory_unavailable")
      throw new Error(
        "The memory this draft used could not be checked. Try again in a moment.",
      );
    // The mailbox's settings, its agent or its connection changed after the
    // turn that wrote this draft. The platform then answers no review of it.
    if (raw.error === "source_subject_inactive")
      throw new Error(
        "The mailbox's settings, agent or connection changed after this draft was made, so it cannot be sent. Answer this mail in Gmail.",
      );
    throw new Error(
      typeof raw.message === "string"
        ? raw.message
        : "The email review action could not be completed. Refresh and try again.",
    );
  }
  return raw;
}

function emailReplyPath(organisationId: string, proposalId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/email-replies/${encodeURIComponent(proposalId)}`;
}

function emailOperationalPath(
  organisationId: string,
  proposalId: string,
): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/email-operational/${encodeURIComponent(proposalId)}`;
}

function readCookie(name: string): string | null {
  const documentValue = Reflect.get(globalThis, "document");
  if (typeof documentValue !== "object" || documentValue === null) return null;
  const rawCookie = Reflect.get(documentValue, "cookie");
  if (typeof rawCookie !== "string") return null;
  for (const cookie of rawCookie.split(";")) {
    const trimmed = cookie.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return decodeURIComponent(trimmed.slice(name.length + 1));
    }
  }
  return null;
}

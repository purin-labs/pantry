import {
  EMAIL_REPLY_SENDER_NAME_MAX,
  EMAIL_REPLY_SUBJECT_MAX,
  type EmailReplyHeadline,
  type MailInboxMessage,
} from "@purin-labs/control-api";
import type { RequestAuthority } from "@purin-labs/contracts";
import { resolveConnectorGmailAccess } from "../actors/connector-email-evaluation";
import type { EmailReviewProjection } from "../data/email-review";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
} from "@purin-labs/kernel/ids";
import { authorizeMailSource } from "../mail-inbox/contract/mail-source-authorization";
import { GMAIL_MAILBOX } from "@purin-labs/connections/mail/gmail-mail-adapter";
import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "./authorization";
import { mailControlAuthority } from "../mail-inbox/contract/control-authority";
import type { Variant } from "@purin-labs/type-utils";

/**
 * The most threads that one read of the queue names. Each costs a Gmail
 * thread read, and Gmail limits the reads of one mailbox each second.
 */
const EMAIL_REPLY_HEADLINE_LIMIT = 10;

type ControlAuthority = Variant<RequestAuthority, "control">;
/** The waiting drafts of one mailbox, by the Gmail thread that they answer. */
type MailboxThreads = Readonly<{
  accountId: IntegrationAccountId;
  threads: ReadonlyMap<string, readonly string[]>;
}>;
type MailboxHeadlines = Readonly<{
  accountId: IntegrationAccountId;
  sourcePin: string;
  /** By proposal. */
  headlines: ReadonlyMap<string, EmailReplyHeadline>;
}>;

/**
 * The headline of each reply draft that waits, for the person who reads the
 * queue: the sender, subject and time of the mail that it answers. The
 * mailbox read boundary of the Inbox decides it for each mailbox, as for a
 * page of mail. Gmail holds the mail, and each read asks it again and keeps
 * nothing. A mailbox that the person may not read, or whose access changes
 * during the read, names none of its drafts.
 */
export async function readEmailReplyHeadlines(
  request: Request,
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  reviews: readonly EmailReviewProjection[],
): Promise<ReadonlyMap<string, EmailReplyHeadline>> {
  const mailboxes = waitingThreads(reviews);
  if (mailboxes.length === 0) return new Map();
  const authority = await mailControlAuthority(authorized);
  if (authority === null) return new Map();
  const read = await Promise.all(
    mailboxes.map(
      readMailboxHeadlines.bind(
        null,
        env,
        authorized.organisationId,
        authority,
      ),
    ),
  );
  // Provider reads may outlive a grant or connection change.
  const current = await authorizeOrganisationRequest(
    request,
    env,
    authorized.organisationId,
    "viewer",
    false,
  );
  if (!current.ok) return new Map();
  const liveAuthority = await mailControlAuthority(current);
  if (liveAuthority === null) return new Map();
  const standing = await Promise.all(
    read.map(mailboxStillReadable.bind(null, env, liveAuthority)),
  );
  const headlines = new Map<string, EmailReplyHeadline>();
  for (const mailbox of standing)
    if (mailbox !== null)
      for (const [proposalId, headline] of mailbox.headlines)
        headlines.set(proposalId, headline);
  return headlines;
}

/** The queue is newest first, so the newest drafts are named first. */
function waitingThreads(
  reviews: readonly EmailReviewProjection[],
): readonly MailboxThreads[] {
  const mailboxes = new Map<string, Map<string, string[]>>();
  let threads = 0;
  for (const review of reviews) {
    if (
      review.kind !== "gmail_reply" ||
      review.lifecycleKind !== "awaiting_approval"
    )
      continue;
    const mailbox =
      mailboxes.get(review.integrationAccountId) ?? new Map<string, string[]>();
    const proposals = mailbox.get(review.backing.gmailThreadId);
    if (proposals !== undefined) {
      proposals.push(review.proposalId);
      continue;
    }
    if (threads === EMAIL_REPLY_HEADLINE_LIMIT) continue;
    threads += 1;
    mailbox.set(review.backing.gmailThreadId, [review.proposalId]);
    mailboxes.set(review.integrationAccountId, mailbox);
  }
  const waiting: MailboxThreads[] = [];
  for (const [raw, mailbox] of mailboxes) {
    const accountId = parseIntegrationAccountId(raw);
    if (accountId.ok)
      waiting.push({ accountId: accountId.value, threads: mailbox });
  }
  return waiting;
}

async function readMailboxHeadlines(
  env: Env,
  organisationId: AuthorizedOrganisationRequest["organisationId"],
  authority: ControlAuthority,
  mailbox: MailboxThreads,
): Promise<MailboxHeadlines | null> {
  const source = await authorizeMailSource(env, authority, mailbox.accountId);
  if (source === null) return null;
  const access = await resolveConnectorGmailAccess({
    env,
    organisationId,
    integrationAccountId: mailbox.accountId,
    now: Date.now(),
    fetcher: runtimeFetch,
  });
  if (!access.ok) return null;
  const threads = [...mailbox.threads];
  const read = await Promise.all(
    threads.map(readThreadHeadline.bind(null, access.value)),
  );
  const headlines = new Map<string, EmailReplyHeadline>();
  threads.forEach(([, proposalIds], index) => {
    const headline = read[index] ?? null;
    if (headline !== null)
      for (const proposalId of proposalIds) headlines.set(proposalId, headline);
  });
  return {
    accountId: mailbox.accountId,
    sourcePin: source.sourcePin,
    headlines,
  };
}

/** A thread that cannot be read now has no headline. Its row still shows. */
async function readThreadHeadline(
  accessToken: string,
  [threadId]: readonly [string, readonly string[]],
): Promise<EmailReplyHeadline | null> {
  const read = await GMAIL_MAILBOX.reads.readThreadHeadline({
    accessToken,
    threadId,
    fetcher: runtimeFetch,
  });
  return read.ok && read.value !== null ? replyHeadline(read.value) : null;
}

async function mailboxStillReadable(
  env: Env,
  authority: ControlAuthority,
  mailbox: MailboxHeadlines | null,
): Promise<MailboxHeadlines | null> {
  if (mailbox === null) return null;
  const live = await authorizeMailSource(env, authority, mailbox.accountId);
  return live !== null && live.sourcePin === mailbox.sourcePin ? mailbox : null;
}

/** A message without a sender has no headline. */
function replyHeadline(message: MailInboxMessage): EmailReplyHeadline | null {
  const senderName = displayName(message.from).slice(
    0,
    EMAIL_REPLY_SENDER_NAME_MAX,
  );
  if (senderName.trim() === "") return null;
  return {
    senderName,
    subject: message.subject.trim().slice(0, EMAIL_REPLY_SUBJECT_MAX),
    receivedAt: message.receivedAt,
  };
}

/** The name of a `From` header, as Gmail shows it, or its address. */
function displayName(from: string): string {
  const bracketed = /^(.*?)\s*<([^<>]+)>\s*$/u.exec(from);
  if (bracketed === null) return from.trim();
  const name = (bracketed[1] ?? "").replaceAll('"', "").trim();
  return name === "" ? (bracketed[2] ?? "").trim() : name;
}

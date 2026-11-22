# Gmail Canary Runbook

Status: Ready to run once the production Google Cloud project exists

This is the isolated production canary required by
[plan-29](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-29-organisation-agent-email-mailboxes.md) Phase 6, plus the
evidence record for provider review. Operating procedure for a live mailbox
lives in [Gmail mailboxes](gmail-mailboxes.md).

## Provisioned infrastructure

The production Pub/Sub half is built in Google Cloud project `purin-pantry`
(Plan 93 step 4):

| Resource        | Value                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| Topic           | `projects/purin-pantry/topics/pantry-gmail-push`                             |
| Gmail publisher | `gmail-api-push@system.gserviceaccount.com` granted `roles/pubsub.publisher` |
| Push identity   | `pantry-gmail-push@purin-pantry.iam.gserviceaccount.com` (no key issued)     |
| Token minting   | Pub/Sub service agent granted `roles/iam.serviceAccountTokenCreator`         |
| Subscription    | `pantry-gmail-push-sub`, OIDC, audience = push endpoint, no expiry           |
| Push endpoint   | `https://pantry.purin.io/hook/email/google`                  |

Gmail API and Pub/Sub API are enabled on that project.

`seams-501403` is reserved for portal Google sign-in and holds no Gmail
infrastructure. The topic, subscription, and push service account briefly
created there during an earlier provisioning round were deleted with the
owner's approval; only the Gmail and Pub/Sub API enablements remain, and both
are inert without a topic or credential. Nothing Gmail-related should ever be
added back to that project, including scopes on its consent screen.

## Blocking prerequisites

Three of the five variables are set. The remaining two require an OAuth client,
which Google exposes only through the Cloud Console — there is no API or CLI
that creates a user-facing Web OAuth client, and the `gcloud alpha iap`
commands create IAP clients, which cannot carry Gmail scopes.

| Variable                       | Status                         |
| ------------------------------ | ------------------------------ |
| `GMAIL_PUBSUB_AUDIENCE`        | Set                            |
| `GMAIL_PUBSUB_TOPIC`           | Set                            |
| `GMAIL_PUBSUB_SERVICE_ACCOUNT` | Set                            |
| `GMAIL_OAUTH_CLIENT_ID`        | Missing — Console only         |
| `GMAIL_OAUTH_CLIENT_SECRET`    | Missing — Console only, secret |

Without an OAuth client no mailbox can be connected, so every canary step below
is blocked until these exist.

The Worker must also be deployed with the Gmail routes. As of this writing
`POST https://pantry.purin.io/hook/email/google` answers 404,
so production is serving a build that predates the mailbox work: the push
subscription is wired correctly and delivers, but there is nothing to receive
it yet. Verify the endpoint answers 503 (configuration missing) or 401 (bad
token) rather than 404 before starting the canary — a 404 means the deploy did
not carry the routes.

Check what a deploy would actually ship before running one. The Gmail work
currently shares a commit with in-flight WhatsApp support, so deploying now
would push that to production too.

The schema is a second, larger prerequisite. `wrangler.jsonc` declares no
`migrations_dir`, the deploy script is a bare `wrangler deploy` that applies no
schema, and the only migration script is `d1:migrate:local`. Because
`0001_current_schema.sql` is a single replaceable baseline and Wrangler records
migrations by filename, a database that already applied `0001` will skip it
however much the file has changed. The mailbox tables and the new
`provider_connection.authority_kind` column would therefore not reach a
production database that has already run it, and code expecting that column
would fail on every provider-connection write.

Confirm the deployed database's schema before deploying. Under the disposable
baseline convention that means recreating it; if the production database holds
data worth keeping, it needs a hand-written delta instead. This has not been
verified against production here — the available API token lacks D1 query
permission.

## The setup in the Console (done for production)

Plan 93 step 4 set up project `purin-pantry` on 22 November 2026: an External
consent screen "In production" with the scopes `openid`, `userinfo.email`,
`userinfo.profile`, `gmail.readonly`, `gmail.compose`, `gmail.send` and
`drive.file`, and one web client, "Purin Pantry web", whose redirect URIs are
the sign-in, Gmail and Drive callbacks on `https://pantry.purin.io`. The
client id is in `env.production.vars` as `GOOGLE_OIDC_CLIENT_ID`,
`GMAIL_OAUTH_CLIENT_ID` and `GDRIVE_OAUTH_CLIENT_ID`, and its secret is the
Worker secret of each. Open: Google verification of the restricted Gmail
scopes (the logo upload and the submission are the owner's).

## Canary sequence

Run in order. Each step names the evidence to capture.

1. **Connect.** Authorize the canary mailbox from the Portal. Evidence: the
   account reaches `active`, and the mailbox reports `Processing off` — OAuth
   success alone must never present as processing.
2. **Assign and publish.** Assign an agent, publish an enabled policy with
   deliberately small limits. Evidence: policy version 1, processing
   `scheduled`, a watch expiry roughly seven days out.
3. **Deliver one message.** Send mail to the canary from an external address.
   Evidence: a push accepted at `/hook/email/google`, one Case admitted, one
   visible Gmail draft created, and the reply queued for approval.
4. **Duplicate notification.** Replay the same Pub/Sub notification. Evidence:
   the second hint is recorded as a duplicate and starts no second evaluation.
5. **Debounce.** Send two more messages inside the hour. Evidence: exactly one
   evaluation runs; the next is scheduled about an hour out.
6. **Every policy limit.** Trip each in turn: active Cases, hourly messages,
   daily tokens, oversized message, oversized attachment, oversized attachment
   total. Evidence: each pause names its own limit and observed value, and new
   mail stays unread in Gmail.
7. **Resume paths.** Acknowledge and resume; then trip the size limit and use
   skip-and-resume. Evidence: skip accepts only the exact message named.
8. **Draft body edit.** Edit the draft body in Gmail, then reload the approval.
   Evidence: the version increments and the snapshot digest changes.
9. **Trusted-target edit.** Change the recipient in Gmail. Evidence: the
   proposal invalidates with `target_changed` and cannot be approved.
10. **Approval rejection.** Reject a proposal. Evidence: the draft is deleted
    and the lifecycle records who rejected it.
11. **Approve and send.** Approve a proposal. Evidence: exactly one message in
    the original thread, a `pantry-dispatch-` Message-ID, and the proposal draft
    deleted afterwards.
12. **Ambiguous send.** Force an indeterminate result if you can reproduce one.
    Evidence: state `send_indeterminate`, then resolution finds the message by
    its dispatch Message-ID without sending again. Exactly one delivered
    message in the thread.
13. **Cursor expiry.** Leave the mailbox disabled past Gmail's history window,
    or reproduce a 404 from `history.list`. Evidence: the account degrades with
    `gmail_history_expired`, and Reconnect restores it from a fresh floor.
14. **Reconnect.** Evidence: a new watch expiry and an active account.
15. **Cleanup failure.** Revoke the OAuth grant from the Google account while a
    draft is outstanding, then dispose it. Evidence: the proposal reports
    cleanup needed rather than reporting success.
16. **Revocation.** Revoke the mailbox. Evidence: processing stops, pending
    sends are fenced, drafts are deleted where possible, the credential no
    longer resolves, and any undeletable draft is reported.

## Exit gate

The gate is zero unauthorized sends, zero duplicate replies, zero policy-limit
overruns, zero cross-organisation disclosures, and no durable Pantry copy of email
content. Confirm each explicitly:

- **Unauthorized sends.** Every delivered message corresponds to one approval
  receipt. No `messages.send` call appears without one.
- **Duplicate replies.** Each approved proposal appears exactly once in its
  thread, including after any ambiguous send.
- **Limit overruns.** No admission occurs past a published limit.
- **Cross-organisation disclosure.** The canary organisation sees only its own mailbox,
  proposals, and Cases.
- **Durable copies.** Inspect D1 and the Connector's storage for the canary
  account. Rows hold identifiers, digests, counters, and instants only — no
  subjects, addresses, bodies, or attachment bytes.

## Evidence already recorded

The behaviours below are proven against the real modules in CI and do not need
to be re-derived by hand during the canary; the canary confirms them against
Google rather than establishing them.

| Exit-gate scenario                                                      | Where it is proven                                |
| ----------------------------------------------------------------------- | ------------------------------------------------- |
| Verified push, routing, enqueue, admission                              | `gmail-operating-path`                            |
| Unroutable and malformed hints acknowledged, never retried              | `gmail-operating-path`                            |
| Unsigned, foreign, wrong-audience pushes refused                        | `gmail-operating-path`, `google-pubsub`           |
| Duplicate notification and 30-second push coalescing                    | `connector-email`                                 |
| No-reply, immediate reply, and acknowledgement-plus-review Cue outcomes | `email-harness-tools`, `email-case-processing`    |
| Resource-granted Slack search and approval-only reply proposal          | `harness-tool-catalog`, `gmail-adapter`           |
| Every admission limit, each naming its cause                            | `connector-email-evaluation`                      |
| Decoded body and attachment size breaches                               | `email-harness-tools`, `email-case-processing`    |
| Pause dedupe, explicit resume, exact-message skip                       | `connector-email`                                 |
| Cursor expiry degrades the account                                      | `connector-email-evaluation`                      |
| Draft body edit re-versions the proposal                                | `connector-email-proposal`, `email-reply-control` |
| Trusted-target edit invalidates the proposal                            | `connector-email-proposal`                        |
| One immutable snapshot sent, draft cleaned up                           | `connector-email-proposal`                        |
| Stale approval refused at dispatch                                      | `connector-email-proposal`, `email-reply-control` |
| Ambiguous send reconciled by Message-ID, never re-sent                  | `connector-email-proposal`, `email-reply-control` |
| Approval rejection disposes the draft                                   | `email-reply-control`                             |
| Cleanup failure surfaces as cleanup needed                              | `connector-email-proposal`                        |
| Revocation fences delivery before teardown                              | `connector-email-revocation`                      |
| Revocation requires authorization first                                 | `agent-mailbox-control`                           |
| Reconnect re-establishes from a fresh floor                             | `agent-mailbox-control`                           |
| Transient turn retains no history or checkpoint                         | `transient-email-turn`                            |
| Transient cleanup failure destroys the container                        | `transient-email-turn`                            |
| OAuth identity, refresh inside one generation                           | `gmail-oauth`                                     |
| OAuth success alone never shows as processing                           | `portal-gmail-mailbox`                            |

## What the canary alone can establish

Three things cannot be proven without Google and are the canary's real purpose:

1. That Gmail accepts Pantry's `users.watch`, publishes to the topic, and that
   the push subscription reaches the Worker with a token that verifies.
2. That a reply built by Pantry threads correctly in a real Gmail client and
   appears once.
3. That the restricted scopes granted in production are sufficient for read,
   draft, and send without further consent prompts.

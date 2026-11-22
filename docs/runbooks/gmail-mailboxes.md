# Gmail Agent Mailboxes Runbook

Status: Active operational runbook

Pantry connects an organisation Gmail mailbox to one assigned agent. Inbound mail is
admitted as a Case, answered by a transient agent turn, and delivered only
after an operator approves an exact snapshot. This runbook covers deployment
configuration, the signals to alert on, and every recovery path.

Design rationale lives in
[plan-29](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-29-organisation-agent-email-mailboxes.md). Callback and origin
policy lives in [provider callback origins](provider-callback-origins.md).

## Deployment configuration

Five variables gate the entire path. Each is optional at the type level so the
Worker deploys without Gmail; every one must be present before a mailbox can
process mail.

| Variable                         | Kind          | Value                                                              |
| -------------------------------- | ------------- | ------------------------------------------------------------------ |
| `GMAIL_OAUTH_CLIENT_ID`          | var           | OAuth client ID                                                    |
| `GMAIL_OAUTH_CLIENT_SECRET`      | secret        | OAuth client secret                                                |
| `GMAIL_PUBSUB_TOPIC`             | var           | `projects/PROJECT/topics/TOPIC`, fully qualified                   |
| `GMAIL_PUBSUB_AUDIENCE`          | var           | Exact `aud` claim on the push token                                |
| `GMAIL_PUBSUB_SERVICE_ACCOUNT`   | var           | Exact `email` claim on the push token                              |
| `GMAIL_PILOT_ACCOUNT_CAP`        | var, optional | Connected Google accounts this project may consume. Defaults to 80 |
| `GMAIL_PILOT_SUBMISSION_TRIGGER` | var, optional | Consumption at which to begin verification. Defaults to 50         |

Two URLs are registered with Google and must match byte for byte:

```text
${PANTRY_OAUTH_CALLBACK_ORIGIN}/v1/control/providers/gmail/callback
${PANTRY_OAUTH_CALLBACK_ORIGIN}/hook/email/google
```

Production Gmail runs in the Google Cloud project `purin-pantry` (Plan 93
step 4), with one web client for sign-in, Gmail and Drive (the owner's
decision in Plan 91 phase 4). Its consent screen is External and "In
production", so refresh tokens do not end after seven days. The Portal shows
no expiry date for a Gmail sign-in. Until Google verifies the
restricted Gmail scopes, a connect shows Google's "unverified app" screen,
and at most 100 people can connect. Because sign-in shares the project, a
restriction on the project would also stop sign-in. Local development uses
the same client, with the topic `pantry-gmail-push-local`.

`GMAIL_PUBSUB_TOPIC` is passed verbatim to `users.watch`. The topic must grant
`roles/pubsub.publisher` to `gmail-api-push@system.gserviceaccount.com` or the
watch call fails outright.

## Model review

Mail goes only to a model route that Purin reviewed for Google's Limited Use
rules: the provider trains on no prompt and keeps no prompt after the answer.
The reviews are in
`services/platform/src/mail-inbox/contract/gmail-model-reviews.ts`, and
[Plan 83](../history/plan-83-one-inbox.md#model-review-and-consent) gives the design.
No operator writes a row by hand. An owner or admin accepts the reviewed
model's terms with the checkbox above **Turn on**, and the Portal writes the
row of `gmail_inference_eligibility`.

| Route                                       | State on 2026-11-22 | Terms                                                                                                      |
| ------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Paid route, Gemini 4 Hydrogen (the default) | Reviewed            | OpenRouter zero data retention; Google Vertex AI keeps a flagged prompt for 90 days, for abuse checks only |
| Paid route, Kimi K3                         | Reviewed            | OpenRouter zero data retention; no Safety Retention                                                        |
| Paid route, Qwen3.7 Flash                   | Not reviewed        | No zero-retention endpoint                                                                                 |
| An Organisation's own API key               | Not reviewed        | The provider keeps each prompt for an abuse check; Pantry cannot see the account's terms                   |
| ChatGPT sign-in, Claude account             | Not reviewed        | The person chooses model training in their own settings                                                    |

Each review ends 90 days after it (the first ones on 2027-02-20). When a
review ends, the dispatch check stops new mail for that model in every
Organisation, and the mail journeys fail. Before the end:

1. Read the terms of the review again (`evidenceReference`) and OpenRouter's
   list of zero-retention endpoints (`https://openrouter.ai/api/v1/endpoints/zdr`).
2. Check that each request of the model still sets `data_collection: "deny"`
   and `zdr: true` (`PLATFORM_PI_MODEL_TABLE` in
   `foundation/agent/actors/pi-model-transport.ts`).
3. Check in OpenRouter's privacy settings of the Purin account that Input &
   Output Logging is off, and that "ZDR only" for Google models is off.
   "ZDR only" refuses every Gemini request: Google Vertex AI serves Gemini
   with Safety Retention.
4. Move `REVIEWED_AT` and `REVIEW_EXPIRES_AT` in the reviews file, and release.
   Each owner accepts the renewed terms again at the next Turn on or
   **Continue**.

To add a model route, add it to the reviews file with the terms that show no
training and no retention after the answer. The type of a reviewed paid
route accepts only a model whose `retention` is `zero`. To withdraw a route,
remove its review; new mail for it stops at the next dispatch.

The chat agent cannot accept the terms for a person. Only an owner or admin
with a Portal session reaches `POST …/agent-mailboxes/{account}/model-consent`.

The release that brought the review list adds the column
`consented_by_user_id`. Apply
`services/platform/scripts/gmail-model-consent-d1-patch.sql` to each regional
database before that release.

## Normal operating loop

1. A Gmail change publishes a Pub/Sub notification to the topic.
2. The push subscription posts an OIDC-signed hint to `/hook/email/google`.
3. The gateway verifies the token, routes the hint to the mailbox's Connector,
   and marks the cursor dirty. The hint carries no message content.
4. The Connector coalesces notifications for 30 seconds, pages Gmail history
   from the last accepted point, applies every policy limit, and admits new
   threads as Cases.
5. Each admitted thread runs one transient Cue turn. Irrelevant mail closes
   without a reply; routine mail can send immediately; sensitive or uncertain
   mail receives the fixed acknowledgement and a visible substantive draft.
6. An operator approves a reviewed snapshot; Pantry sends it once with a
   deterministic dispatch Message-ID and deletes the proposal draft.

Push notifications are hints. Losing one costs latency, never correctness: the
next hint reconciles from the stored history cursor.

## Signals and alert thresholds

Trace events, with the operator action each implies.

| Event                                     | Meaning                                     | Action                                                       |
| ----------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| `integration_gateway.email_push_rejected` | Push token failed verification              | Page if sustained. Audience, service account, or clock drift |
| `integration_gateway.email_push_ignored`  | Hint unroutable or malformed                | Investigate if sustained for a known-active mailbox          |
| `email_watch.renewal_failed`              | Daily watch renewal failed                  | Investigate within one day; watch expires after seven        |
| `email_watch.activation_failed`           | Self-heal could not reactivate              | Investigate; mailbox is not processing                       |
| `email_watch.connector_unavailable`       | Connector unreachable during reconciliation | Page if repeated                                             |
| `connector.email_authorization_expired`   | Refresh token expired or revoked            | Mailbox is paused; reconnect it                              |
| `connector.email_access_unavailable`      | Credential temporarily unusable             | Transient; investigate if sustained                          |
| `connector.email_history_expired`         | Cursor older than Gmail retains             | Mailbox degraded; see recovery                               |
| `connector.email_case_admission_deferred` | Case admission failed; cursor held          | Transient if isolated; page if sustained                     |
| `connector.email_projection_deferred`     | Projection write failed after admission     | Investigate; Case exists, projection lags                    |

Recommended thresholds:

- Any `email_push_rejected` sustained beyond five minutes is a configuration
  fault, not noise. Verify `GMAIL_PUBSUB_AUDIENCE` and
  `GMAIL_PUBSUB_SERVICE_ACCOUNT` against the subscription.
- Any enabled mailbox whose watch expiry falls inside 24 hours and has not
  renewed indicates the scheduled reconciler is not running.
- Any mailbox paused longer than one business day needs an operator decision;
  pauses never clear themselves.
- Any proposal in `cleanup_unreachable` requires manual Gmail cleanup.

## Pilot account budget

Google's test-user allowance counts unique Google accounts that have ever
granted consent, and it is a lifetime budget: revoking a mailbox does not give
the slot back. Operators read consumption at:

```text
GET /v1/control/operator/gmail-pilot-budget
```

It reports each environment's consumed accounts, remaining capacity, and a
status of `healthy`, `submit_verification`, or `exhausted`. The route is
support-role gated and deliberately not organisation-visible: consumption is a
deployment-wide number, and showing it on an organisation's page would disclose how
many other organisations exist.

Act on `submit_verification` by starting production verification and the CASA
assessment while capacity remains — reaching `exhausted` means no new mailbox
can be connected until the production project is verified.

## Paused mailboxes

Processing pauses fail closed and never resumes on its own. Every pause names
its exact limit.

The Portal turns a mailbox on with one press and the server's default limits:
3 emails in progress, 20 new emails an hour, 1,000,000 tokens a day, 256 KiB
for one email and 5 MiB for one attachment. The Portal has no form to change
them. To raise a limit, an owner or admin posts the full enabled policy to
`POST /v1/control/organisations/:organisationId/agent-mailboxes/:integrationAccountId/policy`.

| Pause reason                 | Operator action                                         |
| ---------------------------- | ------------------------------------------------------- |
| `active_case_limit`          | Resume: the waiting replies finish, then new mail comes |
| `hourly_message_limit`       | Wait for the window, or raise the limit, then resume    |
| `daily_token_budget`         | Wait for UTC rollover, or raise the budget, then resume |
| `message_too_large`          | Raise the limit, or skip that exact message and resume  |
| `attachment_too_large`       | Raise the limit, or skip that exact message and resume  |
| `attachment_total_too_large` | Raise the limit, or skip that exact message and resume  |
| `authorization_expired`      | Reconnect the mailbox. Resume cannot clear this one     |

An email is in progress from its admission until its reply turn ends: a
reply sent, a draft saved, no reply, a refusal, or the last failed attempt. A
paused mailbox runs no reply turns. Resume runs the waiting turns before it
reads new mail, so a pause at `active_case_limit` clears when the turns end.

Skip-and-resume accepts only the exact message named by the pause. New mail
stays in Gmail while paused and was never sent to the agent.

## Recovery

**Watch expired or lost.** The scheduled reconciler re-establishes
`users.watch` daily and reactivates processing under the current enabled
policy, keeping the accepted history cursor. An owner or admin can do the same
at once with `POST …/agent-mailboxes/:integrationAccountId/reconnect`. The
Portal offers it as Restart mail sync or Resume only when the mailbox shows
one of the two cases below.

**How Reconnect chooses.** Reconnect keeps the cursor by default, so anything
that arrived during an outage is still caught up on the next evaluation. It
takes a fresh activation floor only when the account is degraded with
`gmail_history_expired`, because that is the one case where catching up is
impossible. The response reports which happened as `cursor_reset`.

**History cursor expired.** Gmail no longer retains history from the stored
point, so the account degrades with reason `gmail_history_expired` rather than
silently skipping mail. Republishing the policy does not clear this: an active
runtime updates its limits in place and keeps its cursor. Recovery is
Reconnect, which re-establishes the watch from a fresh activation floor and
returns the account to active. Mail that arrived while the cursor was invalid
is not retroactively admitted; admitting an unbounded backlog would bypass the
hourly and active-Case limits.

**Credential expired or revoked.** Processing pauses fail-closed with
`authorization_expired` rather than retrying quietly, and the Portal states it
on the mailbox card. Re-authorize through the standard provider flow, then
Reconnect. The cursor is preserved, so mail that arrived while authorization
was broken is admitted rather than skipped. On a Testing-status project this
is expected weekly. After the reconnect, Resume on the mailbox starts the
mail sync again.

**Ambiguous send.** A send whose result is unknown records
`send_indeterminate` and never retries blindly. Resolution searches Gmail for
the deterministic dispatch Message-ID. If found, the proposal is marked sent
and the draft is cleaned; if not found, it stays unresolved for another
attempt. No path issues a second send.

**Draft cleanup.** After a confirmed send the proposal draft is deleted. A
failed delete records `cleanup_pending` and is retried by resolution. A delete
rejected for authorization records `cleanup_unreachable`: the draft remains in
the organisation's Gmail and must be removed by hand. Surface it rather than hiding
it.

**Transient turn cleanup.** Each email turn runs in a per-turn workspace inside
the organisation's retained harness container and is torn down on every exit path.
If teardown fails, the container is destroyed and the turn fails closed. There
is no quarantine state to drain.

## Revocation

Revoking a mailbox stops processing, fences pending sends, attempts to delete
every outstanding Pantry-created draft, and revokes the stored credential.
Drafts that cannot be deleted remain in Gmail and report as cleanup needed.
Limited audit metadata is retained under the workspace retention policy.

Verify after revoking: the mailbox reports no active processing, no proposal
remains in an approvable state, and the credential no longer resolves.

Turn off and Remove also withdraw the acceptance of each model's terms
(`revoked_at`) when no mailbox of the Organisation stays on. The next Turn on
asks for the checkbox again.

## Evidence to retain

Provider review and incident review both ask for the same artifacts:

- proof that one mailbox can authorize, refresh, receive a notification,
  reconcile history, and revoke;
- proof that a threaded reply sends exactly once through `messages.send`;
- proof that deterministic Message-ID reconciliation prevents a second send
  after an ambiguous result;
- proof that proposal drafts are deleted after delivery, and that failures
  surface as cleanup needed rather than disappearing; and
- proof that a transient turn appends no accepted history and writes no
  checkpoint; and
- for each Organisation, the acceptance of the model's terms: the row of
  `gmail_inference_eligibility` names the review, the person
  (`consented_by_user_id`), the time and the receipt.

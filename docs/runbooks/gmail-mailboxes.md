# Gmail Agent Mailboxes Runbook

Status: Active operational runbook

Satyr connects an organisation Gmail mailbox to one assigned agent. Inbound mail is
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

| Variable                         | Kind          | Value                                                                                                            |
| -------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GMAIL_OAUTH_CLIENT_ID`          | var           | OAuth client ID                                                                                                  |
| `GMAIL_OAUTH_CLIENT_SECRET`      | secret        | OAuth client secret                                                                                              |
| `GMAIL_PUBSUB_TOPIC`             | var           | `projects/PROJECT/topics/TOPIC`, fully qualified                                                                 |
| `GMAIL_PUBSUB_AUDIENCE`          | var           | Exact `aud` claim on the push token                                                                              |
| `GMAIL_PUBSUB_SERVICE_ACCOUNT`   | var           | Exact `email` claim on the push token                                                                            |
| `GMAIL_PILOT_ACCOUNT_CAP`        | var, optional | Connected Google accounts this project may consume. Defaults to 80                                               |
| `GMAIL_PILOT_SUBMISSION_TRIGGER` | var, optional | Consumption at which to begin verification. Defaults to 50                                                       |
| `GMAIL_OAUTH_PILOT_EXPIRY_DAYS`  | var, optional | Refresh-token lifetime of this Google project. Set to `7` on a Testing-status project; leave unset once verified |

Two URLs are registered with Google and must match byte for byte:

```text
${PANTRY_OAUTH_CALLBACK_ORIGIN}/v1/control/providers/gmail/callback
${PANTRY_OAUTH_CALLBACK_ORIGIN}/hook/email/google
```

Gmail runs in its own Google Cloud project, `satyr-gmail-dev`, separate from
`seams-501403`, which serves portal sign-in and must never receive Gmail
scopes or credentials — a consent screen is per-project, so restricting one
restricts every flow that shares it. The pilot project is External with
Testing status, so refresh tokens expire after seven days and every mailbox
needs weekly reconnection; `GMAIL_OAUTH_PILOT_EXPIRY_DAYS` makes the console
project each expiry and warn before it lapses. Production will be a third,
separate project, created later and published together with restricted-scope
verification.

`GMAIL_PUBSUB_TOPIC` is passed verbatim to `users.watch`. The topic must grant
`roles/pubsub.publisher` to `gmail-api-push@system.gserviceaccount.com` or the
watch call fails outright.

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
6. An operator approves a reviewed snapshot; Satyr sends it once with a
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

| Pause reason                 | Operator action                                         |
| ---------------------------- | ------------------------------------------------------- |
| `active_case_limit`          | Close Cases or raise the limit, then resume             |
| `hourly_message_limit`       | Wait for the window, or raise the limit, then resume    |
| `daily_token_budget`         | Wait for UTC rollover, or raise the budget, then resume |
| `message_too_large`          | Raise the limit, or skip that exact message and resume  |
| `attachment_too_large`       | Raise the limit, or skip that exact message and resume  |
| `attachment_total_too_large` | Raise the limit, or skip that exact message and resume  |
| `authorization_expired`      | Reconnect the mailbox. Resume cannot clear this one     |

Skip-and-resume accepts only the exact message named by the pause. New mail
stays in Gmail while paused and was never sent to the agent.

## Recovery

**Watch expired or lost.** Reconnect the mailbox from the Portal. That
re-establishes `users.watch` and reactivates processing under the current
enabled policy, keeping the accepted history cursor. The scheduled reconciler
performs the same repair daily.

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
is expected weekly, and the console projects the expiry date in advance when
`GMAIL_OAUTH_PILOT_EXPIRY_DAYS` is set.

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
every outstanding Satyr-created draft, and revokes the stored credential.
Drafts that cannot be deleted remain in Gmail and report as cleanup needed.
Limited audit metadata is retained under the workspace retention policy.

Verify after revoking: the mailbox reports no active processing, no proposal
remains in an approvable state, and the credential no longer resolves.

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
  checkpoint.

---
title: Slack liveness
description: Diagnose signed Slack ingress, durable admission, streaming, delivery, and retry failures.
---

# Slack liveness

Slack liveness is the end-to-end property that a signed event becomes durable
Case work, produces a sequenced response, and settles one provider receipt.

## Signal

Check the event path in order:

```text
signed event
  -> verified workspace connection
  -> active destination
  -> ConnectorActor admission
  -> CaseActor output
  -> AgentSessionActor event stream
  -> Slack delivery receipt
```

## Triage

1. Verify the Slack signature and event identity.
2. Confirm the workspace connection and destination are active for the organisation.
3. Inspect ConnectorActor admission and lease state.
4. Inspect the Case output identity and session cursor.
5. Check Slack stream and delivery receipts.
6. Allow the actor alarm to recover an expired lease before manually retrying.

Recovery resumes the admitted target and preserves the original routing and
authorization decisions. A retry must settle the exact output identity rather
than create a duplicate message.

The repository runbook is `docs/runbooks/slack-liveness.md`.

# Slack Event-Flow Liveness Runbook

Status: Active operational runbook

M6 records `install.last_event_received_at` on every verified Slack Events API
delivery. Alerting reads active Slack installs and flags workspaces whose event
flow goes silent after previously receiving traffic.

## Signal

- Scope: `install.surface_kind = 'slack' AND install.status = 'active'`.
- Healthy: `last_event_received_at` advances when Slack sends events.
- Suspect: active install with prior traffic and no new event for the configured
  organisation liveness window.
- New installs with `last_event_received_at IS NULL` are pending verification,
  not silent.
- Local/operator inspection:
  `GET /v1/debug/slack/install-liveness?staleAfterMs=600000`.

## Install Check

- Start OAuth at `/slack/install/start`.
- The start route generates a signed OAuth `state`; `/slack/install` rejects
  missing, expired, future-dated, or signature-mismatched state values.
- Reinstalls update the existing workspace install and keep the stable
  `vault:slack:bot:<team>` token handle.

## Triage

1. Check Worker request logs for `/slack/events` signature failures, `5xx`, or
   queue fallback exhaustion.
2. Check `pantry-event-dlq` for parked Slack events.
3. Check Slack app Event Subscriptions in the app configuration page. Slack may
   disable delivery after sustained failures; re-enable there after the Worker
   is healthy.
4. Send a fresh `app_mention` from the affected workspace and confirm
   `last_event_received_at` advances.

## Recovery

- If events are in the DLQ, replay them after the root cause is fixed.
- If Slack disabled delivery, re-enable Event Subscriptions, then send a test
  event from the workspace.
- Record gaps that are absent from the DLQ as unrecoverable by the current
  runtime. Channel memory resumes from the next verified Events API delivery.

Pantry currently exposes no Slack history or replies reader. Any future repair
runner must remain off the Slack ACK path and live agent turns.

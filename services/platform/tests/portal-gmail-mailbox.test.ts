import { describe, expect, it } from "vitest";

import { emailReplyIsOpenable, emailReplyLifecycleLabel, emailReplyLifecycleStatus, gmailMailboxStatus, gmailMailboxSummary, gmailPauseCopy, gmailProcessingDescription, mailboxAuthorizationNotice, parseMailboxPolicyDraft } from "../../../apps/portal/src/pages/agent-mailbox";
import type { AgentMailboxView, MailboxPauseReasonView } from "@seams/control-api/portal/agent-mailbox";

const NOW = 1_784_016_325_277;

describe("portal gmail mailbox surface", gmailMailboxSurfaceSuite);

function gmailMailboxSurfaceSuite(): void {
  it(
    "publishes a disabled policy whenever processing is unchecked",
    disabledDraftTest,
  );
  it(
    "refuses to publish an enabled policy with any invalid limit",
    limitValidationTest,
  );
  it(
    "never reports processing for a mailbox that only finished OAuth",
    activationStatusTest,
  );
  it("names the exact limit that paused processing", pauseCopyTest);
  it(
    "only offers approval for proposals still awaiting it",
    replyLifecycleTest,
  );
  it(
    "projects the authorization expiry and escalates as it approaches",
    expiryNoticeTest,
  );
}

const DAY = 86_400_000;

/**
 * A pilot authorization dies on Google's clock with no error of its own, so
 * the console has to say the date early, escalate before it passes, and be
 * unambiguous once processing has actually stopped.
 */
function expiryNoticeTest(): void {
  const authorized = {
    authorizedAt: NOW,
    expiresAt: NOW + 7 * DAY,
    expiryWindowDays: 7,
  };

  // Comfortably valid: stated, not alarming.
  const early = mailboxAuthorizationNotice(
    mailbox({ authorization: authorized }),
    NOW + DAY,
  );
  expect(early?.tone).toBe("info");
  expect(early?.headline).toContain("expires");

  // Inside the warning window it escalates and names the deadline.
  const soon = mailboxAuthorizationNotice(
    mailbox({ authorization: authorized }),
    NOW + 7 * DAY - 6 * 3_600_000,
  );
  expect(soon?.tone).toBe("warning");
  expect(soon?.headline).toContain("in 6 hours");
  expect(soon?.detail).toContain("Reconnect");

  // Past the deadline it is unambiguous.
  const lapsed = mailboxAuthorizationNotice(
    mailbox({ authorization: authorized }),
    NOW + 8 * DAY,
  );
  expect(lapsed?.tone).toBe("danger");

  // A mailbox actually paused on expiry outranks any projection, and says what
  // happened to the mail rather than only what happened to the token.
  const paused = mailboxAuthorizationNotice(
    mailbox({
      authorization: authorized,
      runtime: {
        processing: {
          kind: "paused",
          reason: {
            kind: "authorization_expired",
            observed: null,
            limit: null,
            providerMessageId: null,
          },
          pausedAt: NOW,
        },
        acceptedHistoryId: "9001",
        watchExpiresAt: null,
        usage: {
          activeCases: 0,
          admittedLastHour: 0,
          tokensReserved: 0,
          tokensConsumed: 0,
          nextEvaluationAt: null,
        },
      },
    }),
    NOW + DAY,
  );
  expect(paused?.tone).toBe("danger");
  expect(paused?.detail).toContain("never read");

  // A deployment with no configured window invents no date.
  expect(
    mailboxAuthorizationNotice(
      mailbox({
        authorization: {
          authorizedAt: NOW,
          expiresAt: null,
          expiryWindowDays: null,
        },
      }),
      NOW + DAY,
    ),
  ).toBeNull();
  expect(
    mailboxAuthorizationNotice(mailbox({ authorization: null }), NOW),
  ).toBeNull();
}

function mailbox(overrides: Partial<AgentMailboxView> = {}): AgentMailboxView {
  return {
    integrationAccountId: "integration_gmail_1",
    observedAddress: "support@example.com",
    connectionLifecycle: "active",
    authorization: null,
    binding: {
      mailboxBindingId: "mailbox_binding_1",
      currentRevision: 2,
      installationId: "install_1",
    },
    policy: {
      kind: "enabled",
      policyVersion: 3,
      maxActiveCases: 5,
      maxMessagesPerHour: 20,
      dailyTokenBudget: 250_000,
      maxMessageBytes: 262_144,
      maxAttachmentBytes: 5_242_880,
    },
    runtime: {
      processing: { kind: "scheduled", at: NOW + 3_600_000 },
      acceptedHistoryId: "9001",
      watchExpiresAt: NOW + 86_400_000,
      usage: {
        activeCases: 1,
        admittedLastHour: 2,
        tokensReserved: 0,
        tokensConsumed: 12_000,
        nextEvaluationAt: NOW + 3_600_000,
      },
    },
    ...overrides,
  };
}

function policyForm(entries: Readonly<Record<string, string>>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(entries)) form.append(name, value);
  return form;
}

function validLimits(): Record<string, string> {
  return {
    processingEnabled: "on",
    maxActiveCases: "5",
    maxMessagesPerHour: "20",
    dailyTokenBudget: "250000",
    maxMessageBytes: "262144",
    maxAttachmentBytes: "5242880",
  };
}

function disabledDraftTest(): void {
  // An unchecked toggle must publish an explicit operator-disabled revision
  // rather than silently skipping the publish.
  expect(parseMailboxPolicyDraft(policyForm({}))).toEqual({
    kind: "valid",
    policy: { kind: "disabled_by_operator" },
  });
  const withStaleLimits = parseMailboxPolicyDraft(
    policyForm({ maxActiveCases: "5" }),
  );
  expect(withStaleLimits).toEqual({
    kind: "valid",
    policy: { kind: "disabled_by_operator" },
  });
}

function limitValidationTest(): void {
  const valid = parseMailboxPolicyDraft(policyForm(validLimits()));
  expect(valid).toEqual({
    kind: "valid",
    policy: {
      kind: "enabled",
      maxActiveCases: 5,
      maxMessagesPerHour: 20,
      dailyTokenBudget: 250_000,
      maxMessageBytes: 262_144,
      maxAttachmentBytes: 5_242_880,
    },
  });

  for (const field of Object.keys(validLimits()).filter(
    (name) => name !== "processingEnabled",
  )) {
    for (const bad of ["0", "-1", "", "abc", "1.5e"]) {
      const draft = parseMailboxPolicyDraft(
        policyForm({ ...validLimits(), [field]: bad }),
      );
      expect(draft.kind, `${field}=${bad} must not publish`).toBe("invalid");
    }
    const missing = { ...validLimits() };
    delete missing[field];
    expect(parseMailboxPolicyDraft(policyForm(missing)).kind).toBe("invalid");
  }
}

function activationStatusTest(): void {
  // OAuth success alone never presents as processing.
  const connectedOnly = mailbox({
    binding: null,
    policy: { kind: "disabled_by_default" },
    runtime: null,
  });
  expect(gmailMailboxStatus(connectedOnly)).toEqual({
    kind: "info",
    label: "Needs setup",
  });
  expect(gmailMailboxSummary(connectedOnly, null)).toBe(
    "Off. New mail stays in Gmail untouched.",
  );

  // An enabled policy whose runtime has not reported yet is on, not yet live.
  expect(gmailMailboxStatus(mailbox({ runtime: null }))).toEqual({
    kind: "info",
    label: "On",
  });

  // A broken connection outranks any processing state.
  expect(
    gmailMailboxStatus(mailbox({ connectionLifecycle: "degraded" })).kind,
  ).toBe("warning");
  expect(gmailMailboxStatus(mailbox())).toEqual({
    kind: "success",
    label: "On",
  });
  expect(gmailProcessingDescription({ kind: "waiting" })).toEqual(
    expect.any(String),
  );
}

function pauseCopyTest(): void {
  const reason = (
    overrides: Partial<MailboxPauseReasonView>,
  ): MailboxPauseReasonView => ({
    kind: "active_case_limit",
    observed: 5,
    limit: 5,
    providerMessageId: null,
    ...overrides,
  });

  expect(gmailPauseCopy(reason({}))).toContain("active-Case limit");
  expect(
    gmailPauseCopy(
      reason({ kind: "hourly_message_limit", observed: 20, limit: 20 }),
    ),
  ).toContain("hourly message limit");
  expect(
    gmailPauseCopy(
      reason({ kind: "daily_token_budget", observed: null, limit: 250_000 }),
    ),
  ).toContain("250,000");
  expect(
    gmailPauseCopy(
      reason({
        kind: "message_too_large",
        observed: 300_000,
        limit: 262_144,
        providerMessageId: "m1",
      }),
    ),
  ).toContain("larger than the policy allows");
  // An unrecognised reason still explains itself rather than rendering blank.
  expect(gmailPauseCopy(reason({ kind: "reason_from_a_newer_worker" }))).toBe(
    "Processing paused by a policy limit.",
  );

  const paused = mailbox({
    runtime: {
      processing: { kind: "paused", reason: reason({}), pausedAt: NOW },
      acceptedHistoryId: "9001",
      watchExpiresAt: NOW + 86_400_000,
      usage: {
        activeCases: 5,
        admittedLastHour: 0,
        tokensReserved: 0,
        tokensConsumed: 0,
        nextEvaluationAt: null,
      },
    },
  });
  expect(gmailMailboxStatus(paused)).toEqual({
    kind: "warning",
    label: "Paused · 5 open Cases",
  });
}

function replyLifecycleTest(): void {
  expect(emailReplyIsOpenable("awaiting_approval")).toBe(true);
  for (const closed of [
    "sent",
    "rejected",
    "invalidated",
    "expired",
    "superseded",
    "send_indeterminate",
    "proposal_missing",
  ]) {
    expect(
      emailReplyIsOpenable(closed),
      `${closed} must not be approvable`,
    ).toBe(false);
    expect(emailReplyLifecycleLabel(closed)).not.toBe("Recorded");
  }
  expect(emailReplyLifecycleStatus("send_indeterminate")).toEqual({
    kind: "warning",
    label: "Unconfirmed",
  });
  expect(emailReplyLifecycleStatus("sent").kind).toBe("success");
  // A lifecycle this build does not know about is still rendered honestly.
  expect(emailReplyLifecycleLabel("lifecycle_from_a_newer_worker")).toBe(
    "Recorded",
  );
}

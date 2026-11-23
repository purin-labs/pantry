import { describe, expect, it } from "vitest";

import type { EmailReviewProjection } from "@purin-labs/area-inbox/server/data/email-review";
import { buildSlackEmailReviewNotice } from "@purin-labs/surface-slack/server/email-review-notice";

describe("Slack email review notice", () => {
  it("hands an operational email review to the authenticated Portal", () => {
    const notice = buildSlackEmailReviewNotice({
      review: operationalReview("awaiting_approval"),
      portalUrl:
        "https://pantry.example/portal/acme/cafe-operations/integrations#email-review-proposal_operational_1",
    });

    expect(notice).toEqual({
      deliveryId: "delivery_email_review_proposal_operational_1_3",
      text: [
        "*Email review required*",
        "Operational email · Version 3 · Awaiting approval",
        "Sender, recipient, subject, and message content are available only in the authenticated Portal.",
        "<https://pantry.example/portal/acme/cafe-operations/integrations#email-review-proposal_operational_1|Review in Portal>",
      ].join("\n"),
    });
    expect(notice?.text).not.toContain("supplier_1");
    expect(notice?.text).not.toContain("contact_1");
  });

  it("labels Gmail replies without exposing message data", () => {
    const notice = buildSlackEmailReviewNotice({
      review: gmailReplyReview(),
      portalUrl: "https://pantry.example/review",
    });

    expect(notice?.text).toContain("Gmail reply · Version 2");
    expect(notice?.text).not.toContain("gmail-thread-private");
  });

  it("does not create a second card for settled lifecycle states", () => {
    expect(
      buildSlackEmailReviewNotice({
        review: operationalReview("sent"),
        portalUrl: "https://pantry.example/review",
      }),
    ).toBeNull();
  });
});

function operationalReview(lifecycleKind: string): EmailReviewProjection {
  return {
    kind: "operational_new_message",
    proposalId: "proposal_operational_1",
    integrationAccountId: "integration_gmail_1",
    caseId: "case_1",
    version: 3,
    lifecycleKind,
    createdAt: 1_000,
    updatedAt: 1_100,
    backing: {
      kind: "encrypted_connector",
      target: {
        kind: "supplier_contact",
        supplierId: "supplier_1",
        contactId: "contact_1",
        contactRevision: 4,
      },
      snapshotDigest: "a".repeat(64),
      indeterminateRfcMessageId: null,
    },
  };
}

function gmailReplyReview(): EmailReviewProjection {
  return {
    kind: "gmail_reply",
    proposalId: "proposal_reply_1",
    integrationAccountId: "integration_gmail_1",
    caseId: "case_1",
    version: 2,
    lifecycleKind: "awaiting_approval",
    createdAt: 1_000,
    updatedAt: 1_100,
    backing: {
      kind: "gmail_draft",
      gmailThreadId: "gmail-thread-private",
    },
  };
}

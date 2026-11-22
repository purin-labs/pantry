import type {
  MailboxModelConsentRequest,
  MailboxModelReview,
  MailboxSetupModel,
} from "@purin-labs/control-api";

import type {
  ControlMutationBoundary,
  ControlMutationIdentity,
  ControlMutationReceiptScope,
} from "@purin-labs/tenancy/data/control-mutation";
import { prepareOrganisationControlMutationReceipt } from "@purin-labs/tenancy/data/shared-rows/mutation-receipt";
import type { Env } from "@purin-labs/kernel/env";
import type { UserId } from "@purin-labs/control-api/ids";
import {
  organisationChatModelOptions,
  resolveOrganisationModelRouteAtScope,
  type OrganisationModelRoute,
} from "../models/route";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Result } from "@purin-labs/kernel/result";
import {
  prepareGmailModelConsentAfterReceipt,
  readGmailInferenceEligibility,
} from "./contract/gmail-inference-eligibility";
import {
  findGmailModelReview,
  type GmailModelReview,
} from "./contract/gmail-model-reviews";

/**
 * Whether new mail may go to the workspace's present model: Purin reviewed
 * the route, and an owner or admin accepted the review's terms. The read
 * changes nothing.
 */
export async function readGmailModelState(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    now: number;
  }>,
): Promise<MailboxSetupModel> {
  const route = await resolveOrganisationModelRouteAtScope(input);
  if (!route.ok) return { kind: "unavailable" };
  const review = findGmailModelReview(route.value, input.now);
  if (review === null)
    return { kind: "not_reviewed", name: modelName(route.value) };
  const eligibility = await readGmailInferenceEligibility({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    modelRoute: route.value,
    now: input.now,
  });
  return {
    kind: eligibility.kind === "eligible" ? "approved" : "consent_needed",
    review: reviewView(review),
  };
}

export type GmailModelConsentError = Readonly<{
  code:
    | "mailbox_model_unavailable"
    | "mailbox_model_not_reviewed"
    | "mailbox_model_changed"
    | "organisation_placement_conflict";
}>;

/** What one acceptance answers. The receipt replays the same body. */
export type GmailModelConsentReceipt = Readonly<{
  ok: true;
  consent: Readonly<{
    model: string;
    termsUrl: string;
    consentReference: string;
    consentedAt: number;
    reviewExpiresAt: number;
  }>;
}>;

/**
 * Records that one person accepted the data terms of the workspace's
 * present model for new mail. The route that the person read must still be
 * the workspace's route, and Purin's review of it must still stand. The
 * acceptance and the mutation's receipt are one batch, and the receipt id
 * is the acceptance's reference.
 *
 * The control route admits only an owner or admin, the people who turn a
 * mailbox on. No agent tool reaches it: the acceptance is the person's own
 * (Plan 83, "Model review and consent").
 */
export async function consentToGmailModel(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    request: MailboxModelConsentRequest;
    consentedBy: UserId;
    mutation: Readonly<{
      boundary: ControlMutationBoundary;
      scope: ControlMutationReceiptScope;
      identity: ControlMutationIdentity;
    }>;
    now: number;
  }>,
): Promise<Result<GmailModelConsentReceipt, GmailModelConsentError>> {
  const route = await resolveOrganisationModelRouteAtScope(input);
  if (!route.ok)
    return { ok: false, error: { code: "mailbox_model_unavailable" } };
  const review = findGmailModelReview(route.value, input.now);
  if (review === null)
    return { ok: false, error: { code: "mailbox_model_not_reviewed" } };
  if (!readMatches(input.request, review))
    return { ok: false, error: { code: "mailbox_model_changed" } };
  const receipt: GmailModelConsentReceipt = {
    ok: true,
    consent: {
      model: review.route.model,
      termsUrl: review.evidenceReference,
      consentReference: input.mutation.identity.receiptId,
      consentedAt: input.now,
      reviewExpiresAt: review.reviewExpiresAt,
    },
  };
  const session = input.scope.database.withSession("first-primary");
  const [recorded, accepted] = await session.batch([
    prepareOrganisationControlMutationReceipt(session, {
      executionScope: input.scope,
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
      identity: input.mutation.identity,
      responseStatus: 200,
      responseBody: receipt,
    }),
    prepareGmailModelConsentAfterReceipt(session, {
      organisationId: input.scope.organisationId,
      review,
      consentReference: input.mutation.identity.receiptId,
      consentedBy: input.consentedBy,
      now: input.now,
    }),
  ]);
  return recorded?.meta.changes === 1 &&
    accepted?.meta.changes === 1 &&
    (await input.scope.isActive())
    ? { ok: true, value: receipt }
    : { ok: false, error: { code: "organisation_placement_conflict" } };
}

/** The person read this route and these terms. */
function readMatches(
  request: MailboxModelConsentRequest,
  review: GmailModelReview,
): boolean {
  return (
    request.keySource === review.route.keySource &&
    request.provider === review.route.provider &&
    request.model === review.route.model &&
    request.termsUrl === review.evidenceReference
  );
}

function reviewView(review: GmailModelReview): MailboxModelReview {
  return {
    keySource: review.route.keySource,
    provider: review.route.provider,
    model: review.route.model,
    name: review.name,
    recipients: review.disclosedRecipients,
    termsUrl: review.evidenceReference,
    reviewExpiresAt: review.reviewExpiresAt,
  };
}

function modelName(route: OrganisationModelRoute): string {
  return (
    organisationChatModelOptions(route).find(
      (option) => option.id === route.model,
    )?.name ?? route.model
  );
}

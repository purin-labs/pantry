import type { ModelRoute } from "@purin-labs/contracts";
import {
  platformPiModelName,
  type ZeroRetentionPlatformPiModel,
} from "@purin-labs/agent/actors/pi-model-transport";

/**
 * Purin's review of one model route for Gmail content.
 *
 * Gmail's restricted scopes fall under Google's Limited Use rules: the mail
 * goes to a model only to answer it, and nobody trains a model on it. Purin
 * reviews each route one time here, before an owner can accept it: the
 * provider trains on no prompt and keeps no prompt after the answer. A
 * route enters this list only when its requests enforce that in code, and
 * the review names the terms that say so.
 *
 * An owner or admin accepts one review with the checkbox beside Turn on.
 * The acceptance copies the review into `gmail_inference_eligibility`, and
 * each dispatch checks the row against this list again: a model that leaves
 * the list, new terms, or the end of the review stops new mail until a
 * person accepts again. Renew a review before `reviewExpiresAt`: read the
 * terms again, check the routing, and move both dates
 * (docs/runbooks/gmail-mailboxes.md, "Model review").
 */
export type GmailModelReview = Readonly<{
  route: ReviewedRoute;
  /** The model's name, as a person reads it. */
  name: string;
  /** The terms that the review read. The consent names them. */
  evidenceReference: string;
  /** Who reviewed the route. */
  evidenceOwner: string;
  /** Who receives the content of new mail, as a person reads it. */
  disclosedRecipients: string;
  /** What the content is for. Nothing else may use it. */
  permittedPurpose: "email_processing";
  /** What the terms say, in one sentence. The runbook repeats it. */
  finding: string;
  reviewedAt: number;
  reviewExpiresAt: number;
}>;

/**
 * Pantry's paid route through OpenRouter, for a model whose every request
 * sets OpenRouter's zero data retention (`pi-model-transport.ts`). The
 * type refuses a model that keeps its provider's retention.
 */
type ReviewedRoute = Readonly<{
  keySource: "platform";
  provider: "openai-compatible";
  model: ZeroRetentionPlatformPiModel;
}>;

const OPENROUTER_ZERO_RETENTION_TERMS =
  "https://openrouter.ai/docs/guides/features/zdr";
const REVIEWER = "Purin";
const REVIEWED_AT = Date.UTC(2026, 10, 22);
/** Ninety days after the review. */
const REVIEW_EXPIRES_AT = Date.UTC(2027, 1, 20);

/**
 * The reviewed routes. Left off on 2026-11-22, with the reason:
 *
 * - Qwen3.7 Flash on the paid route: its one OpenRouter endpoint
 *   (Alibaba) keeps prompts, and no zero-retention endpoint serves it.
 * - An Organisation's own OpenAI, Anthropic or Gemini API key: each
 *   provider's standard API terms keep every prompt for some days for an
 *   abuse check, unless the account has its own zero-retention agreement,
 *   and a free Gemini API key lets Google use prompts to improve its
 *   products. Pantry cannot see the terms of an Organisation's own account.
 * - A ChatGPT sign-in or a Claude account: consumer and team plans let the
 *   person choose model training in their own account settings, where
 *   Pantry cannot see or enforce the choice.
 */
export const GMAIL_MODEL_REVIEWS: readonly GmailModelReview[] = [
  platformReview(
    "google/gemini-4-hydrogen",
    "OpenRouter and Google Vertex AI",
    "Only Google Vertex AI serves the model under OpenRouter's zero data " +
      "retention, and it trains on no prompt. Its Safety Retention keeps " +
      "only a prompt that Google's safety check flags, for up to 90 days, " +
      "for abuse checks.",
  ),
  platformReview(
    "moonshotai/kimi-k3",
    "OpenRouter and one zero-retention host that OpenRouter chooses",
    "Only hosts under OpenRouter's zero data retention serve the model. " +
      "They train on no prompt and keep no prompt after the answer.",
  ),
];

function platformReview(
  model: ZeroRetentionPlatformPiModel,
  disclosedRecipients: string,
  finding: string,
): GmailModelReview {
  return {
    route: { keySource: "platform", provider: "openai-compatible", model },
    name: platformPiModelName(model),
    evidenceReference: OPENROUTER_ZERO_RETENTION_TERMS,
    evidenceOwner: REVIEWER,
    disclosedRecipients,
    permittedPurpose: "email_processing",
    finding,
    reviewedAt: REVIEWED_AT,
    reviewExpiresAt: REVIEW_EXPIRES_AT,
  };
}

/** The review that covers this exact route now, or null. */
export function findGmailModelReview(
  route: Pick<ModelRoute, "keySource" | "provider" | "model">,
  now: number,
): GmailModelReview | null {
  return (
    GMAIL_MODEL_REVIEWS.find(
      (review) =>
        review.route.keySource === route.keySource &&
        review.route.provider === route.provider &&
        review.route.model === route.model &&
        review.reviewedAt <= now &&
        now < review.reviewExpiresAt,
    ) ?? null
  );
}

import type { RequestAuthority } from "@purin-labs/contracts";
import type { ScreenRelevanceBand } from "@purin-labs/control-api";
import type { Variant } from "@purin-labs/type-utils";
import type { SchemaTransaction } from "@purin-labs/actor-runtime/actors/schema-migrations";
import { newRequestId, type OrganisationId } from "@purin-labs/kernel/ids";
import type { TypeSafeCredential } from "@purin-labs/agent/integrations/typesafe/credential";
import {
  reserveTypeSafeEvaluation,
  settleTypeSafeEvaluation,
  type TypeSafeUsageAuthority,
  type TypeSafeUsageLimits,
} from "@purin-labs/agent/integrations/typesafe/evaluation-ledger";
import { traceLog } from "@purin-labs/kernel/observability";
import { FlowLabel } from "@purin-labs/authority/policy/information-flow/labels";
import type { SerializedFlowLabel } from "@purin-labs/authority/policy/information-flow/types";
import type { Result } from "@purin-labs/kernel/result";
import {
  insertScreenRelevanceRecord,
  readJevScreenRelevanceSwitch,
} from "./screen-relevance";
import {
  JevScreenRelevanceRequest,
  SCREEN_RELEVANCE_JEV_MODEL,
  SCREEN_RELEVANCE_MAX_REQUEST_BYTES,
  type ScreenRelevanceState,
} from "./screen-relevance-jev";

/**
 * Plan 87 D14, tuned on 2026-11-10 from 48 labelled drafts: every draft that
 * was not about the page scored 0.20 or less, and the page questions scored
 * 0.46 or more, so hint at 0.30 sits in that gap and ask at 0.65 asks for
 * most page questions. A new labelled run tunes them again.
 */
const SCREEN_RELEVANCE_ASK = 0.65;
const SCREEN_RELEVANCE_HINT = 0.3;
/** Plan 87 D13: offer a new chat when the page is off the chat's topic. */
const SCREEN_RELEVANCE_OFF_TOPIC = 0.3;

/**
 * Daily limits of the relevance suggestion, under the monthly allowance of
 * Plan 88: at most 500 checks and $0.20 a day. One check sends at most
 * 8 KiB, so it reserves 8,192 input tokens, about $0.00035.
 */
const SCREEN_RELEVANCE_LIMITS: TypeSafeUsageLimits = Object.freeze({
  maxEvaluations: 500,
  maxConcurrentEvaluations: 4,
  maxInputBytes: 500 * SCREEN_RELEVANCE_MAX_REQUEST_BYTES,
  maxInputTokens: 500 * SCREEN_RELEVANCE_MAX_REQUEST_BYTES,
  maxWallMs: 2_500_000,
  maxCostMicrousd: 200_000,
  reservationMicrousd: 400,
  requestTimeoutMs: 5_000,
});

export type ScreenRelevanceCheckInput = Readonly<{
  organisationId: OrganisationId;
  checkId: string;
  userId: string;
  conversationId: string;
  surface: string;
  authority: Variant<RequestAuthority, "control">;
  state: ScreenRelevanceState;
  /** The joined label of the draft, the chat answer and the page. */
  label: SerializedFlowLabel;
}>;

type ScreenRelevanceCheckResult = Readonly<{
  kind: ScreenRelevanceBand;
  offerNewChat: boolean;
  checkId: string | null;
}>;

/** Why no band came back. Each one leaves the attach rule of section 3 alone. */
type ScreenRelevanceCheckError = Readonly<{
  code:
    | "switch_off"
    | "key_unavailable"
    | "label_invalid"
    | "disclosure_denied"
    | "budget_refused"
    | "jev_failed";
}>;

function screenRelevanceBand(
  aboutScreen: number,
  fitsChat: number,
): Readonly<{ kind: ScreenRelevanceBand; offerNewChat: boolean }> {
  if (aboutScreen >= SCREEN_RELEVANCE_ASK)
    return { kind: "ask", offerNewChat: fitsChat < SCREEN_RELEVANCE_OFF_TOPIC };
  if (aboutScreen >= SCREEN_RELEVANCE_HINT)
    return { kind: "hint", offerNewChat: false };
  return { kind: "quiet", offerNewChat: false };
}

/**
 * One relevance check inside the Organisation Actor, which owns the switch,
 * the TypeSafe key, the ledger and the records. The switch and the key are
 * read for each check, so a switch turned off stops the next check.
 */
export async function runScreenRelevanceCheck(
  input: Readonly<{
    sql: SqlStorage;
    transaction: SchemaTransaction;
    credential: TypeSafeCredential | null;
    request: ScreenRelevanceCheckInput;
    fetcher: typeof fetch;
  }>,
): Promise<Result<ScreenRelevanceCheckResult, ScreenRelevanceCheckError>> {
  const request = input.request;
  const switched = readJevScreenRelevanceSwitch(
    input.sql,
    request.organisationId,
  );
  if (!switched.enabled) return failure("switch_off");
  if (input.credential === null) return failure("key_unavailable");
  const label = await FlowLabel.restore(request.label);
  if (!label.ok) return failure("label_invalid");
  const prepared = await JevScreenRelevanceRequest.prepare({
    state: request.state,
    labels: [label.value],
    sink: {
      kind: "typesafe_system_one",
      organisationId: request.organisationId,
      purpose: "screen_relevance",
      funding: input.credential.authority,
      model: SCREEN_RELEVANCE_JEV_MODEL,
      processing: { kind: "authorized_source", authority: request.authority },
    },
  });
  if (!prepared.ok)
    return failure(
      prepared.error.code === "typesafe_disclosure_denied"
        ? "disclosure_denied"
        : "jev_failed",
    );
  const key = {
    organisationId: request.organisationId,
    purpose: "screen_relevance" as const,
    evaluationId: request.checkId,
    requestDigest: prepared.value.disclosure.requestDigest,
  };
  const authority: TypeSafeUsageAuthority = {
    kind: "active",
    revision: switched.revision,
    funding: input.credential.authority,
    limits: SCREEN_RELEVANCE_LIMITS,
  };
  const reserved = input.transaction(
    reserveTypeSafeEvaluation.bind(
      null,
      input.sql,
      {
        ...key,
        policyRevision: switched.revision,
        inputBytes: SCREEN_RELEVANCE_MAX_REQUEST_BYTES,
        reservedInputTokens: SCREEN_RELEVANCE_MAX_REQUEST_BYTES,
        disclosureDecisionDigest: prepared.value.disclosure.decisionDigest,
        now: Date.now(),
      },
      authority,
    ),
  );
  // On `rate_limited` (the fair share of Plan 88 D8) the check drops.
  if (!reserved.ok || reserved.value.kind === "replayed")
    return failure("budget_refused");
  const startedAt = Date.now();
  const evaluated = await prepared.value.evaluate({
    credential: input.credential,
    timeoutMs: SCREEN_RELEVANCE_LIMITS.requestTimeoutMs,
    signal: new AbortController().signal,
    fetcher: input.fetcher,
  });
  const latencyMs = Date.now() - startedAt;
  const current = readJevScreenRelevanceSwitch(
    input.sql,
    request.organisationId,
  );
  const settlementAuthority: TypeSafeUsageAuthority =
    current.enabled && current.revision === switched.revision
      ? authority
      : { kind: "inactive", revision: switched.revision };
  const committed = input.transaction(
    commitScreenRelevanceCheck.bind(null, {
      sql: input.sql,
      key,
      authority: settlementAuthority,
      evaluated,
      request,
    }),
  );
  if (committed.ok && evaluated.ok)
    logScreenRelevanceCheck(request.organisationId, committed.value, {
      aboutScreen: evaluated.value.aboutScreen,
      fitsChat: evaluated.value.fitsChat,
      latencyMs,
    });
  return committed;
}

/**
 * One line for each completed check, quiet ones too, so that the thresholds
 * of D14 can be tuned from production. It holds scores only: no draft, page,
 * title, answer or person.
 */
function logScreenRelevanceCheck(
  organisationId: OrganisationId,
  result: ScreenRelevanceCheckResult,
  scores: Readonly<{
    aboutScreen: number;
    fitsChat: number;
    latencyMs: number;
  }>,
): void {
  traceLog("chat.screen_relevance_checked", {
    requestId: newRequestId(),
    organisation_id: organisationId,
    band: result.kind,
    about_screen: scores.aboutScreen,
    fits_chat: scores.fitsChat,
    model: SCREEN_RELEVANCE_JEV_MODEL,
    offer_new_chat: result.offerNewChat,
    latency_ms: scores.latencyMs,
  });
}

function commitScreenRelevanceCheck(
  input: Readonly<{
    sql: SqlStorage;
    key: Parameters<typeof settleTypeSafeEvaluation>[1];
    authority: TypeSafeUsageAuthority;
    evaluated: Awaited<ReturnType<JevScreenRelevanceRequest["evaluate"]>>;
    request: ScreenRelevanceCheckInput;
  }>,
): Result<ScreenRelevanceCheckResult, ScreenRelevanceCheckError> {
  const now = Date.now();
  const settled = settleTypeSafeEvaluation(
    input.sql,
    input.key,
    input.authority,
    input.evaluated.ok
      ? {
          ok: true,
          value: {
            inputTokens: input.evaluated.value.usage.inputTokens,
            outputTokens: input.evaluated.value.usage.outputTokens,
            estimatedCostMicrousd: input.evaluated.value.usage.costMicrousd,
          },
        }
      : input.evaluated,
    now,
  );
  if (
    !settled.ok ||
    settled.value.receipt.kind !== "evaluated" ||
    !input.evaluated.ok
  )
    return failure("jev_failed");
  const scores = input.evaluated.value;
  const band = screenRelevanceBand(scores.aboutScreen, scores.fitsChat);
  if (band.kind === "quiet")
    return { ok: true, value: { ...band, checkId: null } };
  insertScreenRelevanceRecord(input.sql, {
    organisationId: input.request.organisationId,
    checkId: input.request.checkId,
    userId: input.request.userId,
    conversationId: input.request.conversationId,
    surface: input.request.surface,
    aboutScreen: scores.aboutScreen,
    fitsChat: scores.fitsChat,
    band: band.kind,
    offerNewChat: band.offerNewChat,
    model: SCREEN_RELEVANCE_JEV_MODEL,
    now,
  });
  return { ok: true, value: { ...band, checkId: input.request.checkId } };
}

function failure(
  code: ScreenRelevanceCheckError["code"],
): Result<never, ScreenRelevanceCheckError> {
  return { ok: false, error: { code } };
}

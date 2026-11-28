import { isRecord } from "@purin-labs/std";

/** Settings › AI features › Jev (Plan 88 section 2). */
export type JevFeature =
  "mail_classification" | "related_cases" | "screen_relevance";

export type JevRelatedCasesMode = "shadow" | "metadata_only" | "party_context";

/**
 * What each feature sends to TypeSafe. Settings › Jev, the onboarding step
 * and the agent's change card say it in these words.
 */
export const JEV_FEATURE_SENDS: Readonly<Record<JevFeature, string>> = {
  mail_classification: "The subject, sender and text of each new email",
  related_cases: "Parts of the email and the Case summaries",
  screen_relevance: "The page title and the visible labels",
};

/** "… go to TypeSafe.", the sentence form of `JEV_FEATURE_SENDS`. */
export function jevFeatureSendsSentence(feature: JevFeature): string {
  return `${JEV_FEATURE_SENDS[feature]} go to TypeSafe.`;
}

type JevMailbox = Readonly<{
  integrationAccountId: string;
  displayName: string;
  /** Jev sorts the new mail of this mailbox. */
  covered: boolean;
}>;

export type JevFeaturesView = Readonly<{
  /** Who pays for the calls: Pantry's key, or the Organisation's own key. */
  funding: "pantry_platform" | "organisation_byo";
  /** False when the key of that authority is missing. Jev calls then fail. */
  keyAvailable: boolean;
  mailClassification: Readonly<{
    enabled: boolean;
    mailboxes: readonly JevMailbox[];
  }>;
  relatedCases: Readonly<{
    enabled: boolean;
    mode: JevRelatedCasesMode | null;
    sourceCount: number;
  }>;
  screenRelevance: Readonly<{ enabled: boolean }>;
  /**
   * The free Jev use of the UTC month on Pantry's key (Plan 88 section 3), or
   * null when the Organisation's own key pays.
   */
  allowance: JevAllowance | null;
  /** Paid use above the free use (Plan 88 section 4). Only the owner changes it. */
  paidUse: JevPaidUse;
}>;

type JevPaidUse = Readonly<{
  enabled: boolean;
  spendingLimitMinor: number;
  /** The charge of the month so far, in US cents. */
  spentMinor: number;
  /** Paid use is on and at its limit: Jev stops until the next month. */
  limitReached: boolean;
  /** The highest monthly limit of the Organisation's plan, in US cents. */
  highestSpendingLimitMinor: number;
  /**
   * Whether paid use is open: this deployment bills through Stripe (Plan 95
   * step 6). When false, a person cannot turn paid use on.
   */
  priced: boolean;
}>;

/** Turns paid use on or off, with the monthly spending limit in US cents. */
export type JevPaidUseCommand = Readonly<{
  enabled: boolean;
  spendingLimitMinor: number;
}>;

export function parseJevPaidUseCommand(raw: unknown): JevPaidUseCommand | null {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 2 ||
    typeof raw.enabled !== "boolean" ||
    typeof raw.spendingLimitMinor !== "number" ||
    !Number.isSafeInteger(raw.spendingLimitMinor) ||
    raw.spendingLimitMinor < 1 ||
    raw.spendingLimitMinor > 100_000
  )
    return null;
  return { enabled: raw.enabled, spendingLimitMinor: raw.spendingLimitMinor };
}

export type JevAllowance = Readonly<{
  usedMicrousd: number;
  limitMicrousd: number;
  /** The first millisecond of the next UTC month. */
  resetsAt: number;
  /** No Jev call fits in what is left; Jev features pause until `resetsAt`. */
  reached: boolean;
}>;

export type JevFeatureCommand =
  | Readonly<{ feature: "mail_classification"; enabled: boolean }>
  | Readonly<{
      feature: "related_cases";
      enabled: boolean;
      mode?: "shadow" | "metadata_only";
    }>
  | Readonly<{ feature: "screen_relevance"; enabled: boolean }>;

export function parseJevFeatureCommand(raw: unknown): JevFeatureCommand | null {
  if (!isRecord(raw) || typeof raw.enabled !== "boolean") return null;
  const keys = Object.keys(raw).length;
  if (
    (raw.feature === "mail_classification" ||
      raw.feature === "screen_relevance") &&
    keys === 2
  )
    return { feature: raw.feature, enabled: raw.enabled };
  if (raw.feature !== "related_cases") return null;
  if (keys === 2) return { feature: "related_cases", enabled: raw.enabled };
  if (keys === 3 && (raw.mode === "shadow" || raw.mode === "metadata_only"))
    return { feature: "related_cases", enabled: raw.enabled, mode: raw.mode };
  return null;
}

export function parseJevFeaturesView(raw: unknown): JevFeaturesView {
  if (
    !isRecord(raw) ||
    (raw.funding !== "pantry_platform" && raw.funding !== "organisation_byo") ||
    typeof raw.keyAvailable !== "boolean" ||
    !isRecord(raw.mailClassification) ||
    typeof raw.mailClassification.enabled !== "boolean" ||
    !Array.isArray(raw.mailClassification.mailboxes) ||
    !isRecord(raw.relatedCases) ||
    typeof raw.relatedCases.enabled !== "boolean" ||
    typeof raw.relatedCases.sourceCount !== "number" ||
    !isRecord(raw.screenRelevance) ||
    typeof raw.screenRelevance.enabled !== "boolean"
  )
    throw new Error("Jev settings are unavailable.");
  const mode = raw.relatedCases.mode;
  if (
    mode !== null &&
    mode !== "shadow" &&
    mode !== "metadata_only" &&
    mode !== "party_context"
  )
    throw new Error("Jev settings are unavailable.");
  const mailboxes: JevMailbox[] = [];
  for (const mailbox of raw.mailClassification.mailboxes) {
    if (
      !isRecord(mailbox) ||
      typeof mailbox.integrationAccountId !== "string" ||
      typeof mailbox.displayName !== "string" ||
      typeof mailbox.covered !== "boolean"
    )
      throw new Error("Jev settings are unavailable.");
    mailboxes.push({
      integrationAccountId: mailbox.integrationAccountId,
      displayName: mailbox.displayName,
      covered: mailbox.covered,
    });
  }
  return {
    funding: raw.funding,
    keyAvailable: raw.keyAvailable,
    mailClassification: {
      enabled: raw.mailClassification.enabled,
      mailboxes,
    },
    relatedCases: {
      enabled: raw.relatedCases.enabled,
      mode,
      sourceCount: raw.relatedCases.sourceCount,
    },
    screenRelevance: { enabled: raw.screenRelevance.enabled },
    allowance: parseJevAllowance(raw.allowance),
    paidUse: parseJevPaidUse(raw.paidUse),
  };
}

function parseJevPaidUse(raw: unknown): JevPaidUse {
  if (
    !isRecord(raw) ||
    typeof raw.enabled !== "boolean" ||
    !nonNegativeInteger(raw.spendingLimitMinor) ||
    !nonNegativeInteger(raw.spentMinor) ||
    typeof raw.limitReached !== "boolean" ||
    !nonNegativeInteger(raw.highestSpendingLimitMinor) ||
    typeof raw.priced !== "boolean"
  )
    throw new Error("Jev settings are unavailable.");
  return {
    enabled: raw.enabled,
    spendingLimitMinor: raw.spendingLimitMinor,
    spentMinor: raw.spentMinor,
    limitReached: raw.limitReached,
    highestSpendingLimitMinor: raw.highestSpendingLimitMinor,
    priced: raw.priced,
  };
}

function parseJevAllowance(raw: unknown): JevAllowance | null {
  if (raw === null) return null;
  if (
    !isRecord(raw) ||
    !nonNegativeInteger(raw.usedMicrousd) ||
    !nonNegativeInteger(raw.limitMicrousd) ||
    !nonNegativeInteger(raw.resetsAt) ||
    typeof raw.reached !== "boolean"
  )
    throw new Error("Jev settings are unavailable.");
  return {
    usedMicrousd: raw.usedMicrousd,
    limitMicrousd: raw.limitMicrousd,
    resetsAt: raw.resetsAt,
    reached: raw.reached,
  };
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

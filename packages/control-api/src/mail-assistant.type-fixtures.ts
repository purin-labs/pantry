import type {
  MailAssistantCommand,
  MailAssistantResult,
  MailAssistantStatus,
} from "./mail-assistant.ts";
const propose = {
  kind: "proposeRule",
  prompt: "Prioritize supplier delays",
  consent: true,
  modelRouteDigest: "0".repeat(64),
} as const;
// @ts-expect-error A rule request cannot include a decision selection through a spread.
const mixedCommand: MailAssistantCommand = { ...propose, messageId: "message" };
// @ts-expect-error An explanation requires an exact rule revision.
const unfencedExplanation: MailAssistantCommand = {
  kind: "explainDecision",
  messageId: "message",
  ruleId: "rule",
  consent: true,
  modelRouteDigest: "0".repeat(64),
};
// @ts-expect-error Consent is required for content-bearing inference.
const missingConsent: MailAssistantCommand = {
  kind: "proposeRule",
  prompt: "Supplier delays",
};
const explanation = {
  kind: "explanation",
  text: "Current evidence",
  evidence: "current",
} as const;
// @ts-expect-error Results cannot mix an explanation with a rule proposal.
const mixedResult: MailAssistantResult = {
  ...explanation,
  rule: { kind: "prioritize", ruleId: "rule", instruction: "Supplier delays" },
};
// @ts-expect-error A ready model disclosure always identifies the recipient.
const undisclosedModel: MailAssistantStatus = { kind: "ready", model: "model" };
void mixedCommand;
void unfencedExplanation;
void missingConsent;
void mixedResult;
void undisclosedModel;

import { isRecord } from "@purin-labs/std";
import {
  mailIdentifier,
  mailRevision,
  parseMailRules,
  type MailRule,
} from "./mail-organization.ts";

export type MailAssistantCommand =
  | Readonly<{
      kind: "proposeRule";
      prompt: string;
      consent: true;
      modelRouteDigest: string;
      messageId?: never;
      ruleId?: never;
      expectedRevision?: never;
    }>
  | Readonly<{
      kind: "explainDecision";
      messageId: string;
      ruleId: string;
      expectedRevision: number;
      consent: true;
      modelRouteDigest: string;
      prompt?: never;
    }>;
export type MailAssistantStatus =
  | Readonly<{
      kind: "ready";
      model: string;
      recipient: "openrouter" | "openai" | "anthropic";
      modelRouteDigest: string;
    }>
  | Readonly<{
      kind: "blocked";
      reason: "model_unavailable" | "eligibility_required";
    }>;
export type MailAssistantResult =
  | Readonly<{
      kind: "ruleProposal";
      rule: MailRule;
      text?: never;
      evidence?: never;
    }>
  | Readonly<{
      kind: "explanation";
      text: string;
      evidence: "current" | "changed";
      rule?: never;
    }>;

export function parseMailAssistantCommand(
  raw: unknown,
): MailAssistantCommand | null {
  if (
    !isRecord(raw) ||
    raw.consent !== true ||
    typeof raw.modelRouteDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.modelRouteDigest)
  )
    return null;
  if (
    raw.kind === "proposeRule" &&
    Object.keys(raw).length === 4 &&
    typeof raw.prompt === "string" &&
    raw.prompt.trim().length > 0 &&
    raw.prompt.length <= 2000
  )
    return {
      kind: "proposeRule",
      prompt: raw.prompt.trim(),
      consent: true,
      modelRouteDigest: raw.modelRouteDigest,
    };
  if (
    raw.kind === "explainDecision" &&
    Object.keys(raw).length === 6 &&
    mailIdentifier(raw.messageId) &&
    mailIdentifier(raw.ruleId) &&
    mailRevision(raw.expectedRevision)
  )
    return {
      kind: "explainDecision",
      messageId: raw.messageId,
      ruleId: raw.ruleId,
      expectedRevision: raw.expectedRevision,
      consent: true,
      modelRouteDigest: raw.modelRouteDigest,
    };
  return null;
}
export function parseMailAssistantResult(
  raw: unknown,
): MailAssistantResult | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "ruleProposal" && Object.keys(raw).length === 2) {
    const rules = parseMailRules([raw.rule]);
    const rule = rules?.at(0);
    return rule === undefined ? null : { kind: "ruleProposal", rule };
  }
  if (
    raw.kind === "explanation" &&
    Object.keys(raw).length === 3 &&
    typeof raw.text === "string" &&
    raw.text.trim().length > 0 &&
    raw.text.length <= 4000 &&
    (raw.evidence === "current" || raw.evidence === "changed")
  )
    return {
      kind: "explanation",
      text: raw.text.trim(),
      evidence: raw.evidence,
    };
  return null;
}
export function parseMailAssistantStatus(
  raw: unknown,
): MailAssistantStatus | null {
  if (!isRecord(raw)) return null;
  if (
    raw.kind === "ready" &&
    Object.keys(raw).length === 4 &&
    typeof raw.modelRouteDigest === "string" &&
    /^[a-f0-9]{64}$/.test(raw.modelRouteDigest) &&
    typeof raw.model === "string" &&
    raw.model.length > 0 &&
    (raw.recipient === "openrouter" ||
      raw.recipient === "openai" ||
      raw.recipient === "anthropic")
  )
    return {
      kind: "ready",
      model: raw.model,
      recipient: raw.recipient,
      modelRouteDigest: raw.modelRouteDigest,
    };
  if (
    raw.kind === "blocked" &&
    Object.keys(raw).length === 2 &&
    (raw.reason === "model_unavailable" ||
      raw.reason === "eligibility_required")
  )
    return { kind: "blocked", reason: raw.reason };
  return null;
}

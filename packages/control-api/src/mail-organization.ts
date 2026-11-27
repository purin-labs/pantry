import { isRecord } from "@purin-labs/std";

export type MailRule = Readonly<{
  ruleId: string;
  instruction: string;
  agentId?: never;
  action?: never;
}> &
  (
    | Readonly<{ kind: "categorize"; category: string }>
    | Readonly<{ kind: "prioritize"; category?: never }>
    | Readonly<{ kind: "investigate_supplier_delay"; category?: never }>
  );
export type MailMatch = "matched" | "not_matched" | "needs_review";
export type MailRuleSet =
  | Readonly<{ kind: "empty"; revision: 0; rules: readonly [] }>
  | Readonly<{
      kind: "published" | "paused";
      revision: number;
      rules: readonly MailRule[];
      activatedAt: number;
    }>;
export type MailClassification = Readonly<{
  messageId: string;
  threadId: string;
  ruleId: string;
  outcome: MailMatch;
  source: "jev" | "operator";
  evaluatedAt: number;
}>;
export type MailOrganizationView = Readonly<{
  rules: MailRuleSet;
  readiness:
    | "ready"
    | "typesafe_unavailable"
    | "eligibility_required"
    | "history_expired";
  pending: number;
  failed: number;
  budgetPaused: number;
  classifications: readonly MailClassification[];
}>;
export type MailOrganizationCommand =
  | Readonly<{
      kind: "publish";
      expectedRevision: number;
      rules: readonly MailRule[];
      consent: true;
    }>
  | Readonly<{ kind: "pause"; expectedRevision: number }>
  | Readonly<{
      kind: "resume";
      expectedRevision: number;
      rules?: never;
      consent?: never;
      messageIds?: never;
      messageId?: never;
      ruleId?: never;
      outcome?: never;
    }>
  | Readonly<{
      kind: "preview";
      rules: readonly MailRule[];
      messageIds: readonly string[];
      consent: true;
    }>
  | Readonly<{
      kind: "classify";
      expectedRevision: number;
      messageIds: readonly string[];
    }>
  | Readonly<{
      kind: "correct";
      expectedRevision: number;
      messageId: string;
      ruleId: string;
      outcome: MailMatch;
    }>;

export function mailIdentifier(raw: unknown): raw is string {
  return (
    typeof raw === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(raw)
  );
}
export function mailRevision(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;
}
export function mailMatch(raw: unknown): raw is MailMatch {
  return raw === "matched" || raw === "not_matched" || raw === "needs_review";
}
export function parseMailRules(raw: unknown): readonly MailRule[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) return null;
  const rules: MailRule[] = [];
  const ids = new Set<string>();
  let investigation = false;
  for (const rule of raw) {
    if (
      !isRecord(rule) ||
      !mailIdentifier(rule.ruleId) ||
      ids.has(rule.ruleId) ||
      typeof rule.instruction !== "string" ||
      rule.instruction.trim().length === 0 ||
      rule.instruction.length > 1000
    )
      return null;
    ids.add(rule.ruleId);
    if (
      rule.kind === "categorize" &&
      Object.keys(rule).length === 4 &&
      typeof rule.category === "string" &&
      rule.category.trim().length > 0 &&
      rule.category.length <= 60
    ) {
      rules.push({
        kind: "categorize",
        ruleId: rule.ruleId,
        instruction: rule.instruction.trim(),
        category: rule.category.trim(),
      });
    } else if (rule.kind === "prioritize" && Object.keys(rule).length === 3) {
      rules.push({
        kind: "prioritize",
        ruleId: rule.ruleId,
        instruction: rule.instruction.trim(),
      });
    } else if (
      rule.kind === "investigate_supplier_delay" &&
      Object.keys(rule).length === 3 &&
      !investigation
    ) {
      investigation = true;
      rules.push({
        kind: "investigate_supplier_delay",
        ruleId: rule.ruleId,
        instruction: rule.instruction.trim(),
      });
    } else return null;
  }
  return rules;
}
export function parseMailRuleSet(raw: unknown): MailRuleSet | null {
  if (!isRecord(raw)) return null;
  if (
    raw.kind === "empty" &&
    raw.revision === 0 &&
    Array.isArray(raw.rules) &&
    raw.rules.length === 0
  )
    return { kind: "empty", revision: 0, rules: [] };
  const rules = parseMailRules(raw.rules);
  if (
    (raw.kind !== "published" && raw.kind !== "paused") ||
    !mailRevision(raw.revision) ||
    raw.revision === 0 ||
    !mailRevision(raw.activatedAt) ||
    rules === null
  )
    return null;
  return {
    kind: raw.kind,
    revision: raw.revision,
    rules,
    activatedAt: raw.activatedAt,
  };
}
export function parseMailOrganizationCommand(
  raw: unknown,
): MailOrganizationCommand | null {
  if (!isRecord(raw)) return null;
  if (
    raw.kind === "publish" &&
    Object.keys(raw).length === 4 &&
    mailRevision(raw.expectedRevision) &&
    raw.consent === true
  ) {
    const rules = parseMailRules(raw.rules);
    return rules === null
      ? null
      : {
          kind: "publish",
          expectedRevision: raw.expectedRevision,
          rules,
          consent: true,
        };
  }
  if (
    (raw.kind === "pause" || raw.kind === "resume") &&
    Object.keys(raw).length === 2 &&
    mailRevision(raw.expectedRevision)
  )
    return { kind: raw.kind, expectedRevision: raw.expectedRevision };
  if (
    (raw.kind === "preview" || raw.kind === "classify") &&
    Object.keys(raw).length === (raw.kind === "preview" ? 4 : 3)
  ) {
    const messageIds = parseMessageIds(raw.messageIds);
    if (messageIds === null) return null;
    if (raw.kind === "classify" && mailRevision(raw.expectedRevision))
      return {
        kind: "classify",
        expectedRevision: raw.expectedRevision,
        messageIds,
      };
    const rules = parseMailRules(raw.rules);
    if (raw.kind === "preview" && rules !== null && raw.consent === true)
      return { kind: "preview", rules, messageIds, consent: true };
  }
  if (
    raw.kind === "correct" &&
    Object.keys(raw).length === 5 &&
    mailRevision(raw.expectedRevision) &&
    mailIdentifier(raw.messageId) &&
    mailIdentifier(raw.ruleId) &&
    mailMatch(raw.outcome)
  )
    return {
      kind: "correct",
      expectedRevision: raw.expectedRevision,
      messageId: raw.messageId,
      ruleId: raw.ruleId,
      outcome: raw.outcome,
    };
  return null;
}
function parseMessageIds(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 25) return null;
  const ids: string[] = [];
  for (const id of raw) {
    if (!mailIdentifier(id) || ids.includes(id)) return null;
    ids.push(id);
  }
  return ids;
}
export function parseMailClassifications(
  raw: unknown,
): readonly MailClassification[] | null {
  if (!Array.isArray(raw) || raw.length > 560) return null;
  const results: MailClassification[] = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      !mailIdentifier(item.messageId) ||
      !mailIdentifier(item.threadId) ||
      !mailIdentifier(item.ruleId) ||
      !mailMatch(item.outcome) ||
      (item.source !== "jev" && item.source !== "operator") ||
      !mailRevision(item.evaluatedAt)
    )
      return null;
    results.push({
      messageId: item.messageId,
      threadId: item.threadId,
      ruleId: item.ruleId,
      outcome: item.outcome,
      source: item.source,
      evaluatedAt: item.evaluatedAt,
    });
  }
  return results;
}

export type MailDecision = Readonly<{
  classification: MailClassification;
  rule: MailRule;
  evidence: "current" | "changed";
}>;

export function parseMailDecision(raw: unknown): MailDecision | null {
  if (!isRecord(raw)) return null;
  const classifications = parseMailClassifications([raw.classification]);
  const rules = parseMailRules([raw.rule]);
  const classification = classifications?.[0];
  const rule = rules?.[0];
  if (
    classification === undefined ||
    rule === undefined ||
    classification.ruleId !== rule.ruleId ||
    (raw.evidence !== "current" && raw.evidence !== "changed")
  )
    return null;
  return { classification, rule, evidence: raw.evidence };
}

export function parseMailClassificationSelection(
  raw: unknown,
): readonly string[] | null {
  if (!Array.isArray(raw) || raw.length > 70) return null;
  const ids: string[] = [];
  for (const id of raw) {
    if (!mailIdentifier(id) || ids.includes(id)) return null;
    ids.push(id);
  }
  return ids;
}
export function parseMailOrganizationView(
  raw: unknown,
): MailOrganizationView | null {
  if (!isRecord(raw)) return null;
  const rules = parseMailRuleSet(raw.rules);
  const classifications = parseMailClassifications(raw.classifications);
  if (
    rules === null ||
    classifications === null ||
    !mailRevision(raw.pending) ||
    !mailRevision(raw.failed) ||
    !mailRevision(raw.budgetPaused) ||
    (raw.readiness !== "ready" &&
      raw.readiness !== "typesafe_unavailable" &&
      raw.readiness !== "eligibility_required" &&
      raw.readiness !== "history_expired")
  )
    return null;
  return {
    rules,
    classifications,
    pending: raw.pending,
    failed: raw.failed,
    budgetPaused: raw.budgetPaused,
    readiness: raw.readiness,
  };
}

import {
  mailIdentifier,
  mailRevision,
  parseMailRuleSet,
  type MailRuleSet,
  type MailRule,
} from "@purin-labs/control-api";
import type { RequestAuthority } from "@purin-labs/contracts";
import { isRecord } from "@purin-labs/std";
import { parseStoredRequestAuthority } from "../request-authority";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Variant } from "@purin-labs/type-utils";

export type MailObservation =
  | Readonly<{
      kind: "watching";
      historyId: string;
      historyPageToken: string | null;
      watchExpiresAt: number;
    }>
  | Readonly<{
      kind: "history_expired";
      historyId?: never;
      historyPageToken?: never;
      watchExpiresAt?: never;
    }>;
export type MailOrganizationHead = Readonly<{
  organisationId: OrganisationId;
  integrationAccountId: IntegrationAccountId;
  view: Exclude<MailRuleSet, { kind: "empty" }>;
  authority: Variant<RequestAuthority, "control">;
  sourcePin: string;
  classificationRevision: number;
  observation: MailObservation;
  action: MailAction;
}>;
export type MailAction =
  | Readonly<{
      kind: "none";
      ruleId?: never;
      historyFloor?: never;
      mailboxBindingId?: never;
      bindingRevision?: never;
      policyVersion?: never;
    }>
  | Readonly<{
      kind: "supplier_delay";
      ruleId: string;
      historyFloor: string;
      mailboxBindingId: string;
      bindingRevision: number;
      policyVersion: number;
    }>;
export type MailWork = Readonly<{
  workId: string;
  messageId: string;
  threadId: string;
  revision: number;
  origin: "arrival" | "historical";
}>;
export function parseMailOrganizationHead(
  raw: unknown,
): MailOrganizationHead | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.organisationId !== "string" ||
    typeof raw.integrationAccountId !== "string"
  )
    return null;
  const organisationId = parseOrganisationId(raw.organisationId);
  const accountId = parseIntegrationAccountId(raw.integrationAccountId);
  const view = parseMailRuleSet(raw.view);
  const authority = parseStoredRequestAuthority(raw.authority);
  const observation = parseMailObservation(raw.observation);
  const action = parseMailAction(raw.action);
  if (
    !organisationId.ok ||
    !accountId.ok ||
    view === null ||
    view.kind === "empty" ||
    !authority.ok ||
    authority.value.requestAuthority.kind !== "control" ||
    authority.value.requestAuthority.organisationId !== organisationId.value ||
    typeof raw.classificationRevision !== "number" ||
    !Number.isSafeInteger(raw.classificationRevision) ||
    raw.classificationRevision < 1 ||
    raw.classificationRevision > view.revision ||
    typeof raw.sourcePin !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.sourcePin) ||
    observation === null ||
    action === null ||
    !actionMatchesRules(action, view.rules)
  )
    return null;
  return {
    organisationId: organisationId.value,
    integrationAccountId: accountId.value,
    view,
    authority: authority.value.requestAuthority,
    sourcePin: raw.sourcePin,
    classificationRevision: raw.classificationRevision,
    observation,
    action,
  };
}
function actionMatchesRules(
  action: MailAction,
  rules: readonly MailRule[],
): boolean {
  for (const rule of rules)
    if (rule.kind === "investigate_supplier_delay")
      return action.kind === "supplier_delay" && action.ruleId === rule.ruleId;
  return action.kind === "none";
}

function parseMailAction(raw: unknown): MailAction | null {
  // Existing organization-only publications normalize at the persistence boundary.
  if (raw === undefined) return { kind: "none" };
  if (!isRecord(raw)) return null;
  if (raw.kind === "none" && Object.keys(raw).length === 1)
    return { kind: "none" };
  if (
    raw.kind !== "supplier_delay" ||
    Object.keys(raw).length !== 6 ||
    !mailIdentifier(raw.ruleId) ||
    typeof raw.historyFloor !== "string" ||
    !/^\d+$/.test(raw.historyFloor) ||
    !mailIdentifier(raw.mailboxBindingId) ||
    !mailRevision(raw.bindingRevision) ||
    raw.bindingRevision === 0 ||
    !mailRevision(raw.policyVersion) ||
    raw.policyVersion === 0
  )
    return null;
  return {
    kind: "supplier_delay",
    ruleId: raw.ruleId,
    historyFloor: raw.historyFloor,
    mailboxBindingId: raw.mailboxBindingId,
    bindingRevision: raw.bindingRevision,
    policyVersion: raw.policyVersion,
  };
}

function parseMailObservation(raw: unknown): MailObservation | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "history_expired" && Object.keys(raw).length === 1)
    return { kind: "history_expired" };
  if (
    raw.kind !== "watching" ||
    typeof raw.historyId !== "string" ||
    !/^\d+$/.test(raw.historyId) ||
    (raw.historyPageToken !== null &&
      (typeof raw.historyPageToken !== "string" ||
        raw.historyPageToken.length > 2048)) ||
    typeof raw.watchExpiresAt !== "number" ||
    !Number.isSafeInteger(raw.watchExpiresAt)
  )
    return null;
  return {
    kind: "watching",
    historyId: raw.historyId,
    historyPageToken: raw.historyPageToken,
    watchExpiresAt: raw.watchExpiresAt,
  };
}

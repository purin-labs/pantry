import { isNonEmptyString, isRecord, positiveIntegerOrNull } from "@purin-labs/std";
import type {
  WhatsAppAgentMode,
  WhatsAppCasePanelEntry,
  WhatsAppProviderHealth,
} from "../index.ts";

export type WhatsAppPolicyView =
  | { readonly kind: "disabled_by_default" }
  | { readonly kind: "disabled_by_operator"; readonly policyVersion: number }
  | {
      readonly kind: "enabled";
      readonly policyVersion: number;
      readonly maxActiveCases: number;
      readonly maxMessagesPerHour: number;
      readonly dailyAgentTokenBudget: number;
      readonly maxMessageBytes: number;
      readonly maxActiveCaseMessages: number;
      readonly maxActiveCaseBytes: number;
      readonly debounceSeconds: number;
      readonly relevantMessageTopics: string;
      readonly automaticAcknowledgementText: string;
      readonly agentMode: WhatsAppAgentMode;
      readonly alwaysWaitTopics: string;
    };

type WhatsAppProcessingView =
  | { readonly kind: "waiting" }
  | { readonly kind: "scheduled"; readonly at: number }
  | { readonly kind: "processing"; readonly caseId: string }
  | {
      readonly kind: "paused";
      readonly reasonKind: string;
      readonly pausedAt: number;
    };

export type WhatsAppRuntimeView = {
  readonly processing: WhatsAppProcessingView;
  readonly activeCases: number;
  readonly admittedLastHour: number;
  readonly tokensReserved: number;
  readonly tokensConsumed: number;
};

export type WhatsAppAccountView = {
  readonly integrationAccountId: string;
  readonly wabaId: string;
  readonly phoneNumberId: string;
  readonly displayPhoneNumber: string;
  readonly verifiedName: string;
  /** Null while the number is a discovered candidate the owner has not chosen. */
  readonly selectedAt: number | null;
  readonly providerHealth: WhatsAppProviderHealth;
  readonly policy: WhatsAppPolicyView;
  readonly binding: {
    readonly supportBindingId: string;
    readonly currentRevision: number;
    readonly installationId: string;
  } | null;
  readonly runtime: WhatsAppRuntimeView | null;
};

export type WhatsAppSurface = {
  readonly applicationConfigured: boolean;
  readonly accounts: readonly WhatsAppAccountView[];
  readonly replies: readonly WhatsAppReplyQueueItem[];
};

type WhatsAppReplyQueueItem = {
  readonly proposalId: string;
  readonly integrationAccountId: string;
  readonly caseId: string;
  readonly customerWaId: string;
  readonly version: number;
  readonly lifecycleKind: string;
  readonly author: "agent" | "human";
  readonly serviceWindowExpiresAt: number;
  readonly updatedAt: number;
};

export type WhatsAppReplyPreview =
  | {
      readonly kind: "current";
      readonly proposal: {
        readonly proposalId: string;
        readonly version: number;
        readonly caseId: string;
        readonly customerWaId: string;
        readonly author: "agent" | "human";
        readonly body: string;
        readonly bodyDigest: string;
        readonly serviceWindowExpiresAt: number;
        readonly expiresAt: number;
      };
    }
  | { readonly kind: "proposal_missing" }
  | { readonly kind: "expired" }
  | { readonly kind: "send_indeterminate"; readonly version: number };

export type WhatsAppCaseView = {
  readonly caseId: string;
  readonly customerWaId: string;
  readonly ownershipKind: "agent_active" | "human_owned";
  readonly handoffRequestedAt: number | null;
  readonly handoffReason: string | null;
  readonly serviceWindowExpiresAt: number;
  readonly messages: readonly WhatsAppCasePanelEntry[];
};

export type WhatsAppPolicyDraft = {
  readonly maxActiveCases: number;
  readonly maxMessagesPerHour: number;
  readonly dailyAgentTokenBudget: number;
  readonly maxMessageBytes: number;
  readonly maxActiveCaseMessages: number;
  readonly maxActiveCaseBytes: number;
  readonly debounceSeconds: number;
  readonly relevantMessageTopics: string;
  readonly automaticAcknowledgementText: string;
};

export function parseWhatsAppSurface(
  raw: unknown,
  replies: unknown,
): WhatsAppSurface {
  if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.accounts)) {
    throw new Error("The server returned an invalid WhatsApp surface.");
  }
  return {
    applicationConfigured: raw.application_configured === true,
    accounts: raw.accounts.map(parseWhatsAppAccount),
    replies: parseWhatsAppReplyQueue(replies),
  };
}

function parseWhatsAppAccount(raw: unknown): WhatsAppAccountView {
  if (
    !isRecord(raw) ||
    !isNonEmptyString(raw.integration_account_id) ||
    !isNonEmptyString(raw.waba_id) ||
    !isNonEmptyString(raw.phone_number_id) ||
    !isNonEmptyString(raw.display_phone_number)
  ) {
    throw new Error("The server returned an invalid WhatsApp phone number.");
  }
  return {
    integrationAccountId: raw.integration_account_id,
    wabaId: raw.waba_id,
    phoneNumberId: raw.phone_number_id,
    displayPhoneNumber: raw.display_phone_number,
    verifiedName:
      typeof raw.verified_name === "string" ? raw.verified_name : "",
    selectedAt: typeof raw.selected_at === "number" ? raw.selected_at : null,
    providerHealth: parseProviderHealth(raw.provider_health),
    policy: parseWhatsAppPolicy(raw.policy),
    binding: parseWhatsAppBinding(raw.binding),
    runtime: parseWhatsAppRuntime(raw.runtime),
  };
}

function parseWhatsAppReplyQueue(
  raw: unknown,
): readonly WhatsAppReplyQueueItem[] {
  if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.proposals))
    return [];
  const items: WhatsAppReplyQueueItem[] = [];
  for (const entry of raw.proposals) {
    if (
      !isRecord(entry) ||
      !isNonEmptyString(entry.proposal_id) ||
      !isNonEmptyString(entry.integration_account_id) ||
      !isNonEmptyString(entry.case_id) ||
      !isNonEmptyString(entry.customer_wa_id) ||
      !isNonEmptyString(entry.lifecycle_kind)
    ) {
      continue;
    }
    const version = positiveIntegerOrNull(entry.version);
    if (version === null) continue;
    items.push({
      proposalId: entry.proposal_id,
      integrationAccountId: entry.integration_account_id,
      caseId: entry.case_id,
      customerWaId: entry.customer_wa_id,
      version,
      lifecycleKind: entry.lifecycle_kind,
      author: entry.author === "human" ? "human" : "agent",
      serviceWindowExpiresAt: numberOrZero(entry.service_window_expires_at),
      updatedAt: numberOrZero(entry.updated_at),
    });
  }
  return items;
}

export function parseWhatsAppReplyPreview(raw: unknown): WhatsAppReplyPreview {
  if (!isRecord(raw) || raw.ok !== true) {
    throw new Error("The server returned an invalid WhatsApp reply preview.");
  }
  if (raw.kind === "proposal_missing") return { kind: "proposal_missing" };
  if (raw.kind === "expired") return { kind: "expired" };
  if (raw.kind === "send_indeterminate") {
    return {
      kind: "send_indeterminate",
      version: positiveIntegerOrNull(raw.version) ?? 1,
    };
  }
  const proposal = raw.proposal;
  if (
    raw.kind !== "current" ||
    !isRecord(proposal) ||
    !isNonEmptyString(proposal.proposal_id) ||
    !isNonEmptyString(proposal.case_id) ||
    !isNonEmptyString(proposal.customer_wa_id) ||
    typeof proposal.body !== "string" ||
    !isNonEmptyString(proposal.body_digest)
  ) {
    throw new Error("The server returned an invalid WhatsApp reply preview.");
  }
  return {
    kind: "current",
    proposal: {
      proposalId: proposal.proposal_id,
      version: positiveIntegerOrNull(proposal.version) ?? 1,
      caseId: proposal.case_id,
      customerWaId: proposal.customer_wa_id,
      author: proposal.author === "human" ? "human" : "agent",
      body: proposal.body,
      bodyDigest: proposal.body_digest,
      serviceWindowExpiresAt: numberOrZero(proposal.service_window_expires_at),
      expiresAt: numberOrZero(proposal.expires_at),
    },
  };
}

export function parseWhatsAppCaseView(raw: unknown): WhatsAppCaseView {
  const value = isRecord(raw) && raw.ok === true ? raw.case : null;
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.caseId) ||
    !isNonEmptyString(value.customerWaId) ||
    !Array.isArray(value.messages)
  ) {
    throw new Error("The server returned an invalid WhatsApp Case.");
  }
  const ownership =
    isRecord(value.ownership) && value.ownership.kind === "human_owned"
      ? ("human_owned" as const)
      : ("agent_active" as const);
  const messages: WhatsAppCasePanelEntry[] = [];
  for (const entry of value.messages) {
    if (
      !isRecord(entry) ||
      typeof entry.text !== "string" ||
      !isNonEmptyString(entry.providerMessageId)
    ) {
      continue;
    }
    messages.push({
      direction: entry.direction === "outbound" ? "outbound" : "inbound",
      occurredAt: numberOrZero(entry.occurredAt),
      providerMessageId: entry.providerMessageId,
      text: entry.text,
    });
  }
  return {
    caseId: value.caseId,
    customerWaId: value.customerWaId,
    ownershipKind: ownership,
    handoffRequestedAt:
      typeof value.handoffRequestedAt === "number"
        ? value.handoffRequestedAt
        : null,
    handoffReason:
      typeof value.handoffReason === "string" ? value.handoffReason : null,
    serviceWindowExpiresAt: numberOrZero(value.serviceWindowExpiresAt),
    messages,
  };
}

export function parseWhatsAppPolicyDraft(
  formData: FormData,
): WhatsAppPolicyDraft | null {
  const fields = [
    "maxActiveCases",
    "maxMessagesPerHour",
    "dailyAgentTokenBudget",
    "maxMessageBytes",
    "maxActiveCaseMessages",
    "maxActiveCaseBytes",
    "debounceSeconds",
  ] as const;
  const values: Record<string, number> = {};
  for (const field of fields) {
    const raw = formData.get(field);
    const value =
      typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    values[field] = value;
  }
  const debounceSeconds = values.debounceSeconds ?? 0;
  if (debounceSeconds < 10 || debounceSeconds > 30) return null;
  const relevantTopics = formData.get("relevantMessageTopics");
  if (typeof relevantTopics !== "string") return null;
  const relevantMessageTopics = relevantTopics.trim();
  if (
    relevantMessageTopics.length === 0 ||
    Array.from(relevantMessageTopics).length > 2_000
  ) {
    return null;
  }
  const acknowledgement = formData.get("automaticAcknowledgementText");
  if (typeof acknowledgement !== "string") return null;
  const automaticAcknowledgementText = acknowledgement.trim();
  if (
    automaticAcknowledgementText.length === 0 ||
    Array.from(automaticAcknowledgementText).length > 1_000
  ) {
    return null;
  }
  return {
    maxActiveCases: values.maxActiveCases ?? 0,
    maxMessagesPerHour: values.maxMessagesPerHour ?? 0,
    dailyAgentTokenBudget: values.dailyAgentTokenBudget ?? 0,
    maxMessageBytes: values.maxMessageBytes ?? 0,
    maxActiveCaseMessages: values.maxActiveCaseMessages ?? 0,
    maxActiveCaseBytes: values.maxActiveCaseBytes ?? 0,
    debounceSeconds,
    relevantMessageTopics,
    automaticAcknowledgementText,
  };
}

function parseProviderHealth(raw: unknown): WhatsAppProviderHealth {
  if (!isRecord(raw)) return { kind: "pending" };
  switch (raw.kind) {
    case "healthy":
      return {
        kind: "healthy",
        webhookVerifiedAt: numberOrZero(raw.webhookVerifiedAt),
      };
    case "degraded":
      return {
        kind: "degraded",
        reasonCode: isNonEmptyString(raw.reasonCode)
          ? raw.reasonCode
          : "unknown",
      };
    case "unsubscribed":
      return { kind: "unsubscribed" };
    case "revoked":
      return { kind: "revoked" };
    default:
      return { kind: "pending" };
  }
}

function parseWhatsAppPolicy(raw: unknown): WhatsAppPolicyView {
  if (!isRecord(raw)) return { kind: "disabled_by_default" };
  if (raw.kind === "disabled_by_default")
    return { kind: "disabled_by_default" };
  const policyVersion = positiveIntegerOrNull(raw.policyVersion);
  if (policyVersion === null) return { kind: "disabled_by_default" };
  if (raw.kind === "disabled_by_operator")
    return { kind: "disabled_by_operator", policyVersion };
  if (raw.kind !== "enabled") return { kind: "disabled_by_default" };
  const limits = [
    positiveIntegerOrNull(raw.maxActiveCases),
    positiveIntegerOrNull(raw.maxMessagesPerHour),
    positiveIntegerOrNull(raw.dailyAgentTokenBudget),
    positiveIntegerOrNull(raw.maxMessageBytes),
    positiveIntegerOrNull(raw.maxActiveCaseMessages),
    positiveIntegerOrNull(raw.maxActiveCaseBytes),
    positiveIntegerOrNull(raw.debounceSeconds),
  ];
  if (limits.some((limit) => limit === null))
    return { kind: "disabled_by_default" };
  if (
    !isNonEmptyString(raw.relevantMessageTopics) ||
    !isNonEmptyString(raw.automaticAcknowledgementText)
  ) {
    return { kind: "disabled_by_default" };
  }
  return {
    kind: "enabled",
    policyVersion,
    maxActiveCases: limits[0] ?? 0,
    maxMessagesPerHour: limits[1] ?? 0,
    dailyAgentTokenBudget: limits[2] ?? 0,
    maxMessageBytes: limits[3] ?? 0,
    maxActiveCaseMessages: limits[4] ?? 0,
    maxActiveCaseBytes: limits[5] ?? 0,
    debounceSeconds: limits[6] ?? 0,
    agentMode:
      raw.agentMode === "off" || raw.agentMode === "draft"
        ? raw.agentMode
        : "answer",
    alwaysWaitTopics:
      typeof raw.alwaysWaitTopics === "string" ? raw.alwaysWaitTopics : "",
    relevantMessageTopics: raw.relevantMessageTopics.trim(),
    automaticAcknowledgementText: raw.automaticAcknowledgementText.trim(),
  };
}

function parseWhatsAppBinding(raw: unknown): WhatsAppAccountView["binding"] {
  if (!isRecord(raw)) return null;
  const currentRevision = positiveIntegerOrNull(raw.current_revision);
  if (
    !isNonEmptyString(raw.support_binding_id) ||
    currentRevision === null ||
    !isNonEmptyString(raw.installation_id)
  ) {
    return null;
  }
  return {
    supportBindingId: raw.support_binding_id,
    currentRevision,
    installationId: raw.installation_id,
  };
}

function parseWhatsAppRuntime(raw: unknown): WhatsAppRuntimeView | null {
  if (!isRecord(raw) || !isRecord(raw.processing) || !isRecord(raw.usage))
    return null;
  const processing = raw.processing;
  const usage = raw.usage;
  const view: WhatsAppProcessingView =
    processing.kind === "scheduled"
      ? { kind: "scheduled", at: numberOrZero(processing.at) }
      : processing.kind === "processing"
        ? {
            kind: "processing",
            caseId: isNonEmptyString(processing.caseId)
              ? processing.caseId
              : "",
          }
        : processing.kind === "paused"
          ? {
              kind: "paused",
              reasonKind:
                isRecord(processing.reason) &&
                isNonEmptyString(processing.reason.kind)
                  ? processing.reason.kind
                  : "unknown",
              pausedAt: numberOrZero(processing.pausedAt),
            }
          : { kind: "waiting" };
  const tokens = isRecord(usage.tokens) ? usage.tokens : {};
  return {
    processing: view,
    activeCases: numberOrZero(usage.activeCases),
    admittedLastHour: numberOrZero(usage.admittedLastHour),
    tokensReserved: numberOrZero(tokens.reserved),
    tokensConsumed: numberOrZero(tokens.consumed),
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

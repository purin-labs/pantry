import type { ConnectorIdentity } from "@purin-labs/contracts";
import type { IntegrationAccountId } from "@purin-labs/kernel/ids";
import type { WhatsAppIngressLimits } from "@purin-labs/area-inbox/server/actors/connector-whatsapp";
import {
  parseWhatsAppReplyOrigin,
  type WhatsAppReplyOrigin,
  type WhatsAppAdmissionRequest,
} from "../connector-whatsapp-rpc";
import type { WhatsAppIndeterminateResolution } from "../connector-whatsapp-proposal";
import {
  checked,
  textFieldSchema,
  whatsappAuthorityFieldsSchema,
  whatsappConversationHeadsFieldsSchema,
  whatsappDispatchFieldsSchema,
  whatsappDisposalFieldsSchema,
  whatsappEditFieldsSchema,
  whatsappEventSchema,
  whatsappHumanReplyFieldsSchema,
  whatsappIdentityRequestSchema,
  whatsappLimitsSchema,
  whatsappResolutionSchema,
  whatsappResumeFieldsSchema,
} from "@purin-labs/contracts/connector-rpc";
import { isRecord } from "@purin-labs/std";

type ConnectorWhatsAppIdentityRequest = {
  readonly identity: ConnectorIdentity;
  readonly now: number;
};

type WhatsAppAuthorityRequest = ConnectorWhatsAppIdentityRequest & {
  readonly policyVersion: number;
  readonly limits: WhatsAppIngressLimits;
  readonly supportBindingId: string;
  readonly bindingRevision: number;
  readonly credentialGeneration: number;
};

export function parseWhatsAppIdentityRequest(
  value: unknown,
): ConnectorWhatsAppIdentityRequest | null {
  const request = checked(whatsappIdentityRequestSchema, value);
  return request === null
    ? null
    : {
        identity: {
          organisationId: request.identity.organisationId,
          connectorId: request.identity.connectorId,
        } as ConnectorIdentity,
        now: request.now,
      };
}

function parseWhatsAppLimits(value: unknown): WhatsAppIngressLimits | null {
  const limits = checked(whatsappLimitsSchema, value);
  return limits === null
    ? null
    : {
        maxActiveCases: limits.maxActiveCases,
        maxMessagesPerHour: limits.maxMessagesPerHour,
        dailyAgentTokenBudget: limits.dailyAgentTokenBudget,
        maxMessageBytes: limits.maxMessageBytes,
        maxActiveCaseMessages: limits.maxActiveCaseMessages,
        maxActiveCaseBytes: limits.maxActiveCaseBytes,
        debounceSeconds: limits.debounceSeconds,
      };
}

function parseWhatsAppAuthorityRequest(
  value: unknown,
): WhatsAppAuthorityRequest | null {
  const base = parseWhatsAppIdentityRequest(value);
  const fields = checked(whatsappAuthorityFieldsSchema, value);
  if (base === null || fields === null) return null;
  const limits = parseWhatsAppLimits(fields.limits);
  return limits === null
    ? null
    : {
        ...base,
        limits,
        policyVersion: fields.policyVersion,
        supportBindingId: fields.supportBindingId,
        bindingRevision: fields.bindingRevision,
        credentialGeneration: fields.credentialGeneration,
      };
}

export function parseWhatsAppActivationRequest(value: unknown):
  | (WhatsAppAuthorityRequest & {
      readonly integrationAccountId: string;
    })
  | null {
  const base = parseWhatsAppAuthorityRequest(value);
  const fields = checked(textFieldSchema("integrationAccountId"), value);
  return base === null || fields === null
    ? null
    : { ...base, integrationAccountId: fields.integrationAccountId };
}

export function parseWhatsAppResumeRequest(value: unknown):
  | (WhatsAppAuthorityRequest & {
      readonly skipProviderMessageId: string | null;
    })
  | null {
  const base = parseWhatsAppAuthorityRequest(value);
  const fields = checked(whatsappResumeFieldsSchema, value);
  return base === null || fields === null
    ? null
    : { ...base, skipProviderMessageId: fields.skipProviderMessageId ?? null };
}

export function parseWhatsAppConversationHeadsRequest(
  value: unknown,
):
  | (ConnectorWhatsAppIdentityRequest & { readonly caseIds: readonly string[] })
  | null {
  const base = parseWhatsAppIdentityRequest(value);
  const fields = checked(whatsappConversationHeadsFieldsSchema, value);
  return base === null || fields === null
    ? null
    : { ...base, caseIds: [...fields.caseIds] };
}

export function parseWhatsAppCaseRequest(value: unknown):
  | (ConnectorWhatsAppIdentityRequest & {
      readonly caseId: string;
    })
  | null {
  const base = parseWhatsAppIdentityRequest(value);
  const fields = checked(textFieldSchema("caseId"), value);
  return base === null || fields === null
    ? null
    : { ...base, caseId: fields.caseId };
}

export function parseWhatsAppProposalRequest(value: unknown):
  | (ConnectorWhatsAppIdentityRequest & {
      readonly proposalId: string;
    })
  | null {
  const base = parseWhatsAppIdentityRequest(value);
  const fields = checked(textFieldSchema("proposalId"), value);
  return base === null || fields === null
    ? null
    : { ...base, proposalId: fields.proposalId };
}

/** The reply origin of a request, or null. */
function replyOrigin(value: unknown): WhatsAppReplyOrigin | null {
  return isRecord(value) ? parseWhatsAppReplyOrigin(value.origin) : null;
}

export function parseWhatsAppEditRequest(value: unknown):
  | (ConnectorWhatsAppIdentityRequest & {
      readonly origin: WhatsAppReplyOrigin;
      readonly proposalId: string;
      readonly body: string;
      readonly maxReplyChars: number;
    })
  | null {
  const origin = replyOrigin(value);
  const base = parseWhatsAppProposalRequest(value);
  const fields = checked(whatsappEditFieldsSchema, value);
  return origin === null || base === null || fields === null
    ? null
    : {
        ...base,
        origin,
        body: fields.body,
        maxReplyChars: fields.maxReplyChars,
      };
}

export function parseWhatsAppDispatchRequest(value: unknown):
  | (ConnectorWhatsAppIdentityRequest & {
      readonly origin: WhatsAppReplyOrigin;
      readonly proposalId: string;
      readonly approvedVersion: number;
      readonly approvedBodyDigest: string;
      readonly approvedBy: string;
    })
  | null {
  const origin = replyOrigin(value);
  const base = parseWhatsAppProposalRequest(value);
  const fields = checked(whatsappDispatchFieldsSchema, value);
  return origin === null || base === null || fields === null
    ? null
    : {
        ...base,
        origin,
        approvedVersion: fields.approvedVersion,
        approvedBodyDigest: fields.approvedBodyDigest,
        approvedBy: fields.approvedBy,
      };
}

export function parseWhatsAppDisposalRequest(value: unknown):
  | (ConnectorWhatsAppIdentityRequest & {
      readonly proposalId: string;
      readonly state: "rejected" | "taken_over" | "revoked" | "expired";
      readonly actorUserId: string;
    })
  | null {
  const base = parseWhatsAppProposalRequest(value);
  const fields = checked(whatsappDisposalFieldsSchema, value);
  return base === null || fields === null
    ? null
    : { ...base, state: fields.state, actorUserId: fields.actorUserId };
}

export function parseWhatsAppResolutionRequest(value: unknown):
  | (ConnectorWhatsAppIdentityRequest & {
      readonly proposalId: string;
      readonly resolution: WhatsAppIndeterminateResolution;
    })
  | null {
  const base = parseWhatsAppProposalRequest(value);
  const resolution = isRecord(value)
    ? checked(whatsappResolutionSchema, value.resolution)
    : null;
  if (base === null || resolution === null) return null;
  return resolution.kind === "not_delivered"
    ? { ...base, resolution: { kind: "not_delivered" } }
    : {
        ...base,
        resolution: {
          kind: "delivered",
          whatsappMessageId: resolution.whatsappMessageId,
        },
      };
}

export function parseWhatsAppTakeoverRequest(value: unknown):
  | (ConnectorWhatsAppIdentityRequest & {
      readonly origin: WhatsAppReplyOrigin;
      readonly caseId: string;
      readonly operatorUserId: string;
    })
  | null {
  const origin = replyOrigin(value);
  const base = parseWhatsAppCaseRequest(value);
  const fields = checked(textFieldSchema("operatorUserId"), value);
  return origin === null || base === null || fields === null
    ? null
    : { ...base, origin, operatorUserId: fields.operatorUserId };
}

export function parseWhatsAppHumanReplyRequest(value: unknown):
  | (ConnectorWhatsAppIdentityRequest & {
      readonly origin: WhatsAppReplyOrigin;
      readonly caseId: string;
      readonly proposalId: string;
      readonly body: string;
      readonly maxReplyChars: number;
      readonly expiresAt: number;
    })
  | null {
  const origin = replyOrigin(value);
  const base = parseWhatsAppCaseRequest(value);
  const fields = checked(whatsappHumanReplyFieldsSchema, value);
  return origin === null || base === null || fields === null
    ? null
    : {
        ...base,
        origin,
        proposalId: fields.proposalId,
        body: fields.body,
        maxReplyChars: fields.maxReplyChars,
        expiresAt: fields.expiresAt,
      };
}

export function parseWhatsAppEventRequest(value: unknown):
  | (ConnectorWhatsAppIdentityRequest & {
      readonly event: WhatsAppAdmissionRequest;
    })
  | null {
  const base = parseWhatsAppIdentityRequest(value);
  const event = isRecord(value)
    ? checked(whatsappEventSchema, value.event)
    : null;
  if (base === null || event === null) return null;
  switch (event.kind) {
    case "text_message":
      return {
        ...base,
        event: {
          kind: "text_message",
          customerWaId: event.customerWaId,
          providerMessageId: event.providerMessageId,
          providerTimestamp: event.providerTimestamp,
          body: event.body,
        },
      };
    case "unsupported_message":
      return {
        ...base,
        event: {
          kind: "unsupported_message",
          customerWaId: event.customerWaId,
          providerMessageId: event.providerMessageId,
          messageType: event.messageType,
        },
      };
    case "status":
      return {
        ...base,
        event: {
          kind: "status",
          whatsappMessageId: event.whatsappMessageId,
          status: event.status,
          statusAt: event.statusAt,
          failureCode: event.failureCode ?? null,
        },
      };
  }
}

/** Plan 40D: what a reply rests on. */
export type EmailReplyProvenance =
  | Readonly<{ kind: "mailbox" }>
  | Readonly<{
      kind: "chat";
      chatSources: readonly import("@purin-labs/area-inbox/server/mail-inbox/reply-sources").EmailChatSource[];
      chatContext: import("@purin-labs/area-inbox/server/mail-inbox/reply-sources").EmailChatContext;
    }>;

export type ConnectorEmailIdentityRequest = {
  readonly identity: ConnectorIdentity;
  readonly now: number;
};

export type EmailMailboxRevocationRequest = ConnectorEmailIdentityRequest & {
  readonly kind: "stand_down" | "erase";
  readonly integrationAccountId: IntegrationAccountId;
};

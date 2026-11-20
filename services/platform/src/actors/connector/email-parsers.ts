import {
  parseSessionTurnExecution,
  type SessionTurnExecution,
} from "../../chat/turn-access";
import type { ConnectorIdentity } from "@purin-labs/contracts";
import {
  parseIntegrationAccountId,
  parseRequestId,
  type IntegrationAccountId,
} from "../../ids";
import { gmailConnectorIdValue } from "../../mail-inbox/contract/connector-ids";
import { parseEmailProposalTarget } from "../../data/email-operational";
import {
  CAPABILITY_KEYS,
  capabilityDefinitionById,
} from "../../authorization/capability-catalogue";
import type { EmailIngressLimits } from "../connector-email";
import type { GmailMessageContent } from "../../mail/gmail-adapter";
import {
  parseEmailChatContext,
  parseEmailChatSources,
  parseEmailReplySources,
} from "../email-proposal-sources";
import type {
  EmailChatContext,
  EmailChatSource,
  EmailReplySources,
} from "../../mail-inbox/reply-sources";
import {
  checked,
  emailActivationFieldsSchema,
  emailChangeFieldsSchema,
  emailCheckFieldsSchema,
  emailDispatchFieldsSchema,
  emailLimitsSchema,
  emailMailboxSearchRequestSchema,
  emailOperationalAccountRequestSchema,
  emailOperationalDispatchRequestSchema,
  emailOperationalProposalCreateRequestSchema,
  emailOperationalProposalEditRequestSchema,
  emailOperationalProposalRequestSchema,
  emailReconnectFieldsSchema,
  emailReplyProposalCreateRequestSchema,
  emailResolveFieldsSchema,
  emailResumeFieldsSchema,
  emailRevocationFieldsSchema,
  textFieldSchema,
  whatsappIdentityRequestSchema,
} from "@purin-labs/contracts/connector-rpc";
import type {
  ConnectorEmailIdentityRequest,
  EmailMailboxRevocationRequest,
} from "./whatsapp-parsers";

export type EmailReplyProposalCreateRequest = ConnectorEmailIdentityRequest & {
  readonly execution: SessionTurnExecution;
  readonly caseId: string;
  readonly proposalId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly body: string;
  /** The records that the draft cites, as the chat's Session verified them. */
  readonly sources: EmailReplySources;
  /** Every source that the chat read before it drafted. */
  readonly chatSources: readonly EmailChatSource[];
  /** The Memories and Projects that the chat's context showed. */
  readonly chatContext: EmailChatContext;
};

type EmailOperationalProposalCreateRequest = ConnectorEmailIdentityRequest & {
  readonly execution: SessionTurnExecution;
  readonly integrationAccountId: string;
  readonly caseId: string;
  readonly proposalId: string;
  readonly target: import("../../data/email-operational").EmailProposalTarget;
  readonly subject: string;
  readonly body: string;
  readonly policyVersion: number;
  readonly expiresAt: number;
};

type EmailOperationalProposalEditRequest = ConnectorEmailIdentityRequest & {
  readonly integrationAccountId: string;
  readonly proposalId: string;
  readonly subject: string;
  readonly body: string;
  readonly expectedVersion?: number;
};

type EmailOperationalProposalRequest = ConnectorEmailIdentityRequest & {
  readonly integrationAccountId: string;
  readonly proposalId: string;
};

type EmailOperationalAccountRequest = ConnectorEmailIdentityRequest & {
  readonly integrationAccountId: string;
};

type EmailOperationalDispatchRequest = EmailOperationalProposalRequest & {
  readonly approvedVersion: number;
  readonly approvedSnapshotDigest: string;
};

function parseConnectorEmailIdentity(
  value: unknown,
): ConnectorEmailIdentityRequest | null {
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

export function parseEmailIdentityRequest(
  value: unknown,
): ConnectorEmailIdentityRequest | null {
  return parseConnectorEmailIdentity(value);
}

export function parseEmailMailboxRevocationRequest(
  value: unknown,
): EmailMailboxRevocationRequest | null {
  const base = parseConnectorEmailIdentity(value);
  const fields = checked(emailRevocationFieldsSchema, value);
  if (base === null || fields === null) return null;
  const account = parseIntegrationAccountId(fields.integrationAccountId);
  if (
    !account.ok ||
    base.identity.connectorId !== gmailConnectorIdValue(account.value)
  )
    return null;
  return {
    identity: base.identity,
    now: base.now,
    kind: fields.kind,
    integrationAccountId: account.value,
  };
}

export function parseEmailProposalRequest(value: unknown):
  | (ConnectorEmailIdentityRequest & {
      readonly proposalId: string;
    })
  | null {
  const base = parseConnectorEmailIdentity(value);
  const fields = checked(textFieldSchema("proposalId"), value);
  return base === null || fields === null
    ? null
    : { ...base, proposalId: fields.proposalId };
}

export function parseEmailMailboxSearchRequest(value: unknown):
  | (ConnectorEmailIdentityRequest & {
      readonly execution: SessionTurnExecution;
      readonly query: string;
      readonly limit: number;
    })
  | null {
  const base = parseConnectorEmailIdentity(value);
  const request = checked(emailMailboxSearchRequestSchema, value);
  const execution =
    request === null ? null : parseSessionTurnExecution(request.execution);
  if (
    base === null ||
    request === null ||
    execution === null ||
    Array.from(request.query.normalize("NFKC")).length > 256
  )
    return null;
  return {
    identity: base.identity,
    now: base.now,
    execution,
    query: request.query.trim(),
    limit: request.limit,
  };
}

export function emailMessageExceedsLimit(
  maxMessageBytes: number,
  message: GmailMessageContent,
): boolean {
  return message.decodedBodyBytes > maxMessageBytes;
}

export function parseEmailReplyProposalCreateRequest(
  value: unknown,
): EmailReplyProposalCreateRequest | null {
  const base = parseConnectorEmailIdentity(value);
  const request = checked(emailReplyProposalCreateRequestSchema, value);
  const execution =
    request === null ? null : parseSessionTurnExecution(request.execution);
  if (
    base === null ||
    request === null ||
    execution === null ||
    request.threadId.length > 256 ||
    request.messageId.length > 256 ||
    Array.from(request.body).length > 20_000
  )
    return null;
  const sources = parseEmailReplySources(request.sources);
  const chatSources = parseEmailChatSources(request.chatSources);
  const chatContext = parseEmailChatContext(request.chatContext);
  if (sources === null || chatSources === null || chatContext === null)
    return null;
  return {
    identity: base.identity,
    now: base.now,
    execution,
    caseId: request.caseId,
    proposalId: request.proposalId,
    threadId: request.threadId,
    messageId: request.messageId,
    body: request.body.trim(),
    sources,
    chatSources,
    chatContext,
  };
}

export function parseEmailOperationalProposalCreateRequest(
  value: unknown,
): EmailOperationalProposalCreateRequest | null {
  const base = parseConnectorEmailIdentity(value);
  const request = checked(emailOperationalProposalCreateRequestSchema, value);
  const execution =
    request === null ? null : parseSessionTurnExecution(request.execution);
  if (
    base === null ||
    request === null ||
    execution === null ||
    request.subject.length > 998 ||
    request.body.length > 20_000 ||
    request.policyVersion !==
      capabilityDefinitionById(CAPABILITY_KEYS.emailOperationalPropose)
        .capabilityVersion ||
    request.expiresAt <= base.now
  )
    return null;
  const target = parseEmailProposalTarget(request.target);
  return target === null
    ? null
    : {
        identity: base.identity,
        now: base.now,
        execution,
        integrationAccountId: request.integrationAccountId,
        caseId: request.caseId,
        proposalId: request.proposalId,
        target,
        subject: request.subject.trim(),
        body: request.body.trim(),
        policyVersion: request.policyVersion,
        expiresAt: request.expiresAt,
      };
}

export function parseEmailOperationalProposalEditRequest(
  value: unknown,
): EmailOperationalProposalEditRequest | null {
  const base = parseConnectorEmailIdentity(value);
  const request = checked(emailOperationalProposalEditRequestSchema, value);
  if (
    base === null ||
    request === null ||
    request.subject.length > 998 ||
    request.body.length > 20_000
  )
    return null;
  return {
    ...base,
    integrationAccountId: request.integrationAccountId,
    proposalId: request.proposalId,
    subject: request.subject.trim(),
    body: request.body.trim(),
    ...(request.expectedVersion === undefined
      ? {}
      : { expectedVersion: request.expectedVersion }),
  };
}

export function parseEmailOperationalProposalRequest(
  value: unknown,
): EmailOperationalProposalRequest | null {
  const base = parseConnectorEmailIdentity(value);
  const request = checked(emailOperationalProposalRequestSchema, value);
  return base === null || request === null
    ? null
    : {
        ...base,
        integrationAccountId: request.integrationAccountId,
        proposalId: request.proposalId,
      };
}

export function parseEmailOperationalAccountRequest(
  value: unknown,
): EmailOperationalAccountRequest | null {
  const base = parseConnectorEmailIdentity(value);
  const request = checked(emailOperationalAccountRequestSchema, value);
  return base === null || request === null
    ? null
    : { ...base, integrationAccountId: request.integrationAccountId };
}

export function parseEmailOperationalDispatchRequest(
  value: unknown,
): EmailOperationalDispatchRequest | null {
  const base = parseConnectorEmailIdentity(value);
  const request = checked(emailOperationalDispatchRequestSchema, value);
  return base === null || request === null
    ? null
    : {
        ...base,
        integrationAccountId: request.integrationAccountId,
        proposalId: request.proposalId,
        approvedVersion: request.approvedVersion,
        approvedSnapshotDigest: request.approvedSnapshotDigest,
      };
}

export function parseEmailResolveRequest(value: unknown):
  | (ConnectorEmailIdentityRequest & {
      readonly proposalId: string;
      readonly dispatchVersion: number;
    })
  | null {
  const base = parseEmailProposalRequest(value);
  const fields = checked(emailResolveFieldsSchema, value);
  return base === null || fields === null
    ? null
    : { ...base, dispatchVersion: fields.dispatchVersion };
}

export function parseEmailDispatchRequest(value: unknown):
  | (ConnectorEmailIdentityRequest & {
      readonly proposalId: string;
      readonly approvedVersion: number;
      readonly approvedSnapshotDigest: string;
    })
  | null {
  const base = parseEmailProposalRequest(value);
  const fields = checked(emailDispatchFieldsSchema, value);
  return base === null || fields === null
    ? null
    : {
        ...base,
        approvedVersion: fields.approvedVersion,
        approvedSnapshotDigest: fields.approvedSnapshotDigest,
      };
}

export function parseEmailChangeRequest(value: unknown):
  | (ConnectorEmailIdentityRequest & {
      readonly notificationId: string;
      readonly historyId: string;
    })
  | null {
  const base = parseConnectorEmailIdentity(value);
  const fields = checked(emailChangeFieldsSchema, value);
  return base === null || fields === null
    ? null
    : {
        ...base,
        notificationId: fields.notificationId,
        historyId: fields.historyId,
      };
}

export function parseEmailCheckRequest(value: unknown):
  | (ConnectorEmailIdentityRequest & {
      readonly integrationAccountId: IntegrationAccountId;
      readonly checkId: string;
    })
  | null {
  const base = parseConnectorEmailIdentity(value);
  const fields = checked(emailCheckFieldsSchema, value);
  if (base === null || fields === null || !parseRequestId(fields.checkId).ok)
    return null;
  const account = parseIntegrationAccountId(fields.integrationAccountId);
  if (
    !account.ok ||
    base.identity.connectorId !== gmailConnectorIdValue(account.value)
  )
    return null;
  return {
    ...base,
    integrationAccountId: account.value,
    checkId: fields.checkId,
  };
}

function parseEmailLimits(value: unknown): EmailIngressLimits | null {
  const limits = checked(emailLimitsSchema, value);
  return limits === null
    ? null
    : {
        maxActiveCases: limits.maxActiveCases,
        maxMessagesPerHour: limits.maxMessagesPerHour,
        dailyTokenBudget: limits.dailyTokenBudget,
        maxMessageBytes: limits.maxMessageBytes,
        maxAttachmentBytes: limits.maxAttachmentBytes,
        debounce: { kind: "push_triggered", coalesceSeconds: 30 },
      };
}

export function parseEmailActivationRequest(value: unknown):
  | (ConnectorEmailIdentityRequest & {
      readonly integrationAccountId: string;
      readonly policyVersion: number;
      readonly limits: EmailIngressLimits;
    })
  | null {
  const base = parseConnectorEmailIdentity(value);
  const fields = checked(emailActivationFieldsSchema, value);
  const limits = fields === null ? null : parseEmailLimits(fields.limits);
  return base === null || fields === null || limits === null
    ? null
    : {
        ...base,
        integrationAccountId: fields.integrationAccountId,
        policyVersion: fields.policyVersion,
        limits,
      };
}

export function parseEmailReconnectRequest(value: unknown):
  | (ConnectorEmailIdentityRequest & {
      readonly integrationAccountId: string;
      readonly policyVersion: number;
      readonly limits: EmailIngressLimits;
      readonly resetCursor: boolean;
    })
  | null {
  const base = parseEmailActivationRequest(value);
  const fields = checked(emailReconnectFieldsSchema, value);
  return base === null || fields === null
    ? null
    : { ...base, resetCursor: fields.resetCursor };
}

export function parseEmailResumeRequest(value: unknown):
  | (ConnectorEmailIdentityRequest & {
      readonly policyVersion: number;
      readonly limits: EmailIngressLimits;
      readonly skipProviderMessageId: string | null;
    })
  | null {
  const base = parseConnectorEmailIdentity(value);
  const fields = checked(emailResumeFieldsSchema, value);
  const limits = fields === null ? null : parseEmailLimits(fields.limits);
  return base === null || fields === null || limits === null
    ? null
    : {
        ...base,
        policyVersion: fields.policyVersion,
        limits,
        skipProviderMessageId: fields.skipProviderMessageId ?? null,
      };
}

import type { Env } from "../../env";
import { handleContactVerification } from "./contact-verification";
import { handleAgentMailboxSetup } from "./mailbox-setup";
import { handleOrganisationSlackReasoningEffort } from "./slack-reasoning-effort";
import { handleAgentMailboxSenderLinks } from "./mailbox-sender-links";
import {
  handleWhatsAppAccount,
  handleWhatsAppAccounts,
  handleWhatsAppCase,
  handleWhatsAppReply,
  handleWhatsAppReplyQueue,
  isWhatsAppAccountAction,
  isWhatsAppCaseAction,
  isWhatsAppReplyAction,
  type WhatsAppAccountAction,
  type WhatsAppCaseAction,
  type WhatsAppReplyAction,
} from "../../whatsapp/control";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";
import {
  handleCampaignBriefDecision,
  handleCampaignBriefQueue,
} from "./agents/campaign-briefs";
import { handleCaseCommand } from "./agents/case-command";
import {
  handleCancelOrganisationCodexAuthorization,
  handleCompleteOrganisationChatGptSignIn,
  handleOrganisationCodex,
  handleOrganisationCodexAuthorizations,
} from "./agents/codex";
import {
  handleEmailOperational,
  handleEmailOperationalContactSync,
} from "./agents/email-operational";
import { handleEmailReply, handleEmailReviewQueue } from "./agents/email-reply";
import { handleOrganisationInference } from "./agents/inference";
import { handleAgentMailbox, handleAgentMailboxCheck } from "./agents/mailbox";
import {
  handleAgentOperationRevisions,
  handleAgentOperations,
} from "./agents/operations";
import { handleMerchantAgentInstallation } from "./agents/merchant-agent";

export type AgentMailboxRouteAction =
  | "bind"
  | "policy"
  | "resume"
  | "skip-and-resume"
  | "reconnect"
  | "disable"
  | "revoke";

export type AgentControlRoute =
  | Readonly<{ kind: "organisationCodex"; organisationIdRaw: string }>
  | Readonly<{
      kind: "organisationCodexAuthorizations";
      organisationIdRaw: string;
    }>
  | Readonly<{
      kind: "cancelOrganisationCodexAuthorization";
      organisationIdRaw: string;
      attemptIdRaw: string;
    }>
  | Readonly<{
      kind: "completeOrganisationChatGptSignIn";
      organisationIdRaw: string;
      attemptIdRaw: string;
    }>
  | Readonly<{ kind: "reconnectOrganisationCodex"; organisationIdRaw: string }>
  | Readonly<{ kind: "organisationInference"; organisationIdRaw: string }>
  | Readonly<{
      kind: "organisationSlackReasoningEffort";
      organisationIdRaw: string;
    }>
  | Readonly<{
      kind: "agentMailbox";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
      action: AgentMailboxRouteAction | null;
    }>
  | Readonly<{
      kind: "agentMailboxSetup";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
    }>
  | Readonly<{
      kind: "agentMailboxCheck";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
    }>
  | Readonly<{
      kind: "agentMailboxSenderLinks";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
      /** The read of one address's link; the address travels in the body. */
      read: boolean;
    }>
  | Readonly<{ kind: "emailReviewQueue"; organisationIdRaw: string }>
  | Readonly<{
      kind: "emailReply";
      organisationIdRaw: string;
      proposalIdRaw: string;
      action:
        | "approve"
        | "reject"
        | "resolve"
        | "edit"
        | "relationship"
        | "correct"
        | "draft-save"
        | "draft-reload"
        | null;
    }>
  | Readonly<{ kind: "emailOperationalContacts"; organisationIdRaw: string }>
  | Readonly<{ kind: "contactEndpointVerification"; organisationIdRaw: string }>
  | Readonly<{
      kind: "emailOperational";
      organisationIdRaw: string;
      proposalIdRaw: string;
      action:
        | "approve"
        | "reject"
        | "edit"
        | "attest-present"
        | "attest-absent"
        | null;
    }>
  | Readonly<{ kind: "whatsappAccounts"; organisationIdRaw: string }>
  | Readonly<{
      kind: "whatsappAccount";
      organisationIdRaw: string;
      integrationAccountIdRaw: string;
      action: WhatsAppAccountAction;
    }>
  | Readonly<{ kind: "whatsappReplyQueue"; organisationIdRaw: string }>
  | Readonly<{
      kind: "whatsappReply";
      organisationIdRaw: string;
      proposalIdRaw: string;
      action: WhatsAppReplyAction | null;
    }>
  | Readonly<{
      kind: "whatsappCase";
      organisationIdRaw: string;
      caseIdRaw: string;
      action: WhatsAppCaseAction | null;
    }>
  | Readonly<{ kind: "agentOperations"; organisationIdRaw: string }>
  | Readonly<{
      kind: "agentOperationRevisions";
      organisationIdRaw: string;
      targetKind: "agent_definition" | "skill";
      targetId: string;
    }>
  | Readonly<{ kind: "caseCommand"; organisationIdRaw: string }>
  | Readonly<{ kind: "urkInstallation"; organisationIdRaw: string }>
  | Readonly<{ kind: "campaignBriefQueue"; organisationIdRaw: string }>
  | Readonly<{
      kind: "campaignBrief";
      organisationIdRaw: string;
      briefIdRaw: string;
      action: "accept" | "dismiss";
    }>;

export function matchAgentControlRoute(
  pathname: string,
): AgentControlRoute | null {
  const authorizationCancel = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/inference\/codex\/authorizations\/([^/]+)\/cancel$/u,
  );
  if (authorizationCancel !== null) {
    return {
      kind: "cancelOrganisationCodexAuthorization",
      organisationIdRaw: decode(authorizationCancel[0]),
      attemptIdRaw: decode(authorizationCancel[1]),
    };
  }
  const authorizationComplete = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/inference\/codex\/authorizations\/([^/]+)\/complete$/u,
  );
  if (authorizationComplete !== null) {
    return {
      kind: "completeOrganisationChatGptSignIn",
      organisationIdRaw: decode(authorizationComplete[0]),
      attemptIdRaw: decode(authorizationComplete[1]),
    };
  }
  const authorizations = organisation(
    pathname,
    "inference/codex/authorizations",
  );
  if (authorizations !== null)
    return {
      kind: "organisationCodexAuthorizations",
      organisationIdRaw: authorizations,
    };
  const reconnect = organisation(pathname, "inference/codex/reconnect");
  if (reconnect !== null)
    return { kind: "reconnectOrganisationCodex", organisationIdRaw: reconnect };
  const codex = organisation(pathname, "inference/codex");
  if (codex !== null)
    return { kind: "organisationCodex", organisationIdRaw: codex };
  const slackEffort = organisation(
    pathname,
    "inference/slack-reasoning-effort",
  );
  if (slackEffort !== null)
    return {
      kind: "organisationSlackReasoningEffort",
      organisationIdRaw: slackEffort,
    };
  const mailboxSetup = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/agent-mailboxes\/([^/]+)\/setup$/u,
  );
  if (mailboxSetup !== null) {
    return {
      kind: "agentMailboxSetup",
      organisationIdRaw: decode(mailboxSetup[0]),
      integrationAccountIdRaw: decode(mailboxSetup[1]),
    };
  }
  const mailboxCheck = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/agent-mailboxes\/([^/]+)\/check$/u,
  );
  if (mailboxCheck !== null) {
    return {
      kind: "agentMailboxCheck",
      organisationIdRaw: decode(mailboxCheck[0]),
      integrationAccountIdRaw: decode(mailboxCheck[1]),
    };
  }
  const senderLinks = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/agent-mailboxes\/([^/]+)\/sender-links(\/read)?$/u,
  );
  if (senderLinks !== null) {
    return {
      kind: "agentMailboxSenderLinks",
      organisationIdRaw: decode(senderLinks[0]),
      integrationAccountIdRaw: decode(senderLinks[1]),
      read: senderLinks[2] !== undefined,
    };
  }
  const mailboxAction = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/agent-mailboxes\/([^/]+)\/([a-z-]+)$/u,
  );
  if (mailboxAction !== null && isAgentMailboxRouteAction(mailboxAction[2])) {
    return {
      kind: "agentMailbox",
      organisationIdRaw: decode(mailboxAction[0]),
      integrationAccountIdRaw: decode(mailboxAction[1]),
      action: mailboxAction[2],
    };
  }
  const mailbox = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/agent-mailboxes\/([^/]+)$/u,
  );
  if (mailbox !== null) {
    return {
      kind: "agentMailbox",
      organisationIdRaw: decode(mailbox[0]),
      integrationAccountIdRaw: decode(mailbox[1]),
      action: null,
    };
  }
  const whatsappAccounts = organisation(pathname, "whatsapp-accounts");
  if (whatsappAccounts !== null)
    return { kind: "whatsappAccounts", organisationIdRaw: whatsappAccounts };
  const whatsappAccount = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/whatsapp-accounts\/([^/]+)\/([a-z-]+)$/u,
  );
  if (whatsappAccount !== null && isWhatsAppAccountAction(whatsappAccount[2])) {
    return {
      kind: "whatsappAccount",
      organisationIdRaw: decode(whatsappAccount[0]),
      integrationAccountIdRaw: decode(whatsappAccount[1]),
      action: whatsappAccount[2],
    };
  }
  const whatsappReply = matchWhatsAppReply(pathname);
  if (whatsappReply !== null) return whatsappReply;
  const whatsappCase = matchWhatsAppCase(pathname);
  if (whatsappCase !== null) return whatsappCase;
  const emailOperationalContacts = organisation(
    pathname,
    "email-operational-contacts",
  );
  if (emailOperationalContacts !== null) {
    return {
      kind: "emailOperationalContacts",
      organisationIdRaw: emailOperationalContacts,
    };
  }
  const contactVerification = organisation(
    pathname,
    "contact-endpoint-verifications",
  );
  if (contactVerification !== null) {
    return {
      kind: "contactEndpointVerification",
      organisationIdRaw: contactVerification,
    };
  }
  const emailReviews = organisation(pathname, "email-reviews");
  if (emailReviews !== null) {
    return { kind: "emailReviewQueue", organisationIdRaw: emailReviews };
  }
  const emailOperational = matchEmailOperational(pathname);
  if (emailOperational !== null) return emailOperational;
  const emailReply = matchEmailReply(pathname);
  if (emailReply !== null) return emailReply;
  const revisions = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/operations\/(definitions|skills)\/([^/]+)\/revisions$/u,
  );
  if (revisions !== null) {
    return {
      kind: "agentOperationRevisions",
      organisationIdRaw: decode(revisions[0]),
      targetKind: revisions[1] === "definitions" ? "agent_definition" : "skill",
      targetId: decode(revisions[2]),
    };
  }
  const operations = organisation(pathname, "operations");
  if (operations !== null)
    return { kind: "agentOperations", organisationIdRaw: operations };
  const merchantAgent = organisation(pathname, "agents/urk");
  if (merchantAgent !== null) return { kind: "urkInstallation", organisationIdRaw: merchantAgent };
  const briefDecision = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/campaign-briefs\/([^/]+)\/(accept|dismiss)$/u,
  );
  if (briefDecision !== null) {
    return {
      kind: "campaignBrief",
      organisationIdRaw: decode(briefDecision[0]),
      briefIdRaw: decode(briefDecision[1]),
      action: briefDecision[2] === "accept" ? "accept" : "dismiss",
    };
  }
  const briefQueue = organisation(pathname, "campaign-briefs");
  if (briefQueue !== null)
    return { kind: "campaignBriefQueue", organisationIdRaw: briefQueue };
  const caseCommand = organisation(pathname, "cases/commands");
  if (caseCommand !== null)
    return { kind: "caseCommand", organisationIdRaw: caseCommand };
  const inference = organisation(pathname, "inference");
  return inference === null
    ? null
    : { kind: "organisationInference", organisationIdRaw: inference };
}

function matchWhatsAppReply(
  pathname: string,
): Variant<AgentControlRoute, "whatsappReply" | "whatsappReplyQueue"> | null {
  const action = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/whatsapp-replies\/([^/]+)\/([a-z-]+)$/u,
  );
  if (action !== null && isWhatsAppReplyAction(action[2])) {
    return {
      kind: "whatsappReply",
      organisationIdRaw: decode(action[0]),
      proposalIdRaw: decode(action[1]),
      action: action[2],
    };
  }
  const reply = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/whatsapp-replies\/([^/]+)$/u,
  );
  if (reply !== null)
    return {
      kind: "whatsappReply",
      organisationIdRaw: decode(reply[0]),
      proposalIdRaw: decode(reply[1]),
      action: null,
    };
  const queue = organisation(pathname, "whatsapp-replies");
  return queue === null
    ? null
    : { kind: "whatsappReplyQueue", organisationIdRaw: queue };
}

function matchWhatsAppCase(
  pathname: string,
): Variant<AgentControlRoute, "whatsappCase"> | null {
  const action = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/whatsapp-cases\/([^/]+)\/([a-z-]+)$/u,
  );
  if (action !== null && isWhatsAppCaseAction(action[2])) {
    return {
      kind: "whatsappCase",
      organisationIdRaw: decode(action[0]),
      caseIdRaw: decode(action[1]),
      action: action[2],
    };
  }
  const value = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/whatsapp-cases\/([^/]+)$/u,
  );
  return value === null
    ? null
    : {
        kind: "whatsappCase",
        organisationIdRaw: decode(value[0]),
        caseIdRaw: decode(value[1]),
        action: null,
      };
}

function matchEmailReply(
  pathname: string,
): Variant<AgentControlRoute, "emailReply"> | null {
  const action = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/email-replies\/([^/]+)\/(approve|reject|resolve|edit|relationship|correct|draft-save|draft-reload)$/u,
  );
  if (action !== null) {
    const operation = action[2];
    if (
      operation !== "approve" &&
      operation !== "reject" &&
      operation !== "resolve" &&
      operation !== "edit" &&
      operation !== "relationship" &&
      operation !== "correct" &&
      operation !== "draft-save" &&
      operation !== "draft-reload"
    )
      return null;
    return {
      kind: "emailReply",
      organisationIdRaw: decode(action[0]),
      proposalIdRaw: decode(action[1]),
      action: operation,
    };
  }
  const reply = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/email-replies\/([^/]+)$/u,
  );
  if (reply !== null)
    return {
      kind: "emailReply",
      organisationIdRaw: decode(reply[0]),
      proposalIdRaw: decode(reply[1]),
      action: null,
    };
  return null;
}

function matchEmailOperational(
  pathname: string,
): Variant<AgentControlRoute, "emailOperational"> | null {
  const action = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/email-operational\/([^/]+)\/(approve|reject|edit|attest-present|attest-absent)$/u,
  );
  if (action !== null) {
    const operation = action[2];
    if (
      operation !== "approve" &&
      operation !== "reject" &&
      operation !== "edit" &&
      operation !== "attest-present" &&
      operation !== "attest-absent"
    ) {
      return null;
    }
    return {
      kind: "emailOperational",
      organisationIdRaw: decode(action[0]),
      proposalIdRaw: decode(action[1]),
      action: operation,
    };
  }
  const proposal = captures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/email-operational\/([^/]+)$/u,
  );
  if (proposal !== null) {
    return {
      kind: "emailOperational",
      organisationIdRaw: decode(proposal[0]),
      proposalIdRaw: decode(proposal[1]),
      action: null,
    };
  }
  return null;
}

function isAgentMailboxRouteAction(
  value: string | undefined,
): value is AgentMailboxRouteAction {
  return (
    value === "bind" ||
    value === "policy" ||
    value === "resume" ||
    value === "skip-and-resume" ||
    value === "reconnect" ||
    value === "disable" ||
    value === "revoke"
  );
}

function organisation(pathname: string, suffix: string): string | null {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = captures(
    pathname,
    new RegExp(`^/v1/control/organisations/([^/]+)/${escaped}$`, "u"),
  );
  return value === null ? null : decode(value[0]);
}

function captures(
  pathname: string,
  pattern: RegExp,
): readonly string[] | null {
  const result = pattern.exec(pathname);
  return result === null ? null : result.slice(1);
}

function decode(value: string | undefined): string {
  if (value === undefined)
    throw new Error("Agent control route capture is missing");
  return decodeURIComponent(value);
}

export function handleAgentControlRoute(
  request: Request,
  env: Env,
  route: AgentControlRoute,
): Promise<Response> {
  switch (route.kind) {
    case "organisationCodex":
      return handleOrganisationCodex(request, env, route.organisationIdRaw);
    case "organisationCodexAuthorizations":
      return handleOrganisationCodexAuthorizations(
        request,
        env,
        route.organisationIdRaw,
        false,
      );
    case "cancelOrganisationCodexAuthorization":
      return handleCancelOrganisationCodexAuthorization(
        request,
        env,
        route.organisationIdRaw,
        route.attemptIdRaw,
      );
    case "completeOrganisationChatGptSignIn":
      return handleCompleteOrganisationChatGptSignIn(
        request,
        env,
        route.organisationIdRaw,
        route.attemptIdRaw,
      );
    case "reconnectOrganisationCodex":
      return handleOrganisationCodexAuthorizations(
        request,
        env,
        route.organisationIdRaw,
        true,
      );
    case "organisationInference":
      return handleOrganisationInference(request, env, route.organisationIdRaw);
    case "organisationSlackReasoningEffort":
      return handleOrganisationSlackReasoningEffort(
        request,
        env,
        route.organisationIdRaw,
      );
    case "agentMailbox":
      return handleAgentMailbox(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
        route.action,
      );
    case "agentMailboxSetup":
      return handleAgentMailboxSetup(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
      );
    case "agentMailboxCheck":
      return handleAgentMailboxCheck(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
      );
    case "agentMailboxSenderLinks":
      return handleAgentMailboxSenderLinks(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
        route.read,
      );
    case "emailReviewQueue":
      return handleEmailReviewQueue(request, env, route.organisationIdRaw);
    case "emailReply":
      return handleEmailReply(
        request,
        env,
        route.organisationIdRaw,
        route.proposalIdRaw,
        route.action,
      );
    case "emailOperationalContacts":
      return handleEmailOperationalContactSync(
        request,
        env,
        route.organisationIdRaw,
      );
    case "contactEndpointVerification":
      return handleContactVerification(request, env, route.organisationIdRaw);
    case "emailOperational":
      return handleEmailOperational(
        request,
        env,
        route.organisationIdRaw,
        route.proposalIdRaw,
        route.action,
      );
    case "whatsappAccounts":
      return handleWhatsAppAccounts(request, env, route.organisationIdRaw);
    case "whatsappAccount":
      return handleWhatsAppAccount(
        request,
        env,
        route.organisationIdRaw,
        route.integrationAccountIdRaw,
        route.action,
      );
    case "whatsappReplyQueue":
      return handleWhatsAppReplyQueue(request, env, route.organisationIdRaw);
    case "whatsappReply":
      return handleWhatsAppReply(
        request,
        env,
        route.organisationIdRaw,
        route.proposalIdRaw,
        route.action,
      );
    case "whatsappCase":
      return handleWhatsAppCase(
        request,
        env,
        route.organisationIdRaw,
        route.caseIdRaw,
        route.action,
      );
    case "agentOperations":
      return handleAgentOperations(request, env, route.organisationIdRaw);
    case "agentOperationRevisions":
      return handleAgentOperationRevisions(
        request,
        env,
        route.organisationIdRaw,
        route.targetKind,
        route.targetId,
      );
    case "caseCommand":
      return handleCaseCommand(request, env, route.organisationIdRaw);
    case "urkInstallation":
      return handleMerchantAgentInstallation(request, env, route.organisationIdRaw);
    case "campaignBriefQueue":
      return handleCampaignBriefQueue(request, env, route.organisationIdRaw);
    case "campaignBrief":
      return handleCampaignBriefDecision(
        request,
        env,
        route.organisationIdRaw,
        route.briefIdRaw,
        route.action,
      );
    default:
      return assertNever(route);
  }
}

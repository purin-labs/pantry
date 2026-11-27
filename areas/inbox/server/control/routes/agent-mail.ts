import type { DecidePendingDecision } from "@purin-labs/control/worker/decide-pending-decision";
import {
  decodeCapture,
  organisationPath,
  pathCaptures,
} from "@purin-labs/control/worker/path-match";
import type { Env } from "@purin-labs/kernel/env";
import { assertNever } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";
import { handleContactVerification } from "./contact-verification";
import { handleAgentMailboxSetup } from "./mailbox-setup";
import { handleAgentMailboxSenderLinks } from "./mailbox-sender-links";
import {
  handleEmailOperational,
  handleEmailOperationalContactSync,
} from "./agents/email-operational";
import { handleEmailReply, handleEmailReviewQueue } from "./agents/email-reply";
import {
  handleAgentMailbox,
  handleAgentMailboxCheck,
  isAgentMailboxRouteAction,
  type AgentMailboxRouteAction,
} from "./agents/mailbox";

/** The control routes of the agent mailboxes and of their email reviews. */
export type InboxAgentControlRoute =
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
    }>;

export function matchInboxAgentControlRoute(
  pathname: string,
): InboxAgentControlRoute | null {
  const mailboxSetup = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/agent-mailboxes\/([^/]+)\/setup$/u,
  );
  if (mailboxSetup !== null) {
    return {
      kind: "agentMailboxSetup",
      organisationIdRaw: decodeCapture(mailboxSetup[0]),
      integrationAccountIdRaw: decodeCapture(mailboxSetup[1]),
    };
  }
  const mailboxCheck = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/agent-mailboxes\/([^/]+)\/check$/u,
  );
  if (mailboxCheck !== null) {
    return {
      kind: "agentMailboxCheck",
      organisationIdRaw: decodeCapture(mailboxCheck[0]),
      integrationAccountIdRaw: decodeCapture(mailboxCheck[1]),
    };
  }
  const senderLinks = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/agent-mailboxes\/([^/]+)\/sender-links(\/read)?$/u,
  );
  if (senderLinks !== null) {
    return {
      kind: "agentMailboxSenderLinks",
      organisationIdRaw: decodeCapture(senderLinks[0]),
      integrationAccountIdRaw: decodeCapture(senderLinks[1]),
      read: senderLinks[2] !== undefined,
    };
  }
  const mailboxAction = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/agent-mailboxes\/([^/]+)\/([a-z-]+)$/u,
  );
  if (mailboxAction !== null && isAgentMailboxRouteAction(mailboxAction[2])) {
    return {
      kind: "agentMailbox",
      organisationIdRaw: decodeCapture(mailboxAction[0]),
      integrationAccountIdRaw: decodeCapture(mailboxAction[1]),
      action: mailboxAction[2],
    };
  }
  const mailbox = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/agent-mailboxes\/([^/]+)$/u,
  );
  if (mailbox !== null) {
    return {
      kind: "agentMailbox",
      organisationIdRaw: decodeCapture(mailbox[0]),
      integrationAccountIdRaw: decodeCapture(mailbox[1]),
      action: null,
    };
  }
  const emailOperationalContacts = organisationPath(
    pathname,
    "email-operational-contacts",
  );
  if (emailOperationalContacts !== null) {
    return {
      kind: "emailOperationalContacts",
      organisationIdRaw: emailOperationalContacts,
    };
  }
  const contactVerification = organisationPath(
    pathname,
    "contact-endpoint-verifications",
  );
  if (contactVerification !== null) {
    return {
      kind: "contactEndpointVerification",
      organisationIdRaw: contactVerification,
    };
  }
  const emailReviews = organisationPath(pathname, "email-reviews");
  if (emailReviews !== null) {
    return { kind: "emailReviewQueue", organisationIdRaw: emailReviews };
  }
  const emailOperational = matchEmailOperational(pathname);
  if (emailOperational !== null) return emailOperational;
  return matchEmailReply(pathname);
}

function matchEmailReply(
  pathname: string,
): Variant<InboxAgentControlRoute, "emailReply"> | null {
  const action = pathCaptures(
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
      organisationIdRaw: decodeCapture(action[0]),
      proposalIdRaw: decodeCapture(action[1]),
      action: operation,
    };
  }
  const reply = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/email-replies\/([^/]+)$/u,
  );
  if (reply !== null)
    return {
      kind: "emailReply",
      organisationIdRaw: decodeCapture(reply[0]),
      proposalIdRaw: decodeCapture(reply[1]),
      action: null,
    };
  return null;
}

function matchEmailOperational(
  pathname: string,
): Variant<InboxAgentControlRoute, "emailOperational"> | null {
  const action = pathCaptures(
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
      organisationIdRaw: decodeCapture(action[0]),
      proposalIdRaw: decodeCapture(action[1]),
      action: operation,
    };
  }
  const proposal = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/email-operational\/([^/]+)$/u,
  );
  if (proposal !== null) {
    return {
      kind: "emailOperational",
      organisationIdRaw: decodeCapture(proposal[0]),
      proposalIdRaw: decodeCapture(proposal[1]),
      action: null,
    };
  }
  return null;
}

/**
 * Answers one route of the agent mailboxes. An approval or a refusal of an
 * email proposal goes through the one decide call.
 */
export function handleInboxAgentControlRoute(
  request: Request,
  env: Env,
  route: InboxAgentControlRoute,
  decide: DecidePendingDecision,
): Promise<Response> {
  switch (route.kind) {
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
      if (route.action === "approve" || route.action === "reject")
        return decide(
          { request, organisationIdRaw: route.organisationIdRaw },
          {
            kind: "email_review",
            message: "gmail_reply",
            id: route.proposalIdRaw,
            answer: route.action === "approve" ? "allow" : "refuse",
          },
        );
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
      if (route.action === "approve" || route.action === "reject")
        return decide(
          { request, organisationIdRaw: route.organisationIdRaw },
          {
            kind: "email_review",
            message: "operational_new_message",
            id: route.proposalIdRaw,
            answer: route.action === "approve" ? "allow" : "refuse",
          },
        );
      return handleEmailOperational(
        request,
        env,
        route.organisationIdRaw,
        route.proposalIdRaw,
        route.action,
      );
    default:
      return assertNever(route);
  }
}

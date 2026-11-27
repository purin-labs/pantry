import type { Env } from "@purin-labs/kernel/env";
import {
  decodeCapture,
  organisationPath,
  pathCaptures,
} from "@purin-labs/control/worker/path-match";
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
} from "./agents/whatsapp";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

/**
 * The control routes of the WhatsApp accounts, the reply queue and the
 * WhatsApp Cases. The handlers are in `agents/whatsapp.ts`.
 */
export type WhatsAppControlRoute =
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
    }>;

export function matchWhatsAppControlRoute(
  pathname: string,
): WhatsAppControlRoute | null {
  const whatsappAccounts = organisationPath(pathname, "whatsapp-accounts");
  if (whatsappAccounts !== null)
    return { kind: "whatsappAccounts", organisationIdRaw: whatsappAccounts };
  const whatsappAccount = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/whatsapp-accounts\/([^/]+)\/([a-z-]+)$/u,
  );
  if (whatsappAccount !== null && isWhatsAppAccountAction(whatsappAccount[2])) {
    return {
      kind: "whatsappAccount",
      organisationIdRaw: decodeCapture(whatsappAccount[0]),
      integrationAccountIdRaw: decodeCapture(whatsappAccount[1]),
      action: whatsappAccount[2],
    };
  }
  const whatsappReply = matchWhatsAppReply(pathname);
  if (whatsappReply !== null) return whatsappReply;
  return matchWhatsAppCase(pathname);
}

function matchWhatsAppReply(
  pathname: string,
): Variant<
  WhatsAppControlRoute,
  "whatsappReply" | "whatsappReplyQueue"
> | null {
  const action = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/whatsapp-replies\/([^/]+)\/([a-z-]+)$/u,
  );
  if (action !== null && isWhatsAppReplyAction(action[2])) {
    return {
      kind: "whatsappReply",
      organisationIdRaw: decodeCapture(action[0]),
      proposalIdRaw: decodeCapture(action[1]),
      action: action[2],
    };
  }
  const reply = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/whatsapp-replies\/([^/]+)$/u,
  );
  if (reply !== null)
    return {
      kind: "whatsappReply",
      organisationIdRaw: decodeCapture(reply[0]),
      proposalIdRaw: decodeCapture(reply[1]),
      action: null,
    };
  const queue = organisationPath(pathname, "whatsapp-replies");
  return queue === null
    ? null
    : { kind: "whatsappReplyQueue", organisationIdRaw: queue };
}

function matchWhatsAppCase(
  pathname: string,
): Variant<WhatsAppControlRoute, "whatsappCase"> | null {
  const action = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/whatsapp-cases\/([^/]+)\/([a-z-]+)$/u,
  );
  if (action !== null && isWhatsAppCaseAction(action[2])) {
    return {
      kind: "whatsappCase",
      organisationIdRaw: decodeCapture(action[0]),
      caseIdRaw: decodeCapture(action[1]),
      action: action[2],
    };
  }
  const value = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/whatsapp-cases\/([^/]+)$/u,
  );
  return value === null
    ? null
    : {
        kind: "whatsappCase",
        organisationIdRaw: decodeCapture(value[0]),
        caseIdRaw: decodeCapture(value[1]),
        action: null,
      };
}

export function handleWhatsAppControlRoute(
  request: Request,
  env: Env,
  route: WhatsAppControlRoute,
): Promise<Response> {
  switch (route.kind) {
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
    default:
      return assertNever(route);
  }
}

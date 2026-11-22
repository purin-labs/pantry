import type { Env } from "@purin-labs/kernel/env";
import { handlePortalChat, type PortalChatExecution } from "../chat";
import { handlePortalChatCancel } from "./cancel";
import {
  handlePortalChatConversation,
  handlePortalChatDraft,
  handlePortalChatRead,
} from "./conversation";
import { handlePortalChatPermission } from "./permission";
import {
  handlePortalChatSurfaceEffects,
  handlePortalChatSurfaceReceipt,
} from "./surface";
import { handlePortalChatStream } from "./stream";
import {
  handlePortalChatSlackMessage,
  type SlackMessageAction,
} from "../chat-slack-messages";
import {
  handlePortalChatConfigurationDraft,
  type ConfigurationDraftAction,
} from "../chat-configuration-drafts";
import {
  handlePortalChatSideCase,
  type SideCaseAction,
} from "../chat-side-cases";
import { handlePortalChatScreenRelevance } from "../chat-screen-relevance";
import { assertNever } from "@purin-labs/std";
import { controlError } from "../../http";
import { decodeSegment as decode, matchPath as match } from "../../path-match";

/**
 * The routes of the Portal chat (Refactor 17). They were in the route file of
 * the custom connectors; the chat is a surface, and a custom connector is an
 * integration.
 */
export type PortalChatControlRoute =
  | { readonly kind: "portalChat"; readonly organisationIdRaw: string }
  | { readonly kind: "portalChatCancel"; readonly organisationIdRaw: string }
  | { readonly kind: "portalChatStream"; readonly organisationIdRaw: string }
  | {
      readonly kind: "portalChatSurfaceEffects";
      readonly organisationIdRaw: string;
    }
  | {
      readonly kind: "portalChatSurfaceReceipt";
      readonly organisationIdRaw: string;
      readonly effectIdRaw: string;
    }
  | {
      readonly kind: "portalChatConversation";
      readonly organisationIdRaw: string;
      readonly conversationIdRaw: string;
    }
  | {
      readonly kind:
        "portalChatDraft" | "portalChatRead" | "portalChatPermission";
      readonly organisationIdRaw: string;
      readonly conversationIdRaw: string;
    }
  | {
      readonly kind: "portalChatSlackMessage";
      readonly organisationIdRaw: string;
      readonly conversationIdRaw: string;
      readonly proposalIdRaw: string;
      readonly action: SlackMessageAction | null;
    }
  | {
      readonly kind: "portalChatConfigurationDraft";
      readonly organisationIdRaw: string;
      readonly conversationIdRaw: string;
      readonly draftIdRaw: string;
      readonly action: ConfigurationDraftAction;
    }
  | {
      readonly kind: "portalChatScreenRelevance";
      readonly organisationIdRaw: string;
      readonly conversationIdRaw: string;
      readonly checkIdRaw: string | null;
    }
  | {
      readonly kind: "portalChatSideCase";
      readonly organisationIdRaw: string;
      readonly conversationIdRaw: string;
      readonly proposalIdRaw: string;
      readonly action: SideCaseAction;
    };

export function matchPortalChatControlRoute(
  pathname: string,
): PortalChatControlRoute | null {
  const surfaceReceipt = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/surface-effects\/([^/]+)\/receipt$/u,
  );
  if (surfaceReceipt !== null)
    return {
      kind: "portalChatSurfaceReceipt",
      organisationIdRaw: decode(surfaceReceipt[0]),
      effectIdRaw: decode(surfaceReceipt[1]),
    };
  const surfaceEffects = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/surface-effects$/u,
  );
  if (surfaceEffects !== null)
    return {
      kind: "portalChatSurfaceEffects",
      organisationIdRaw: decode(surfaceEffects[0]),
    };
  const stream = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/stream$/u,
  );
  if (stream !== null)
    return {
      kind: "portalChatStream",
      organisationIdRaw: decode(stream[0]),
    };
  const cancel = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/cancel$/u,
  );
  if (cancel !== null)
    return {
      kind: "portalChatCancel",
      organisationIdRaw: decode(cancel[0]),
    };
  const draft = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/conversations\/([^/]+)\/draft$/u,
  );
  if (draft !== null)
    return {
      kind: "portalChatDraft",
      organisationIdRaw: decode(draft[0]),
      conversationIdRaw: decode(draft[1]),
    };
  const slackMessage = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/conversations\/([^/]+)\/slack-messages\/([^/]+?)(?:\/(send|discard|edit))?$/u,
  );
  if (slackMessage !== null)
    return {
      kind: "portalChatSlackMessage",
      organisationIdRaw: decode(slackMessage[0]),
      conversationIdRaw: decode(slackMessage[1]),
      proposalIdRaw: decode(slackMessage[2]),
      action: slackMessageAction(slackMessage[3]),
    };
  const configurationDraft = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/conversations\/([^/]+)\/configuration-drafts\/([^/]+)\/(confirm|cancel)$/u,
  );
  if (configurationDraft !== null)
    return {
      kind: "portalChatConfigurationDraft",
      organisationIdRaw: decode(configurationDraft[0]),
      conversationIdRaw: decode(configurationDraft[1]),
      draftIdRaw: decode(configurationDraft[2]),
      action: configurationDraft[3] === "confirm" ? "confirm" : "cancel",
    };
  const screenRelevance = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/conversations\/([^/]+)\/screen-relevance(?:\/([^/]+)\/choice)?$/u,
  );
  if (screenRelevance !== null)
    return {
      kind: "portalChatScreenRelevance",
      organisationIdRaw: decode(screenRelevance[0]),
      conversationIdRaw: decode(screenRelevance[1]),
      checkIdRaw: screenRelevance[2] === "" ? null : decode(screenRelevance[2]),
    };
  const sideCase = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/conversations\/([^/]+)\/side-cases\/([^/]+)\/(start|dismiss)$/u,
  );
  if (sideCase !== null)
    return {
      kind: "portalChatSideCase",
      organisationIdRaw: decode(sideCase[0]),
      conversationIdRaw: decode(sideCase[1]),
      proposalIdRaw: decode(sideCase[2]),
      action: sideCase[3] === "start" ? "start" : "dismiss",
    };
  const permission = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/conversations\/([^/]+)\/permission$/u,
  );
  if (permission !== null)
    return {
      kind: "portalChatPermission",
      organisationIdRaw: decode(permission[0]),
      conversationIdRaw: decode(permission[1]),
    };
  const read = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/conversations\/([^/]+)\/read$/u,
  );
  if (read !== null)
    return {
      kind: "portalChatRead",
      organisationIdRaw: decode(read[0]),
      conversationIdRaw: decode(read[1]),
    };
  const conversation = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/conversations\/([^/]+)$/u,
  );
  if (conversation !== null)
    return {
      kind: "portalChatConversation",
      organisationIdRaw: decode(conversation[0]),
      conversationIdRaw: decode(conversation[1]),
    };
  const authoring = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/chat$/u,
  );
  if (authoring !== null)
    return {
      kind: "portalChat",
      organisationIdRaw: decode(authoring[0]),
    };
  return null;
}

export function handlePortalChatControlRoute(
  request: Request,
  env: Env,
  route: PortalChatControlRoute,
  execution: PortalChatExecution | null,
): Promise<Response> {
  switch (route.kind) {
    case "portalChat":
      return execution === null
        ? Promise.resolve(controlError("execution_context_required", 500))
        : handlePortalChat(request, env, route.organisationIdRaw);
    case "portalChatCancel":
      return handlePortalChatCancel(request, env, route.organisationIdRaw);
    case "portalChatStream":
      return execution === null
        ? Promise.resolve(controlError("execution_context_required", 500))
        : handlePortalChatStream(
            request,
            env,
            route.organisationIdRaw,
            execution,
          );
    case "portalChatSurfaceEffects":
      return handlePortalChatSurfaceEffects(
        request,
        env,
        route.organisationIdRaw,
      );
    case "portalChatSurfaceReceipt":
      return handlePortalChatSurfaceReceipt(
        request,
        env,
        route.organisationIdRaw,
        route.effectIdRaw,
      );
    case "portalChatConversation":
      return handlePortalChatConversation(
        request,
        env,
        route.organisationIdRaw,
        route.conversationIdRaw,
      );
    case "portalChatDraft":
      return handlePortalChatDraft(
        request,
        env,
        route.organisationIdRaw,
        route.conversationIdRaw,
      );
    case "portalChatPermission":
      return handlePortalChatPermission(
        request,
        env,
        route.organisationIdRaw,
        route.conversationIdRaw,
      );
    case "portalChatSlackMessage":
      return handlePortalChatSlackMessage(
        request,
        env,
        route.organisationIdRaw,
        route.conversationIdRaw,
        route.proposalIdRaw,
        route.action,
      );
    case "portalChatConfigurationDraft":
      return handlePortalChatConfigurationDraft(
        request,
        env,
        route.organisationIdRaw,
        route.conversationIdRaw,
        route.draftIdRaw,
        route.action,
      );
    case "portalChatScreenRelevance":
      return handlePortalChatScreenRelevance(
        request,
        env,
        route.organisationIdRaw,
        route.conversationIdRaw,
        route.checkIdRaw,
      );
    case "portalChatSideCase":
      return handlePortalChatSideCase(
        request,
        env,
        route.organisationIdRaw,
        route.conversationIdRaw,
        route.proposalIdRaw,
        route.action,
      );
    case "portalChatRead":
      return handlePortalChatRead(
        request,
        env,
        route.organisationIdRaw,
        route.conversationIdRaw,
      );
    default:
      return assertNever(route);
  }
}

function slackMessageAction(raw: string): SlackMessageAction | null {
  return raw === "send" || raw === "discard" || raw === "edit" ? raw : null;
}

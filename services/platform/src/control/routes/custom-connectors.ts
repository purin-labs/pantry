import type { Env } from "../../env";
import { handlePortalChat, type PortalChatExecution } from "./chat";
import { handlePortalChatCancel } from "./chat/cancel";
import {
  handlePortalChatConversation,
  handlePortalChatDraft,
  handlePortalChatRead,
} from "./chat/conversation";
import { handlePortalChatPermission } from "./chat/permission";
import {
  handlePortalChatSurfaceEffects,
  handlePortalChatSurfaceReceipt,
} from "./chat/surface";
import { handlePortalChatStream } from "./chat/stream";
import { parseCustomConnectorRevision } from "../../custom-connectors";
import { controlError } from "../http";
import {
  handlePortalChatSlackMessage,
  type SlackMessageAction,
} from "./chat-slack-messages";
import {
  handlePortalChatConfigurationDraft,
  type ConfigurationDraftAction,
} from "./chat-configuration-drafts";
import {
  handlePortalChatSideCase,
  type SideCaseAction,
} from "./chat-side-cases";
import { handlePortalChatScreenRelevance } from "./chat-screen-relevance";
import { assertNever } from "@seams/std";
import {
  handleConnectorLifecycle,
  handleCreate,
  handleCreateRevision,
  handleDetail,
  handleList,
  handleRevisionAction,
} from "./custom-connectors/definitions";
import {
  handleReadSetup,
  handleSetupAction,
  handleStartSetup,
} from "./custom-connectors/setup";
import { handleCustomConnectorWriteAction } from "./custom-connectors/write-actions";

export type CollectionRoute = Readonly<{
  kind: "customConnectors";
  organisationIdRaw: string;
}>;

export type ConnectorRouteBase = Readonly<{
  organisationIdRaw: string;
  connectorIdRaw: string;
}>;

export type CustomConnectorControlRoute =
  | CollectionRoute
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
    }
  | (ConnectorRouteBase & { readonly kind: "customConnector" })
  | (ConnectorRouteBase & {
      readonly kind: "customConnectorAction";
      readonly action: "disable" | "resume";
    })
  | (ConnectorRouteBase & { readonly kind: "customConnectorRevisions" })
  | (ConnectorRouteBase & {
      readonly kind: "customConnectorRevisionAction";
      readonly revisionRaw: string;
      readonly action: "validate" | "approve" | "reject" | "retire";
    })
  | (ConnectorRouteBase & { readonly kind: "customConnectorSetupAttempts" })
  | (ConnectorRouteBase & {
      readonly kind: "customConnectorSetupAttempt";
      readonly attemptIdRaw: string;
    })
  | (ConnectorRouteBase & {
      readonly kind: "customConnectorSetupAction";
      readonly attemptIdRaw: string;
      readonly action: "credential" | "test" | "commit" | "cancel";
    })
  | (ConnectorRouteBase & {
      readonly kind: "customConnectorWriteAction";
      readonly actionNonceRaw: string;
      readonly action: "read" | "approval" | "execute" | "retry" | "reconcile";
    });

export function matchCustomConnectorControlRoute(
  pathname: string,
): CustomConnectorControlRoute | null {
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
  const writeAction = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/custom-connectors\/([^/]+)\/actions\/([^/]+)(?:\/(approval|execute|retry|reconcile))?$/u,
  );
  if (writeAction !== null) {
    return {
      kind: "customConnectorWriteAction",
      organisationIdRaw: decode(writeAction[0]),
      connectorIdRaw: decode(writeAction[1]),
      actionNonceRaw: decode(writeAction[2]),
      action: requireWriteAction(writeAction[3]),
    };
  }
  const setupAction = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/custom-connectors\/([^/]+)\/setup-attempts\/([^/]+)\/(credential|test|commit|cancel)$/u,
  );
  if (setupAction !== null) {
    return {
      kind: "customConnectorSetupAction",
      organisationIdRaw: decode(setupAction[0]),
      connectorIdRaw: decode(setupAction[1]),
      attemptIdRaw: decode(setupAction[2]),
      action: requireSetupAction(setupAction[3]),
    };
  }
  const setupAttempt = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/custom-connectors\/([^/]+)\/setup-attempts\/([^/]+)$/u,
  );
  if (setupAttempt !== null) {
    return {
      kind: "customConnectorSetupAttempt",
      organisationIdRaw: decode(setupAttempt[0]),
      connectorIdRaw: decode(setupAttempt[1]),
      attemptIdRaw: decode(setupAttempt[2]),
    };
  }
  const setupAttempts = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/custom-connectors\/([^/]+)\/setup-attempts$/u,
  );
  if (setupAttempts !== null) {
    return {
      kind: "customConnectorSetupAttempts",
      organisationIdRaw: decode(setupAttempts[0]),
      connectorIdRaw: decode(setupAttempts[1]),
    };
  }
  const revisionAction = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/custom-connectors\/([^/]+)\/revisions\/([^/]+)\/(validate|approve|reject|retire)$/u,
  );
  if (revisionAction !== null) {
    return {
      kind: "customConnectorRevisionAction",
      organisationIdRaw: decode(revisionAction[0]),
      connectorIdRaw: decode(revisionAction[1]),
      revisionRaw: decode(revisionAction[2]),
      action: requireRevisionAction(revisionAction[3]),
    };
  }
  const revisions = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/custom-connectors\/([^/]+)\/revisions$/u,
  );
  if (revisions !== null) {
    return {
      kind: "customConnectorRevisions",
      organisationIdRaw: decode(revisions[0]),
      connectorIdRaw: decode(revisions[1]),
    };
  }
  const connectorAction = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/custom-connectors\/([^/]+)\/(disable|resume)$/u,
  );
  if (connectorAction !== null) {
    return {
      kind: "customConnectorAction",
      organisationIdRaw: decode(connectorAction[0]),
      connectorIdRaw: decode(connectorAction[1]),
      action: requireConnectorAction(connectorAction[2]),
    };
  }
  const connector = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/custom-connectors\/([^/]+)$/u,
  );
  if (connector !== null) {
    return {
      kind: "customConnector",
      organisationIdRaw: decode(connector[0]),
      connectorIdRaw: decode(connector[1]),
    };
  }
  const collection = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/custom-connectors$/u,
  );
  return collection === null
    ? null
    : { kind: "customConnectors", organisationIdRaw: decode(collection[0]) };
}

export function handleCustomConnectorControlRoute(
  request: Request,
  env: Env,
  route: CustomConnectorControlRoute,
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
    case "customConnectors":
      return request.method === "GET"
        ? handleList(request, env, route.organisationIdRaw)
        : handleCreate(request, env, route.organisationIdRaw);
    case "customConnector":
      if (request.method === "GET") return handleDetail(request, env, route);
      if (request.method === "DELETE") {
        return handleConnectorLifecycle(request, env, route, "remove");
      }
      return Promise.resolve(controlError("method_not_allowed", 405));
    case "customConnectorAction":
      return handleConnectorLifecycle(request, env, route, route.action);
    case "customConnectorRevisions":
      return handleCreateRevision(request, env, route);
    case "customConnectorRevisionAction":
      return handleRevisionAction(request, env, route);
    case "customConnectorSetupAttempts":
      return handleStartSetup(request, env, route);
    case "customConnectorSetupAttempt":
      return handleReadSetup(request, env, route);
    case "customConnectorSetupAction":
      return handleSetupAction(request, env, route);
    case "customConnectorWriteAction":
      return handleCustomConnectorWriteAction(request, env, route);
    default:
      return assertNever(route);
  }
}

export function match(
  pathname: string,
  pattern: RegExp,
): readonly [string, string, string, string] | null {
  const result = pattern.exec(pathname);
  if (result === null) return null;
  return [result[1] ?? "", result[2] ?? "", result[3] ?? "", result[4] ?? ""];
}

export function slackMessageAction(raw: string): SlackMessageAction | null {
  return raw === "send" || raw === "discard" || raw === "edit" ? raw : null;
}

export function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

/** A revision as a path holds it: decimal digits with no leading zero. */
export function parseRevisionSegment(raw: string) {
  return parseCustomConnectorRevision(
    /^[1-9]\d{0,14}$/u.test(raw) ? Number(raw) : null,
  );
}

export function requireConnectorAction(
  value: string | null,
): "disable" | "resume" {
  if (value === "disable" || value === "resume") return value;
  throw new Error("custom connector route action is invalid");
}

export function requireRevisionAction(
  value: string | null,
): "validate" | "approve" | "reject" | "retire" {
  if (
    value === "validate" ||
    value === "approve" ||
    value === "reject" ||
    value === "retire"
  ) {
    return value;
  }
  throw new Error("custom connector revision action is invalid");
}

export function requireSetupAction(
  value: string | null,
): "credential" | "test" | "commit" | "cancel" {
  if (
    value === "credential" ||
    value === "test" ||
    value === "commit" ||
    value === "cancel"
  ) {
    return value;
  }
  throw new Error("custom connector setup action is invalid");
}

export function requireWriteAction(
  value: string | null,
): "read" | "approval" | "execute" | "retry" | "reconcile" {
  if (
    value === "approval" ||
    value === "execute" ||
    value === "retry" ||
    value === "reconcile"
  ) {
    return value;
  }
  return "read";
}

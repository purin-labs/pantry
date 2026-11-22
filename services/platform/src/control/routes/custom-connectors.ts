import type { DecidePendingDecision } from "../decide-pending-decision";
import type { Env } from "@purin-labs/kernel/env";
import { parseCustomConnectorRevision } from "../../custom-connectors";
import { controlError } from "../http";
import { decodeSegment as decode, matchPath as match } from "../path-match";
import { assertNever } from "@purin-labs/std";
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

type CollectionRoute = Readonly<{
  kind: "customConnectors";
  organisationIdRaw: string;
}>;

type ConnectorRouteBase = Readonly<{
  organisationIdRaw: string;
  connectorIdRaw: string;
}>;

export type CustomConnectorControlRoute =
  | CollectionRoute
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
      readonly action:
        | "read"
        | "approval"
        | "rejection"
        | "execute"
        | "retry"
        | "reconcile";
    });

export function matchCustomConnectorControlRoute(
  pathname: string,
): CustomConnectorControlRoute | null {
  const writeAction = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/custom-connectors\/([^/]+)\/actions\/([^/]+)(?:\/(approval|rejection|execute|retry|reconcile))?$/u,
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
  decide: DecidePendingDecision,
): Promise<Response> {
  switch (route.kind) {
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
      return handleCustomConnectorWriteAction(request, env, route, decide);
    default:
      return assertNever(route);
  }
}

/** A revision as a path holds it: decimal digits with no leading zero. */
export function parseRevisionSegment(raw: string) {
  return parseCustomConnectorRevision(
    /^[1-9]\d{0,14}$/u.test(raw) ? Number(raw) : null,
  );
}

function requireConnectorAction(value: string | null): "disable" | "resume" {
  if (value === "disable" || value === "resume") return value;
  throw new Error("custom connector route action is invalid");
}

function requireRevisionAction(
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

function requireSetupAction(
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

function requireWriteAction(
  value: string | null,
): "read" | "approval" | "rejection" | "execute" | "retry" | "reconcile" {
  if (
    value === "approval" ||
    value === "rejection" ||
    value === "execute" ||
    value === "retry" ||
    value === "reconcile"
  ) {
    return value;
  }
  return "read";
}

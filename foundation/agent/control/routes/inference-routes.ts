import type { Env } from "@purin-labs/kernel/env";
import { assertNever } from "@purin-labs/std";
import {
  decodeCapture,
  organisationPath,
  pathCaptures,
} from "@purin-labs/control/worker/path-match";
import {
  handleCancelOrganisationCodexAuthorization,
  handleCompleteOrganisationChatGptSignIn,
  handleOrganisationCodex,
  handleOrganisationCodexAuthorizations,
} from "./agents/codex";
import { handleOrganisationInference } from "./agents/inference";

/** The control routes of the inference source of an Organisation. */
export type AgentInferenceRoute =
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
  | Readonly<{ kind: "organisationInference"; organisationIdRaw: string }>;

export function matchAgentInferenceRoute(
  pathname: string,
): AgentInferenceRoute | null {
  const authorizationCancel = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/inference\/codex\/authorizations\/([^/]+)\/cancel$/u,
  );
  if (authorizationCancel !== null) {
    return {
      kind: "cancelOrganisationCodexAuthorization",
      organisationIdRaw: decodeCapture(authorizationCancel[0]),
      attemptIdRaw: decodeCapture(authorizationCancel[1]),
    };
  }
  const authorizationComplete = pathCaptures(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/inference\/codex\/authorizations\/([^/]+)\/complete$/u,
  );
  if (authorizationComplete !== null) {
    return {
      kind: "completeOrganisationChatGptSignIn",
      organisationIdRaw: decodeCapture(authorizationComplete[0]),
      attemptIdRaw: decodeCapture(authorizationComplete[1]),
    };
  }
  const authorizations = organisationPath(
    pathname,
    "inference/codex/authorizations",
  );
  if (authorizations !== null)
    return {
      kind: "organisationCodexAuthorizations",
      organisationIdRaw: authorizations,
    };
  const reconnect = organisationPath(pathname, "inference/codex/reconnect");
  if (reconnect !== null)
    return { kind: "reconnectOrganisationCodex", organisationIdRaw: reconnect };
  const codex = organisationPath(pathname, "inference/codex");
  if (codex !== null)
    return { kind: "organisationCodex", organisationIdRaw: codex };
  const inference = organisationPath(pathname, "inference");
  return inference === null
    ? null
    : { kind: "organisationInference", organisationIdRaw: inference };
}

export function handleAgentInferenceRoute(
  request: Request,
  env: Env,
  route: AgentInferenceRoute,
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
    default:
      return assertNever(route);
  }
}

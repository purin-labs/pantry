import { authenticatedConversationScope } from "@purin-labs/tenancy/organisation-access/access";
import type { Env } from "@purin-labs/kernel/env";
import {
  commandEvalAsOperator,
  commandEvalRunAsOperator,
  readEvalRunViews,
  readEvalSenderChoices,
  readEvalViews,
  type EvalAccessError,
} from "../../evals/access";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readBoundedJsonRecord,
} from "@purin-labs/control/worker/http";
import { assertNever } from "@purin-labs/std";

export type EvalRoute = Readonly<{
  kind: "evals";
  organisationId: OrganisationId;
}> &
  (
    | Readonly<{ operation: "list"; evalId?: never }>
    | Readonly<{ operation: "command"; evalId?: never }>
    | Readonly<{ operation: "run_command"; evalId?: never }>
    | Readonly<{ operation: "runs"; evalId: string }>
    | Readonly<{ operation: "contacts"; evalId: string }>
  );

export function matchEvalRoute(pathname: string): EvalRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/evals(?:\/(commands|runs)|\/([^/]+)\/(runs|contacts))?$/.exec(
      pathname,
    );
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    if (!organisationId.ok) return null;
    const base = {
      kind: "evals",
      organisationId: organisationId.value,
    } as const;
    if (match[3] !== undefined)
      return {
        ...base,
        operation: match[4] === "contacts" ? "contacts" : "runs",
        evalId: decodeURIComponent(match[3]),
      };
    if (match[2] === "commands") return { ...base, operation: "command" };
    return match[2] === "runs"
      ? { ...base, operation: "run_command" }
      : { ...base, operation: "list" };
  } catch {
    return null;
  }
}

export async function handleEvalRoute(
  request: Request,
  env: Env,
  route: EvalRoute,
): Promise<Response> {
  try {
    switch (route.operation) {
      case "list": {
        if (request.method !== "GET")
          return controlError("method_not_allowed", 405);
        // Reading needs no management role: the live capability, each
        // revision's label and every cited record decide what is returned.
        const authorized = await authorizeOrganisationRequest(
          request,
          env,
          route.organisationId,
          "viewer",
          false,
        );
        if (!authorized.ok) return authorized.response;
        const evals = await readEvalViews(
          env,
          authenticatedConversationScope(
            authorized.organisationId,
            authorized.authenticated.session,
          ),
          authorized.executionScope,
        );
        return evals.ok
          ? controlJson({ ok: true, evals: evals.value })
          : evalError(evals.error);
      }
      case "command": {
        if (request.method !== "POST")
          return controlError("method_not_allowed", 405);
        const authorized = await authorizeOrganisationRequest(
          request,
          env,
          route.organisationId,
          "admin",
          true,
        );
        if (!authorized.ok) return authorized.response;
        const body = await readBoundedJsonRecord(request, 131_072);
        if (body === null) return controlError("eval_invalid", 400);
        const receipt = await commandEvalAsOperator(
          env,
          authenticatedConversationScope(
            authorized.organisationId,
            authorized.authenticated.session,
          ),
          body,
        );
        return receipt.ok
          ? controlJson({ ok: true, receipt: receipt.value })
          : evalError(receipt.error);
      }
      case "runs": {
        if (request.method !== "GET")
          return controlError("method_not_allowed", 405);
        const authorized = await authorizeOrganisationRequest(
          request,
          env,
          route.organisationId,
          "viewer",
          false,
        );
        if (!authorized.ok) return authorized.response;
        const runs = await readEvalRunViews(
          env,
          authenticatedConversationScope(
            authorized.organisationId,
            authorized.authenticated.session,
          ),
          route.evalId,
        );
        return runs.ok
          ? controlJson({ ok: true, runs: runs.value })
          : evalError(runs.error);
      }
      case "contacts": {
        if (request.method !== "GET")
          return controlError("method_not_allowed", 405);
        // The contacts serve the scenario editor, and a revision needs the
        // admin role. The Eval's own review decides what is returned.
        const authorized = await authorizeOrganisationRequest(
          request,
          env,
          route.organisationId,
          "admin",
          false,
        );
        if (!authorized.ok) return authorized.response;
        const contacts = await readEvalSenderChoices(
          env,
          authenticatedConversationScope(
            authorized.organisationId,
            authorized.authenticated.session,
          ),
          route.evalId,
        );
        return contacts.ok
          ? controlJson({ ok: true, contacts: contacts.value })
          : evalError(contacts.error);
      }
      case "run_command": {
        if (request.method !== "POST")
          return controlError("method_not_allowed", 405);
        const authorized = await authorizeOrganisationRequest(
          request,
          env,
          route.organisationId,
          "admin",
          true,
        );
        if (!authorized.ok) return authorized.response;
        const body = await readBoundedJsonRecord(request, 16_384);
        if (body === null) return controlError("eval_invalid", 400);
        const receipt = await commandEvalRunAsOperator(
          env,
          authenticatedConversationScope(
            authorized.organisationId,
            authorized.authenticated.session,
          ),
          body,
        );
        return receipt.ok
          ? controlJson({ ok: true, receipt: receipt.value })
          : evalError(receipt.error);
      }
      default:
        return assertNever(route);
    }
  } catch {
    return controlError("eval_unavailable", 503);
  }
}

function evalError(error: EvalAccessError): Response {
  switch (error.code) {
    case "eval_invalid":
    case "eval_evidence_unsupported":
    case "eval_reviewer_required":
      return controlError(error.code, 422);
    case "eval_unavailable":
      return controlError(error.code, 404);
    case "eval_conflict":
    case "eval_command_conflict":
    case "eval_capacity_exceeded":
      return controlError(error.code, 409);
    default:
      return assertNever(error.code);
  }
}

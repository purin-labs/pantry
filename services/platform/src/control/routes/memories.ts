import { authenticatedAccountConversationScope } from "../../account-platform/access";
import type { Env } from "../../env";
import { parseOrganisationId, type OrganisationId } from "../../ids";
import {
  commandMemoryAsOperator,
  readMemoryViews,
  type MemoryAccessError,
} from "../../memory/access";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readBoundedJsonRecord } from "../http";
import { assertNever } from "@purin-labs/std";

export type MemoryRoute = Readonly<{
  kind: "memories";
  organisationId: OrganisationId;
  operation: "list" | "command";
}>;

export function matchMemoryRoute(pathname: string): MemoryRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/memories(\/commands)?$/.exec(
      pathname,
    );
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    return organisationId.ok
      ? {
          kind: "memories",
          organisationId: organisationId.value,
          operation: match[2] === undefined ? "list" : "command",
        }
      : null;
  } catch {
    return null;
  }
}

export async function handleMemoryRoute(
  request: Request,
  env: Env,
  route: MemoryRoute,
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
        const memories = await readMemoryViews(
          env,
          authenticatedAccountConversationScope(
            authorized.organisationId,
            authorized.authenticated.session,
          ),
          authorized.executionScope,
        );
        return memories.ok
          ? controlJson({ ok: true, memories: memories.value })
          : memoryError(memories.error);
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
        const body = await readBoundedJsonRecord(request, 65_536);
        if (body === null) return controlError("memory_invalid", 400);
        const receipt = await commandMemoryAsOperator(
          env,
          authenticatedAccountConversationScope(
            authorized.organisationId,
            authorized.authenticated.session,
          ),
          body,
        );
        return receipt.ok
          ? controlJson({ ok: true, receipt: receipt.value })
          : memoryError(receipt.error);
      }
      default:
        return assertNever(route.operation);
    }
  } catch {
    return controlError("memory_unavailable", 503);
  }
}

function memoryError(error: MemoryAccessError): Response {
  switch (error.code) {
    case "memory_invalid":
    case "memory_evidence_unsupported":
    case "memory_reviewer_required":
      return controlError(error.code, 422);
    case "memory_unavailable":
      return controlError(error.code, 404);
    case "memory_conflict":
    case "memory_command_conflict":
    case "memory_capacity_exceeded":
      return controlError(error.code, 409);
    default:
      return assertNever(error.code);
  }
}

import { authenticatedConversationScope } from "@purin-labs/tenancy/organisation-access/access";
import {
  MAX_CASE_EXECUTION_PAGE,
  MAX_CASE_TIMELINE_WINDOW,
  isConversationId,
  type ConversationId,
} from "@purin-labs/control-api";
import { readConversationCaseId } from "@purin-labs/conversation/chat/conversation-access";
import { assertNever } from "@purin-labs/std";

import {
  listCaseExecutionCases,
  readCaseExecutionNodeDetail,
  readCaseExecutionPage,
  type CaseExecutionReadError,
} from "../../case-execution/access";
import {
  readCaseTimelineDay,
  readScheduleRunsDay,
} from "../../case-execution/timeline";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import { controlError, controlJson } from "@purin-labs/control/worker/http";

export type CaseExecutionRoute = Readonly<{
  kind: "case_execution";
  organisationId: OrganisationId;
}> &
  (
    | Readonly<{
        operation: "cases" | "timeline" | "schedule_runs";
        caseId?: never;
        nodeId?: never;
        conversationId?: never;
      }>
    | Readonly<{
        operation: "page";
        caseId: string;
        nodeId?: never;
        conversationId?: never;
      }>
    | Readonly<{
        operation: "node";
        caseId: string;
        nodeId: string;
        conversationId?: never;
      }>
    | Readonly<{
        operation: "chat";
        conversationId: ConversationId;
        caseId?: never;
        nodeId?: never;
      }>
  );

export function matchCaseExecutionRoute(
  pathname: string,
): CaseExecutionRoute | null {
  const chat =
    /^\/v1\/control\/organisations\/([^/]+)\/chat\/([^/]+)\/execution$/.exec(
      pathname,
    );
  if (chat !== null) {
    try {
      const organisation = parseOrganisationId(
        decodeURIComponent(chat[1] ?? ""),
      );
      const conversationId = decodeURIComponent(chat[2] ?? "");
      if (!organisation.ok || !isConversationId(conversationId)) return null;
      return {
        kind: "case_execution",
        organisationId: organisation.value,
        operation: "chat",
        conversationId,
      };
    } catch {
      return null;
    }
  }
  const timeline =
    /^\/v1\/control\/organisations\/([^/]+)\/case-executions\/(timeline|schedule-runs)$/.exec(
      pathname,
    );
  if (timeline !== null) {
    try {
      const organisation = parseOrganisationId(
        decodeURIComponent(timeline[1] ?? ""),
      );
      return organisation.ok
        ? {
            kind: "case_execution",
            organisationId: organisation.value,
            operation:
              timeline[2] === "schedule-runs" ? "schedule_runs" : "timeline",
          }
        : null;
    } catch {
      return null;
    }
  }
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/(?:case-executions|cases\/([^/]+)\/execution(?:\/nodes\/([^/]+))?)$/.exec(
      pathname,
    );
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    if (!organisationId.ok) return null;
    const base = {
      kind: "case_execution",
      organisationId: organisationId.value,
    } as const;
    if (match[2] === undefined) return { ...base, operation: "cases" };
    const caseId = decodeURIComponent(match[2]);
    return match[3] === undefined
      ? { ...base, operation: "page", caseId }
      : {
          ...base,
          operation: "node",
          caseId,
          nodeId: decodeURIComponent(match[3]),
        };
  } catch {
    return null;
  }
}

/**
 * The read-only execution projection of a Case. No route here changes a
 * record. Reading needs no management role: the live context capability, the
 * access of the chat that presents the Case (any other Case belongs to the
 * whole Organisation, whatever its Project) and each record's stored label
 * decide what is returned.
 */
export async function handleCaseExecutionRoute(
  request: Request,
  env: Env,
  route: CaseExecutionRoute,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationId,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const scope = authenticatedConversationScope(
    authorized.organisationId,
    authorized.authenticated.session,
  );
  try {
    switch (route.operation) {
      case "cases": {
        const cases = await listCaseExecutionCases(env, scope);
        return cases.ok
          ? controlJson({ ok: true, cases: cases.value })
          : readError(cases.error);
      }
      case "timeline":
      case "schedule_runs": {
        // A window of at most a week, in epoch milliseconds.
        const query = new URL(request.url).searchParams;
        const from = Number(query.get("from"));
        const to = Number(query.get("to"));
        if (
          !Number.isSafeInteger(from) ||
          !Number.isSafeInteger(to) ||
          from < 0 ||
          to <= from ||
          to - from > MAX_CASE_TIMELINE_WINDOW
        )
          return controlError("case_timeline_window_invalid", 400);
        if (route.operation === "schedule_runs") {
          const runs = await readScheduleRunsDay(env, scope, { from, to });
          return runs.ok
            ? controlJson({ ok: true, schedule: runs.value })
            : readError(runs.error);
        }
        const day = await readCaseTimelineDay(env, scope, { from, to });
        return day.ok
          ? controlJson({ ok: true, timeline: day.value })
          : readError(day.error);
      }
      case "page":
      case "chat": {
        const query = new URL(request.url).searchParams;
        const rawLimit = query.get("limit");
        const limit =
          rawLimit === null ? MAX_CASE_EXECUTION_PAGE : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1)
          return controlError("case_execution_cursor_invalid", 400);
        const caseId =
          route.operation === "page"
            ? route.caseId
            : await readConversationCaseId(
                authorized.executionScope.database,
                scope,
                route.conversationId,
              );
        if (caseId === null)
          return controlError("case_execution_not_found", 404);
        const page = await readCaseExecutionPage(env, scope, {
          caseId,
          cursor: query.get("after"),
          limit,
        });
        return page.ok
          ? controlJson({ ok: true, page: page.value })
          : readError(page.error);
      }
      case "node": {
        const detail = await readCaseExecutionNodeDetail(env, scope, {
          caseId: route.caseId,
          nodeId: route.nodeId,
        });
        return detail.ok
          ? controlJson({ ok: true, detail: detail.value })
          : readError(detail.error);
      }
      default:
        return assertNever(route);
    }
  } catch {
    return controlError("case_execution_unavailable", 503);
  }
}

function readError(error: CaseExecutionReadError): Response {
  switch (error.code) {
    case "case_execution_not_found":
      return controlError(error.code, 404);
    case "case_execution_cursor_invalid":
      return controlError(error.code, 400);
    case "case_execution_changed":
      return controlError(error.code, 409);
    case "case_execution_unavailable":
      return controlError(error.code, 503);
    default:
      return assertNever(error.code);
  }
}

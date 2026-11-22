import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  readNumberField,
  readStringField,
  readOrganisationIdField,
} from "@purin-labs/contracts/boundary";
import type { Env } from "@purin-labs/kernel/env";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from "@purin-labs/kernel/http";
import type { Result } from "@purin-labs/kernel/result";
import { fieldErrorResponse, isAuthorizedOrganisationAdminRequest, jsonBodyErrorResponse } from "./request-helpers";

type CueStatusRow = {
  cueId: unknown;
  nativeId: unknown;
  decision: unknown;
  reason: unknown;
  surfaceThreadId: unknown;
  at: unknown;
};

type CueStatusEntry = {
  cueId: string;
  nativeId: string;
  decision: "matched" | "proposed" | "store_only";
  reason: string | null;
  surfaceThreadId: string | null;
  at: number;
};

type CueStatusSource = "stripe" | "shopify" | "slack";

export async function handleCueStatus(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  if (!isAuthorizedOrganisationAdminRequest(request, env)) {
    return notFound();
  }

  const body = await readJsonObject(request);

  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }

  const organisationId = readOrganisationIdField(body.value);
  const source = readStringField(body.value, "source");
  const after = readNumberField(body.value, "after", 0);

  if (!organisationId.ok) {
    return fieldErrorResponse(organisationId.error);
  }

  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) {
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  }
  const scope = execution.value;

  if (!source.ok || !isCueStatusSource(source.value)) {
    return errorResponse("invalid_field", "Cue status source is invalid.", 422);
  }

  if (!after.ok || !Number.isSafeInteger(after.value) || after.value < 0) {
    return errorResponse(
      "invalid_field",
      "Cue status after timestamp is invalid.",
      422,
    );
  }

  const result = await scope.database
    .prepare(
      `SELECT cue_id AS cueId, native_id AS nativeId, decision, reason,
              surface_thread_id AS surfaceThreadId, at
       FROM cue_log
       WHERE organisation_id = ? AND source = ? AND at >= ?
       ORDER BY at DESC
       LIMIT 20`,
    )
    .bind(organisationId.value, source.value, after.value)
    .all<CueStatusRow>();
  const entries: CueStatusEntry[] = [];

  for (const raw of result.results) {
    const parsed = parseCueStatusEntry(raw);

    if (!parsed.ok) {
      return errorResponse(
        parsed.error.code,
        "Cue status data is invalid.",
        500,
      );
    }

    entries.push(parsed.value);
  }

  return jsonResponse({
    ok: true,
    organisationId: organisationId.value,
    source: source.value,
    entries,
  });
}

function parseCueStatusEntry(
  raw: CueStatusRow,
): Result<CueStatusEntry, { code: "cue_status_row_invalid" }> {
  if (
    typeof raw.cueId !== "string" ||
    typeof raw.nativeId !== "string" ||
    !isCueAcceptanceDecision(raw.decision) ||
    (raw.reason !== null && typeof raw.reason !== "string") ||
    (raw.surfaceThreadId !== null && typeof raw.surfaceThreadId !== "string") ||
    typeof raw.at !== "number" ||
    !Number.isSafeInteger(raw.at)
  ) {
    return { ok: false, error: { code: "cue_status_row_invalid" } };
  }

  return {
    ok: true,
    value: {
      cueId: raw.cueId,
      nativeId: raw.nativeId,
      decision: raw.decision,
      reason: raw.reason,
      surfaceThreadId: raw.surfaceThreadId,
      at: raw.at,
    },
  };
}

function isCueAcceptanceDecision(
  raw: unknown,
): raw is CueStatusEntry["decision"] {
  return raw === "matched" || raw === "proposed" || raw === "store_only";
}

function isCueStatusSource(raw: string): raw is CueStatusSource {
  return raw === "stripe" || raw === "shopify" || raw === "slack";
}

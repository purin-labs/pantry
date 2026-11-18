import { EntityPlaneHttpError } from "../entity-plane/http-error.ts";

export function actorRefused(message: string): Response {
  return jsonResponse(400, { message, field: "Underclerk-Actor" });
}

export function entityPlaneErrorResponse(error: unknown): Response | undefined {
  if (!(error instanceof EntityPlaneHttpError)) return undefined;
  if (error.queryFailure !== null)
    return jsonResponse(error.status, {
      message: error.message,
      queryFailure: error.queryFailure,
    });
  return error.error === undefined
    ? jsonResponse(error.status, { message: error.message })
    : jsonResponse(error.status, {
        message: error.message,
        error: error.error,
      });
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, jsonReplacer), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

import { isRecord } from "@purin-labs/std";

type ErrorBody = {
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

export type JsonObject = Record<string, unknown>;

export type JsonBodyError =
  { code: "invalid_json" } | { code: "object_required" };

export function jsonResponse<TBody>(body: TBody, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
): Response {
  return jsonResponse<ErrorBody>(
    {
      ok: false,
      error: {
        code,
        message,
      },
    },
    status,
  );
}

export function methodNotAllowed(allowedMethods: readonly string[]): Response {
  return new Response(null, {
    status: 405,
    headers: {
      allow: allowedMethods.join(", "),
    },
  });
}

export function notFound(): Response {
  return errorResponse("not_found", "No route matched the request.", 404);
}

export async function readJsonObject(
  request: Request,
): Promise<
  { ok: true; value: JsonObject } | { ok: false; error: JsonBodyError }
> {
  let parsed: unknown;

  try {
    parsed = await request.json();
  } catch {
    return { ok: false, error: { code: "invalid_json" } };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: { code: "object_required" } };
  }

  return { ok: true, value: parsed };
}

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

/**
 * At most `limit` bytes of a request body, or null when it is longer. A
 * declared length over the limit is refused before any byte is read.
 */
export async function readBoundedBytes(
  request: Request,
  limit: number,
): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** A request body as text, or null when it is longer than `limit` bytes. */
export async function readBoundedText(
  request: Request,
  limit: number,
): Promise<string | null> {
  const bytes = await readBoundedBytes(request, limit);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

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

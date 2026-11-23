import { isRecord } from "@purin-labs/std";
import { readBoundedText } from "@purin-labs/kernel/http";
export type JsonRecord = Record<string, unknown>;

export async function readBoundedJsonRecord(
  request: Request,
  maxBytes: number,
): Promise<JsonRecord | null> {
  if (request.body === null) return null;
  const text = await readBoundedText(request, maxBytes);
  if (text === null) return null;
  try {
    const raw: unknown = JSON.parse(text);
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function readJsonRecord(
  request: Request,
): Promise<
  { readonly ok: true; readonly value: JsonRecord } | { readonly ok: false }
> {
  try {
    const value: unknown = await request.json();
    return isRecord(value) ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim()
  );
}

export function noStoreJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function controlJson(body: unknown, status = 200): Response {
  const headers = controlHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

export function controlError(code: string, status: number): Response {
  return controlJson({ ok: false, error: code }, status);
}

export function controlHeaders(): Headers {
  return new Headers({
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    vary: "Cookie",
  });
}

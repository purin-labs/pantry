import type { Result } from "../result";

type ReplyStreamProjection =
  | { readonly kind: "pending" }
  | { readonly kind: "buffered_action" }
  | { readonly kind: "reply"; readonly text: string };

// Text from before a tool call can come first in the answer, so the reply
// is the last reply object in it. A JSON string escapes its quotes, so the
// prefix cannot match inside the reply text.
const REPLY_PREFIX =
  /(?:```(?:json)?\s*)?\{\s*"kind"\s*:\s*"reply"\s*,\s*"text"\s*:\s*"/gu;

export function projectReplyStreamText(
  assembledText: string,
): Result<ReplyStreamProjection, { readonly code: "reply_stream_invalid" }> {
  const prefix = [...assembledText.matchAll(REPLY_PREFIX)].at(-1) ?? null;
  if (prefix === null) {
    return assembledText.includes('"kind"') &&
      !assembledText.includes('"kind":"reply"') &&
      !assembledText.includes('"kind" : "reply"')
      ? { ok: true, value: { kind: "buffered_action" } }
      : { ok: true, value: { kind: "pending" } };
  }
  const rawString = assembledText.slice(prefix.index + prefix[0].length);
  const completePrefix = completeJsonStringPrefix(rawString);
  if (!completePrefix.ok) return completePrefix;
  try {
    const decoded: unknown = JSON.parse(`"${completePrefix.value}"`);
    return typeof decoded === "string"
      ? { ok: true, value: { kind: "reply", text: decoded } }
      : { ok: false, error: { code: "reply_stream_invalid" } };
  } catch {
    return { ok: false, error: { code: "reply_stream_invalid" } };
  }
}

function completeJsonStringPrefix(
  raw: string,
): Result<string, { readonly code: "reply_stream_invalid" }> {
  let index = 0;
  while (index < raw.length) {
    const character = raw[index];
    if (character === '"') return { ok: true, value: raw.slice(0, index) };
    if (character !== "\\") {
      index += 1;
      continue;
    }
    const escape = raw[index + 1];
    if (escape === undefined) return { ok: true, value: raw.slice(0, index) };
    if (escape === "u") {
      const unicode = raw.slice(index + 2, index + 6);
      if (unicode.length < 4) return { ok: true, value: raw.slice(0, index) };
      if (!/^[0-9a-fA-F]{4}$/u.test(unicode))
        return { ok: false, error: { code: "reply_stream_invalid" } };
      index += 6;
      continue;
    }
    if (!/["\\/bfnrt]/u.test(escape))
      return { ok: false, error: { code: "reply_stream_invalid" } };
    index += 2;
  }
  return { ok: true, value: raw };
}

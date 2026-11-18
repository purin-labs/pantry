import { isRecord } from "@seams/std";
import { parseMessageCaseContent } from "../case-content";
import type { ConnectorIngressContent } from "./ingress-parsers";
import type { ConnectorResult } from "./types";

export function parseIngressContent(
  value: unknown,
): ConnectorIngressContent | null {
  if (
    isRecord(value) &&
    (value.kind === "user_message" || value.kind === "record_message")
  ) {
    return parseMessageCaseContent(value);
  }

  return isRecord(value) &&
    value.kind === "text" &&
    typeof value.text === "string" &&
    value.text.trim().length > 0
    ? { kind: "text", text: value.text }
    : null;
}

export function invalid<T>(code: string): ConnectorResult<T> {
  return { ok: false, error: { code } };
}

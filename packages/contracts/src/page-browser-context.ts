import { hasExactKeys, isNonEmptyString, isRecord } from "@purin-labs/std";

/** The browser tab and the conversation that a person's page is bound to. */
export type PageBrowserBinding = Readonly<{
  browserInstanceId: string;
  conversationId: string;
}>;

/**
 * What a person's browser gave with a message: if a page of the browser can
 * take a command of the agent, and for which tab and conversation. It names
 * no page and no product area. A turn carries it, and the area of a page
 * reads it when a command runs.
 */
export type PageBrowserContext =
  | Readonly<{ kind: "unavailable"; binding?: never }>
  | Readonly<{ kind: "excluded"; binding: PageBrowserBinding }>
  | Readonly<{ kind: "available"; binding: PageBrowserBinding }>;

export function parsePageBrowserBinding(
  raw: unknown,
): PageBrowserBinding | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["browserInstanceId", "conversationId"]) ||
    !isNonEmptyString(raw.browserInstanceId) ||
    raw.browserInstanceId.length > 160 ||
    !isNonEmptyString(raw.conversationId) ||
    raw.conversationId.length > 160
  )
    return null;
  return {
    browserInstanceId: raw.browserInstanceId,
    conversationId: raw.conversationId,
  };
}

export function parsePageBrowserContext(
  raw: unknown,
): PageBrowserContext | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "unavailable" && hasExactKeys(raw, ["kind"]))
    return { kind: "unavailable" };
  if (
    (raw.kind !== "available" && raw.kind !== "excluded") ||
    !hasExactKeys(raw, ["kind", "binding"])
  )
    return null;
  const binding = parsePageBrowserBinding(raw.binding);
  return binding === null ? null : { kind: raw.kind, binding };
}

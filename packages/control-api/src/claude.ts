import { isRecord } from "@purin-labs/std";

export type ClaudeConnection =
  | Readonly<{ kind: "disconnected"; connectionId?: never }>
  | Readonly<{ kind: "connected"; connectionId: string }>
  | Readonly<{ kind: "action_required"; connectionId: string }>;

export type ClaudeAuthorization = Readonly<{
  attemptId: string;
  authorizationUrl: string;
  expiresAt: number;
}>;

export type ClaudeAuthorizationState =
  | Readonly<{ kind: "idle"; authorization?: never }>
  | Readonly<{ kind: "authorizing"; authorization: ClaudeAuthorization }>;

export type ClaudeConnectionView = Readonly<{
  connection: ClaudeConnection;
  authorization: ClaudeAuthorizationState;
}>;

export function parseClaudeConnection(raw: unknown): ClaudeConnection | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "disconnected":
      return { kind: "disconnected" };
    case "connected":
    case "action_required":
      return typeof raw.connectionId === "string" && raw.connectionId.length > 0
        ? { kind: raw.kind, connectionId: raw.connectionId }
        : null;
    default:
      return null;
  }
}

export function parseClaudeAuthorization(
  raw: unknown,
): ClaudeAuthorization | null {
  if (
    !isRecord(raw) ||
    typeof raw.attemptId !== "string" ||
    !raw.attemptId ||
    typeof raw.authorizationUrl !== "string" ||
    typeof raw.expiresAt !== "number" ||
    !Number.isSafeInteger(raw.expiresAt) ||
    raw.expiresAt < 0
  )
    return null;
  try {
    const url = new URL(raw.authorizationUrl);
    if (
      url.origin !== "https://claude.ai" ||
      url.pathname !== "/oauth/authorize"
    )
      return null;
    return {
      attemptId: raw.attemptId,
      authorizationUrl: url.href,
      expiresAt: raw.expiresAt,
    };
  } catch {
    return null;
  }
}

export function parseClaudeConnectionView(
  raw: unknown,
): ClaudeConnectionView | null {
  if (!isRecord(raw) || !isRecord(raw.authorization)) return null;
  const connection = parseClaudeConnection(raw.connection);
  if (connection === null) return null;
  if (raw.authorization.kind === "idle")
    return { connection, authorization: { kind: "idle" } };
  if (raw.authorization.kind !== "authorizing") return null;
  const authorization = parseClaudeAuthorization(
    raw.authorization.authorization,
  );
  return authorization === null
    ? null
    : { connection, authorization: { kind: "authorizing", authorization } };
}

import { isRecord } from "@purin-labs/std";
import { parseClaudeConnection, type ClaudeConnection } from "../index.ts";

export function parseConnection(raw: unknown): ClaudeConnection {
  const connection =
    isRecord(raw) && raw.ok === true
      ? parseClaudeConnection(raw.connection)
      : null;
  if (connection === null)
    throw new Error("The server returned an invalid Claude connection.");
  return connection;
}

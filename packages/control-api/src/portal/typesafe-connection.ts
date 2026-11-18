import { isRecord } from "@seams/std";

type Connection =
  | Readonly<{ kind: "disconnected"; revision: number }>
  | Readonly<{
      kind: "connected";
      revision: number;
      provider: "typesafe";
      testedAt: number;
    }>;

export type Configuration = Readonly<{
  connection: Connection;
  credentialConfigured: boolean;
}>;

export function parseConfiguration(raw: unknown): Configuration {
  if (
    !isRecord(raw) ||
    !isRecord(raw.connection) ||
    typeof raw.credentialConfigured !== "boolean"
  )
    throw new Error("Connection information is unavailable.");
  const value = raw.connection;
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    throw new Error("Invalid connection revision.");
  if (value.kind === "disconnected") {
    if (raw.credentialConfigured)
      throw new Error("Invalid connection information.");
    return {
      connection: { kind: "disconnected", revision: value.revision },
      credentialConfigured: raw.credentialConfigured,
    };
  }
  if (
    value.kind !== "connected" ||
    value.revision < 1 ||
    value.provider !== "typesafe" ||
    typeof value.testedAt !== "number" ||
    !Number.isSafeInteger(value.testedAt) ||
    value.testedAt < 0
  )
    throw new Error("Invalid connection information.");
  return {
    connection: {
      kind: "connected",
      revision: value.revision,
      provider: value.provider,
      testedAt: value.testedAt,
    },
    credentialConfigured: raw.credentialConfigured,
  };
}

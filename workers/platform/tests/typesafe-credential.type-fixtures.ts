import type { TypeSafeCredential } from "@purin-labs/agent/typesafe/credential";

// @ts-expect-error All feature consumers must pin a connection revision.
export const unpinnedCredential: TypeSafeCredential = {
  provider: "typesafe",
  apiKey: "synthetic",
};

import type { TypeSafeCredential } from "../src/integrations/typesafe/credential";

// @ts-expect-error All feature consumers must pin a connection revision.
export const unpinnedCredential: TypeSafeCredential = {
  provider: "typesafe",
  apiKey: "synthetic",
};

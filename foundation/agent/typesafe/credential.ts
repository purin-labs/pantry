import type { TypeSafeAuthority } from "./authority";

export type TypeSafeCredential = Readonly<{
  provider: "typesafe";
  apiKey: string;
  authority: TypeSafeAuthority;
}>;

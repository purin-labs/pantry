import type { HeaderInjection } from "./HeaderInjection";

export type InjectionMode =
  | ({ kind: "header" } & HeaderInjection)
  | { kind: "bodyPlaceholder"; bodyPlaceholder: string };

import type { InjectionMode } from "./InjectionMode";

export type InjectionRule = {
  ruleId: string;
  hostPattern: string;
  credentialRef: string;
  mode: InjectionMode;
};

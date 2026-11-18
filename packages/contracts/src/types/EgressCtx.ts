import type { EgressPolicy } from "./EgressPolicy";

export type EgressCtx = {
  organisationId: string;
  sessionId: string;
  policy: EgressPolicy;
};

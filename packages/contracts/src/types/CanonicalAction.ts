import type { ActionNonce } from "./ActionNonce";
import type { Amount } from "./Amount";

export type CanonicalAction = {
  organisationId: string;
  integrationAccountId: string;
  threadId: string;
  sessionId: string;
  host: string;
  verb: string;
  path: string;
  argsHash: string;
  amount: Amount | null;
  nonce: ActionNonce;
  exp: number;
  resourceKey: string;
};

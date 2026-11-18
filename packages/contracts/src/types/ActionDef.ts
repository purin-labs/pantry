import type { ActionClass } from "./ActionClass";
import type { CredentialScope } from "./CredentialScope";
import type { IdempotencySupport } from "./IdempotencySupport";

export type ActionDef = {
  provider: string;
  verb: string;
  method: string | null;
  pathPattern: string | null;
  stakes: ActionClass;
  argsSchema: unknown;
  resourceKey: string;
  idempotency: IdempotencySupport;
  credentialScope: CredentialScope;
  auditFields: Array<string>;
};

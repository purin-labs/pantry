import { CaseActor } from "./case/case-actor";

/**
 * The Case Durable Object class of the Worker. It keeps the deployed class
 * name and the RPC method names. The Case actor holds the logic and names no
 * product area and no surface. This class gives it the parts of the areas.
 */
export class CaseDO extends CaseActor {}

declare module "../env" {
  interface Env {
    CASE: DurableObjectNamespace<CaseDO>;
  }
}

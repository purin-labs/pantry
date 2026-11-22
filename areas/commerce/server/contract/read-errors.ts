import { ToolRequestError } from "@purin-labs/agent-tools/errors";
import type { RequestableEntityTypeRead } from "@purin-labs/authority/authorization/requestable-capabilities";
import type { CommerceGraphReaderError } from "../entity-plane/graph-reader";

/**
 * Why a governed commerce read failed. A tool of another area, for example a
 * Kitchen tool, reads it to ask a person for the read grant that is missing.
 */
export type CommerceContextAssemblyError =
  | CommerceGraphReaderError
  | Readonly<{
      code:
        | "commerce_context_sensitivity_denied"
        | "commerce_context_authority_denied";
    }>
  /**
   * A grant covers this query's scope, but the request authority's sensitivity
   * ceiling is below what the query needs. Distinct from having no grant at
   * all: the caller may be able to ask again under stronger authority.
   */
  | Readonly<{ code: "commerce_context_ceiling_denied" }>;

export class CommerceReadRequestError extends ToolRequestError {
  constructor(
    readonly failure: CommerceContextAssemblyError,
    /**
     * The record type or types whose read grants would admit this read, when a
     * permission request may ask for them.
     */
    requestableRead:
      | RequestableEntityTypeRead
      | readonly RequestableEntityTypeRead[]
      | null = null,
  ) {
    super(describeCommerceReadFailure(failure), requestableRead);
  }
}

function describeCommerceReadFailure(
  failure: CommerceContextAssemblyError,
): string {
  switch (failure.code) {
    case "commerce_context_authority_denied":
      return "Commerce read denied (commerce_context_authority_denied). No active grant covers this query for the current conversation and merchant. If request_permission is available, call it and name the read that is missing. If it is not available, tell the person which read is missing. Do not send the person to a settings page. Do not retry this denied read.";
    case "commerce_context_sensitivity_denied":
    case "commerce_context_ceiling_denied":
      return `Commerce read denied (${failure.code}). The request's sensitivity ceiling does not permit this query. Ask an authorized operator to review access controls, then start a new turn. Do not retry this denied read.`;
    default:
      return `Commerce read unavailable (${failure.code}). Authoritative evidence was not obtained.`;
  }
}

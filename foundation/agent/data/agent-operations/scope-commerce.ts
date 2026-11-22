import type { Variant } from "@purin-labs/type-utils";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import type { Result } from "@purin-labs/kernel/result";
import type {
  AgentResponsibilityScope,
  AgentResponsibilityScopePublicationEvidence,
} from "../agent-operations";

/** Why a published resource reference was refused. */
export type PublishedResourceBoundaryError =
  | Readonly<{
      readonly code:
        | "invalid_reference"
        | "not_published"
        | "organisation_mismatch"
        | "merchant_mismatch"
        | "unavailable";
    }>
  | Readonly<{
      readonly code: "revision_conflict";
      readonly expected: number;
      readonly actual: number;
    }>;

/**
 * The commerce parts of a responsibility scope of an agent area: the
 * checks of the commerce references that a scope names, the read of their
 * published evidence from the commerce engine, and the match of the
 * evidence with the scope. Commerce owns the records, so it gives the
 * implementation, and the Worker registers it (`worker-ports.ts`).
 */
export type ResponsibilityScopeCommerce = Readonly<{
  /** The relationship of a scope, or null when it is not one. */
  parseRelationship(
    raw: unknown,
  ): Variant<AgentResponsibilityScope, "relationship">["relationship"] | null;
  /** The list entry of a scope, or null when it is not one. */
  parseListEntry(
    raw: unknown,
  ): Variant<AgentResponsibilityScope, "commerce_list_entry">["entry"] | null;
  /** The graph query of a saved selector, or null when it is not one. */
  parseSelectorQuery(
    raw: unknown,
  ):
    | Variant<AgentResponsibilityScope, "saved_selector">["selector"]["query"]
    | null;
  /** Reads the published evidence of the records that a scope names. */
  resolvePublishedScope(
    input: Readonly<{
      env: Env;
      organisationId: OrganisationId;
      merchantId: string;
      scope: AgentResponsibilityScope;
    }>,
  ): Promise<
    Result<
      AgentResponsibilityScopePublicationEvidence,
      PublishedResourceBoundaryError
    >
  >;
  /** Whether the published evidence names the records of the scope. */
  evidenceMatchesScope(
    scope: AgentResponsibilityScope,
    evidence: AgentResponsibilityScopePublicationEvidence,
  ): boolean;
}>;

export const responsibilityScopeCommerce =
  definePort<ResponsibilityScopeCommerce>("responsibility_scope_commerce");

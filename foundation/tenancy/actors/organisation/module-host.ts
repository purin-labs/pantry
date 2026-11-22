import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import type { Result } from "@purin-labs/kernel/result";

/**
 * What the Organisation actor gives to a module of one product area
 * (Refactor 17, step A1.9). A module is a class with this one value: it reads
 * no field of the Actor class. The state and the bindings are read at each
 * use.
 */
export type OrganisationModuleHost = Readonly<{
  ctx: DurableObjectState;
  env: Env;
  /**
   * Runs one Organisation command: it admits the placement, runs `start`
   * with the admitted scope, checks the placement again and tracks the
   * execution for the export barrier.
   */
  command<Outcome extends Result<unknown, { readonly code: string }>>(
    organisationId: OrganisationId,
    start: (scope: OrganisationExecutionScope) => Promise<Outcome>,
  ): Promise<
    | Outcome
    | Result<never, { readonly code: "organisation_placement_conflict" }>
  >;
  /** Sets the alarm from the Organisation's stored work. */
  rearm(): Promise<number | null>;
}>;

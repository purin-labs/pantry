import type { Result } from "@purin-labs/kernel/result";
import {
  recordOrganisationCommerceMutationReceipt,
  type UnversionedControlMutationBoundary,
  type ControlMutationReceiptScope,
} from "../data/control-mutation";
import type { AuthorizedOrganisationRequest } from "./authorization";
import { controlCausationId } from "./mutation";

export function recordCommerceMutationReceipt(input: {
  readonly authorized: AuthorizedOrganisationRequest;
  readonly identity: {
    readonly issuer: string;
    readonly subject: string;
    readonly userId: string;
  };
  readonly scope: ControlMutationReceiptScope;
  readonly boundary: UnversionedControlMutationBoundary;
  readonly request: Request;
  readonly responseBody: unknown;
  readonly responseStatus?: number;
  readonly now: number;
}): Promise<
  Result<null, { readonly code: "organisation_placement_conflict" }>
> {
  return recordOrganisationCommerceMutationReceipt({
    executionScope: input.authorized.executionScope,
    identity: input.identity,
    scope: input.scope,
    boundary: input.boundary,
    causationId: controlCausationId(input.request),
    responseBody: input.responseBody,
    responseStatus: input.responseStatus,
    now: input.now,
  });
}

import { Type, type Static } from "typebox";
import type { StrictUnion } from "@purin-labs/type-utils";
import { StrictObject } from "@purin-labs/commerce-contracts/schema";

// Request eligibility of an Organisation (Plan 95). A request asks if a
// person or an automation of the Organisation may take one action now.

/**
 * `execute` starts work, `disclose` shows a record, `restore` brings back an
 * archived record and `replay` reads accepted history again.
 */
const OrganisationAdmissionActionSchema = Type.Union([
  Type.Literal("execute"),
  Type.Literal("disclose"),
  Type.Literal("restore"),
  Type.Literal("replay"),
]);
export type OrganisationAdmissionAction = Static<
  typeof OrganisationAdmissionActionSchema
>;

/** Why a person acts: the evidence that names the request. */
const OrganisationUserAuthoritySchema = Type.Union([
  StrictObject({
    kind: Type.Literal("authenticated_session"),
    nativeSessionId: Type.String({ minLength: 1 }),
  }),
  StrictObject({
    kind: Type.Literal("accepted_execution"),
    acceptedExecutionId: Type.String({ minLength: 1 }),
  }),
  StrictObject({
    kind: Type.Literal("disclosure_recipient"),
    disclosureEvidenceId: Type.String({ minLength: 1 }),
  }),
  StrictObject({
    kind: Type.Literal("authenticated_provider_event"),
    provider: Type.Literal("slack"),
    nativeEventId: Type.String({ minLength: 1 }),
    nativeIntegrationAccountId: Type.String({ minLength: 1 }),
    nativeWorkspaceId: Type.String({ minLength: 1 }),
    nativeExternalUserId: Type.String({ minLength: 1 }),
  }),
]);
export type OrganisationUserAuthority = StrictUnion<
  Static<typeof OrganisationUserAuthoritySchema>
>;

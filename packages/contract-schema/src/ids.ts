// The ids that the records of Pantry and of the commerce engine both carry
// (Refactor 17, step A1.11). Each contract package names them from here, so
// neither package names the other.
import { Type, type Static } from "typebox";

export const organisationIdSchema = Type.String();
export type OrganisationId = Static<typeof organisationIdSchema>;

export const integrationAccountIdSchema = Type.String();
export type IntegrationAccountId = Static<typeof integrationAccountIdSchema>;

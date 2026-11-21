import type { CaseId } from "./CaseId";
import type { OrganisationId } from "@purin-labs/contract-schema";

export type CaseIdentity = { organisationId: OrganisationId; caseId: CaseId };

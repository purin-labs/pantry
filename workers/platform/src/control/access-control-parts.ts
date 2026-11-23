import { resolveActiveCustomConnectorAccount } from "@purin-labs/area-integrations/server/custom-connectors/accounts";
import { resolveCustomConnectorRevision } from "@purin-labs/area-integrations/server/custom-connectors/revisions";
import { resolveAirtableAccountToken } from "@purin-labs/area-integrations/server/external-records/oauth";
import type { AccessControlParts } from "@purin-labs/control/worker/routes/access-control-explain";

/**
 * The parts of the integrations area that the access control routes read.
 * The Worker router gives this value to the routes.
 */
export const ACCESS_CONTROL_PARTS: AccessControlParts = {
  customConnectorAccount: resolveActiveCustomConnectorAccount,
  customConnectorRevision: resolveCustomConnectorRevision,
  airtableAccountToken: resolveAirtableAccountToken,
};

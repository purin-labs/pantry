import type { ConnectorIdentity } from "@purin-labs/contracts";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { ConnectorModuleHost } from "./channel-adapter";
import { ensureConnectorIdentity } from "./ingress-parsers";
import { invalid } from "./support";
import type { ConnectorResult } from "./types";

/**
 * Admits one piece of work of a module for the named Connector. The Connector
 * must admit work at its placement, and its stored identity must be the named
 * one: the first call of a Connector stores it. The steps and their order are
 * the ones that each RPC method of a channel had.
 */
export async function admitNamedConnector(
  host: ConnectorModuleHost,
  identity: ConnectorIdentity,
): Promise<ConnectorResult<OrganisationExecutionScope>> {
  const scope = await host.admitExecution(identity);
  if (scope === null) return invalid("connector_placement_conflict");
  const ensured = host.ctx.storage.transactionSync(
    ensureConnectorIdentity.bind(null, host.ctx.storage.sql, identity),
  );
  return ensured.ok ? { ok: true, value: scope } : ensured;
}

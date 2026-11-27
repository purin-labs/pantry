import type { SqlStorage } from "@cloudflare/workers-types";
import { definePort } from "@purin-labs/kernel/port";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

/**
 * The eval runs of one Connector, as its email channel sees them: the
 * channel runs the due eval work as one step of its alarm.
 */
export type ConnectorEvalWork = Readonly<{
  runDueEvalWork(scope: OrganisationExecutionScope): Promise<void>;
}>;

/**
 * The eval tables in the storage of a Connector. The email channel creates
 * them with its own tables, and its alarm reads when the next eval work is
 * due. The Brain owns the tables, and the Worker registers the
 * implementation (`worker-ports.ts`).
 */
export type ConnectorEvalStore = Readonly<{
  createSchema: (sql: SqlStorage) => void;
  nextWorkAt: (sql: SqlStorage) => number | null;
}>;

export const connectorEvalStore = definePort<ConnectorEvalStore>(
  "connector_eval_store",
);

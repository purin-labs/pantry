import type { IntegrationDiscoveryView } from "@purin-labs/contracts";
import type {
  AirtableReadInput,
  AirtableWriteInput,
} from "../../actors/airtable-tool-input";
import type {
  CustomConnectorReadCatalogEntry,
  CustomConnectorWriteCatalogEntry,
} from "../../custom-connectors";
import { defineToolFamily } from "../define-tool";
import type { PreparedEffect } from "../tool-effect";

type HarnessCustomConnectorRead = (
  entry: CustomConnectorReadCatalogEntry,
  input: unknown,
  operationId: string,
) => Promise<unknown>;

type HarnessCustomConnectorWriteProposal = (
  entry: CustomConnectorWriteCatalogEntry,
  input: unknown,
  operationId: string,
) => Promise<unknown>;

export type HarnessIntegrationListRequest = Readonly<{ kind: "list" }>;

type IntegrationList = (
  request: HarnessIntegrationListRequest,
) => Promise<IntegrationDiscoveryView>;

/** What a turn gives to the integration tools. */
export type IntegrationToolServices = {
  readonly listIntegrations: IntegrationList;
  readonly readAirtable?: (input: AirtableReadInput) => Promise<unknown>;
  readonly writeAirtable?: (
    input: AirtableWriteInput,
  ) => Promise<PreparedEffect>;
  readonly readCustomConnector: HarnessCustomConnectorRead;
  readonly proposeCustomConnectorWrite: HarnessCustomConnectorWriteProposal;
};

export const defineIntegrationTool =
  defineToolFamily<IntegrationToolServices>()("integrations");

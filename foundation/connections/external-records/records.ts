import { definePort } from "@purin-labs/kernel/port";
import type { Result } from "@purin-labs/kernel/result";

/**
 * The external records port (Refactor 17). The Airtable and Notion client is a
 * part of the integrations area (`server/external-records/records.ts`). The
 * access model of the control module lists the Airtable bases of an account
 * through this port, and the Worker registers the client.
 */

export type ExternalRecordsError =
  | { readonly code: "external_records_input_invalid"; readonly field: string }
  | { readonly code: "external_records_credential_invalid" }
  | { readonly code: "external_records_access_denied" }
  | { readonly code: "external_records_rate_limited" }
  | { readonly code: "external_records_unavailable" }
  | { readonly code: "external_records_response_invalid" };

/** An Airtable base that a credential can read: its resource scope and its name. */
export type AirtableBase = Readonly<{ scope: string; label: string }>;

export type ExternalRecordsDiscovery = Readonly<{
  discoverAirtableBases(
    credential: string,
    fetcher: typeof fetch,
  ): Promise<Result<readonly AirtableBase[], ExternalRecordsError>>;
}>;

export const externalRecordsDiscovery = definePort<ExternalRecordsDiscovery>(
  "external_records_discovery",
);

/** The Airtable bases that the credential can read. */
export function discoverAirtableBases(
  credential: string,
  fetcher: typeof fetch,
): Promise<Result<readonly AirtableBase[], ExternalRecordsError>> {
  return externalRecordsDiscovery
    .use()
    .discoverAirtableBases(credential, fetcher);
}

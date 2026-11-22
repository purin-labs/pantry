import type { Result } from "@purin-labs/kernel/result";
import { parseConnectorId, type ConnectorId } from "@purin-labs/kernel/ids";

/** The Connector id of a Gmail mailbox, by its integration account. */
export function gmailConnectorIdValue(integrationAccountId: string): string {
  return `connector_gmail_${integrationAccountId}`;
}

export function gmailConnectorId(
  integrationAccountId: string,
): Result<
  ConnectorId,
  { readonly code: "invalid_field"; readonly field: string }
> {
  const parsed = parseConnectorId(gmailConnectorIdValue(integrationAccountId));
  return parsed.ok
    ? parsed
    : {
        ok: false,
        error: { code: "invalid_field", field: "integrationAccountId" },
      };
}

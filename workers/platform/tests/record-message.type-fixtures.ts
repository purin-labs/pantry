import type { CaseContent, UserMessage } from "@purin-labs/contracts";
import type { SourceProvenance } from "@purin-labs/commerce-contracts";

export function recordMessageTypeChecks(
  message: UserMessage,
  provenance: SourceProvenance,
): CaseContent {
  // @ts-expect-error A selected record cannot discard the authored message.
  const missingMessage: CaseContent = { kind: "record_message", provenance };
  // @ts-expect-error A record message requires an exact source locator.
  const missingProvenance: CaseContent = { kind: "record_message", message };
  void missingMessage;
  void missingProvenance;
  return { kind: "record_message", message, provenance };
}

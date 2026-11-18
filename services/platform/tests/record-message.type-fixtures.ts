import type {
  CaseContent,
  SourceProvenance,
  UserMessage,
} from "@seams/contracts";

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

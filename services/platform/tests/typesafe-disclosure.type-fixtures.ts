import type { TypeSafeDisclosure } from "../src/integrations/typesafe/disclosure";
import type { TypeSafeInferenceSink } from "@purin-labs/authority/policy/information-flow/types";
import { JevRelationshipRequest } from "../src/case-context-discovery/jev";

export function rejectForgedDisclosure(
  value: TypeSafeDisclosure,
  sink: TypeSafeInferenceSink,
): void {
  // @ts-expect-error Candidate mapping can only be constructed with its authorized request.
  new JevRelationshipRequest(value, []);
  // @ts-expect-error Request bytes require the private authorized request slot.
  const forged: TypeSafeDisclosure = { ...value };
  const mixed: TypeSafeInferenceSink = {
    ...sink,
    // @ts-expect-error Public fixture processing cannot retain a private source authority.
    processing: { kind: "public_fixture", fixtureRevision: 1, authority: {} },
  };
  void forged;
  void mixed;
}

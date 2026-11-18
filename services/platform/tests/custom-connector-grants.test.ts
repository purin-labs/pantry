import { describe, expect, it } from "vitest";

import {
  encodeCapabilityKey,
  parseCapabilityKey,
} from "../src/authorization/access-grants";
import { parseAccessGrantTarget } from "../src/data/access-grants";

const target = {
  kind: "custom_connector_operation" as const,
  capabilityId: "custom_connector.read",
  capabilityVersion: 1,
  integrationAccountId: "integration_custom_inventory",
  connectorId: "custom_connector_inventory",
  definitionRevision: 3,
  definitionDigest: "a".repeat(64),
  operationId: "list_products",
};

describe("custom connector grants", function customConnectorGrantSuite() {
  it("round trips one exact operation capability key", function roundTripsCapabilityKey() {
    const encoded = encodeCapabilityKey(target);
    expect(parseCapabilityKey(encoded)).toEqual({ ok: true, value: target });
  });

  it("parses the complete target and rejects a missing revision binding", function parsesExactTarget() {
    expect(parseAccessGrantTarget(target)).toEqual({ ok: true, value: target });
    const { definitionDigest: _removed, ...missingDigest } = target;
    expect(parseAccessGrantTarget(missingDigest)).toEqual({
      ok: false,
      error: { code: "invalid_grant_target", field: "target.kind" },
    });
  });

  it("rejects a generic or future capability at the request boundary", function rejectsBroadCapability() {
    expect(
      parseAccessGrantTarget({
        ...target,
        capabilityId: "custom_connector.http",
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_grant_target", field: "target.capabilityId" },
    });
  });
});

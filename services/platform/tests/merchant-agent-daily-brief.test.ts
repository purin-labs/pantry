import { describe, expect, it } from "vitest";

import { CommerceEntityPlaneClient } from "@purin-labs/commerce-client";
import type { RequestAuthority } from "@purin-labs/contracts";

import { CommerceGraphReader } from "@purin-labs/area-commerce/server/entity-plane/graph-reader";
import { runMerchantReport } from "@purin-labs/area-commerce/server/entity-plane/merchant-report-runner";
import type { MerchantReportName } from "@purin-labs/area-commerce/server/entity-plane/merchant-reports";
import { CommerceEngineSource } from "@purin-labs/area-commerce/server/entity-plane/commerce-source";
import { parseOrganisationId } from "@purin-labs/kernel/ids";

const ORGANISATION_ID = "organisation_urk_brief";
const MERCHANT_ID = "merchant_urk_brief";
const INTEGRATION_ID = "integration_urk_brief";
const NOW = "2026-09-05T00:00:00.000Z";

describe("Urk daily brief", () => {
  it("says product sales is unavailable instead of reporting another number", async () => {
    const sales = await report("product_sales");
    if (sales.kind !== "unavailable")
      throw new Error("product sales must not report a number");
    // The refusal names what is actually missing, so nobody re-derives it.
    expect(sales.reason).toContain("authorized line-level report route");
    expect(sales.dependency.length).toBeGreaterThan(0);
  });

  it("still refuses a scheduled run the sales total, and says what is missing", async () => {
    const result = await runMerchantReport(runInput("product_sales"));
    if (!result.ok)
      throw new Error(`report failed: ${JSON.stringify(result.error)}`);
    // The graph-count runner cannot substitute for the authorized report API.
    expect(result.value.kind).toBe("unavailable");
    if (result.value.kind !== "unavailable") return;
    expect(result.value.dependency).toBe("authorized_product_sales_read");
  });

  it("denies a report whose entity type no grant covers", async () => {
    const denied = await runMerchantReport(runInput("open_orders"));
    expect(denied).toEqual({
      ok: false,
      error: { code: "commerce_context_authority_denied" },
    });
  });
});

async function report(name: MerchantReportName) {
  const result = await runMerchantReport(runInput(name));
  if (!result.ok)
    throw new Error(`report ${name} failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

function runInput(name: MerchantReportName) {
  const organisationId = required(parseOrganisationId(ORGANISATION_ID));
  // Scenario 2 is an operator asking Sous Chef what needs attention today.
  const requestAuthority: RequestAuthority = {
    kind: "direct_conversation",
    organisationId,
    requesterPersonId: "person_urk_operator",
    membershipRevision: 1,
    role: "operator",
    connectorId: "connector_urk_brief",
    integrationAccountId: INTEGRATION_ID,
    conversationId: "conversation_urk_brief",
  };
  return {
    organisationId: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    grants: [],
    requestAuthority,
    causationId: "turn_urk_brief",
    reader: fixtureReader(),
    allowedSensitivity: "internal" as const,
    name,
    now: NOW,
  };
}

function fixtureReader(): CommerceGraphReader {
  const client = new CommerceEntityPlaneClient({
    baseUrl: "https://commerce.urk-brief.test",
    serviceToken: "urk-brief-test-token",
    fetch: rejectUnexpectedRead,
  });
  return new CommerceGraphReader({
    organisationId: ORGANISATION_ID,
    merchantId: MERCHANT_ID,
    commerce: new CommerceEngineSource({
      organisationId: ORGANISATION_ID,
      merchantId: MERCHANT_ID,
      integrationAccountId: INTEGRATION_ID,
      client,
    }),
  });
}

async function rejectUnexpectedRead(): Promise<never> {
  throw new Error("A refused report must not read commerce records.");
}

function required<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

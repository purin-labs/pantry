import { expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { URL as NodeUrl } from "node:url";
import {
  CommerceAdminClient,
  CommerceEntityPlaneClient,
  parseCommerceGraphQuery,
} from "@seams/commerce-client";
import { parsePantryCommerceReadAuthority } from "@seams/commerce-contracts/read-authority";
import {
  createFinancierSample,
  FINANCIER_SAMPLE_ID,
} from "../src/commerce/bakery/sample";
import { CommerceGraphReader } from "../src/commerce/entity-plane/graph-reader";
import { CommerceEngineSource } from "../src/commerce/entity-plane/commerce-source";
import {
  parseCommerceBindingId,
  parseCommerceEngineMerchantId,
} from "../src/data/commerce-merchant-binding";
import { parseCommerceSystemRevision } from "../src/data/organisation-commerce-system";
import {
  startCommerceWorker,
  type CommerceWorker,
} from "./commerce-fixture-worker";
import { requireOrganisationId } from "./test-ids";

const NOW = "2026-10-24T00:00:00Z";
const EXPIRES = "2030-01-01T00:00:00Z";
const ORGANISATION = requireOrganisationId(
  "organisation_read_authority_journey",
);
const MERCHANT = "merchant_read_authority_journey";
it(
  "reads a real procedure through typed authority and fences expired and out-of-scope reads",
  { timeout: 60000 },
  readAuthorityJourney,
);
async function readAuthorityJourney(): Promise<void> {
  const worker = await startCommerceWorker({ now: NOW });
  const requests: string[] = [];
  try {
    const config = {
      baseUrl: worker.baseUrl,
      serviceToken: worker.serviceToken,
      fetch: recordRequest.bind(null, worker, requests),
    };
    const provisioned = await new CommerceAdminClient(
      config,
    ).provisionMerchant({
      schemaVersion: "underclerk.provision-merchant.v2",
      externalReference: ORGANISATION,
      merchantId: MERCHANT,
      createdAt: NOW,
    });
    expect(provisioned.ok).toBe(true);
    const client = new CommerceEntityPlaneClient(config);
    const sample = await createFinancierSample({
      client,
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
      principalId: "read_operator",
      expiresAt: EXPIRES,
    });
    expect(sample.ok).toBe(true);
    const binding = parseCommerceBindingId(
      "underclerk_binding_read_authority",
    );
    const merchant = parseCommerceEngineMerchantId(MERCHANT);
    const revision = parseCommerceSystemRevision(1);
    if (!binding.ok || !merchant.ok || !revision.ok)
      throw new Error("Invalid commerce fixture identity");
    const reader = new CommerceGraphReader({
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
      commerceSystem: {
        kind: "satyr_commerce",
        organisationId: ORGANISATION,
        bindingId: binding.value,
        merchantId: merchant.value,
        revision: revision.value,
      },
      underclerk: new CommerceEngineSource({
        organisationId: ORGANISATION,
        merchantId: MERCHANT,
        integrationAccountId: "integration_read_authority",
        client,
      }),
    });
    const authority = parsePantryCommerceReadAuthority(
      {
        context: {
          organisationId: ORGANISATION,
          merchantId: MERCHANT,
          principalId: "read_operator",
          sensitivityCeiling: "restricted",
          expiresAt: EXPIRES,
          causation: { kind: "event", eventId: "read_journey" },
        },
        scope: {
          kind: "entity_type",
          entityTypeId: { origin: "custom", typeId: "bakery_procedure" },
        },
      },
      NOW,
    );
    if (!authority.ok) throw new Error(authority.error.reason);
    const query = parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: "bakery_procedure",
        entityId: FINANCIER_SAMPLE_ID,
      },
      traversal: { maxDepth: 0, resultLimit: 1 },
      filter: null,
    });
    const beforeRead = requests.length;
    const accepted = await reader.query({
      query,
      authority: authority.value,
      now: NOW,
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error(accepted.error.code);
    expect(accepted.value.entities).toHaveLength(1);
    expect(accepted.value.entities[0]?.reference.entityId).toBe(
      FINANCIER_SAMPLE_ID,
    );
    expect(requests.length).toBeGreaterThan(beforeRead);
    const beforeRefused = requests.length;
    const expired = await reader.query({
      query,
      authority: authority.value,
      now: EXPIRES,
    });
    expect(expired).toEqual({
      ok: false,
      error: { code: "authority_expired" },
    });
    const otherType = parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: "bakery_operation",
        entityId: "different",
      },
      traversal: { maxDepth: 0, resultLimit: 1 },
      filter: null,
    });
    const refused = await reader.query({
      query: otherType,
      authority: authority.value,
      now: NOW,
    });
    expect(refused).toEqual({
      ok: false,
      error: { code: "authority_out_of_scope" },
    });
    expect(requests.length).toBe(beforeRefused);
    const originalDeniedRequests = requests.length - beforeRefused;
    const precise = parsePantryCommerceReadAuthority(
      {
        context: {
          organisationId: ORGANISATION,
          merchantId: MERCHANT,
          principalId: "read_operator",
          sensitivityCeiling: "restricted",
          expiresAt: "2026-10-24T00:00:00.000000002Z",
          causation: { kind: "event", eventId: "precise_read" },
        },
        scope: authority.value.scope,
      },
      NOW,
    );
    if (!precise.ok) throw new Error(precise.error.reason);
    const beforeExpiry = await reader.query({
      query,
      authority: precise.value,
      now: "2026-10-24T00:00:00.000000001Z",
    });
    expect(beforeExpiry.ok).toBe(true);
    const offsetEquivalent = await reader.query({
      query,
      authority: precise.value,
      now: "2026-10-24T09:00:00.000000001+09:00",
    });
    expect(offsetEquivalent).toEqual(beforeExpiry);
    const beforeExactExpiry = requests.length;
    const exactExpiry = await reader.query({
      query,
      authority: precise.value,
      now: "2026-10-24T00:00:00.000000002Z",
    });
    expect(exactExpiry).toEqual({
      ok: false,
      error: { code: "authority_expired" },
    });
    expect(requests.length).toBe(beforeExactExpiry);

    const directory = new NodeUrl("../output/plan-78/", import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      new NodeUrl("read-authority-http.json", directory),
      JSON.stringify(
        {
          status: "passed",
          entity: accepted.value.entities[0]?.reference,
          expiredRefused: true,
          outOfScopeRefused: true,
          deniedRequestsSent:
            originalDeniedRequests + requests.length - beforeExactExpiry,
          nanosecondReadAllowed: beforeExpiry.ok,
          exactExpiryRefused: true,
          offsetEquivalent: true,
          sourceRequests: requests.length - beforeRead,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await worker.dispose();
  }
}
async function recordRequest(
  worker: CommerceWorker,
  requests: string[],
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  requests.push(new URL(String(input)).pathname);
  return worker.fetch(input, init);
}

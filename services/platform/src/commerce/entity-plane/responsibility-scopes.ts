// The commerce parts of the responsibility scope of an agent area
// (Refactor 17). The port is data/agent-operations/scope-commerce.ts, and
// the Worker registers this implementation.
import {
  parseCommerceListEntryRef,
  parseCommerceRelationshipRef,
} from "@purin-labs/commerce-client";
import type { ResponsibilityScopeCommerce } from "@purin-labs/agent/data/agent-operations/scope-commerce";
import { pantryCommerceAccess } from "../contract/client";
import {
  createPublishedResourceClient,
  publishedResourceEvidenceMatchesScope,
  resolvePublishedResponsibilityScope,
} from "./published-resources";
import { parseCommerceGraphQuery } from "./routes";

export const RESPONSIBILITY_SCOPE_COMMERCE: ResponsibilityScopeCommerce = {
  parseRelationship(raw) {
    try {
      return parseCommerceRelationshipRef(raw);
    } catch {
      return null;
    }
  },
  parseListEntry(raw) {
    try {
      return parseCommerceListEntryRef(raw);
    } catch {
      return null;
    }
  },
  parseSelectorQuery(raw) {
    const query = parseCommerceGraphQuery(raw);
    return query.ok ? query.value : null;
  },
  async resolvePublishedScope({ env, organisationId, merchantId, scope }) {
    if (
      env.COMMERCE_BASE_URL === undefined ||
      env.COMMERCE_SERVICE_TOKEN === undefined
    ) {
      return { ok: false, error: { code: "unavailable" } };
    }
    const client = createPublishedResourceClient({
      baseUrl: env.COMMERCE_BASE_URL,
      ...pantryCommerceAccess(
        env.COMMERCE_SERVICE_TOKEN,
        String(organisationId),
        env.COMMERCE.fetch.bind(env.COMMERCE),
      ),
    });
    if (client === null) {
      return { ok: false, error: { code: "unavailable" } };
    }
    return resolvePublishedResponsibilityScope({
      client,
      organisationId,
      merchantId,
      scope,
    });
  },
  evidenceMatchesScope: (scope, evidence) =>
    publishedResourceEvidenceMatchesScope(scope, evidence),
};

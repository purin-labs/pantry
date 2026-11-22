// The commerce parts of the access-control routes (Refactor 17). The port
// is access-control/commerce-access-targets.ts, and the Worker registers
// this implementation.
import { parseEntityTypeId } from "@purin-labs/commerce-client";
import type { CommerceAccessTargets } from "@purin-labs/authority/access-control/commerce-access-targets";
import {
  listPublishedCommerceTargets,
  resolvePublishedCommerceTarget,
} from "./published-resources";
import { parseCommerceGraphQuery } from "./routes";

export const COMMERCE_ACCESS_TARGETS: CommerceAccessTargets = {
  listPublishedTargets: (input) => listPublishedCommerceTargets(input),
  resolvePublishedTarget: (input) => resolvePublishedCommerceTarget(input),
  parseEntityTypeId(raw) {
    try {
      return parseEntityTypeId(raw);
    } catch {
      return null;
    }
  },
  parseListReadId(listId) {
    const query = parseCommerceGraphQuery({
      kind: "commerce_list_page",
      listId,
      filter: { kind: "all" },
      sorts: [],
      pagination: { limit: 1, cursor: null },
    });
    return query.ok && query.value.kind === "commerce_list_page"
      ? query.value.listId
      : null;
  },
};

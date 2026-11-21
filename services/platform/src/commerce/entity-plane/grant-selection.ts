// The selection of the source grant of a commerce read, for the access model
// and the Project references of the foundation (Refactor 17). The port is
// authorization/access-grants/commerce-grant-selection.ts, and the Worker
// registers this implementation.
import { parseSystemEntityRef } from "@purin-labs/commerce-client";
import type {
  CommerceGrantSelection,
  CommerceGrantSelectionError,
} from "../../authorization/access-grants/commerce-grant-selection";
import type { AccessGrant } from "../../authorization/access-grants/types";
import {
  requestableReadScope,
  type RequestableEntityTypeRead,
} from "../../authorization/requestable-capabilities";
import type { Result } from "../../result";
import type { CommerceContextAssemblyError } from "../contract/read-errors";
import { selectNamedCommerceQuerySourceGrant } from "./context-read";
import { parseCommerceGraphQuery } from "./routes";

export const COMMERCE_GRANT_SELECTION: CommerceGrantSelection = {
  selectRequestableReadGrant({ read, ...input }) {
    const query = parseCommerceGraphQuery(requestableReadQuery(read));
    if (!query.ok) return { ok: false, error: { code: "unavailable" } };
    return selected(
      selectNamedCommerceQuerySourceGrant({
        ...input,
        query: query.value,
        allowedSensitivity: "internal",
      }),
    );
  },
  selectRecordGrant({ recordType, recordId, ...input }) {
    return selected(
      selectNamedCommerceQuerySourceGrant({
        ...input,
        query: {
          kind: "entity_by_ref",
          reference: parseSystemEntityRef(recordType, recordId),
          traversal: { maxDepth: 0, resultLimit: 1 },
          filter: null,
        },
        allowedSensitivity: "public",
      }),
    );
  },
};

function selected(
  result: Result<AccessGrant, CommerceContextAssemblyError>,
): Result<AccessGrant, CommerceGrantSelectionError> {
  if (result.ok) return result;
  return {
    ok: false,
    error: {
      code:
        result.error.code === "commerce_context_authority_denied"
          ? "denied"
          : "unavailable",
    },
  };
}

/** A query that only a grant over the whole read scope admits. */
function requestableReadQuery(read: RequestableEntityTypeRead): unknown {
  const scope = requestableReadScope(read);
  switch (scope.kind) {
    case "entity_type":
      return {
        kind: "entity_type_page",
        entityTypeId: { origin: "system", typeId: scope.typeId },
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 1, cursor: null },
        traversal: { maxDepth: 0, resultLimit: 1 },
      };
    case "commerce_list":
      return {
        kind: "commerce_list_page",
        listId: scope.listId,
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 1, cursor: null },
      };
  }
}

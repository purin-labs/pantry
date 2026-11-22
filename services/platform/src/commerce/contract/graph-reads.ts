import type {
  commerceGraphControlAuthority,
  controlCommerceSensitivityCeiling,
  openControlCommerceGraph,
} from "../../control/commerce-graph";
import { definePort } from "@purin-labs/kernel/port";
import type { CommerceEngineSource } from "../entity-plane/commerce-source";
import type {
  readNamedCommerceQuery,
  selectNamedCommerceQuerySourceGrant,
} from "../entity-plane/context-read";
import type { createCommerceGraphReader } from "../entity-plane/selected-graph-reader";

/**
 * The graph reads of commerce, as a service interface of its contract. The
 * Inbox reads the supplier records of a mail under the grant of the reader,
 * and the sender links route reads one supplier under the person's control
 * authority. Commerce owns the graph, its sources and its authority. The
 * Worker registers the implementation (`worker-ports.ts`).
 */
export type CommerceGraphReads = Readonly<{
  /** Selects the source grant of one named graph query. */
  selectNamedCommerceQuerySourceGrant: typeof selectNamedCommerceQuerySourceGrant;
  /** Runs one named graph query under the grant that it selects. */
  readNamedCommerceQuery: typeof readNamedCommerceQuery;
  /** The commerce engine source of one merchant binding. */
  createCommerceEngineSource(
    options: ConstructorParameters<typeof CommerceEngineSource>[0],
  ): CommerceEngineSource;
  /** The graph reader of the selected commerce system. */
  createCommerceGraphReader: typeof createCommerceGraphReader;
  /** The graph reader of a control request, with its merchant. */
  openControlCommerceGraph: typeof openControlCommerceGraph;
  /** The read authority of a control request for one query. */
  commerceGraphControlAuthority: typeof commerceGraphControlAuthority;
  /** The sensitivity ceiling of a control request. */
  controlCommerceSensitivityCeiling: typeof controlCommerceSensitivityCeiling;
}>;

export const commerceGraphReads = definePort<CommerceGraphReads>(
  "commerce_graph_reads",
);

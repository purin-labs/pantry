import type { prepareCommerceReadForEmbeddedHarness } from "../../agent-tools/commerce/handlers";
import type {
  admitCommerceReadObservation,
  prepareSharedCommerceObservation,
  prepareStaffPageWork,
  refreshRecipeProjection,
  requestableReportRead,
  selectInternalQuerySourceGrant,
  selectMerchantReportSourceGrant,
  supplierDirectoryQuery,
} from "../../agent-tools/commerce/read-support";
import type { readNamedCommerceQuery } from "../entity-plane/context-read";
import type { parseCommerceGraphQuery } from "../entity-plane/routes";

export type { PreparedCommerceRead } from "../../agent-tools/commerce/read-support";

/**
 * The governed commerce reads of a tool handler, as a service interface of
 * the commerce contract. A handler of another area, for example a Kitchen
 * tool, reads commerce records through it: the grant of the turn, the flow
 * label, the observation and the staff page work. Commerce implements it,
 * and the Worker gives the implementation to the area that asks.
 */
export type CommerceToolReads = Readonly<{
  /** Prepares one commerce read of a turn for the grant that is selected. */
  prepareCommerceRead: typeof prepareCommerceReadForEmbeddedHarness;
  /** A prepared read whose label a shared document may show. */
  prepareSharedCommerceObservation: typeof prepareSharedCommerceObservation;
  /** Records one commerce read as observation evidence of the turn. */
  admitCommerceReadObservation: typeof admitCommerceReadObservation;
  /** Turns a denied read into a request that a person can allow. */
  requestableReportRead: typeof requestableReportRead;
  /** The member, the read and the client of a tool that acts as a staff page. */
  prepareStaffPageWork: typeof prepareStaffPageWork;
  /** Asks the commerce projection to read a saved recipe now. */
  refreshRecipeProjection: typeof refreshRecipeProjection;
  /** Selects the grant of a merchant report for one entity type. */
  selectMerchantReportSourceGrant: typeof selectMerchantReportSourceGrant;
  /** Selects the grant of the turn for one graph query, at the internal level. */
  selectInternalQuerySourceGrant: typeof selectInternalQuerySourceGrant;
  /** The graph query of the supplier directory. */
  supplierDirectoryQuery: typeof supplierDirectoryQuery;
  /** Runs one named graph query under the grant that the turn selects. */
  readNamedCommerceQuery: typeof readNamedCommerceQuery;
  /** Parses a commerce graph query. */
  parseCommerceGraphQuery: typeof parseCommerceGraphQuery;
}>;

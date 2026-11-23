import type { EffectiveGrantSet } from "@purin-labs/authority/authorization/access-grants/index";
import type {
  AuthorizedCustomConnectorRead,
  CustomConnectorReadCatalogEntry,
} from "@purin-labs/area-integrations/server/custom-connectors/index";
import type {
  ReviewedConnectorOperationRequest,
  ReviewedConnectorFailure,
} from "@purin-labs/area-integrations/server/custom-connectors/mcp";
import type {
  CustomConnectorOperationRequest,
  CustomConnectorTransportError,
} from "@purin-labs/area-integrations/server/custom-connectors/egress";

declare const entry: CustomConnectorReadCatalogEntry;
declare const effectiveGrants: EffectiveGrantSet;

// @ts-expect-error Invocation authority is created only after current grant, flow, and lease checks.
const forgedAuthorization: AuthorizedCustomConnectorRead = {
  entry,
  arguments: {},
  executionId: "execution_forged",
  leaseId: "lease_forged",
  deadlineAtUnixMs: 1,
  flowBindingDigest: "a".repeat(64),
  flowDecisionDigest: "b".repeat(64),
};

void effectiveGrants;
void forgedAuthorization;

declare const protocolPost: Extract<
  CustomConnectorOperationRequest,
  { kind: "mcp_post" }
>;
declare const protocolDelete: Extract<
  CustomConnectorOperationRequest,
  { kind: "mcp_delete" }
>;

// @ts-expect-error Raw MCP protocol frames cannot select a reviewed operation.
const invalidProtocolPost: ReviewedConnectorOperationRequest = protocolPost;
// @ts-expect-error Broad spreads cannot admit raw MCP cleanup as an operation.
const invalidProtocolDelete: ReviewedConnectorOperationRequest = {
  ...protocolDelete,
};
const invalidMcpBody: ReviewedConnectorOperationRequest = {
  kind: "mcp",
  url: new URL("https://supplier.example/mcp"),
  toolName: "inventory_read",
  arguments: {},
  // @ts-expect-error Reviewed MCP calls cannot supply REST bodies.
  body: new Uint8Array(),
};
const remoteTool = { toolName: "inventory_read", arguments: {} };
// @ts-expect-error REST requests cannot acquire MCP fields through broad spreads.
const invalidRestMcpSpread: ReviewedConnectorOperationRequest = {
  kind: "get",
  url: new URL("https://supplier.example/inventory"),
  ...remoteTool,
};

void invalidProtocolPost;
void invalidProtocolDelete;
void invalidMcpBody;
void invalidRestMcpSpread;

declare const wireFailure: CustomConnectorTransportError;
// @ts-expect-error A wire error cannot classify an effect without dispatch state.
const missingDispatchState: ReviewedConnectorFailure = { ...wireFailure };
const invalidDispatchState: ReviewedConnectorFailure = {
  // @ts-expect-error Failure state cannot claim successful confirmation.
  kind: "confirmed",
  code: "transport_unavailable",
};
void missingDispatchState;
void invalidDispatchState;

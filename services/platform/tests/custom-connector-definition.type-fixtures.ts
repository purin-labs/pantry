import type {
  CustomConnectorDefinitionV1,
  CustomConnectorDefinitionDigest,
  CustomConnectorId,
  CustomConnectorRestTransport,
  CustomConnectorMcpTransport,
  CustomConnectorRevision,
  CustomConnectorRevisionIdentity,
} from "../src/custom-connectors";

declare const connectorId: CustomConnectorId;
declare const revision: CustomConnectorRevision;
declare const definitionDigest: CustomConnectorDefinitionDigest;

const validIdentity: CustomConnectorRevisionIdentity = {
  connectorId,
  revision,
  definitionDigest,
};

const validGet: CustomConnectorRestTransport = {
  kind: "get",
  pathTemplate: "/v1/items",
  pathBindings: {},
  queryBindings: {},
};

// @ts-expect-error GET definitions cannot carry JSON body bindings.
const invalidGet: CustomConnectorRestTransport = {
  kind: "get",
  pathTemplate: "/v1/items",
  pathBindings: {},
  queryBindings: {},
  bodyBindings: {},
};

// @ts-expect-error JSON POST definitions require body bindings.
const invalidPost: CustomConnectorRestTransport = {
  kind: "post_json",
  pathTemplate: "/v1/items/search",
  pathBindings: {},
  queryBindings: {},
};

const invalidIdentity: CustomConnectorRevisionIdentity = {
  // @ts-expect-error Raw strings cannot select custom connectors.
  connectorId: "custom_connector_unparsed",
  // @ts-expect-error Raw numbers cannot select revisions.
  revision: 1,
  // @ts-expect-error Raw digests must pass the boundary parser.
  definitionDigest: "a".repeat(64),
};

void validIdentity;
void validGet;
void invalidGet;
void invalidPost;
void invalidIdentity;

const validBasicAuthentication: CustomConnectorDefinitionV1["authentication"] =
  { kind: "basic_api_key" };
// @ts-expect-error Basic API-key authentication cannot choose an arbitrary header.
const invalidBasicAuthentication: CustomConnectorDefinitionV1["authentication"] =
  { kind: "basic_api_key", name: "X-Key" };
const arbitraryHeader = { name: "X-Key" };
// @ts-expect-error Broad spreads cannot combine Basic auth with a header name.
const invalidBasicSpread: CustomConnectorDefinitionV1["authentication"] = {
  kind: "basic_api_key",
  ...arbitraryHeader,
};
void validBasicAuthentication;
void invalidBasicAuthentication;
void invalidBasicSpread;

const validMcp: CustomConnectorMcpTransport = {
  kind: "mcp",
  endpointPath: "/mcp",
  toolName: "inventory.read",
};
// @ts-expect-error MCP operations must pin a tool name.
const missingMcpTool: CustomConnectorMcpTransport = {
  kind: "mcp",
  endpointPath: "/mcp",
};
const restFields = { bodyBindings: {} };
// @ts-expect-error Broad spreads cannot give MCP operations REST body bindings.
const invalidMcpSpread: CustomConnectorMcpTransport = {
  kind: "mcp",
  endpointPath: "/mcp",
  toolName: "inventory.read",
  ...restFields,
};
void validMcp;
void missingMcpTool;
void invalidMcpSpread;

import { executeCustomConnectorTransport } from "../src/custom-connectors/egress";
declare const transportInput: Parameters<
  typeof executeCustomConnectorTransport
>[0];
const { authorizeDispatch: dispatchAuthority, ...unfencedTransport } =
  transportInput;
void dispatchAuthority;
// @ts-expect-error Transport must recheck execution authority after DNS preparation.
void executeCustomConnectorTransport(unfencedTransport);

const { onDispatch: dispatchNotification, ...untrackedTransport } =
  transportInput;
void dispatchNotification;
// @ts-expect-error Transport must report actual dispatch for durable receipt recovery.
void executeCustomConnectorTransport(untrackedTransport);

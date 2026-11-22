import type {
  CustomConnectorOperationRequest,
  CustomConnectorTransportRequest,
} from "../src/custom-connectors/egress";
import type { OrganisationId } from "@purin-labs/kernel/ids";

declare const organisationId: OrganisationId;
declare const url: URL;

const validGet: CustomConnectorOperationRequest = { kind: "get", url };
const validPost: CustomConnectorOperationRequest = {
  kind: "post_json",
  url,
  body: new Uint8Array(),
};

const invalidGet: CustomConnectorOperationRequest = {
  kind: "get",
  url,
  // @ts-expect-error GET operations cannot carry a request body.
  body: new Uint8Array(),
};

// @ts-expect-error JSON POST operations require a body.
const invalidPost: CustomConnectorOperationRequest = {
  kind: "post_json",
  url,
};

const invalidOrganisation: CustomConnectorTransportRequest = {
  // @ts-expect-error Container isolation requires a branded organisation identity.
  organisationId: "organisation_unparsed",
  authentication: { kind: "bearer", value: "fixture" },
  operation: validGet,
  deadlineAtUnixMs: Date.now() + 1_000,
  maxWireBytes: 1_024,
  maxDecodedBytes: 1_024,
};

void organisationId;
void validGet;
void validPost;
void invalidGet;
void invalidPost;
void invalidOrganisation;

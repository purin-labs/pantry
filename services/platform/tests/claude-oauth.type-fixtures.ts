import type { ModelRoute } from "@purin-labs/contracts";
import type { ClaudeConnection } from "../src/models/claude-connection";

const claude: ModelRoute = {
  keySource: "organisation_oauth",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  connectionId: "oauth-generation",
};

// @ts-expect-error A Claude OAuth route requires its exact connection identity.
const missingConnection: ModelRoute = {
  keySource: "organisation_oauth",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};
// @ts-expect-error Claude OAuth cannot select the OpenAI provider.
const wrongProvider: ModelRoute = {
  keySource: "organisation_oauth",
  provider: "openai",
  model: "claude-sonnet-4-6",
  connectionId: "connection",
};
// @ts-expect-error A spread cannot mix an API key reference with OAuth authority.
const mixedAuthority: ModelRoute = { ...claude, byoKeyRef: "vault:api:key" };
// @ts-expect-error A disconnected connection has no connection identity.
const invalidConnection: ClaudeConnection = {
  kind: "disconnected",
  connectionId: "connection",
};

void [missingConnection, wrongProvider, mixedAuthority, invalidConnection];

// @ts-expect-error A cast cannot turn a disjoint provider/source pair into a route.
const invalidCast = {
  keySource: "organisation_oauth",
  provider: "openai",
} as ModelRoute;
void invalidCast;

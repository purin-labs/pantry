import { textLimit } from "@purin-labs/contract-schema";
import type { JsonRecord } from "@purin-labs/control/worker/http";
import type { MessageLinkEgress } from "@purin-labs/agent/messages/link-reader";
import type {
  CustomConnectorId,
  CustomConnectorRevision,
  CustomConnectorSetupAttemptId,
} from "@purin-labs/connections/custom-connectors/identity";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import type { Result } from "@purin-labs/kernel/result";
import type { ConversationDocument } from "@purin-labs/conversation/chat/conversation";

/** A refusal of the chat setup of a custom connector, with its reason. */
export type CustomConnectorAuthoringError = {
  readonly code: string;
  readonly reason: string;
};

/** A connector summary, as the chat prompt shows it. */
type ChatConnectorSummary = Readonly<Record<string, unknown>>;

/** The state of one setup attempt, as the chat prompt shows it. */
export type ChatConnectorSetup = Readonly<{
  connectorId: CustomConnectorId;
  revision: CustomConnectorRevision;
  state: string;
  failure: Readonly<{ code: string; correlationId: string }> | null;
}>;

/**
 * The custom connector parts of the Portal chat: the connectors and the
 * setup attempts that the prompt shows, the head revision of a connector that the chat revises,
 * the read of the documentation pages, and the check of a generated
 * definition. The Integrations area owns the connector records, and the
 * Worker registers the implementation (`worker-ports.ts`).
 */
export type CustomConnectorChat = Readonly<{
  /** The connectors of the Organisation. */
  listSummaries(input: {
    readonly db: Pick<OrganisationDatabase, "prepare">;
    readonly organisationId: OrganisationId;
  }): Promise<Result<readonly ChatConnectorSummary[], { readonly code: string }>>;
  /** The state of a setup attempt, or null when it is unavailable. */
  readSetup(input: {
    readonly db: Pick<OrganisationDatabase, "prepare">;
    readonly organisationId: OrganisationId;
    readonly attemptId: CustomConnectorSetupAttemptId;
  }): Promise<ChatConnectorSetup | null>;
  /** The head revision of a connector, or null when it is unavailable. */
  readHeadRevision(input: {
    readonly db: Pick<OrganisationDatabase, "prepare">;
    readonly organisationId: OrganisationId;
    readonly connectorId: CustomConnectorId;
  }): Promise<CustomConnectorRevision | null>;
  readDocumentation(
    urls: readonly string[],
    egress: MessageLinkEgress,
  ): Promise<
    Result<readonly ConversationDocument[], CustomConnectorAuthoringError>
  >;
  parseAuthoringOutput(
    text: string,
    documents: readonly ConversationDocument[],
  ): Promise<Result<JsonRecord, CustomConnectorAuthoringError>>;
}>;

export const customConnectorChat = definePort<CustomConnectorChat>(
  "custom_connector_chat",
);

/** The format and the limits of a definition that the chat generates. */
export function connectorDefinitionInstructions(): string {
  return [
    "Generate the smallest useful set of GET reads, including an authenticated current-account probe with a stable account ID and display name. A shipment, warehouse, or arbitrary label cannot identify an account. Explain when the API lacks this requirement. Exclude credential-management, API-key, payment, label-purchase, account-update, and other write operations.",
    "Authentication supports bearer, header with an explicit name, or basic_api_key (API key username, empty password). Explain provider-specific key requirements discovered in the documentation. Named Authorization headers require the complete header value. Do not invent authentication schemes.",
    "Use this wire format with fields evidenced in fetched documentation. All object schemas have additionalProperties:false. Outputs project only declared fields. Strings and arrays require finite bounds; optional inputs must accept null. Use nullable output fields where documented. Pagination may be none for a bounded first page; describe the limit. Use classification confidential for account, address, and shipment data. Transport kind is rest, method GET, bodyBindings null. Keep the definition under 32KB. Documentation references are filled from server-fetched sources.",
    JSON.stringify(AUTHORING_FORMAT_EXAMPLE),
  ].join("\n\n");
}

const AUTHORING_FORMAT_EXAMPLE = {
  schemaVersion: 1,
  name: "Example service",
  description: "Read account information.",
  origin: "https://api.example.com",
  authentication: { kind: "bearer" },
  documentation: [],
  operations: [
    {
      id: "current_account",
      description: "Read the authenticated account.",
      effect: { kind: "read" },
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      transport: {
        kind: "rest",
        method: "GET",
        pathTemplate: "/account",
        pathBindings: {},
        queryBindings: {},
        bodyBindings: null,
      },
      response: {
        successStatuses: [200],
        resultPointer: "",
        outputSchema: {
          type: "object",
          properties: {
            id: textLimit({ type: "string", minLength: 1, maxLength: 128 }),
            name: textLimit({ type: "string", minLength: 1, maxLength: 256 }),
          },
          required: ["id", "name"],
          additionalProperties: false,
        },
        classification: "confidential",
      },
      pagination: { kind: "none" },
    },
  ],
  identity: {
    operationId: "current_account",
    arguments: {},
    accountIdPointer: "/id",
    displayNamePointer: "/name",
  },
  limits: { wireBytes: 1048576, decodedBytes: 1048576 },
};

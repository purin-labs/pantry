import type { JsonRecord } from "../control/http";
import {
  readMessageLink,
  type MessageLinkEgress,
} from "../messages/link-reader";
import { parseCustomConnectorDefinition } from "./definition";
import type { Result } from "../result";
import { isRecord } from "@purin-labs/std";
import type { ConversationDocument } from "../chat/conversation";

/** The chat record stores the pages that it read. */
export type ConnectorDocumentation = ConversationDocument;

type AuthoringError = { readonly code: string; readonly reason: string };

export async function readConnectorDocumentation(
  urls: readonly string[],
  egress: MessageLinkEgress,
): Promise<Result<readonly ConnectorDocumentation[], AuthoringError>> {
  const documents: ConnectorDocumentation[] = [];
  for (const url of urls) {
    const result = await readMessageLink({ url, egress, maxTextChars: 65_536 });
    if (!result.ok)
      return refused(
        "authoring_documentation_unavailable",
        `Could not read documentation: ${result.error.code}. Try a direct API reference URL.`,
      );
    if (
      result.value.content.kind !== "text" ||
      result.value.content.text.length === 0
    )
      return refused(
        "authoring_documentation_unavailable",
        "Use a public HTML, Markdown, or JSON API reference.",
      );
    documents.push({
      url,
      sha256: result.value.receipt.contentDigest,
      text: result.value.content.text,
      truncated: result.value.content.truncated,
    });
  }
  return { ok: true, value: documents };
}

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
            id: { type: "string", minLength: 1, maxLength: 128 },
            name: { type: "string", minLength: 1, maxLength: 256 },
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

export async function parseConnectorAuthoringOutput(
  text: string,
  documents: readonly ConnectorDocumentation[],
): Promise<Result<JsonRecord, AuthoringError>> {
  if (new TextEncoder().encode(text).byteLength > 32 * 1024)
    return refused(
      "authoring_definition_invalid",
      "The generated definition was too large.",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, "$1"));
  } catch {
    return refused(
      "authoring_definition_invalid",
      "Return a single JSON object in the requested format.",
    );
  }
  if (!isRecord(raw))
    return refused("authoring_definition_invalid", "Return a JSON object.");
  if (
    raw.kind === "unsupported" &&
    typeof raw.reason === "string" &&
    raw.reason.length > 0 &&
    raw.reason.length <= 1000
  )
    return refused("authoring_service_unsupported", raw.reason);
  if (raw.kind !== "definition" || !isRecord(raw.document))
    return refused(
      "authoring_definition_invalid",
      "Return kind:definition and a document object.",
    );
  const document: JsonRecord = {
    ...raw.document,
    documentation: documents.map(documentationReference),
  };
  const parsed = await parseCustomConnectorDefinition(document);
  if (!parsed.ok)
    return refused(
      "authoring_definition_invalid",
      JSON.stringify(parsed.error),
    );
  for (const operation of parsed.value.definition.operations) {
    if (
      operation.effect.kind !== "read" ||
      operation.transport.kind !== "get" ||
      /(?:api[_-]?keys|tokens|secrets|sub[_-]?users)(?:\/|$)/iu.test(
        operation.transport.pathTemplate,
      )
    )
      return refused(
        "authoring_service_unsupported",
        "AI setup currently supports GET reads without credential-management endpoints.",
      );
  }
  if (
    !documents.some(mentionsOrigin.bind(null, parsed.value.definition.origin))
  )
    return refused(
      "authoring_definition_invalid",
      "The API origin must appear in the fetched documentation.",
    );
  return { ok: true, value: document };
}

function mentionsOrigin(
  origin: string,
  document: ConnectorDocumentation,
): boolean {
  return document.text.includes(origin);
}

function documentationReference(document: ConnectorDocumentation): {
  url: string;
  sha256: string;
} {
  return { url: document.url, sha256: document.sha256 };
}

function refused(code: string, reason: string): Result<never, AuthoringError> {
  return { ok: false, error: { code, reason } };
}

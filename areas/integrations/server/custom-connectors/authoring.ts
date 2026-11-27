import type { JsonRecord } from "@purin-labs/control/worker/http";
import {
  readMessageLink,
  type MessageLinkEgress,
} from "@purin-labs/agent/messages/link-reader";
import { parseCustomConnectorDefinition } from "./definition";
import type { Result } from "@purin-labs/kernel/result";
import { isRecord } from "@purin-labs/std";
import type { ConversationDocument } from "@purin-labs/conversation/chat/conversation";
import type { CustomConnectorAuthoringError } from "@purin-labs/area-integrations-contract/server/custom-connector-chat";

/** The chat record stores the pages that it read. */
export type ConnectorDocumentation = ConversationDocument;

type AuthoringError = CustomConnectorAuthoringError;

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

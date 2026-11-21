import type {
  AuthorizedHarnessToolResult,
  HarnessToolOutput,
} from "@purin-labs/contracts";

import { digestCanonical } from "../policy";
import {
  type CatalogToolAuthority,
  executeCatalogTool,
} from "../agent-tools/catalog/execute";
import type { HarnessCapabilityClaim } from "../agent-tools/catalog/types";
import {
  WHATSAPP_AGENT_TOOL_REGISTRY,
  type WhatsAppAgentToolServices,
} from "../agent-tools/channels/whatsapp-agent";
import { modelToolDefinition } from "../agent-tools/define-tool";
import { ToolRequestError } from "../agent-tools/errors";
import type { HarnessToolHost } from "./embedded-harness";
import type { Variant } from "@purin-labs/type-utils";

/**
 * The complete WhatsApp agent authority: read the exact admitted Case, return
 * one text proposal, or ask a human to take over. There is no send tool, no
 * recipient argument, no template, no Graph API client, and no provider
 * credential anywhere in this host. The customer's own words are evidence in
 * the read result and cannot select a destination or approve anything.
 */

export type WhatsAppCaseMessage = {
  readonly direction: "inbound" | "outbound";
  readonly occurredAt: number;
  readonly text: string;
};

export type WhatsAppCaseManifest = {
  readonly caseId: string;
  readonly integrationAccountId: string;
  readonly customerWaId: string;
  readonly businessDisplayPhoneNumber: string;
  readonly messages: readonly WhatsAppCaseMessage[];
  readonly maxReplyChars: number;
  readonly expiresAt: number;
};

export type WhatsAppTurnOutcome =
  | { readonly kind: "proposed"; readonly body: string }
  | { readonly kind: "handoff"; readonly reason: string }
  | { readonly kind: "none" };

export type WhatsAppHarnessToolHost = HarnessToolHost & {
  outcome(): WhatsAppTurnOutcome;
};

export async function createWhatsAppHarnessToolHost(
  input: Readonly<{
    manifest: WhatsAppCaseManifest;
    now: () => number;
  }>,
): Promise<WhatsAppHarnessToolHost> {
  const registry = WHATSAPP_AGENT_TOOL_REGISTRY;
  const definitions = registry.tools.map(modelToolDefinition);
  const catalogDigest = await digestCanonical({
    kind: "pantry_whatsapp_tool_catalog_v1",
    definitions,
    caseId: input.manifest.caseId,
    integrationAccountId: input.manifest.integrationAccountId,
  });
  let outcome: WhatsAppTurnOutcome = { kind: "none" };
  const requireNoOutcome = (): void => {
    if (outcome.kind !== "none") {
      throw new ToolRequestError("This turn already produced an outcome.");
    }
  };
  const services: WhatsAppAgentToolServices = {
    readCase: () => renderCase(input.manifest),
    proposeReply: (inputJson) => {
      requireNoOutcome();
      const body = readStringArgument(inputJson, "body");
      if (body === null) throw new ToolRequestError("Invalid tool arguments.");
      const trimmed = body.trim();
      if (
        trimmed.length === 0 ||
        trimmed.length > input.manifest.maxReplyChars
      ) {
        throw new ToolRequestError(
          `A reply must be between 1 and ${input.manifest.maxReplyChars} characters.`,
        );
      }
      outcome = { kind: "proposed", body: trimmed };
      return "Reply proposed. A human operator must approve it before it is sent.";
    },
    requestHandoff: (inputJson) => {
      requireNoOutcome();
      const reason = readStringArgument(inputJson, "reason");
      if (reason === null) {
        throw new ToolRequestError("Invalid tool arguments.");
      }
      outcome = { kind: "handoff", reason: reason.trim().slice(0, 200) };
      return "Handoff requested. An operator will take over this Case.";
    },
  };
  const authority: CatalogToolAuthority = {
    registry,
    definitions,
    turnTools: [],
    services: { whatsapp_agent: services },
    claimCapability: refuseCapabilityClaim,
    profile: {
      envelope: {
        success: (value) => authorizedRead(String(value)),
        failure: (detail) => authorizedRead(detail, "failed"),
      },
      outsideCatalog: (name) => `Unknown tool: ${name}`,
    },
  };

  return {
    mode: "hybrid",
    codeMode: { kind: "disabled" },
    catalogDigest,
    definitions,
    outcome: () => outcome,
    async executeTool(
      name: string,
      inputJson: string,
    ): Promise<AuthorizedHarnessToolResult> {
      if (input.now() > input.manifest.expiresAt) {
        return authorizedRead("This Case turn has expired.", "failed");
      }
      return executeCatalogTool(
        authority,
        { kind: "direct" },
        name,
        inputJson,
        "",
      );
    },
  };
}

/** No tool of this host claims a capability: the turn holds its authority. */
async function refuseCapabilityClaim(): ReturnType<HarnessCapabilityClaim> {
  return {
    ok: false,
    error: {
      code: "embedded_harness_capability_claim_rejected",
      detail: "The WhatsApp agent host has no capability to claim",
    },
  };
}

function renderCase(manifest: WhatsAppCaseManifest): string {
  const header = [
    `Customer: ${manifest.customerWaId}`,
    `Business number: ${manifest.businessDisplayPhoneNumber}`,
    `Messages: ${manifest.messages.length} (oldest first)`,
  ].join("\n");
  const body = manifest.messages
    .map(
      (message) =>
        `[${message.direction === "inbound" ? "customer" : "business"} ${new Date(message.occurredAt).toISOString()}]\n${message.text}`,
    )
    .join("\n\n");
  return manifest.messages.length === 0
    ? `${header}\n\n(no admitted messages)`
    : `${header}\n\n${body}`;
}

function readStringArgument(inputJson: string, field: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const value = (parsed as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

async function authorizedRead(
  output: string,
  status: "succeeded" | "failed" = "succeeded",
): Promise<AuthorizedHarnessToolResult> {
  const value = await inlineToolOutput(output);
  return {
    kind: "read",
    output: value,
    authority: { kind: "read", resultDigest: value.digest },
    status,
  };
}

async function inlineToolOutput(
  output: string,
): Promise<Variant<HarnessToolOutput, "inline">> {
  const digest = await digestCanonical({
    kind: "pantry_whatsapp_tool_output_v1",
    output,
  });
  return { kind: "inline", content: [{ kind: "text", text: output }], digest };
}

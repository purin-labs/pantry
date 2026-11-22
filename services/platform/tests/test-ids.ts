import { createHash } from "node:crypto";
import { parseConversationId, parseProjectId } from "@purin-labs/control-api";
import { parseSessionTurnInputDigest } from "../src/actors/agent-session-turn-input-digest";
import { parseVaultHandle } from "../src/credential-vault";
import {
  parseCaseId,
  parseChannelId,
  parseConnectorId,
  parseIntegrationAccountId,
  parseRequestId,
  parseSessionId,
  parseOrganisationId,
  parseWorkspaceId,
} from "@purin-labs/kernel/ids";
import { parseUserId } from "@purin-labs/control-api/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  parseWhatsAppCustomerId,
  parseWhatsAppPhoneNumberId,
} from "@purin-labs/connections/whatsapp/identifiers";

/**
 * Typed identifiers for test fixtures. A fixture with an invalid identifier is
 * a broken test, not a case under test, so these throw instead of returning a
 * Result.
 */
function required<T>(parsed: Result<T, unknown>, raw: string): T {
  if (!parsed.ok) throw new Error(`invalid test identifier: ${raw}`);
  return parsed.value;
}

export const requireOrganisationId = (raw: string) =>
  required(parseOrganisationId(raw), raw);
export const requireVaultHandle = (raw: string) =>
  required(parseVaultHandle(raw), raw);
export const requireIntegrationAccountId = (raw: string) =>
  required(parseIntegrationAccountId(raw), raw);
export const requireUserId = (raw: string) =>
  required(parseUserId(raw), raw);
export const requireCaseId = (raw: string) => required(parseCaseId(raw), raw);
export const requireSessionId = (raw: string) =>
  required(parseSessionId(raw), raw);
export const requireWorkspaceId = (raw: string) =>
  required(parseWorkspaceId(raw), raw);
export const requireRequestId = (raw: string) =>
  required(parseRequestId(raw), raw);
export const requireSessionTurnInputDigest = (raw: string) =>
  required(parseSessionTurnInputDigest(raw), raw);
export const requireChannelId = (raw: string) =>
  required(parseChannelId(raw), raw);
export const requireConnectorId = (raw: string) =>
  required(parseConnectorId(raw), raw);
export const requireWhatsAppCustomerId = (raw: string) =>
  required(parseWhatsAppCustomerId(raw), raw);
export const requireWhatsAppPhoneNumberId = (raw: string) =>
  required(parseWhatsAppPhoneNumberId(raw), raw);

export const requireConversationId = (raw: string) => required(parseConversationId(raw), raw);
export const requireProjectId = (raw: string) => required(parseProjectId(raw), raw);

export function parseFixtureUserId(label: string) {
  const hash = createHash("sha256").update(label).digest("hex");
  return parseUserId(`user_${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`);
}

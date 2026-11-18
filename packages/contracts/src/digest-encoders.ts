import { assertNever, sha256Hex } from "@seams/std";
import type { HarnessCheckpointRecord } from "./types/HarnessCheckpointRecord.ts";
import type { MessageAttachmentSource } from "./types/MessageAttachmentSource.ts";
import type { TurnIdentity } from "./types/TurnIdentity.ts";
import type { UserMessage } from "./types/UserMessage.ts";
import type { UserMessagePart } from "./types/UserMessagePart.ts";

/** Preserve serde's declaration order at every level of a checkpoint. */
export function encodeHarnessCheckpointRecord(
  record: HarnessCheckpointRecord,
): string {
  return JSON.stringify({
    backendId: record.backendId,
    blob: {
      objectKey: record.blob.objectKey,
      sha256: record.blob.sha256,
      byteLength: record.blob.byteLength,
      formatVersion: record.blob.formatVersion,
      harnessBuild: record.blob.harnessBuild,
      createdAt: record.blob.createdAt,
    },
    session: {
      organisationId: record.session.organisationId,
      sessionId: record.session.sessionId,
      streamId: record.session.streamId,
    },
    turn: orderedTurn(record.turn),
    runtimeLease: {
      generation: record.runtimeLease.generation,
      leaseId: record.runtimeLease.leaseId,
    },
    runtimeRevision: record.runtimeRevision,
    policyVersion: record.policyVersion,
    budgetRevision: record.budgetRevision,
    budgetUsage: {
      tokens: record.budgetUsage.tokens,
      activeWallMs: record.budgetUsage.activeWallMs,
      capabilityCalls: record.budgetUsage.capabilityCalls,
    },
    usageCursor: record.usageCursor,
    budgetAccountDigest: record.budgetAccountDigest,
    cursor: {
      turn: orderedTurn(record.cursor.turn),
      lastSequence: record.cursor.lastSequence,
      lastEventDigest: record.cursor.lastEventDigest,
    },
    historyCursor: {
      lastSequence: record.historyCursor.lastSequence,
      lastEntryDigest: record.historyCursor.lastEntryDigest,
    },
    lastActorEventSequence: record.lastActorEventSequence,
    workspaceBaseRevision: record.workspaceBaseRevision,
    workspaceRevision: record.workspaceRevision,
    instructionDigest: record.instructionDigest,
    toolCatalogDigest: record.toolCatalogDigest,
    modelRouteDigest: record.modelRouteDigest,
  });
}

export async function harnessCheckpointId(
  record: HarnessCheckpointRecord,
): Promise<string> {
  return `checkpoint_${await sha256Hex(encodeHarnessCheckpointRecord(record))}`;
}

function orderedTurn(turn: TurnIdentity): TurnIdentity {
  return {
    turnId: turn.turnId,
    inputId: turn.inputId,
    turnLeaseGeneration: turn.turnLeaseGeneration,
    budgetRevision: turn.budgetRevision,
  };
}

/** Preserve the original separators and the order of the accepted parts. */
export function encodeUserMessageDigest(message: UserMessage): string {
  let encoded = `satyr.user_message.v1\x1e${encodeMessagePart(message.firstPart)}`;
  for (const part of message.remainingParts) {
    encoded += `\x1e${encodeMessagePart(part)}`;
  }
  return encoded;
}

export function digestUserMessage(message: UserMessage): Promise<string> {
  return sha256Hex(encodeUserMessageDigest(message));
}

function encodeMessagePart(part: UserMessagePart): string {
  switch (part.kind) {
    case "text":
      return `text\x1f${part.text}`;
    case "link": {
      const presentation = part.link.presentation;
      switch (presentation.kind) {
        case "url":
          return `link\x1f${part.link.url}\x1f`;
        case "label":
          return `link\x1f${part.link.url}\x1f${presentation.label}`;
        default:
          return assertNever(presentation);
      }
    }
    case "attachment": {
      const attachment = part.attachment;
      return [
        "attachment",
        attachment.id,
        attachment.sha256,
        attachment.descriptor.media.mediaType,
        String(attachment.byteLength),
        messageAttachmentSourceIdentity(attachment.source),
      ].join("\x1f");
    }
    default:
      return assertNever(part);
  }
}

export function messageAttachmentSourceIdentity(
  source: MessageAttachmentSource,
): string {
  switch (source.kind) {
    case "portal":
      return `portal:${source.userId}:${source.conversationId}:${source.uploadId}`;
    case "slack":
      return `slack:${source.integrationAccountId}:${source.workspaceId}:${source.channelId}:${source.messageTs}:${source.fileId}:${source.revision}`;
    default:
      return assertNever(source);
  }
}

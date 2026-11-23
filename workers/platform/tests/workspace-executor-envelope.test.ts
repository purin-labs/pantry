import { describe, expect, it } from "vitest";

import {
  encodeWorkspaceExecutorEnvelope,
  type WorkspaceExecutorInspectionRequest,
} from "@purin-labs/agent/workspace-executor-container";
import { WORKSPACE_EXECUTOR_ATTACHMENT_ID } from "./workspace-executor-fixtures";

/**
 * The envelope is the one contract the Worker and the container both have to
 * read identically. The Rust side has its own decoding tests; these pin the
 * framing this side produces, so a drift shows up here rather than as an opaque
 * container rejection.
 */

const REQUEST: WorkspaceExecutorInspectionRequest = {
  schemaVersion: "workspace_executor_preparation.v1",
  preparationId: "preparation_1",
  identity: {
    organisationId: "organisation_1",
    sessionId: "session_1",
    turnId: "turn_1",
    attachmentId: WORKSPACE_EXECUTOR_ATTACHMENT_ID,
    sourceSha256: "b".repeat(64),
    handlerRevision: "handler.v1",
  },
  limits: {
    maxInputBytes: 32_768,
    maxOutputBytes: 2_048,
    maxDurationMs: 3_000,
    maxFrames: 4,
  },
  deadlineAtUnixMs: 1_700_000_060_000,
  operation: {
    kind: "prepare_message_attachment",
    mediaClass: "document",
    mediaType: "text/csv",
    byteLength: 13,
    maxTextChars: 1_000,
  },
};

describe("workspace executor envelope", function envelopeSuite() {
  it("frames the JSON length, then the JSON, then the raw bytes", function frames() {
    const attachment = new TextEncoder().encode("espresso,3.50");
    const envelope = encodeWorkspaceExecutorEnvelope(REQUEST, attachment);
    const header = new DataView(envelope.buffer, 0, 8);
    const jsonLength = Number(header.getBigUint64(0, false));
    const json = new TextDecoder().decode(envelope.slice(8, 8 + jsonLength));

    expect(JSON.parse(json)).toEqual(REQUEST);
    // The bytes follow the JSON verbatim: no base64, no re-encoding.
    expect(envelope.slice(8 + jsonLength)).toEqual(attachment);
    expect(envelope.byteLength).toBe(8 + jsonLength + attachment.byteLength);
  });

  it("carries bytes no JSON string could hold intact", function carriesBinary() {
    // A lone surrogate and a NUL survive because they never become text.
    const attachment = new Uint8Array([0x00, 0xff, 0xed, 0xa0, 0x80, 0x1a]);
    const envelope = encodeWorkspaceExecutorEnvelope(REQUEST, attachment);
    const jsonLength = Number(
      new DataView(envelope.buffer, 0, 8).getBigUint64(0, false),
    );

    expect(envelope.slice(8 + jsonLength)).toEqual(attachment);
  });

  it("frames an empty attachment without ambiguity", function framesEmpty() {
    const envelope = encodeWorkspaceExecutorEnvelope(REQUEST, new Uint8Array());
    const jsonLength = Number(
      new DataView(envelope.buffer, 0, 8).getBigUint64(0, false),
    );

    expect(envelope.byteLength).toBe(8 + jsonLength);
  });
});

import { describe, expect, it } from "vitest";

import {
  parseWorkspaceExecutorInspectionResponse,
  type WorkspaceExecutorInspectionRequest,
} from "@purin-labs/agent/workspace-executor-container";
import { WORKSPACE_EXECUTOR_ATTACHMENT_ID } from "./workspace-executor-fixtures";

/** The preparation response is bound to the exact identity and limits. */

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

const REQUEST: WorkspaceExecutorInspectionRequest = {
  schemaVersion: "workspace_executor_preparation.v1",
  preparationId: "preparation-1",
  identity: {
    organisationId: "organisation-1",
    sessionId: "session-1",
    turnId: "turn-1",
    attachmentId: WORKSPACE_EXECUTOR_ATTACHMENT_ID,
    sourceSha256: SHA,
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

function envelope(
  operation: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: "workspace_executor_response.v1",
    preparationId: REQUEST.preparationId,
    identity: REQUEST.identity,
    operation,
    inputBytes: 100,
    outputBytes: 50,
    durationMs: 7,
    ...overrides,
  });
}

describe("workspace executor inspection response", function inspectionResponseSuite() {
  it("parses extracted text bound to the requested file", function parsesText() {
    const parsed = parseWorkspaceExecutorInspectionResponse(
      envelope({
        kind: "attachment_text",
        attachmentId: WORKSPACE_EXECUTOR_ATTACHMENT_ID,
        text: "espresso,3.50",
        truncated: false,
        sourceSha256: SHA,
      }),
      REQUEST,
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        preparationId: "preparation-1",
        identity: REQUEST.identity,
        operation: {
          kind: "attachment_text",
          text: "espresso,3.50",
          truncated: false,
          sourceSha256: SHA,
        },
        inputBytes: 100,
        outputBytes: 50,
        durationMs: 7,
      },
    });
  });

  it("parses decoded frames with their per-frame digests", function parsesFrames() {
    const parsed = parseWorkspaceExecutorInspectionResponse(
      envelope({
        kind: "attachment_video_frames",
        attachmentId: WORKSPACE_EXECUTOR_ATTACHMENT_ID,
        policyRevision: "plan37.frames.v1",
        selectedTimestampsMs: [76, 307],
        frames: [
          {
            timestampMs: 76,
            width: 64,
            height: 48,
            mediaType: "image/jpeg",
            jpegBase64: "/9j/",
            sha256: OTHER_SHA,
          },
        ],
        omittedFrames: 1,
        sourceSha256: SHA,
      }),
      REQUEST,
    );

    expect(parsed.ok).toBe(true);

    if (
      parsed.ok &&
      parsed.value.operation.kind === "attachment_video_frames"
    ) {
      expect(parsed.value.operation.frames).toHaveLength(1);
      expect(parsed.value.operation.omittedFrames).toBe(1);
      expect(parsed.value.operation.selectedTimestampsMs).toEqual([76, 307]);
    } else {
      throw new Error("expected decoded frames");
    }
  });

  it("parses a stated limit", function parsesLimit() {
    const parsed = parseWorkspaceExecutorInspectionResponse(
      envelope({
        kind: "attachment_not_inspectable",
        attachmentId: WORKSPACE_EXECUTOR_ATTACHMENT_ID,
        reason: "codec_unsupported",
        sourceSha256: SHA,
      }),
      REQUEST,
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        operation: {
          kind: "attachment_not_inspectable",
          reason: "codec_unsupported",
        },
      },
    });
  });

  it("refuses a reply for a different preparation", function refusesForeignPreparation() {
    const parsed = parseWorkspaceExecutorInspectionResponse(
      envelope(
        {
          kind: "attachment_text",
          attachmentId: WORKSPACE_EXECUTOR_ATTACHMENT_ID,
          text: "x",
          truncated: false,
          sourceSha256: SHA,
        },
        { preparationId: "preparation-other" },
      ),
      REQUEST,
    );

    expect(parsed).toEqual({
      ok: false,
      error: { kind: "invalid_response", field: "preparationId" },
    });
  });

  it("refuses a reply with a different preparation identity", function refusesForeignIdentity() {
    const wrongIdentity = parseWorkspaceExecutorInspectionResponse(
      envelope(
        {
          kind: "attachment_text",
          attachmentId: WORKSPACE_EXECUTOR_ATTACHMENT_ID,
          text: "x",
          truncated: false,
          sourceSha256: SHA,
        },
        {
          identity: {
            ...REQUEST.identity,
            organisationId: "organisation-other",
          },
        },
      ),
      REQUEST,
    );

    const wrongId = parseWorkspaceExecutorInspectionResponse(
      envelope({
        kind: "attachment_text",
        attachmentId: "att_foreign",
        text: "x",
        truncated: false,
        sourceSha256: SHA,
      }),
      REQUEST,
    );
    const wrongBytes = parseWorkspaceExecutorInspectionResponse(
      envelope({
        kind: "attachment_text",
        attachmentId: WORKSPACE_EXECUTOR_ATTACHMENT_ID,
        text: "x",
        truncated: false,
        sourceSha256: OTHER_SHA,
      }),
      REQUEST,
    );

    expect(wrongIdentity).toEqual({
      ok: false,
      error: { kind: "invalid_response", field: "identity" },
    });
    expect(wrongId).toEqual({
      ok: false,
      error: { kind: "invalid_response", field: "operation.attachmentId" },
    });
    expect(wrongBytes).toEqual({
      ok: false,
      error: { kind: "invalid_response", field: "operation.sourceSha256" },
    });
  });

  it("refuses an operation kind it does not know", function refusesUnknownKind() {
    const parsed = parseWorkspaceExecutorInspectionResponse(
      envelope({
        kind: "attachment_unknown",
        attachmentId: WORKSPACE_EXECUTOR_ATTACHMENT_ID,
        sourceSha256: SHA,
      }),
      REQUEST,
    );

    expect(parsed).toEqual({
      ok: false,
      error: { kind: "invalid_response", field: "operation.kind" },
    });
  });

  it("refuses usage outside the preparation limits", function refusesUnboundedUsage() {
    const parsed = parseWorkspaceExecutorInspectionResponse(
      envelope(
        {
          kind: "attachment_text",
          attachmentId: WORKSPACE_EXECUTOR_ATTACHMENT_ID,
          text: "x",
          truncated: false,
          sourceSha256: SHA,
        },
        { outputBytes: REQUEST.limits.maxOutputBytes + 1 },
      ),
      REQUEST,
    );

    expect(parsed).toEqual({
      ok: false,
      error: { kind: "invalid_response", field: "outputBytes" },
    });
  });

  it("refuses decoded frame counts outside the preparation limit", function refusesUnboundedFrames() {
    const parsed = parseWorkspaceExecutorInspectionResponse(
      envelope({
        kind: "attachment_video_frames",
        attachmentId: WORKSPACE_EXECUTOR_ATTACHMENT_ID,
        policyRevision: "plan37.frames.v1",
        selectedTimestampsMs: [1, 2, 3, 4],
        frames: [],
        omittedFrames: REQUEST.limits.maxFrames + 1,
        sourceSha256: SHA,
      }),
      REQUEST,
    );

    expect(parsed).toEqual({
      ok: false,
      error: { kind: "invalid_response", field: "operation.frames" },
    });
  });
});

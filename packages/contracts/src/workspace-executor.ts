import {
  OpenObject,
  StrictObject,
  PositiveInteger,
  NonNegativeInteger as unsignedInteger,
} from "@purin-labs/contract-schema";
import { Type, type Static } from "typebox";
import type { StrictUnion } from "@purin-labs/type-utils";
import type { AttachmentId } from "./types/AttachmentId";

const unsigned32 = Type.Integer({ minimum: 0, maximum: 0xffffffff });
const identity = Type.String();
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const attachmentIdSchema = Type.Unsafe<AttachmentId>(
  Type.String({ pattern: "^att_[0-9a-z]{1,64}$" }),
);

// These native domain builders retain semantic checks until their areas migrate.
const preparationIdentitySchema = StrictObject(
  {
    organisationId: identity,
    sessionId: identity,
    turnId: identity,
    attachmentId: attachmentIdSchema,
    sourceSha256: digest,
    handlerRevision: Type.String(),
  },
  {
    title: "PreparationIdentity",
    "x-rust-type": "crate::contracts::MessageAttachmentPreparationIdentity",
  },
);

const preparationLimitsSchema = StrictObject(
  {
    maxInputBytes: PositiveInteger,
    maxOutputBytes: PositiveInteger,
    maxDurationMs: PositiveInteger,
    maxFrames: PositiveInteger,
  },
  {
    title: "PreparationLimits",
    "x-rust-type": "crate::contracts::MessageAttachmentPreparationLimits",
  },
);

const attachmentMediaClassSchema = Type.Enum(
  ["document", "audio", "video", "opaque"],
  { title: "AttachmentMediaClassWire" },
);

// TypeBox ReadonlyObject rebuilds object options. Apply strictness to its readonly properties.
const preparationOperationSchema = StrictObject(
  Type.ReadonlyObject(
    OpenObject({
      kind: Type.Literal("prepare_message_attachment"),
      mediaClass: attachmentMediaClassSchema,
      mediaType: Type.String(),
      byteLength: unsignedInteger,
      maxTextChars: unsigned32,
    }),
  ).properties,
  { title: "WorkspaceExecutorPreparationOperationWire" },
);

const workspaceExecutorInspectionRequestSchema = StrictObject(
  Type.ReadonlyObject(
    OpenObject({
      schemaVersion: Type.Literal("workspace_executor_preparation.v1"),
      preparationId: identity,
      identity: preparationIdentitySchema,
      limits: preparationLimitsSchema,
      deadlineAtUnixMs: unsignedInteger,
      operation: preparationOperationSchema,
    }),
  ).properties,
);

const workspaceExecutorDecodedFrameSchema = StrictObject(
  Type.ReadonlyObject(
    OpenObject({
      timestampMs: unsignedInteger,
      width: unsigned32,
      height: unsigned32,
      mediaType: Type.String(),
      jpegBase64: Type.String(),
      sha256: digest,
    }),
  ).properties,
  { title: "DecodedVideoFrame" },
);

const inspectionLimitSchema = Type.Enum(
  [
    "handler_unavailable",
    "format_unreadable",
    "codec_unsupported",
    "picture_too_large",
  ],
  { title: "AttachmentInspectionLimit" },
);

const workspaceExecutorInspectionOperationSchema = Type.Union(
  [
    StrictObject(
      Type.ReadonlyObject(
        OpenObject({
          kind: Type.Literal("attachment_text"),
          attachmentId: identity,
          text: Type.String(),
          truncated: Type.Boolean(),
          sourceSha256: digest,
        }),
      ).properties,
    ),
    StrictObject(
      Type.ReadonlyObject(
        OpenObject({
          kind: Type.Literal("attachment_video_frames"),
          attachmentId: identity,
          policyRevision: Type.String(),
          selectedTimestampsMs: Type.ReadonlyObject(
            Type.Array(unsignedInteger),
          ),
          frames: Type.ReadonlyObject(
            Type.Array(workspaceExecutorDecodedFrameSchema),
          ),
          omittedFrames: unsigned32,
          sourceSha256: digest,
        }),
      ).properties,
    ),
    StrictObject(
      Type.ReadonlyObject(
        OpenObject({
          kind: Type.Literal("attachment_not_inspectable"),
          attachmentId: identity,
          reason: inspectionLimitSchema,
          sourceSha256: digest,
        }),
      ).properties,
    ),
  ],
  { title: "WorkspaceExecutorInspectionOperation" },
);

const responseVersion = Type.Literal("workspace_executor_response.v1");
const workspaceExecutorInspectionResponseSchema = StrictObject(
  Type.ReadonlyObject(
    OpenObject({
      schemaVersion: responseVersion,
      preparationId: identity,
      identity: preparationIdentitySchema,
      operation: workspaceExecutorInspectionOperationSchema,
      inputBytes: unsignedInteger,
      outputBytes: unsignedInteger,
      durationMs: unsignedInteger,
    }),
  ).properties,
);

export const executorWireSchemas = {
  WorkspaceExecutorPreparationRequestWire:
    workspaceExecutorInspectionRequestSchema,
  WorkspaceExecutorPreparationResponse:
    workspaceExecutorInspectionResponseSchema,
};

export type WorkspaceExecutorInspectionRequest = Static<
  typeof workspaceExecutorInspectionRequestSchema
>;
export type WorkspaceExecutorInspectionResponse = Static<
  typeof workspaceExecutorInspectionResponseSchema
>;
export type WorkspaceExecutorInspectionOperation = StrictUnion<
  Static<typeof workspaceExecutorInspectionOperationSchema>
>;
export type WorkspaceExecutorDecodedFrame = Static<
  typeof workspaceExecutorDecodedFrameSchema
>;

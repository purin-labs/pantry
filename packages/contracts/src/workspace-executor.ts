import {
  OpenObject,
  StrictObject,
  PositiveInteger,
  parseContract,
  type ContractDecodeResult,
  type ContractRejection,
  NonNegativeInteger as unsignedInteger,
} from "@seams/commerce-contracts/schema";
import { Type, type Static } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import type { StrictUnion } from "@seams/type-utils";
import type { AttachmentId } from "./types/AttachmentId";

const unsigned32 = Type.Integer({ minimum: 0, maximum: 0xffffffff });
const identity = Type.String();
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const attachmentIdSchema = Type.Unsafe<AttachmentId>(
  Type.String({ pattern: "^att_[0-9a-z]{1,64}$" }),
);

// TypeBox ReadonlyObject rebuilds object options. Apply strictness to its readonly properties.
export const workspaceExecutorProductFilesSchema = StrictObject(
  Type.ReadonlyObject(
    OpenObject({
      productMarkdown: Type.String(),
      variantsYaml: Type.String(),
    }),
  ).properties,
  { title: "ProductFolderFilesWire" },
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

const changesetSchema = StrictObject(
  {
    schemaVersion: Type.String(),
    organisationId: identity,
    workspaceId: identity,
    baseRevision: identity,
    resultingSemanticHash: digest,
    diff: StrictObject({
      productId: identity,
      fields: Type.Array(
        Type.Enum(["slug", "title", "description", "currency"]),
      ),
      variantIds: Type.Array(identity),
    }),
    changesetDigest: digest,
  },
  {
    title: "ValidatedChangeset",
    "x-rust-type": "crate::file_native::ValidatedProductFolderChangesetV1",
  },
);

const claimedChangesetSchema = Type.With(changesetSchema, {
  title: "ClaimedChangeset",
  "x-rust-type": "serde_json::Value",
});

// serde accepts extra fields on this request branch. The native boundary ignores them.
const productOperationSchema = Type.ReadonlyObject(
  OpenObject({
    kind: Type.Literal("product_folder_candidate"),
    productRoot: Type.String(),
    workspaceYaml: Type.String(),
    base: workspaceExecutorProductFilesSchema,
    candidate: workspaceExecutorProductFilesSchema,
    claimedChangeset: claimedChangesetSchema,
  }),
  { title: "WorkspaceExecutorOperationWire" },
);

const attachmentMediaClassSchema = Type.Enum(
  ["document", "audio", "video", "opaque"],
  { title: "AttachmentMediaClassWire" },
);

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

export const workspaceExecutorRequestSchema = StrictObject(
  Type.ReadonlyObject(
    OpenObject({
      schemaVersion: Type.Literal("workspace_executor_request.v1"),
      executionId: identity,
      executionReceiptId: identity,
      deadlineAtUnixMs: unsignedInteger,
      baseRevision: identity,
      baseCanonicalHead: digest,
      baseManifestDigest: digest,
      operation: productOperationSchema,
    }),
  ).properties,
);

export const workspaceExecutorInspectionRequestSchema = StrictObject(
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

const fileReplacementSchema = StrictObject(
  Type.ReadonlyObject(OpenObject({ path: Type.String(), utf8: Type.String() }))
    .properties,
  { title: "WorkspaceFileReplacement" },
);
const replacementOverlaySchema = StrictObject(
  Type.ReadonlyObject(
    OpenObject({
      productMarkdown: fileReplacementSchema,
      variantsYaml: fileReplacementSchema,
    }),
  ).properties,
  { title: "ProductFolderReplacementOverlay" },
);

export const workspaceExecutorDecodedFrameSchema = StrictObject(
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

export const workspaceExecutorInspectionOperationSchema = Type.Union(
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

const productResultSchema = StrictObject(
  Type.ReadonlyObject(
    OpenObject({
      kind: Type.Literal("validated_product_folder_changeset"),
      productRoot: Type.String(),
      replacementOverlay: replacementOverlaySchema,
      validatedChangeset: changesetSchema,
    }),
  ).properties,
  { title: "WorkspaceExecutorProductResult" },
);

const responseVersion = Type.Literal("workspace_executor_response.v1");
export const workspaceExecutorResponseSchema = StrictObject(
  Type.ReadonlyObject(
    OpenObject({
      schemaVersion: responseVersion,
      executionId: identity,
      executionReceiptId: identity,
      baseRevision: identity,
      baseCanonicalHead: digest,
      baseManifestDigest: digest,
      operation: productResultSchema,
      inputBytes: unsignedInteger,
      outputBytes: unsignedInteger,
      durationMs: unsignedInteger,
    }),
  ).properties,
);

export const workspaceExecutorInspectionResponseSchema = StrictObject(
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
  WorkspaceExecutorRequestWire: workspaceExecutorRequestSchema,
  WorkspaceExecutorPreparationRequestWire:
    workspaceExecutorInspectionRequestSchema,
  WorkspaceExecutorResponse: workspaceExecutorResponseSchema,
  WorkspaceExecutorPreparationResponse:
    workspaceExecutorInspectionResponseSchema,
};

export type WorkspaceExecutorProductFiles = Static<
  typeof workspaceExecutorProductFilesSchema
>;
export type WorkspaceExecutorRequest = Static<
  typeof workspaceExecutorRequestSchema
>;
export type WorkspaceExecutorInspectionRequest = Static<
  typeof workspaceExecutorInspectionRequestSchema
>;
export type WorkspaceExecutorResponse = Static<
  typeof workspaceExecutorResponseSchema
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
export type WorkspaceExecutorFileReplacement = Static<
  typeof fileReplacementSchema
>;

export function parseWorkspaceExecutorRequest(
  value: unknown,
): ContractDecodeResult<WorkspaceExecutorRequest> {
  return parseContract(workspaceExecutorRequestSchema, value, invalidRequest);
}

export function parseWorkspaceExecutorInspectionRequest(
  value: unknown,
): ContractDecodeResult<WorkspaceExecutorInspectionRequest> {
  return parseContract(
    workspaceExecutorInspectionRequestSchema,
    value,
    invalidRequest,
  );
}

function invalidRequest(_issue: TLocalizedValidationError): ContractRejection {
  return {
    code: "invalid_request",
    reason: "workspace executor request is invalid",
    details: null,
  };
}

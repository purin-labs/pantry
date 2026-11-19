import {
  StrictObject,
  parseContract,
  type ContractDecodeResult,
  type ContractRejection,
  NonNegativeInteger as unsignedInteger,
} from "@purin-labs/commerce-contracts/schema";
import { Type, type Static } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import type { StrictUnion } from "@purin-labs/type-utils";

const unsigned32 = Type.Integer({ minimum: 0, maximum: 0xffffffff });

export const mediaContainerSchema = Type.Enum([
  "iso_base_media",
  "matroska",
  "riff",
  "ogg",
  "flac",
  "mpeg",
  "unknown",
]);

export const videoTrackMetadataSchema = StrictObject({
  codec: Type.Union([Type.String(), Type.Null()]),
  width: Type.Union([unsigned32, Type.Null()]),
  height: Type.Union([unsigned32, Type.Null()]),
});

export const audioTrackMetadataSchema = StrictObject({
  codec: Type.Union([Type.String(), Type.Null()]),
  channels: Type.Union([unsigned32, Type.Null()]),
  sampleRateHz: Type.Union([unsigned32, Type.Null()]),
});

export const mediaMetadataSchema = StrictObject({
  container: mediaContainerSchema,
  durationMs: Type.Union([unsignedInteger, Type.Null()]),
  video: Type.Union([videoTrackMetadataSchema, Type.Null()]),
  audio: Type.Union([audioTrackMetadataSchema, Type.Null()]),
  headerIncomplete: Type.Boolean(),
});

export const sampledFrameSchema = StrictObject({
  timestampMs: unsignedInteger,
  byteOffset: unsignedInteger,
  byteLength: unsignedInteger,
  sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  mediaType: Type.String(),
});

export const frameSamplingOutcomeSchema = Type.Union([
  StrictObject({
    kind: Type.Literal("sampled"),
    policyRevision: Type.String(),
    selectedTimestampsMs: Type.Array(unsignedInteger),
    frames: Type.Array(sampledFrameSchema),
  }),
  StrictObject({
    kind: Type.Literal("decoder_required"),
    codec: Type.String(),
  }),
  StrictObject({ kind: Type.Literal("no_video_track") }),
  StrictObject({ kind: Type.Literal("container_unreadable") }),
]);

export type MediaContainer = Static<typeof mediaContainerSchema>;
export type VideoTrackMetadata = Static<typeof videoTrackMetadataSchema>;
export type AudioTrackMetadata = Static<typeof audioTrackMetadataSchema>;
export type MediaMetadata = Static<typeof mediaMetadataSchema>;
export type SampledFrame = Static<typeof sampledFrameSchema>;
export type FrameSamplingOutcome = StrictUnion<
  Static<typeof frameSamplingOutcomeSchema>
>;

export function parseMediaMetadata(
  value: unknown,
): ContractDecodeResult<MediaMetadata> {
  return parseContract(mediaMetadataSchema, value, invalidMedia);
}

export function parseFrameSamplingOutcome(
  value: unknown,
): ContractDecodeResult<FrameSamplingOutcome> {
  return parseContract(frameSamplingOutcomeSchema, value, invalidMedia);
}

function invalidMedia(_issue: TLocalizedValidationError): ContractRejection {
  return {
    code: "invalid_media_contract",
    reason: "media parser returned an invalid contract",
    details: null,
  };
}

import type { FrameSamplingOutcome } from "./media-inspect.ts";
import type { WorkspaceExecutorInspectionOperation } from "./workspace-executor.ts";
import type { ContractDecodeResult } from "@purin-labs/contract-schema";
import type { Variant } from "@purin-labs/type-utils";

declare const decodedFrames: Variant<FrameSamplingOutcome, "sampled">;
declare const sourceSha256: string;

// @ts-expect-error A decoder request cannot contain sampled frames.
const mixedFrames: FrameSamplingOutcome = {
  ...decodedFrames,
  kind: "decoder_required",
  codec: "avc1",
};
// @ts-expect-error A limitation cannot contain text, including through a broad spread.
const mixedInspection: WorkspaceExecutorInspectionOperation = {
  ...{
    kind: "attachment_not_inspectable" as const,
    attachmentId: "att_1",
    reason: "codec_unsupported" as const,
    sourceSha256,
    text: "unread",
  },
};
const inputError = {
  kind: "input_invalid",
  code: "invalid_json",
  reason: "invalid",
  details: null,
} as const;
// @ts-expect-error A successful decode cannot contain an error.
const mixedResult: ContractDecodeResult<string> = {
  ok: true,
  value: "parsed",
  error: inputError,
};

void mixedFrames;
void mixedInspection;
void mixedResult;

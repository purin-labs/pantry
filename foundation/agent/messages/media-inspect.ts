import type { FrameSamplingOutcome, MediaMetadata } from "@purin-labs/contracts";
import {
  parseFrameSamplingOutcome,
  parseMediaMetadata,
} from "@purin-labs/contracts/media-inspect";
import {
  initSync,
  inspectMediaMetadata as inspect,
  sampleVideoFrames as sample,
} from "@purin-labs/contracts/media-wasm";
import mediaWasm from "../../../packages/contracts/media-wasm-pkg/media_inspect_bg.wasm?module";

const decoder = new TextDecoder();
initSync({ module: mediaWasm });

export function inspectMediaMetadata(header: Uint8Array): MediaMetadata {
  const result = parseMediaMetadata(
    JSON.parse(decoder.decode(inspect(header))),
  );
  if (!result.ok) throw new TypeError(result.error.code);
  return result.value;
}

export function sampleVideoFrames(
  file: Uint8Array,
  maxFrames: number,
): FrameSamplingOutcome {
  const result = parseFrameSamplingOutcome(
    JSON.parse(decoder.decode(sample(file, maxFrames))),
  );
  if (!result.ok) throw new TypeError(result.error.code);
  return result.value;
}

export declare function initSync(input: {
  readonly module: WebAssembly.Module;
}): void;
export declare function inspectMediaMetadata(header: Uint8Array): Uint8Array;
export declare function sampleVideoFrames(
  file: Uint8Array,
  maxFrames: number,
): Uint8Array;

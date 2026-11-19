import { parseJson } from "@purin-labs/std";
import type { CellTransport } from "./cell-adapter.ts";

/**
 * The cell protocol through the controller's Wasm module: one call carries a
 * command in and leaves its reply in the module's memory. A browser worker
 * and a Node host use it alike; each supplies its own text codec.
 */

/** The part of the controller's module the cell protocol uses. */
export type CellModule = Readonly<{
  /** Read at each use: the module replaces it when its memory grows. */
  HEAPU8: Uint8Array;
  _bakery_alloc(length: number): number;
  _bakery_free(pointer: number, length: number): void;
  _bakery_cell_command(pointer: number, length: number): number;
  _bakery_response_pointer(): number;
  _bakery_response_length(): number;
}>;

export type TextCodec = Readonly<{
  encode(text: string): Uint8Array;
  decode(bytes: Uint8Array): string;
}>;

/**
 * The cell protocol as text: one command's JSON in, the controller's reply
 * text out. A result cache stores the reply bytes exactly as they came.
 */
export type TextCellTransport = Readonly<{
  exchange(command: string): Promise<string>;
}>;

/** One host command, answered within the call. */
export function exchangeNow(
  module: CellModule,
  codec: TextCodec,
  command: string,
): string {
  const bytes = codec.encode(command);
  const pointer = module._bakery_alloc(bytes.length);
  module.HEAPU8.set(bytes, pointer);
  const code = module._bakery_cell_command(pointer, bytes.length);
  module._bakery_free(pointer, bytes.length);
  const start = module._bakery_response_pointer();
  const text = codec.decode(
    module.HEAPU8.subarray(start, start + module._bakery_response_length()),
  );
  // A refused command is a reply. Only a fault in the host itself fails.
  if (code !== 0) throw new Error(text);
  return text;
}

export function wasmTextTransport(
  module: CellModule,
  codec: TextCodec,
): TextCellTransport {
  return {
    async exchange(command) {
      return exchangeNow(module, codec, command);
    },
  };
}

/** The object transport over the text transport. */
export function parsedTransport(transport: TextCellTransport): CellTransport {
  return {
    async send(command) {
      return parseJson(await transport.exchange(JSON.stringify(command)));
    },
  };
}

export function wasmTransport(
  module: CellModule,
  codec: TextCodec,
): CellTransport {
  return parsedTransport(wasmTextTransport(module, codec));
}

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// QuickJS for merchant plugin functions, compiled once, as the Worker's
// `?module` import gives it.
const wasmPath = createRequire(import.meta.url).resolve(
  "quickjs-wasi/quickjs.wasm",
);

export default Reflect.construct(WebAssembly.Module, [readFileSync(wasmPath)]);

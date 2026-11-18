import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeUrl } from "node:url";

export default Reflect.construct(WebAssembly.Module, [
  readFileSync(
    fileURLToPath(
      new NodeUrl(
        "../../../packages/contracts/media-wasm-pkg/media_inspect_bg.wasm",
        import.meta.url,
      ),
    ),
  ),
]);

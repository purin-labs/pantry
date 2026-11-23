declare module "*.wasm?module" {
  const compiledWasm: WebAssembly.Module;
  export default compiledWasm;
}

/** The 1Password SDK core, which the Worker imports as a compiled module. */
declare module "*/core_bg.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

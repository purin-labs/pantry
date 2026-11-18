/**
 * What a retained execution bundle's engine module exports: the engine, the
 * host loop, the adapter over the controller's cell protocol and its Wasm
 * transport, as they were when the bundle was built. A host that resolved the
 * bundle drives it through `createExecutionHost`, whose requests and replies
 * are host protocol version 4, and calls nothing from its own, possibly
 * newer, engine.
 */
export * from "./index.ts";
export * from "./execution-host.ts";
export * from "./native/cell-adapter.ts";
export * from "./native/wasm-transport.ts";
export * from "./native/model-packs.ts";
export * from "./native/result-cache.ts";
export * from "./native/result-store.ts";

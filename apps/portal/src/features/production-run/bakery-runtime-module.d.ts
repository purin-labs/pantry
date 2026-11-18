// The controller runtime's loader. The execution bundle build resolves this
// name to the runtime bundle it compiles the worker against.
declare module "bakery-runtime-module" {
  const createBakeryModule: (
    options: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
  export default createBakeryModule;
}

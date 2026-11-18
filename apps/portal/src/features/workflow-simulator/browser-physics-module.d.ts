declare function createBakeryModule(options: {
  locateFile(path: string): string;
  wasmBinary: Uint8Array;
  getPreloadedPackage(remoteName: string, remoteSize: number): ArrayBuffer;
}): Promise<unknown>;

export default createBakeryModule;

// The types of scripts/lib/source-roots.mjs, for a TypeScript test that
// reads the folders of the product source.
export declare const SOURCE_ROOTS: string[];
export declare const PLATFORM_SOURCE: string[];
export declare const PORTAL_SOURCE: string[];
export declare function inFolders(
  path: string,
  folders: readonly string[],
): boolean;
export declare function filesIn(
  root: string,
  folders: readonly string[],
  test: (name: string) => boolean,
): string[];

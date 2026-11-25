// Types of the release guard in worker-environment.mjs, for the TypeScript
// tests that read it.

/** A resolved Wrangler profile, as far as the release guard reads it. */
export type ReleaseTargetConfig = {
  readonly name?: string;
  readonly workers_dev?: boolean;
  readonly preview_urls?: boolean;
  readonly routes?: readonly unknown[];
};

export declare const WORKER_NAMES: Readonly<
  Record<string, Readonly<{ local?: string; production: string }>>
>;
export declare const WORKER_DOMAINS: Readonly<
  Record<string, readonly string[]>
>;
export declare function releaseTargetProblems(
  config: ReleaseTargetConfig,
): string[];
export declare function requireReleaseTarget(config: ReleaseTargetConfig): void;

/**
 * The ChatGPT allowance that Portal shows. `unavailable`: the last read
 * failed. `not_reported`: the sign-in has no allowance source; OpenAI
 * reports none to "Sign in with ChatGPT" (Plan 74B).
 */
export type CodexAllowance =
  | ({ readonly kind: "unavailable" } & NoAllowanceFigures)
  | ({ readonly kind: "not_reported" } & NoAllowanceFigures)
  | {
      readonly kind: "available";
      readonly usedPercent: number;
      readonly resetsAt: number | null;
      readonly secondaryUsedPercent: number | null;
      readonly secondaryResetsAt: number | null;
      readonly credits: "available" | "exhausted" | "unknown";
    };

type NoAllowanceFigures = {
  readonly credits?: never;
  readonly usedPercent?: never;
  readonly resetsAt?: never;
  readonly secondaryUsedPercent?: never;
  readonly secondaryResetsAt?: never;
};

/**
 * One skill a definition revision attaches, pinned to the exact revision that
 * revision was published against. The pair is immutable for the life of the
 * definition revision, so a later skill publication never changes what an
 * already-published agent runs.
 */
export type AgentSkillRef = {
  readonly skillId: string;
  readonly revision: number;
};

export type CuePresetId =
  "observe_commerce" | "commerce_operator" | "proactive_triage";

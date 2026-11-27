/**
 * What Jev reads for one check (Plan 87 section 3A): the draft, the chat's
 * origin label, the last answer of the chat cut to 1,000 characters, and the
 * page on screen with its section titles. No table row and no fact value.
 */
export type ScreenRelevanceState = Readonly<{
  draft: string;
  chatOrigin: string | null;
  lastAnswer: string | null;
  page: Readonly<{
    title: string;
    area: string;
    record: string | null;
    sections: readonly string[];
  }>;
}>;


export type CueAction =
  | { kind: "notify"; template: string | null }
  | { kind: "propose"; template: string | null }
  | { kind: "run_task"; taskRef: string };

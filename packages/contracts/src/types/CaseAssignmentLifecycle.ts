import type { CaseAssignment } from "./CaseAssignment";
import type { CaseAssignmentStart } from "./CaseAssignmentStart";
import type { CaseAssignmentTerminalDisposition } from "./CaseAssignmentTerminalDisposition";

export type CaseAssignmentLifecycle =
  | { kind: "assigned"; assignment: CaseAssignment }
  | { kind: "running"; assignment: CaseAssignment; start: CaseAssignmentStart }
  | {
      kind: "settled";
      assignment: CaseAssignment;
      start: CaseAssignmentStart;
      disposition: CaseAssignmentTerminalDisposition;
    };

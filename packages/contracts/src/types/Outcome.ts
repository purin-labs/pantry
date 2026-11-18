import type { ArtifactRef } from "./ArtifactRef";
import type { OutcomeStatus } from "./OutcomeStatus";

export type Outcome = {
  status: OutcomeStatus;
  summary: string | null;
  artifacts: Array<ArtifactRef>;
};

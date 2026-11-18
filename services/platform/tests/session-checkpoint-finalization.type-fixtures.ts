import type { HarnessTurnLease } from "@seams/contracts";
import type { CheckpointCommittedSessionCommit } from "../src/actors/actor-journal";
import { buildTextTurnCheckpointCommittedCommit } from "../src/actors/agent-session-text-turn";
import { uploadHarnessCheckpoint } from "../src/actors/agent-session-harness-checkpoint";
import type { HarnessCheckpointPublication } from "../src/actors/agent-session-harness-authority";

declare const accepted: CheckpointCommittedSessionCommit;
declare const lease: HarnessTurnLease;
declare const input: Parameters<
  typeof buildTextTurnCheckpointCommittedCommit
>[0];

const executable: CheckpointCommittedSessionCommit = {
  ...accepted,
  // @ts-expect-error A saved finalization cannot retain executable harness authority.
  harnessLease: lease,
};
void executable;

// @ts-expect-error Spreading an old request cannot authorize saved-checkpoint finalization.
buildTextTurnCheckpointCommittedCommit({ ...input, harnessLease: lease });

declare const published: Extract<
  HarnessCheckpointPublication,
  { kind: "published" }
>;
declare const upload: Parameters<typeof uploadHarnessCheckpoint>[0];

// @ts-expect-error Published checkpoints cannot carry pending plaintext.
const impossiblePublication: HarnessCheckpointPublication = {
  ...published,
  payload: new ArrayBuffer(1),
};
void impossiblePublication;

// @ts-expect-error A published checkpoint has no pending payload to upload.
uploadHarnessCheckpoint({ ...upload, publication: published });

const executablePublication: HarnessCheckpointPublication = {
  ...published,
  // @ts-expect-error Completed checkpoint evidence grants no execution lease.
  harnessLease: lease,
};
void executablePublication;

// @ts-expect-error Pending upload construction requires its saved payload.
const missingPayload: HarnessCheckpointPublication = {
  kind: "upload_pending",
  checkpoint: published.checkpoint,
};
void missingPayload;

// @ts-expect-error A publication discriminator cannot be cast to an unfinished upload.
const unsafeUpload = published as Extract<
  HarnessCheckpointPublication,
  { kind: "upload_pending" }
>;
void unsafeUpload;

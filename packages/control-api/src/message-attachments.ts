/**
 * The one place message-attachment limits are defined.
 *
 * Every limit appears in typed rejection evidence, so a refusal always names
 * the rule it applied and the value it observed. Nothing else in the codebase
 * may hard-code an attachment size or count.
 *
 * These are Milestone 1 values, sized to what the runtime can actually do
 * today rather than to the plan's aspirational ceiling:
 *
 * - ingestion hashes a file to verify its digest, and `crypto.subtle.digest`
 *   has no streaming form, so the whole file is resident in the Worker while it
 *   is verified. The Worker has 128 MB. A 100 MiB file cannot be admitted
 *   without incremental hashing and a streaming R2 put.
 * - the batch limit is the sum a single case-work claim may hold at once.
 *
 * Raising these requires streaming ingestion plus measured download, R2,
 * timeout, and memory evidence — the plan records that as a Milestone 2
 * prerequisite, not a constant edit.
 */
export const MESSAGE_ATTACHMENT_POLICY = {
  revision: "plan37.m1.v1",
  maxFilesPerMessage: 10,
  maxFileBytes: 25 * 1024 * 1024,
  maxBatchBytes: 50 * 1024 * 1024,
  /** Leading bytes handed to the contract for signature identification. */
  signatureHeaderBytes: 64,
  maxRedirects: 3,
  downloadTimeoutMs: 15_000,
} as const;

import { verifyProjectSnapshot } from "@purin-labs/control-api";
import { digestStoredContextBundle } from "../actor-journal";
import type {
  FrameSamplingOutcome,
  MediaMetadata,
  AcceptedInputRef,
  CaseAssignment,
  HarnessTurnLease,
  StoredMessageAttachment,
} from "@purin-labs/contracts";
import type { Env } from "@purin-labs/kernel/env";
import { newRequestId, type OrganisationId } from "@purin-labs/kernel/ids";
import { traceLog, traceWarn } from "@purin-labs/kernel/observability";
import type { Result } from "@purin-labs/kernel/result";
import {
  SessionExecutionAdmission,
  requireSessionExecution,
} from "../session-execution-admission";
import type { SessionTurnContext } from "../actor-journal";
import { MAX_HARNESS_HISTORY_ENTRY_BYTES } from "../agent-session-harness-authority";
import {
  encodeHarnessHistoryEntry,
  type HarnessHistoryContent,
} from "../harness-history";
import {
  modelContextPrompt,
  renderModelContext,
} from "../model-context-prompt";
import {
  inspectMessageAttachment,
  inspectionMayUseExecutor,
  readVerifiedAttachment,
  type DecodedVideoStill,
  type VerifiedAttachmentBytes,
} from "../../messages/attachment-inspection";
import {
  prepareAttachmentInExecutor,
  type AttachmentPreparationExecutionControl,
  type AttachmentPreparationLimit,
} from "../message-attachment-preparation";
import { persistDerivedStills } from "../../messages/derived-stills";
import { attachmentManifestLine } from "@purin-labs/contracts/message";
import {
  prepareAcceptedMessageAttachment,
  readAcceptedMessageAttachment,
  messagePreparationId,
  messagePreparationIdentity,
  MESSAGE_PREPARATION_LIMITS,
  type MessagePreparationError,
  type MessagePreparationAttempt,
} from "../message-preparation";
import type { EmbeddedHarnessUserInput } from "../embedded-harness";
import type { CanonicalEmbeddedHarnessInput } from "../canonical-embedded-harness-input";
import { parseStoredAttachmentJson } from "../../messages/stored-attachment";
import { reachableAttachmentObjectKeys } from "../../messages/attachment-reachability";
import {
  readSessionBudgetAccount,
  canonicalRunBudgetIdentity,
} from "../agent-session-budget";
import { authorityPartitionKey } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import { parseStoredRequestAuthority } from "@purin-labs/authority/request-authority/index";
import type { Variant } from "@purin-labs/type-utils";
import { encodeBase64 } from "@purin-labs/std";
import { claimCanonicalRunCapability } from "./capability-claims";
import {
  modelContextWithoutProject,
  projectModelContext,
} from "./model-context";
import { projectItemForSnapshot } from "./transient-turns";

export function readSessionTurnAttachments(
  sql: SqlStorage,
  input: {
    readonly turnId: string;
    readonly organisationId: string;
    readonly sessionId: string;
  },
): {
  readonly attachments: readonly StoredMessageAttachment[];
  readonly links: readonly string[];
} | null {
  const row =
    sql
      .exec<
        Record<string, SqlStorageValue> & {
          organisation_id: string;
          session_id: string;
          attachments_json: string;
          links_json: string;
        }
      >(
        "SELECT organisation_id, session_id, attachments_json, links_json FROM session_turn_attachment WHERE turn_id = ?",
        input.turnId,
      )
      .toArray()[0] ?? null;
  if (row === null) return { attachments: [], links: [] };
  if (
    row.organisation_id !== input.organisationId ||
    row.session_id !== input.sessionId
  )
    return null;
  const attachments = parseStoredAttachmentJson(row.attachments_json);
  if (!attachments.ok) return null;
  return {
    attachments: attachments.value,
    links: parseTurnLinks(row.links_json),
  };
}

export function sessionReachableAttachmentObjectKeys(
  sql: SqlStorage,
): readonly string[] {
  const keys = new Set<string>();
  for (const row of sql
    .exec<{ attachments_json: string }>(
      "SELECT attachments_json FROM session_turn_attachment",
    )
    .toArray()) {
    const attachments = parseStoredAttachmentJson(row.attachments_json);
    if (!attachments.ok)
      throw new Error("session_attachment_inventory_invalid");
    for (const key of reachableAttachmentObjectKeys(attachments.value))
      keys.add(key);
  }
  return [...keys];
}

/** Link values are stored as written; anything else is treated as absent. */
function parseTurnLinks(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(function isText(value): value is string {
          return typeof value === "string" && value.length > 0;
        })
      : [];
  } catch {
    return [];
  }
}

export async function validateAcceptedTurnContext(input: {
  readonly acceptedInput: Variant<AcceptedInputRef, "case">;
  readonly assignment: CaseAssignment;
  readonly lease: HarnessTurnLease;
  readonly context: SessionTurnContext;
}): Promise<boolean> {
  if (
    input.context.projectContext !== null &&
    (!(await verifyProjectSnapshot(input.context.projectContext)) ||
      !input.assignment.objective.instruction.startsWith(
        `Project context binding: ${input.context.projectContext.digest}\n\n`,
      ))
  )
    return false;
  if (
    input.context.projectContext?.layer.kind === "project" &&
    !input.context.bundle.items.some(
      projectItemForSnapshot.bind(null, input.context.projectContext.digest),
    )
  )
    return false;
  const partition = input.assignment.authorityPartition;
  const parsedAuthority = parseStoredRequestAuthority(
    input.lease.requestAuthority,
  );
  if (!parsedAuthority.ok) return false;
  const bundleDigest = await digestStoredContextBundle(input.context.bundle);
  if (
    input.assignment.authority.authorityPartitionDigest !== partition.digest ||
    input.lease.authorityPartitionDigest !== partition.digest ||
    JSON.stringify(
      authorityPartitionKey(parsedAuthority.value.requestAuthority),
    ) !== JSON.stringify(partition.key) ||
    input.context.bundleDigest !== bundleDigest ||
    input.acceptedInput.contextBundleDigest !== bundleDigest
  )
    return false;

  const bundle = input.context.bundle;
  return (
    bundle.organisationId ===
      parsedAuthority.value.requestAuthority.organisationId &&
    bundle.caseId === input.assignment.caseId &&
    bundle.assignmentId === input.assignment.assignmentId &&
    bundle.sessionId === input.assignment.sessionId &&
    bundle.policyVersion === partition.policyVersion
  );
}

export async function materializeEmbeddedHarnessUserInput(input: {
  readonly execution: SessionExecutionAdmission;
  readonly archive: R2Bucket;
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly lease: HarnessTurnLease;
  readonly organisationId: OrganisationId;
  readonly input: CanonicalEmbeddedHarnessInput;
  readonly executionControl: AttachmentPreparationExecutionControl;
}): Promise<
  Result<readonly EmbeddedHarnessUserInput[], MessagePreparationError>
> {
  const content: EmbeddedHarnessUserInput[] = [
    {
      kind: "text",
      text: "",
    },
  ];
  // The attachments of one group are prepared together. Each preparation has
  // its own record, its own flight and its own result object. The results are
  // taken in message order, so the first failure in that order is reported.
  for (const group of attachmentPreparationGroups(input.input.attachments)) {
    const prepared = await Promise.allSettled(
      group.map(materializeGroupedAttachment.bind(null, input)),
    );
    for (const outcome of prepared) {
      if (outcome.status === "rejected") throw outcome.reason;
      if (!outcome.value.ok) return outcome.value;
      content.push(...outcome.value.value.inputs);
    }
  }
  const emptyEntry = encodeHarnessHistoryEntry({
    kind: "user_input",
    turn: input.lease.turn,
    input: input.input.acceptedInput,
    content: content.map(userInputHistoryContent),
    acceptedAt: Number.MAX_SAFE_INTEGER,
  });
  // Replace the empty JSON string, including its two quote bytes.
  const availableTextBytes =
    MAX_HARNESS_HISTORY_ENTRY_BYTES -
    new TextEncoder().encode(emptyEntry).byteLength +
    2;
  // Each Memory line names the reference by which a reply cites it.
  content[0] = {
    kind: "text",
    text: renderModelContext(
      modelContextWithoutProject(input.input.modelContext),
      [
        `Current UTC time for this request: ${new Date().toISOString()}`,
        "",
        input.input.instruction,
      ].join("\n"),
      availableTextBytes,
      { memoryReferences: true },
    ).text,
  };
  if (input.input.projectContext?.layer.kind === "project") {
    content.push({
      kind: "project_context",
      snapshotDigest: input.input.projectContext.digest,
      text: modelContextPrompt(
        projectModelContext(input.input.modelContext),
        "Current project working defaults. Source bodies require authorized reads.",
        availableTextBytes -
          new TextEncoder().encode(JSON.stringify(content[0])).byteLength,
      ),
    });
  }
  return { ok: true, value: content };
}

function userInputHistoryContent(
  input: EmbeddedHarnessUserInput,
): HarnessHistoryContent {
  if (input.kind === "project_context")
    return {
      kind: "project_context",
      snapshotDigest: input.snapshotDigest,
      text: input.text,
    };
  if (input.kind === "text") return { kind: "text", text: input.text };
  return { kind: "attachment", attachment: input.attachment };
}

/** The bytes that one group of attachments may hold in memory together. */
const CONCURRENT_PREPARATION_BYTES = 16 * 1024 * 1024;

/**
 * The attachments of a message in groups that are prepared together. The
 * executor serves one preparation at a time, and a preparation's deadline
 * starts when the preparation begins. An attachment whose inspection can call
 * the executor is therefore a group of its own. The bytes of a group are
 * bounded, because a group holds them in memory at the same time.
 */
function attachmentPreparationGroups(
  attachments: readonly StoredMessageAttachment[],
): StoredMessageAttachment[][] {
  const groups: StoredMessageAttachment[][] = [];
  let group: StoredMessageAttachment[] = [];
  let groupBytes = 0;

  for (const attachment of attachments) {
    const alone = inspectionMayUseExecutor(attachment);
    if (
      group.length > 0 &&
      (alone ||
        groupBytes + attachment.byteLength > CONCURRENT_PREPARATION_BYTES)
    ) {
      groups.push(group);
      group = [];
      groupBytes = 0;
    }
    if (alone) {
      groups.push([attachment]);
      continue;
    }
    group.push(attachment);
    groupBytes += attachment.byteLength;
  }

  if (group.length > 0) groups.push(group);

  return groups;
}

function materializeGroupedAttachment(
  input: Omit<AttachmentPreparationContext, "attachment">,
  attachment: StoredMessageAttachment,
): ReturnType<typeof materializeAcceptedAttachment> {
  return materializeAcceptedAttachment({
    execution: input.execution,
    env: input.env,
    archive: input.archive,
    storage: input.storage,
    lease: input.lease,
    organisationId: input.organisationId,
    attachment,
    executionControl: input.executionControl,
  });
}

type AttachmentPreparationContext = {
  readonly execution: SessionExecutionAdmission;
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly lease: HarnessTurnLease;
  readonly archive: R2Bucket;
  readonly organisationId: OrganisationId;
  readonly attachment: StoredMessageAttachment;
  readonly executionControl: AttachmentPreparationExecutionControl;
};

export async function materializeAcceptedAttachment(
  input: AttachmentPreparationContext,
): ReturnType<typeof prepareAcceptedMessageAttachment> {
  const attachment = input.attachment;
  const budget = readSessionBudgetAccount(
    input.storage.sql,
    canonicalRunBudgetIdentity(input.lease),
  );
  if (
    !budget.ok ||
    budget.value.kind !== "open" ||
    budget.value.reservation.kind !== "active"
  ) {
    return {
      ok: false,
      error: {
        code: "embedded_harness_attachment_preparation_failed",
        attachmentId: attachment.id,
        reason: "preparation_budget_unavailable",
      },
    };
  }
  return prepareAcceptedMessageAttachment({
    storage: input.storage,
    archive: input.archive,
    lease: input.lease,
    attachment,
    deadlineAt: budget.value.reservation.reservation.deadlineAt,
    materialize: materializeVerifiedAttachment.bind(null, {
      execution: input.execution,
      env: input.env,
      storage: input.storage,
      lease: input.lease,
      archive: input.archive,
      organisationId: input.organisationId,
      attachment,
      executionControl: input.executionControl,
    }),
  });
}

async function materializeVerifiedAttachment(
  input: AttachmentPreparationContext,
  deadlineAt: number,
  attempt: MessagePreparationAttempt,
): Promise<readonly Exclude<EmbeddedHarnessUserInput, { kind: "text" }>[]> {
  if (
    !input.attachment.objectKey.startsWith(
      `attachments/${input.organisationId}/`,
    )
  ) {
    throw new Error("attachment_not_in_organisation");
  }
  const readStartedAt = Date.now();
  const verified = await readVerifiedAttachment(
    input.archive,
    input.attachment,
  );
  traceLog("session.attachment_read_timing", {
    requestId: newRequestId(),
    organisation_id: input.organisationId,
    turn_id: input.lease.turn.turnId,
    byte_length: input.attachment.byteLength,
    read_ms: Date.now() - readStartedAt,
    outcome: verified.ok ? "read" : verified.error.code,
  });
  if (!verified.ok) throw new Error(verified.error.code);
  const bytes = verified.value;
  return harnessInputsForAttachment({
    execution: input.execution,
    env: input.env,
    storage: input.storage,
    lease: input.lease,
    archive: input.archive,
    organisationId: input.organisationId,
    attachment: input.attachment,
    bytes,
    deadlineAt,
    attempt,
    executionControl: input.executionControl,
  });
}

export function readPreparedInspection(
  execution: SessionExecutionAdmission,
  storage: DurableObjectStorage,
  archive: R2Bucket,
  lease: HarnessTurnLease,
  attachment: StoredMessageAttachment,
): Promise<
  Result<readonly EmbeddedHarnessUserInput[], MessagePreparationError>
> {
  return readAcceptedMessageAttachment({
    authorizeExecution: requireSessionExecution.bind(null, execution, lease),
    storage,
    archive,
    lease,
    attachment,
  });
}

async function runPreparedExecutor(
  input: AttachmentPreparationContext,
  deadlineAt: number,
  attachment: StoredMessageAttachment,
  bytes: Uint8Array,
) {
  const identity = messagePreparationIdentity(input.lease, attachment);
  const preparationId = await messagePreparationId(identity);
  const budgetIdentity = canonicalRunBudgetIdentity(input.lease);
  const claimed = await claimCanonicalRunCapability(
    input.storage,
    input.execution,
    budgetIdentity,
    input.lease,
    {
      boundary: "attachment_preparation",
      capability: "message.attachment.inspect",
      callId: preparationId,
    },
  );
  if (!claimed.ok) {
    traceAttachmentExecutorRefusal(
      input,
      attachment,
      "capability_claim",
      claimed.error.code,
      claimed.error.detail,
    );
    return null;
  }
  const account = readSessionBudgetAccount(input.storage.sql, budgetIdentity);
  if (
    !account.ok ||
    account.value.kind !== "open" ||
    account.value.reservation.kind !== "active"
  ) {
    throw new Error("preparation_budget_unavailable");
  }
  const prepared = await prepareAttachmentInExecutor({
    env: input.env,
    storage: input.storage,
    organisationId: input.organisationId,
    lease: input.lease,
    preparationId,
    identity,
    limits: MESSAGE_PREPARATION_LIMITS,
    deadlineAt: Math.min(
      deadlineAt,
      account.value.reservation.reservation.deadlineAt,
    ),
    attachment,
    bytes,
    executionControl: input.executionControl,
  });
  if (!prepared.ok) throw new Error(prepared.error.code);
  if (prepared.value.kind === "limited") {
    traceAttachmentExecutorRefusal(
      input,
      attachment,
      "executor_preparation",
      "attachment_preparation_limited",
      prepared.value.detail,
      prepared.value.limit,
    );
    return null;
  }
  return prepared.value.operation;
}

async function decodePreparedVideo(
  input: AttachmentPreparationContext,
  deadlineAt: number,
  attachment: StoredMessageAttachment,
  bytes: Uint8Array,
): Promise<readonly DecodedVideoStill[] | null> {
  const operation = await runPreparedExecutor(
    input,
    deadlineAt,
    attachment,
    bytes,
  );
  if (operation?.kind !== "attachment_video_frames") return null;
  return persistDerivedStills({
    archive: input.archive,
    organisationId: input.organisationId,
    attachment,
    policyRevision: operation.policyRevision,
    frames: operation.frames,
    now: Date.now(),
  });
}

function traceAttachmentExecutorRefusal(
  input: AttachmentPreparationContext,
  attachment: StoredMessageAttachment,
  stage: "capability_claim" | "executor_preparation",
  code:
    | "embedded_harness_capability_claim_rejected"
    | "attachment_preparation_limited",
  detail: string,
  limit: AttachmentPreparationLimit | null = null,
): void {
  traceWarn("session.attachment_executor_refused", {
    requestId: newRequestId(),
    organisation_id: String(input.organisationId),
    session_id: String(input.lease.session.sessionId),
    turn_id: String(input.lease.turn.turnId),
    attachment_id: String(attachment.id),
    stage,
    code,
    limit,
    detail: boundedPreparationDetail(detail),
  });
}

function boundedPreparationDetail(detail: string): string {
  return /^[a-zA-Z0-9_.:-]{1,120}$/u.test(detail) ? detail : "unclassified";
}

async function readPreparedDocument(
  input: AttachmentPreparationContext,
  deadlineAt: number,
  attachment: StoredMessageAttachment,
  bytes: Uint8Array,
): Promise<{ readonly text: string; readonly truncated: boolean } | null> {
  const operation = await runPreparedExecutor(
    input,
    deadlineAt,
    attachment,
    bytes,
  );
  return operation?.kind === "attachment_text"
    ? { text: operation.text, truncated: operation.truncated }
    : null;
}

/**
 * Chooses the model-visible representations for one verified attachment.
 *
 * A verified image becomes native image input. A document becomes its extracted
 * text. Audio and video become deterministic container facts, and sampled video
 * frames become further native image inputs. Anything no handler could read is
 * described rather than interpreted, so the agent is never told a file was read
 * when it was not.
 */
async function harnessInputsForAttachment(input: {
  readonly execution: SessionExecutionAdmission;
  readonly attempt: MessagePreparationAttempt;
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly lease: HarnessTurnLease;
  readonly deadlineAt: number;
  readonly archive: R2Bucket;
  readonly organisationId: OrganisationId;
  readonly attachment: StoredMessageAttachment;
  readonly bytes: VerifiedAttachmentBytes;
  readonly executionControl: AttachmentPreparationExecutionControl;
}): Promise<readonly Exclude<EmbeddedHarnessUserInput, { kind: "text" }>[]> {
  const { attachment, bytes } = input;
  const descriptor = attachment.descriptor;
  const manifest = `${attachmentManifestLine(attachment)} contents not read`;

  if (
    descriptor.kind === "image" &&
    descriptor.media.kind === "signature_verified"
  ) {
    return [
      {
        kind: "image",
        dataUrl: `data:${descriptor.media.mediaType};base64,${encodeBase64(bytes)}`,
        detail: "original",
        attachment,
      },
    ];
  }

  // The bytes are verified already, so the inspection reads the archive for
  // nothing but stills an earlier turn decoded.
  const prepared = await inspectMessageAttachment({
    archive: input.archive,
    organisationId: input.organisationId,
    attachment,
    verified: bytes,
    decodeVideoFrames:
      input.attempt.kind === "initial"
        ? decodePreparedVideo.bind(null, input, input.deadlineAt)
        : undefined,
    readOversizedDocument:
      input.attempt.kind === "initial"
        ? readPreparedDocument.bind(null, input, input.deadlineAt)
        : undefined,
  });

  if (!prepared.ok) {
    throw new Error(prepared.error.code);
  }

  if (prepared.value.kind === "extracted_text") {
    return [
      {
        kind: "attachment_text",
        manifest,
        text: prepared.value.text,
        truncated: prepared.value.truncated,
        attachment,
      },
    ];
  }

  if (prepared.value.kind === "media_metadata") {
    const frames = prepared.value.frames;
    const inputs: Exclude<EmbeddedHarnessUserInput, { kind: "text" }>[] = [
      {
        kind: "attachment_media",
        manifest,
        summary: describeMediaMetadata(
          prepared.value.metadata,
          frames,
          prepared.value.decodedStills,
        ),
        attachment,
      },
    ];

    if (frames !== null && frames.kind === "sampled") {
      // Sampled stills are images, so they reach the model as image input
      // rather than as a description of an image.
      for (const frame of frames.frames) {
        const frameBytes = frameBytesFor(bytes, frame);

        if (frameBytes !== null) {
          inputs.push({
            kind: "image",
            dataUrl: `data:${frame.mediaType};base64,${encodeBase64(frameBytes)}`,
            detail: "original",
            attachment,
          });
        }
      }
    }

    // Stills the executor decoded carry their own bytes; there is no source
    // offset to slice, because the pixels never existed in the container.
    for (const still of prepared.value.decodedStills ?? []) {
      inputs.push({
        kind: "image",
        dataUrl: `data:${still.mediaType};base64,${encodeBase64(still.bytes)}`,
        detail: "original",
        attachment,
      });
    }

    return inputs;
  }

  return [
    {
      kind: "attachment_manifest",
      manifest: `${manifest}; preparation=${prepared.value.reason}`,
      attachment,
    },
  ];
}

/** A one-line technical summary. No claim is made about content. */
function describeMediaMetadata(
  metadata: MediaMetadata,
  frames: FrameSamplingOutcome | null,
  decodedStills: readonly DecodedVideoStill[] | null,
): string {
  const parts = [`container=${metadata.container}`];

  if (metadata.durationMs !== null)
    parts.push(`durationMs=${metadata.durationMs}`);
  if (metadata.audio !== null) {
    parts.push(`audio=${metadata.audio.codec ?? "unknown"}`);
    if (metadata.audio.channels !== null)
      parts.push(`channels=${metadata.audio.channels}`);
    if (metadata.audio.sampleRateHz !== null)
      parts.push(`sampleRateHz=${metadata.audio.sampleRateHz}`);
  }
  if (metadata.video !== null) {
    parts.push(`video=${metadata.video.codec ?? "unknown"}`);
    if (metadata.video.width !== null && metadata.video.height !== null) {
      parts.push(`dimensions=${metadata.video.width}x${metadata.video.height}`);
    }
  }
  if (metadata.headerIncomplete) parts.push("headerIncomplete");
  if (frames !== null) {
    parts.push(
      frames.kind === "sampled"
        ? `frames=${frames.frames.length}`
        : `frames=${frames.kind}`,
    );
  }
  if (decodedStills !== null && decodedStills.length > 0) {
    parts.push(`decodedStills=${decodedStills.length}`);
  }
  // Said plainly, because a technical summary is not a description of content.
  parts.push("contents not interpreted");

  return parts.join(" ");
}

/** Slices a sampled frame out of the verified source bytes. */
function frameBytesFor(
  bytes: Uint8Array,
  frame: { readonly byteOffset: number; readonly byteLength: number },
): Uint8Array | null {
  const end = frame.byteOffset + frame.byteLength;

  return frame.byteLength > 0 && end <= bytes.byteLength
    ? bytes.slice(frame.byteOffset, end)
    : null;
}

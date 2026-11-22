import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { readPortalChatAttachmentKeys } from "../chat/attachments";
import { readChatForkAttachmentKeys } from "../chat/fork-history";
import { actorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import {
  listOrganisationActorRegistryEntries,
  type ActorRegistryEntry,
} from "@purin-labs/actor-runtime/actors/actor-registry";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  type RequestId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  collectMessageAttachments,
  type AttachmentCollectionError,
  type AttachmentCollectionReceipt,
  type AttachmentCollectionUncertainReceipt,
} from "./attachment-reachability";
import { traceWarn } from "@purin-labs/kernel/observability";
import { assertNever } from "@purin-labs/std";
/**
 * The scheduled attachment collection pass.
 *
 * Runs from the Worker's cron. Each pass takes a bounded number of active
 * organisations whose last collection is older than the interval, asks every live
 * Case and Session actor which attachment objects it still names, adds retained
 * fork references from D1, and hands
 * the union to the collector. The receipt — deletions, or the reason nothing
 * was deleted — is written to R2 outside the attachment prefix, and the
 * latest one is what paces the next pass. No D1 schema is involved.
 *
 * Deletion needs a complete inventory. An organisation whose registry holds a
 * reserved, exporting, or quarantined actor, or whose actor does not answer,
 * is skipped whole and the receipt says why; a retired actor is superseded by
 * its successor and contributes nothing.
 */

export const ATTACHMENT_COLLECTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;
/** Younger objects are kept regardless: in-flight staging, a trigger being written. */
export const ATTACHMENT_COLLECTION_GRACE_MS = 24 * 60 * 60 * 1_000;
const ATTACHMENT_COLLECTION_ORGANISATIONS_PER_PASS = 4;

const RECEIPT_ROOT = "attachment-collection";

type OrganisationAttachmentCollectionOutcome =
  | {
      readonly kind: "collected";
      readonly receipt: AttachmentCollectionReceipt;
    }
  | {
      readonly kind: "uncertain";
      readonly reason: "attachment_collection_deletion_uncertain";
      readonly receipt: AttachmentCollectionUncertainReceipt;
    }
  | {
      readonly kind: "skipped";
      readonly reason:
        | "organisation_placement_conflict"
        | "registry_unavailable"
        | "actor_not_active"
        | "actor_unreachable"
        | "fork_history_unavailable"
        | "attachment_collection_listing_stalled"
        | "attachment_collection_failed";
      readonly actors: readonly string[];
    };

/** What is written beside the organisation's attachments after each pass. */
type OrganisationAttachmentCollectionRecord = {
  readonly schemaVersion: "plan37.attachment-collection-pass.v1";
  readonly organisationId: OrganisationId;
  readonly collectedAt: number;
  readonly outcome: OrganisationAttachmentCollectionOutcome;
};

type AttachmentCollectionNamespaces = Pick<Env, "CASE" | "SESSION">;

export async function collectOrganisationAttachments(input: {
  readonly scope: OrganisationExecutionScope;
  readonly archive: R2Bucket;
  readonly namespaces: AttachmentCollectionNamespaces;
  readonly now: number;
}): Promise<OrganisationAttachmentCollectionOutcome> {
  if (!(await input.scope.isActive()))
    return {
      kind: "skipped",
      reason: "organisation_placement_conflict",
      actors: [],
    };
  const entries = await listOrganisationActorRegistryEntries({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
  });

  if (!entries.ok) {
    return { kind: "skipped", reason: "registry_unavailable", actors: [] };
  }

  const owners = entries.value.filter(function ownsAttachments(entry) {
    return (
      (entry.identity.objectKind === "case" ||
        entry.identity.objectKind === "session") &&
      entry.lifecycleStatus !== "retired"
    );
  });
  const notActive = owners.filter(function inactive(entry) {
    return entry.lifecycleStatus !== "active";
  });

  if (notActive.length > 0) {
    return {
      kind: "skipped",
      reason: "actor_not_active",
      actors: notActive.map(logicalId),
    };
  }

  const reachable = new Set<string>();
  try {
    for (const key of await readPortalChatAttachmentKeys(
      input.scope.database,
      input.archive,
      input.scope.organisationId,
    ))
      reachable.add(key);
    for (const key of await readChatForkAttachmentKeys(
      input.scope.database,
      input.scope.organisationId,
    ))
      reachable.add(key);
  } catch {
    return { kind: "skipped", reason: "fork_history_unavailable", actors: [] };
  }

  for (const entry of owners) {
    let keys: readonly string[];

    try {
      keys = await reachableKeysOf(input.namespaces, entry);
    } catch {
      // Silence is not an inventory.
      return {
        kind: "skipped",
        reason: "actor_unreachable",
        actors: [logicalId(entry)],
      };
    }

    for (const key of keys) {
      reachable.add(key);
    }
  }

  if (!(await input.scope.isActive()))
    return {
      kind: "skipped",
      reason: "organisation_placement_conflict",
      actors: [],
    };
  const collected = await collectMessageAttachments({
    archive: input.archive,
    organisationId: input.scope.organisationId,
    reachableSourceKeys: [...reachable],
    retainUploadedAfter: input.now - ATTACHMENT_COLLECTION_GRACE_MS,
    now: input.now,
  });

  if (collected.ok) {
    return { kind: "collected", receipt: collected.value };
  }

  return organisationCollectionErrorOutcome(collected.error);
}

export async function runAttachmentCollection(
  env: Env,
  now: number,
): Promise<void> {
  const requestId = crypto.randomUUID() as RequestId;
  let organisations: readonly OrganisationId[];

  try {
    organisations = await listActiveOrganisationIds(env.DB);
  } catch (error) {
    traceWarn("attachment_collection_organisations_unavailable", {
      requestId,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return;
  }

  let processed = 0;

  for (const organisationId of organisations) {
    if (processed >= ATTACHMENT_COLLECTION_ORGANISATIONS_PER_PASS) {
      return;
    }

    const latest = await readLatestRecord(env.ARCHIVE, organisationId);

    if (
      latest !== null &&
      now - latest.collectedAt < ATTACHMENT_COLLECTION_INTERVAL_MS
    ) {
      continue;
    }

    processed += 1;

    const execution = await OrganisationExecutionScope.resolve(
      env,
      organisationId,
    );
    if (!execution.ok) continue;
    const outcome = await collectOrganisationAttachments({
      scope: execution.value,
      archive: env.ARCHIVE,
      namespaces: env,
      now,
    });
    const record: OrganisationAttachmentCollectionRecord = {
      schemaVersion: "plan37.attachment-collection-pass.v1",
      organisationId,
      collectedAt: now,
      outcome,
    };

    await writeRecord(env.ARCHIVE, record);

    if (outcome.kind === "uncertain") {
      traceWarn("attachment_collection_uncertain", {
        requestId,
        organisationId,
        reason: outcome.reason,
        deletedCount: outcome.receipt.deleted.length,
        uncertainCount: outcome.receipt.uncertain.length,
      });
    } else if (outcome.kind === "skipped") {
      traceWarn("attachment_collection_skipped", {
        requestId,
        organisationId,
        reason: outcome.reason,
        actors: outcome.actors,
      });
    }
  }
}

function organisationCollectionErrorOutcome(
  error: AttachmentCollectionError,
): OrganisationAttachmentCollectionOutcome {
  switch (error.code) {
    case "attachment_collection_deletion_uncertain":
      return { kind: "uncertain", reason: error.code, receipt: error.receipt };
    case "attachment_collection_listing_stalled":
    case "attachment_collection_failed":
      return { kind: "skipped", reason: error.code, actors: [] };
    default:
      return assertNever(error);
  }
}

export function attachmentCollectionRecordKey(
  organisationId: OrganisationId,
  collectedAt: number | "latest",
): string {
  return `${RECEIPT_ROOT}/${organisationId}/${collectedAt}.json`;
}

async function reachableKeysOf(
  namespaces: AttachmentCollectionNamespaces,
  entry: ActorRegistryEntry,
): Promise<readonly string[]> {
  switch (entry.identity.objectKind) {
    case "case":
      return actorStub(
        namespaces.CASE,
        entry.physicalObjectName,
        entry.placement,
      ).listReachableAttachmentObjectKeys();
    case "session":
      return actorStub(
        namespaces.SESSION,
        entry.physicalObjectName,
        entry.placement,
      ).listReachableAttachmentObjectKeys();
    default:
      return [];
  }
}

async function listActiveOrganisationIds(
  db: D1Database,
): Promise<readonly OrganisationId[]> {
  const rows = await db
    .prepare(
      "SELECT organisation_id AS organisationId FROM organisation WHERE status = 'active' ORDER BY organisation_id",
    )
    .all<{ organisationId: string }>();
  const organisations: OrganisationId[] = [];

  for (const row of rows.results) {
    const parsed = parseOrganisationId(row.organisationId);

    if (parsed.ok) {
      organisations.push(parsed.value);
    }
  }

  return organisations;
}

async function readLatestRecord(
  archive: R2Bucket,
  organisationId: OrganisationId,
): Promise<OrganisationAttachmentCollectionRecord | null> {
  try {
    const object = await archive.get(
      attachmentCollectionRecordKey(organisationId, "latest"),
    );

    if (object === null) {
      return null;
    }

    const parsed: unknown = JSON.parse(await object.text());

    return isAttachmentCollectionRecord(parsed) ? parsed : null;
  } catch {
    // An unreadable record paces nothing: the organisation is simply due.
    return null;
  }
}

async function writeRecord(
  archive: R2Bucket,
  record: OrganisationAttachmentCollectionRecord,
): Promise<void> {
  const body = JSON.stringify(record);
  const options = { httpMetadata: { contentType: "application/json" } };

  await archive.put(
    attachmentCollectionRecordKey(record.organisationId, record.collectedAt),
    body,
    options,
  );
  await archive.put(
    attachmentCollectionRecordKey(record.organisationId, "latest"),
    body,
    options,
  );
}

function isAttachmentCollectionRecord(
  value: unknown,
): value is OrganisationAttachmentCollectionRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { schemaVersion?: unknown }).schemaVersion ===
      "plan37.attachment-collection-pass.v1" &&
    Number.isSafeInteger((value as { collectedAt?: unknown }).collectedAt)
  );
}

function logicalId(entry: ActorRegistryEntry): string {
  return entry.identity.logicalObjectId;
}

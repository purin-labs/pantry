import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { RequestAuthority } from "@purin-labs/contracts";
import { listAccessGrants } from "../../data/access-grants";
import { resolveCurrentOrganisationCommerceMerchantBinding } from "@purin-labs/connections/data/commerce-merchant-binding";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { RequestableEntityTypeRead } from "../requestable-capabilities";
import { commerceGrantSelection } from "./commerce-grant-selection";
import type { AccessGrant } from "./types";

/**
 * Who must be able to read a record type. A Slack channel turn answers
 * everyone in the channel, so its reads need a grant for the channel. Its
 * draft edits write the record into a draft that the requester's role reads,
 * so they also need a grant for that role. A direct message reads under the
 * requester's role alone.
 *
 * Production requests feed the shared production plan, which every role
 * reads (Plan 40D). An agent may write a plan line only when each role may
 * read the requests, so that read names each role.
 */
export type EntityTypeReadAudience =
  "conversation" | "requester" | OrganisationReadRole;

export type OrganisationReadRole = "owner" | "admin" | "operator" | "viewer";

const EVERY_ROLE: readonly OrganisationReadRole[] = [
  "owner",
  "admin",
  "operator",
  "viewer",
];

export type MissingEntityTypeRead = Readonly<{
  read: RequestableEntityTypeRead;
  audience: EntityTypeReadAudience;
}>;

type EntityTypeReadsError = Readonly<{ code: "entity_type_reads_unavailable" }>;

export function entityTypeReadAudiences(
  authority: RequestAuthority,
  read: RequestableEntityTypeRead,
): readonly EntityTypeReadAudience[] {
  const members: readonly EntityTypeReadAudience[] =
    read === "production_requests" ? EVERY_ROLE : ["requester"];
  return authority.kind === "shared_conversation"
    ? ["conversation", ...members]
    : members;
}

export function isOrganisationReadRole(
  audience: EntityTypeReadAudience,
): audience is OrganisationReadRole {
  return audience !== "conversation" && audience !== "requester";
}

/**
 * The requested record-type reads that each audience of a request authority
 * cannot do now. A read counts only when one active grant covers every record
 * of the type, as the draft tools select their source grant. Like
 * `currentGrantedCapabilityIds`, it reads no live membership.
 */
export async function missingEntityTypeReads(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    requestAuthority: RequestAuthority;
    reads: readonly RequestableEntityTypeRead[];
    causationId: string;
    now: number;
  }>,
): Promise<Result<readonly MissingEntityTypeRead[], EntityTypeReadsError>> {
  if (input.reads.length === 0) return { ok: true, value: [] };
  const [binding, grants] = await Promise.all([
    resolveCurrentOrganisationCommerceMerchantBinding({
      db: input.db,
      organisationId: input.organisationId,
    }),
    listAccessGrants({
      db: input.db,
      organisationId: input.organisationId,
      lifecycle: "active",
    }),
  ]);
  if (!binding.ok || !grants.ok) return unavailable();
  const missing: MissingEntityTypeRead[] = [];
  const selection = commerceGrantSelection.use();
  for (const read of input.reads) {
    for (const audience of entityTypeReadAudiences(
      input.requestAuthority,
      read,
    )) {
      const selected = selection.selectRequestableReadGrant({
        organisationId: String(input.organisationId),
        merchantId: String(binding.value.merchantId),
        grants: grants.value.filter(audienceGrant.bind(null, audience)),
        requestAuthority: audienceAuthority(input.requestAuthority, audience),
        causationId: input.causationId,
        read,
        now: new Date(input.now).toISOString(),
      });
      if (selected.ok) continue;
      if (selected.error.code !== "denied") return unavailable();
      missing.push({ read, audience });
    }
  }
  return { ok: true, value: missing };
}

/**
 * The requester's own reads are those of a direct message: its role and
 * person grants, without the channel's.
 */
function audienceAuthority(
  authority: RequestAuthority,
  audience: EntityTypeReadAudience,
): RequestAuthority {
  if (audience === "conversation") return authority;
  const direct: RequestAuthority =
    authority.kind === "shared_conversation"
      ? { ...authority, kind: "direct_conversation" }
      : authority;
  // A role's read is checked as a member of that role would make it.
  return isOrganisationReadRole(audience) && "role" in direct
    ? ({ ...direct, role: audience } as RequestAuthority)
    : direct;
}

/** The grants that can give one audience its read. */
function audienceGrant(
  audience: EntityTypeReadAudience,
  grant: AccessGrant,
): boolean {
  if (audience === "conversation") return true;
  if (audience === "requester") return grant.subject.kind !== "conversation";
  return (
    grant.subject.kind === "organisation_role" &&
    grant.subject.role === audience
  );
}

function unavailable(): Result<never, EntityTypeReadsError> {
  return { ok: false, error: { code: "entity_type_reads_unavailable" } };
}

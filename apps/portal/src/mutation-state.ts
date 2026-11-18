/**
 * Browser-owned mutation state. The ledger only tracks work that is currently
 * in flight; server state remains authoritative after the operation settles.
 */

import { assertNever } from "@seams/std";

export type MutationProvider =
  | "airtable"
  | "dropbox"
  | "gmail"
  | "google_drive"
  | "notion"
  | "slack"
  | "square"
  | "stripe"
  | "shopify"
  | "whatsapp";

export type OrganisationMutation =
  | { readonly kind: "select_commerce"; readonly integrationAccountId: string }
  | { readonly kind: "provision_commerce" }
  | { readonly kind: "sync_commerce" }
  | { readonly kind: "connect_provider"; readonly provider: MutationProvider }
  | { readonly kind: "codex_connection" }
  | { readonly kind: "inference_selection" }
  | { readonly kind: "setup" }
  | { readonly kind: "readiness" }
  | { readonly kind: "activation" }
  | {
      readonly kind: "integration_account";
      readonly integrationAccountId: string;
    }
  | { readonly kind: "workspace_lifecycle" }
  | { readonly kind: "invite_member" }
  | { readonly kind: "invitation"; readonly invitationId: string }
  | { readonly kind: "member"; readonly userId: string }
  | {
      readonly kind: "commerce_action";
      readonly operation: "approve" | "load" | "reject" | "execute";
    }
  | { readonly kind: "agent_mailbox"; readonly integrationAccountId: string }
  | {
      readonly kind: "email_reply";
      readonly proposalId: string;
      readonly operation: "approve" | "reject" | "resolve" | "edit";
    }
  | {
      readonly kind: "email_operational";
      readonly proposalId: string;
      readonly operation: "approve" | "reject" | "edit" | "attest";
    };

/**
 * A scope represents the record or control-plane surface that may be changed
 * by one mutation. Different scopes may proceed concurrently.
 */
type MutationScope =
  | { readonly kind: "commerce" }
  | { readonly kind: "provider"; readonly provider: MutationProvider }
  | { readonly kind: "codex_connection" }
  | { readonly kind: "inference_selection" }
  | {
      readonly kind: "integration_account";
      readonly integrationAccountId: string;
    }
  | {
      readonly kind: "workspace_control";
      readonly control:
        "setup" | "readiness" | "activation" | "lifecycle" | "invite_member";
    }
  | { readonly kind: "invitation"; readonly invitationId: string }
  | { readonly kind: "member"; readonly userId: string }
  | { readonly kind: "commerce_action" }
  | { readonly kind: "agent_mailbox"; readonly integrationAccountId: string }
  | { readonly kind: "email_reply"; readonly proposalId: string }
  | { readonly kind: "email_operational"; readonly proposalId: string };

type MutationConflict = {
  readonly requested: OrganisationMutation;
  readonly active: OrganisationMutation;
  readonly scope: MutationScope;
};

type MutationAddResult =
  | {
      readonly kind: "added";
      readonly ledger: MutationLedger;
      readonly mutation: OrganisationMutation;
    }
  | {
      readonly kind: "duplicate";
      readonly ledger: MutationLedger;
      readonly requested: OrganisationMutation;
      readonly active: OrganisationMutation;
      readonly scope: MutationScope;
    }
  | {
      readonly kind: "conflict";
      readonly ledger: MutationLedger;
      readonly requested: OrganisationMutation;
      readonly active: OrganisationMutation;
      readonly scope: MutationScope;
    };

type MutationLedgerRecord = {
  readonly mutation: OrganisationMutation;
  readonly scope: MutationScope;
};

/**
 * Immutable in-flight mutation state suitable for React state. The private
 * constructor prevents callers from constructing a ledger that already has
 * duplicate or conflicting records.
 */
export class MutationLedger {
  private constructor(
    private readonly records: readonly MutationLedgerRecord[],
  ) {}

  static empty(): MutationLedger {
    return new MutationLedger([]);
  }

  get size(): number {
    return this.records.length;
  }

  /** Return a read-only snapshot for diagnostics or rendering. */
  toArray(): readonly OrganisationMutation[] {
    const mutations: OrganisationMutation[] = [];
    for (const record of this.records) mutations.push(record.mutation);
    return mutations;
  }

  isActive(mutation: OrganisationMutation): boolean {
    return findExactRecord(this.records, mutation) !== null;
  }

  /**
   * Return the active mutation occupying the requested scope. Exact matches
   * are included; callers that need to distinguish a duplicate should inspect
   * the result from add().
   */
  conflict(mutation: OrganisationMutation): MutationConflict | null {
    const requestedScope = mutationScope(mutation);
    for (const record of this.records) {
      if (scopesEqual(record.scope, requestedScope)) {
        return {
          requested: mutation,
          active: record.mutation,
          scope: record.scope,
        };
      }
    }
    return null;
  }

  add(mutation: OrganisationMutation): MutationAddResult {
    const exact = findExactRecord(this.records, mutation);
    if (exact !== null) {
      return {
        kind: "duplicate",
        ledger: this,
        requested: mutation,
        active: exact.mutation,
        scope: exact.scope,
      };
    }

    const conflict = this.conflict(mutation);
    if (conflict !== null) {
      return {
        kind: "conflict",
        ledger: this,
        requested: mutation,
        active: conflict.active,
        scope: conflict.scope,
      };
    }

    const scope = mutationScope(mutation);
    const records = [...this.records, { mutation, scope }];
    return {
      kind: "added",
      ledger: new MutationLedger(records),
      mutation,
    };
  }

  remove(mutation: OrganisationMutation): MutationLedger {
    const index = findExactRecordIndex(this.records, mutation);
    if (index === -1) return this;

    const records: MutationLedgerRecord[] = [];
    for (
      let currentIndex = 0;
      currentIndex < this.records.length;
      currentIndex += 1
    ) {
      const record = this.records[currentIndex];
      if (currentIndex !== index && record !== undefined) records.push(record);
    }
    return new MutationLedger(records);
  }
}

function mutationScope(mutation: OrganisationMutation): MutationScope {
  switch (mutation.kind) {
    case "select_commerce":
    case "provision_commerce":
    case "sync_commerce":
      return { kind: "commerce" };
    case "connect_provider":
      return { kind: "provider", provider: mutation.provider };
    case "codex_connection":
      return { kind: "codex_connection" };
    case "inference_selection":
      return { kind: "inference_selection" };
    case "integration_account":
      return {
        kind: "integration_account",
        integrationAccountId: mutation.integrationAccountId,
      };
    case "setup":
      return { kind: "workspace_control", control: "setup" };
    case "readiness":
      return { kind: "workspace_control", control: "readiness" };
    case "activation":
      return { kind: "workspace_control", control: "activation" };
    case "workspace_lifecycle":
      return { kind: "workspace_control", control: "lifecycle" };
    case "invite_member":
      return { kind: "workspace_control", control: "invite_member" };
    case "invitation":
      return { kind: "invitation", invitationId: mutation.invitationId };
    case "member":
      return { kind: "member", userId: mutation.userId };
    case "commerce_action":
      return { kind: "commerce_action" };
    case "agent_mailbox":
      return {
        kind: "agent_mailbox",
        integrationAccountId: mutation.integrationAccountId,
      };
    case "email_reply":
      return { kind: "email_reply", proposalId: mutation.proposalId };
    case "email_operational":
      return {
        kind: "email_operational",
        proposalId: mutation.proposalId,
      };
    default:
      return assertNever(mutation, "Unexpected mutation state");
  }
}

function findExactRecord(
  records: readonly MutationLedgerRecord[],
  mutation: OrganisationMutation,
): MutationLedgerRecord | null {
  for (const record of records) {
    if (sameOrganisationMutation(record.mutation, mutation)) return record;
  }
  return null;
}

function findExactRecordIndex(
  records: readonly MutationLedgerRecord[],
  mutation: OrganisationMutation,
): number {
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record !== undefined && sameOrganisationMutation(record.mutation, mutation))
      return index;
  }
  return -1;
}

export function sameOrganisationMutation(
  left: OrganisationMutation,
  right: OrganisationMutation,
): boolean {
  switch (left.kind) {
    case "select_commerce":
      return (
        right.kind === "select_commerce" &&
        left.integrationAccountId === right.integrationAccountId
      );
    case "provision_commerce":
      return right.kind === "provision_commerce";
    case "sync_commerce":
      return right.kind === "sync_commerce";
    case "connect_provider":
      return (
        right.kind === "connect_provider" && left.provider === right.provider
      );
    case "codex_connection":
      return right.kind === "codex_connection";
    case "inference_selection":
      return right.kind === "inference_selection";
    case "setup":
      return right.kind === "setup";
    case "readiness":
      return right.kind === "readiness";
    case "activation":
      return right.kind === "activation";
    case "integration_account":
      return (
        right.kind === "integration_account" &&
        left.integrationAccountId === right.integrationAccountId
      );
    case "workspace_lifecycle":
      return right.kind === "workspace_lifecycle";
    case "invite_member":
      return right.kind === "invite_member";
    case "invitation":
      return (
        right.kind === "invitation" && left.invitationId === right.invitationId
      );
    case "member":
      return (
        right.kind === "member" &&
        left.userId === right.userId
      );
    case "commerce_action":
      return (
        right.kind === "commerce_action" && left.operation === right.operation
      );
    case "agent_mailbox":
      return (
        right.kind === "agent_mailbox" &&
        left.integrationAccountId === right.integrationAccountId
      );
    case "email_reply":
      return (
        right.kind === "email_reply" &&
        left.proposalId === right.proposalId &&
        left.operation === right.operation
      );
    case "email_operational":
      return (
        right.kind === "email_operational" &&
        left.proposalId === right.proposalId &&
        left.operation === right.operation
      );
    default:
      return assertNever(left, "Unexpected mutation state");
  }
}

function scopesEqual(left: MutationScope, right: MutationScope): boolean {
  switch (left.kind) {
    case "commerce":
      return right.kind === "commerce";
    case "provider":
      return right.kind === "provider" && left.provider === right.provider;
    case "codex_connection":
      return right.kind === "codex_connection";
    case "inference_selection":
      return right.kind === "inference_selection";
    case "integration_account":
      return (
        right.kind === "integration_account" &&
        left.integrationAccountId === right.integrationAccountId
      );
    case "workspace_control":
      return (
        right.kind === "workspace_control" && left.control === right.control
      );
    case "invitation":
      return (
        right.kind === "invitation" && left.invitationId === right.invitationId
      );
    case "member":
      return (
        right.kind === "member" &&
        left.userId === right.userId
      );
    case "commerce_action":
      return right.kind === "commerce_action";
    case "agent_mailbox":
      return (
        right.kind === "agent_mailbox" &&
        left.integrationAccountId === right.integrationAccountId
      );
    case "email_reply":
      return (
        right.kind === "email_reply" && left.proposalId === right.proposalId
      );
    case "email_operational":
      return (
        right.kind === "email_operational" &&
        left.proposalId === right.proposalId
      );
    default:
      return assertNever(left, "Unexpected mutation state");
  }
}

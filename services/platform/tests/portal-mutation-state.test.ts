import { describe, expect, it } from "vitest";

import {
  MutationLedger,
  type OrganisationMutation,
} from "../../../apps/portal/src/mutation-state";

describe("Café scoped mutation ledger", () => {
  it("allows independent scopes while rejecting duplicate and conflicting work", () => {
    const initial = MutationLedger.empty();
    const commerce = add(initial, { kind: "sync_commerce" });
    const member = add(commerce, {
      kind: "member",
      userId: "user_a91164e9-f505-553f-b3c3-5609e35ba3b1",
    });

    expect(member.size).toBe(2);
    expect(member.isActive({ kind: "sync_commerce" })).toBe(true);
    expect(
      member.isActive({ kind: "member", userId: "user_a91164e9-f505-553f-b3c3-5609e35ba3b1" }),
    ).toBe(true);

    const duplicate = member.add({ kind: "sync_commerce" });
    expect(duplicate.kind).toBe("duplicate");
    if (duplicate.kind === "duplicate") {
      expect(duplicate.active).toEqual({ kind: "sync_commerce" });
      expect(duplicate.ledger).toBe(member);
    }

    const conflict = member.add({ kind: "provision_commerce" });
    expect(conflict.kind).toBe("conflict");
    if (conflict.kind === "conflict") {
      expect(conflict.active).toEqual({ kind: "sync_commerce" });
      expect(conflict.scope).toEqual({ kind: "commerce" });
      expect(conflict.ledger).toBe(member);
    }
  });

  it("keeps record-level operations independent inside a shared resource family", () => {
    const first = add(MutationLedger.empty(), {
      kind: "integration_account",
      integrationAccountId: "account-1",
    });
    const second = first.add({
      kind: "integration_account",
      integrationAccountId: "account-2",
    });

    expect(second.kind).toBe("added");
    if (second.kind === "added") {
      expect(second.ledger.size).toBe(2);
      expect(
        second.ledger.isActive({
          kind: "integration_account",
          integrationAccountId: "account-1",
        }),
      ).toBe(true);
      expect(
        second.ledger.isActive({
          kind: "integration_account",
          integrationAccountId: "account-2",
        }),
      ).toBe(true);
    }
  });

  it("removes one exact mutation without mutating the prior React state value", () => {
    const active = add(MutationLedger.empty(), {
      kind: "invitation",
      invitationId: "invite-1",
    });
    const unchanged = active.remove({
      kind: "member",
      userId: "user_a91164e9-f505-553f-b3c3-5609e35ba3b1",
    });
    const cleared = active.remove({
      kind: "invitation",
      invitationId: "invite-1",
    });

    expect(unchanged).toBe(active);
    expect(active.size).toBe(1);
    expect(cleared).not.toBe(active);
    expect(cleared.size).toBe(0);
    expect(
      active.isActive({ kind: "invitation", invitationId: "invite-1" }),
    ).toBe(true);
    expect(
      cleared.isActive({ kind: "invitation", invitationId: "invite-1" }),
    ).toBe(false);
  });

  it("keeps independent workspace controls available", () => {
    const savingSetup = add(MutationLedger.empty(), { kind: "setup" });
    const evaluatingReadiness = savingSetup.add({ kind: "readiness" });

    expect(evaluatingReadiness.kind).toBe("added");
    expect(evaluatingReadiness.ledger.size).toBe(2);
    expect(savingSetup.conflict({ kind: "activation" })).toBeNull();
  });
});

function add(ledger: MutationLedger, mutation: OrganisationMutation): MutationLedger {
  const result = ledger.add(mutation);
  if (result.kind !== "added")
    throw new Error(`Expected mutation to be added, received ${result.kind}`);
  return result.ledger;
}

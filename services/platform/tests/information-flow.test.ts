import { organisationAuthzFromPolicy } from "../src/policy/information-flow";
import { defaultDenyPolicy } from "../src/policy-snapshot";
import type { RequestAuthority } from "@seams/contracts";
import { describe, expect, it } from "vitest";

import {
  advanceInformationFlowContext,
  audiencesForDestination,
  decideAutomaticContextAdmission,
  decideContextAdmission,
  decideFlowSink,
  evaluateFlowLabelSink,
  FlowBinding,
  FlowLabel,
  flowBindingForContext,
  InformationFlowContext,
  joinFlowLabels,
  ObservationEvidence,
} from "../src/policy";
import type { Variant } from "@seams/type-utils";

const directAuthority: Variant<RequestAuthority, "direct_conversation"> = {
  kind: "direct_conversation",
  organisationId: "organisation_ifc",
  requesterPersonId: "person_ifc",
  membershipRevision: 1,
  role: "operator",
  connectorId: "connector_ifc",
  integrationAccountId: "account_ifc",
  conversationId: "dm_ifc",
};

const sharedAuthority: Variant<RequestAuthority, "shared_conversation"> = {
  kind: "shared_conversation",
  organisationId: "organisation_ifc",
  requesterPersonId: "person_ifc",
  membershipRevision: 1,
  role: "operator",
  connectorId: "connector_ifc",
  integrationAccountId: "account_ifc",
  conversationId: "channel_ifc",
};

const workflowAuthority: Variant<RequestAuthority, "workflow"> = {
  kind: "workflow",
  organisationId: "organisation_ifc",
  workflowId: "cue_ifc",
  workflowRevision: 1,
};

/** The organisation's current policy, with no capability rules. */
const NO_ORGANISATION_RULES = organisationAuthzFromPolicy(
  defaultDenyPolicy({ now: 0 }),
);

/** The organisation's current policy, which sends refunds for approval. */
const REFUND_APPROVAL_RULES = organisationAuthzFromPolicy({
  ...defaultDenyPolicy({ now: 0 }),
  authz: {
    ...defaultDenyPolicy({ now: 0 }).authz,
    approvalRequired: ["stripe.refund.create"],
  },
});

describe("agent information-flow control", () => {
  it("admits person-visible context for a direct conversation and denies a shared destination", async () => {
    const label = await personLabel();
    const admission = await decideContextAdmission({
      subject: {
        kind: "authority_derived",
        requestAuthority: directAuthority,
        caseId: "case_ifc",
      },
      inputLabel: label,
    });
    expect(admission.kind).toBe("admit");

    const context = await observedContext(label);
    const direct = await decideFlowSink({
      organisationAuthz: NO_ORGANISATION_RULES,
      binding: flowBindingForContext(context, "turn_ifc"),
      sink: {
        kind: "conversation_delivery",
        destinationAuthority: directAuthority,
      },
    });
    const shared = await decideFlowSink({
      organisationAuthz: NO_ORGANISATION_RULES,
      binding: flowBindingForContext(context, "turn_ifc"),
      sink: {
        kind: "conversation_delivery",
        destinationAuthority: sharedAuthority,
      },
    });
    expect(direct.kind).toBe("allow");
    expect(shared.kind).toBe("deny");
  });

  it("does not derive a requester role audience for a shared conversation", () => {
    expect(audiencesForDestination(sharedAuthority)).toEqual([
      {
        kind: "conversation",
        integrationAccountId: "account_ifc",
        conversationId: "channel_ifc",
      },
    ]);
  });

  it("allows an exact workflow reader to reach its trusted delivery adapter", async () => {
    const label = await FlowLabel.create([
      {
        owner: { kind: "organisation", organisationId: "organisation_ifc" },
        readers: [
          {
            kind: "workflow",
            workflowKind: "cue_subscription",
            workflowId: "cue_ifc",
            workflowRevision: 1,
          },
        ],
      },
    ]);
    expect(label.ok).toBe(true);
    if (!label.ok) return;
    const context = await observedContext(label.value);
    const decision = await decideFlowSink({
      organisationAuthz: NO_ORGANISATION_RULES,
      binding: flowBindingForContext(context, "turn_ifc_workflow"),
      sink: {
        kind: "conversation_delivery",
        destinationAuthority: workflowAuthority,
      },
    });
    expect(decision.kind).toBe("allow");
  });

  it("keeps a person-only label out of a channel's automatic context", async () => {
    const label = await personLabel();
    const admission = await decideAutomaticContextAdmission({
      subject: {
        kind: "authority_derived",
        requestAuthority: sharedAuthority,
        caseId: "case_ifc",
      },
      inputLabel: label,
      recipient: null,
    });
    expect(admission.kind).toBe("deny");
  });

  it("evaluates the paired provider effect as a labelled sink", async () => {
    const label = await FlowLabel.create([
      {
        owner: {
          kind: "integration_resource",
          organisationId: "organisation_ifc",
          integrationAccountId: "account_ifc",
          resourceScope: "commerce:orders",
        },
        readers: [{ kind: "person", personId: "person_ifc" }],
      },
    ]);
    expect(label.ok).toBe(true);
    if (!label.ok) return;
    const context = await observedContext(label.value);
    const decision = await decideFlowSink({
      organisationAuthz: NO_ORGANISATION_RULES,
      binding: flowBindingForContext(context, "turn_ifc"),
      sink: {
        kind: "tool_effect",
        destinationAuthority: directAuthority,
        capabilityId: "commerce.action.propose",
        integrationAccountId: "account_ifc",
        resourceScope: "commerce:orders",
        approvalSatisfied: true,
      },
    });
    expect(decision.kind).toBe("allow");
    if (decision.kind === "allow") {
      expect(decision.flowBindingDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect(decision.decisionDigest).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("keeps pure label decisions identical to runtime sink decisions", async () => {
    const label = await FlowLabel.create([
      {
        owner: { kind: "organisation", organisationId: "organisation_ifc" },
        readers: [{ kind: "person", personId: "person_ifc" }],
      },
    ]);
    expect(label.ok).toBe(true);
    if (!label.ok) return;
    const context = await observedContext(label.value);
    const binding = flowBindingForContext(context, "turn_ifc_pure");
    const approvalSink = {
      kind: "tool_effect" as const,
      destinationAuthority: directAuthority,
      capabilityId: "stripe.refund.create",
      integrationAccountId: "account_ifc",
      resourceScope: "refund:refund_ifc",
      approvalSatisfied: false,
    };
    const pureApproval = evaluateFlowLabelSink({
      organisationAuthz: REFUND_APPROVAL_RULES,
      flowLabel: label.value,
      sink: approvalSink,
    });
    const runtimeApproval = await decideFlowSink({
      organisationAuthz: REFUND_APPROVAL_RULES,
      binding,
      sink: approvalSink,
    });
    expect(pureApproval.kind).toBe("approval_required");
    expect(decisionProjection(runtimeApproval)).toEqual(
      decisionProjection(pureApproval),
    );

    const approvedSink = { ...approvalSink, approvalSatisfied: true };
    const pureAllow = evaluateFlowLabelSink({
      organisationAuthz: REFUND_APPROVAL_RULES,
      flowLabel: label.value,
      sink: approvedSink,
    });
    const runtimeAllow = await decideFlowSink({
      binding,
      sink: approvedSink,
      organisationAuthz: REFUND_APPROVAL_RULES,
    });
    expect(decisionProjection(runtimeAllow)).toEqual(
      decisionProjection(pureAllow),
    );

    const sharedSink = {
      kind: "conversation_delivery" as const,
      destinationAuthority: sharedAuthority,
    };
    const pureDeny = evaluateFlowLabelSink({
      organisationAuthz: NO_ORGANISATION_RULES,
      flowLabel: label.value,
      sink: sharedSink,
    });
    const runtimeDeny = await decideFlowSink({
      binding,
      sink: sharedSink,
      organisationAuthz: NO_ORGANISATION_RULES,
    });
    expect(decisionProjection(runtimeDeny)).toEqual(
      decisionProjection(pureDeny),
    );
  });

  it("joins labels associatively, commutatively, and idempotently", async () => {
    const person = await personLabel();
    const conversation = await conversationLabel();
    const left = await joinFlowLabels(person, conversation);
    const right = await joinFlowLabels(conversation, person);
    const duplicate = await joinFlowLabels(person, person);
    expect(left.ok && right.ok ? left.value.digest : null).toBe(
      right.ok ? right.value.digest : null,
    );
    expect(duplicate.ok ? duplicate.value.digest : null).toBe(person.digest);
  });

  it("restores opaque labels, contexts, evidence, and bindings with exact digests", async () => {
    const label = await personLabel();
    const context = await observedContext(label);
    const restoredLabel = await FlowLabel.restore(
      JSON.parse(JSON.stringify(label)),
    );
    const restoredContext = await InformationFlowContext.restore(
      JSON.parse(JSON.stringify(context)),
    );
    const restoredBinding = await flowBindingRestore(context);
    expect(restoredLabel.ok ? restoredLabel.value.digest : null).toBe(
      label.digest,
    );
    expect(restoredContext.ok ? restoredContext.value.digest : null).toBe(
      context.digest,
    );
    expect(restoredBinding).toBe(
      flowBindingForContext(context, "turn_ifc").informationFlowContextDigest,
    );
  });

  it("refuses a stored policy that holds more than an owner and readers", async () => {
    const label = await personLabel();
    const stored = JSON.parse(JSON.stringify(label));
    stored.policies[0].restrictions = [];
    expect(await FlowLabel.restore(stored)).toEqual({
      ok: false,
      error: { code: "invalid_flow_label", field: "policies" },
    });
  });

  it("keeps label and evidence digests stable across input ordering", async () => {
    const first = await FlowLabel.create([
      {
        owner: { kind: "organisation", organisationId: "organisation_ifc" },
        readers: [
          { kind: "person", personId: "person_ifc" },
          { kind: "organisation_role", role: "operator" },
        ],
      },
    ]);
    const second = await FlowLabel.create([
      {
        owner: { kind: "organisation", organisationId: "organisation_ifc" },
        readers: [
          { kind: "organisation_role", role: "operator" },
          { kind: "person", personId: "person_ifc" },
        ],
      },
    ]);
    expect(first.ok && second.ok ? first.value.digest : null).toBe(
      second.ok ? second.value.digest : null,
    );

    if (!first.ok) return;
    const evidenceA = await ObservationEvidence.create({
      source: {
        kind: "case_entry",
        caseId: " case_ifc ",
        entryId: " entry_ifc ",
      },
      sourceRevision: 1,
      contentDigest: "b".repeat(64),
      inputLabel: first.value,
      observedAt: 2,
    });
    const evidenceB = await ObservationEvidence.create({
      source: { kind: "case_entry", caseId: "case_ifc", entryId: "entry_ifc" },
      sourceRevision: 1,
      contentDigest: "b".repeat(64),
      inputLabel: first.value,
      observedAt: 1,
    });
    expect(
      evidenceA.ok && evidenceB.ok ? evidenceA.value.evidenceDigest : null,
    ).toBe(evidenceB.ok ? evidenceB.value.evidenceDigest : null);
  });

  it("round-trips readers with delimiter-bearing identifiers", async () => {
    const label = await FlowLabel.create([
      {
        owner: { kind: "organisation", organisationId: "organisation_ifc" },
        readers: [{ kind: "person", personId: "person:ifc" }],
      },
    ]);
    expect(label.ok).toBe(true);
    if (!label.ok) return;
    const serialized = JSON.parse(JSON.stringify(label.value));
    expect(serialized.policies[0].readers[0]).toEqual({
      kind: "person",
      personId: "person:ifc",
    });
    const restored = await FlowLabel.restore(serialized);
    expect(restored.ok ? restored.value.digest : null).toBe(label.value.digest);
  });
});

async function flowBindingRestore(
  context: InformationFlowContext,
): Promise<string | null> {
  const binding = flowBindingForContext(context, "turn_ifc");
  const restored = await FlowBinding.restore(
    JSON.parse(JSON.stringify(binding)),
  );
  return restored.ok ? restored.value.informationFlowContextDigest : null;
}

function decisionProjection(
  decision: Readonly<{
    readonly kind: "allow" | "approval_required" | "deny";
    readonly reason?: Readonly<{
      readonly code: string;
      readonly ruleId: string | null;
      readonly reasonCode: string;
    }>;
  }>,
): Readonly<{ readonly kind: string; readonly reason: unknown }> {
  return {
    kind: decision.kind,
    reason: decision.reason ?? null,
  };
}

async function observedContext(
  label: FlowLabel,
): Promise<InformationFlowContext> {
  const initial = await InformationFlowContext.create({
    organisationId: "organisation_ifc",
    sessionId: "session_ifc",
    authorityPartitionDigest: "a".repeat(64),
  });
  if (!initial.ok) throw new Error(initial.error.code);
  const evidence = await ObservationEvidence.create({
    source: { kind: "case_entry", caseId: "case_ifc", entryId: "entry_ifc" },
    sourceRevision: 1,
    contentDigest: "b".repeat(64),
    inputLabel: label,
    observedAt: 1,
  });
  if (!evidence.ok) throw new Error(evidence.error.code);
  const advanced = await advanceInformationFlowContext({
    context: initial.value,
    observation: evidence.value,
    inputLabel: label,
  });
  if (!advanced.ok) throw new Error(advanced.error.code);
  return advanced.value.context;
}

async function personLabel(): Promise<FlowLabel> {
  const label = await FlowLabel.create([
    {
      owner: { kind: "organisation", organisationId: "organisation_ifc" },
      readers: [{ kind: "person", personId: "person_ifc" }],
    },
  ]);
  if (!label.ok) throw new Error(label.error.code);
  return label.value;
}

async function conversationLabel(): Promise<FlowLabel> {
  const label = await FlowLabel.create([
    {
      owner: { kind: "organisation", organisationId: "organisation_ifc" },
      readers: [
        {
          kind: "conversation",
          integrationAccountId: "account_ifc",
          conversationId: "channel_ifc",
        },
      ],
    },
  ]);
  if (!label.ok) throw new Error(label.error.code);
  return label.value;
}

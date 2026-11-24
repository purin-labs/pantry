import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { Env } from "@purin-labs/kernel/env";
import type { ControlSessionId, OrganisationId } from "@purin-labs/kernel/ids";
import type { ControlRole } from "@purin-labs/tenancy/data/control-plane";
import type {
  AgentOperationInput,
  AgentOperationsSnapshot,
} from "@purin-labs/agent/data/agent-operations";
import type { BakeStockLevelInput } from "@purin-labs/area-kitchen/server/agent-tools/kitchen/services";
import type { WorkflowChangeCommand } from "@purin-labs/area-kitchen/server/contract/workflow-changes";
import type {
  JevDraftCommand,
  JevDraftRefusal,
} from "@purin-labs/area-integrations/server/contract/jev-draft";
import type { OfferPriceAllowanceCommand } from "@purin-labs/area-commerce/server/contract/offer-price-allowance";

// The configuration drafts that an operator or the chat agent asks for and a
// person confirms, as the Organisation services name them. A part of the
// Organisation contract.

export type OperatorConfigurationDraftState =
  "pending" | "confirmed" | "settled" | "cancelled" | "expired";

/**
 * A configuration change an operator asked for, stored before it is shown.
 *
 * Slack has no durable form state, so a preview an operator confirms minutes
 * later must be recoverable from something other than the message. The draft
 * is that record: it holds the exact normalized command, who may confirm it,
 * and the digest confirmation is bound to.
 *
 * This is a distinct origin from an agent suggesting a change to itself.
 * Only a direct operator request creates one.
 */
export type OperatorConfigurationDraft = Readonly<{
  draftId: string;
  organisationId: OrganisationId;
  /** The Case the request arrived in, which scopes confirmation. */
  caseId: string;
  /** The control identity linked to the verified Slack account. */
  actorUserId: string;
  actorPersonId: string;
  /** The typed command, exactly as it will be applied. */
  command: OperatorDraftCommand;
  /** Confirmation must present this digest, so the text cannot drift. */
  commandDigest: string;
  /** One stable identity for the mutation, reused across retries. */
  mutationId: string;
  state: OperatorConfigurationDraftState;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  /** The outcome of applying it, so a lost response can be read back. */
  receiptCode: string | null;
}>;

/**
 * What one draft can carry.
 *
 * Agent configuration and a price allowance are different kinds of state with
 * different owners — one is D1, the other Commerce — so they keep separate
 * typed boundaries rather than being forced into one union. The draft carries
 * either, because the thing a draft models is "a change an operator asked for
 * and must confirm", which is true of both.
 */
export type OperatorDraftCommand =
  | Readonly<{ family: "agent_operation"; operation: AgentOperationInput }>
  | Readonly<{
      family: "offer_price_allowance";
      allowance: OfferPriceAllowanceCommand;
    }>
  | Readonly<{ family: "device_command"; command: DeviceDraftCommand }>
  | Readonly<{ family: "workflow_change"; change: WorkflowChangeCommand }>
  /** A Jev switch that the chat agent proposed (Plan 88). */
  | Readonly<{ family: "jev_feature"; command: JevDraftCommand }>
  /** A bake stock level that the chat agent proposed (Plan 24 S1). */
  | Readonly<{ family: "bake_stock_level"; level: BakeStockLevelInput }>;

/** A change to a shop device that an agent proposed and a person confirms. */
export type DeviceDraftCommand =
  | Readonly<{
      kind: "device_restrict";
      deviceId: string;
      deviceName: string;
      reason: string;
    }>
  | Readonly<{
      kind: "device_resume";
      deviceId: string;
      deviceName: string;
    }>;

export type OperatorDraftError =
  | Readonly<{ code: "operator_draft_authority_inactive" }>
  | Readonly<{ code: "operator_draft_invalid"; field: string }>
  | Readonly<{ code: "operator_draft_not_found" }>
  | Readonly<{ code: "operator_draft_expired" }>
  | Readonly<{
      code: "operator_draft_not_pending";
      state: OperatorConfigurationDraftState;
    }>
  | Readonly<{ code: "operator_draft_actor_mismatch" }>
  | Readonly<{ code: "operator_draft_digest_mismatch" }>
  | Readonly<{ code: "operator_draft_persistence_failed" }>
  /** The applied recipe moved after the proposal read it. */
  | Readonly<{ code: "workflow_revision_conflict" }>
  /** A person changed the same steps in the shared draft. */
  | Readonly<{ code: "workflow_human_intervention" }>
  /** A proposal needs a signed-in person, because it writes to the shared draft. */
  | Readonly<{ code: "workflow_approver_required" }>
  /** A Jev switch that could not turn on, in the words of Settings › Jev. */
  | JevDraftRefusal
  /** A bake stock level that the Bakes page would refuse too. */
  | Readonly<{
      code: "bake_level_invalid" | "bake_recipe_missing" | "bake_level_stale";
    }>;

export type ConfirmOperatorDraftInput = Readonly<{
  db: OrganisationDatabase;
  /**
   * Needed because carrying out a command may reach past D1 — opening a Case
   * for a manual run, or resolving published-resource evidence.
   */
  env: Env;
  organisationId: OrganisationId;
  draftId: string;
  /** The Portal session that confirms. A recipe change writes to a shared draft with it. */
  controlSessionId?: ControlSessionId;
  /** Who is confirming, resolved from the verified account, not the message. */
  actorUserId: string;
  /**
   * The confirmer's current role, read fresh for this message. A manual run
   * opens a Case under this authority, so it must be the role they hold now,
   * never one assumed for them.
   */
  actorRole: ControlRole;
  /**
   * The short code the preview displayed and the operator repeated back.
   *
   * Checked against the stored draft's own code, so a reply written for an
   * earlier preview cannot accept the change that replaced it.
   */
  previewCode: string;
  now: number;
}>;

export type OperatorDraftReceipt = Readonly<{
  draft: OperatorConfigurationDraft;
  snapshot: AgentOperationsSnapshot;
}>;

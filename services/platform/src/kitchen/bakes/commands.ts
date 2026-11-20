import { machineTransition } from "@purin-labs/std/state-machine";
import type { Variant } from "@purin-labs/type-utils";
import { deriveStableCaseId } from "../../case-identity";
import { readAppliedWorkflowHead } from "../../commerce/bakery/workflow-revisions";
import type { OrganisationDatabase } from "../../database-handles";
import type { OrganisationId } from "../../ids";
import type { Result } from "../../result";
import { BAKE_PROPOSAL_MACHINE } from "./bake-proposal.machine";
import type { BakeRunError, RunActor } from "./run";
import { bakeRunIdOf, readBakeRun, writeBakeRunCheck } from "./run-records";
import { startProposalRun, type BakeRunLaunchPorts } from "./run-start";
import {
  insertBakeProposal,
  openWaitingBakeProposal,
  readBakeProposal,
  readBakeStockLevel,
  readBakeStockLevelsOf,
  readProductProposals,
  writeBakeDecision,
  writeBakeEnd,
  type BakeDecidedVia,
  type BakeDeciderRole,
  type BakeProposal,
  type BakeStockLevel,
} from "./records";

/**
 * The bake proposals of Plan 24 S1. Every change of a proposal goes through
 * `runBakeCommand`: the Organisation Actor runs it for a commerce delivery,
 * for the Portal, for Slack and for the agent, so the policy check of a
 * decision is the same everywhere. The ports give what Kitchen does not own:
 * the oven (Plan 85), the counter stock (Commerce) and the Case with its Slack
 * card.
 */

type BakeOven = Readonly<{ deviceId: string; name: string }>;

type CounterStock = Readonly<{ locationId: string; pieces: number }>;

/** One applied change of a product's counter stock, in pieces. */
export type CounterStockChange = Readonly<{
  inventoryItemId: string;
  locationId: string;
  beforePieces: number | null;
  afterPieces: number;
}>;

export type BakeKitchenPorts = Readonly<{
  /** The active enrolled device with the `bake` capability at the location. */
  findOven(kitchenLocation: string): Promise<BakeOven | null>;
  counterStock(inventoryItemId: string): Promise<CounterStock | null>;
  /**
   * Opens the proposal's Case and posts its Slack card, or updates the card
   * after a decision or an end. It never fails its caller: a proposal stays
   * on the Bakes page when Slack is not there.
   */
  announce(proposal: BakeProposal): Promise<void>;
  /** The devices and the run's Durable Object, for an approved run. */
  launchRun: BakeRunLaunchPorts;
  /** A pause, resume, stop or settle of a started run's Durable Object. */
  controlRun(
    runId: string,
    action: BakeRunAction,
    actor: RunActor,
  ): Promise<Result<null, BakeRunError>>;
  /**
   * Raises the counter stock by the checked pieces through the commerce
   * authority, once for each key, and returns its receipt.
   */
  raiseCounterStock(
    proposal: BakeProposal,
    input: Readonly<{ pieces: number; key: string; checkedBy: string }>,
  ): Promise<Result<Readonly<{ receiptId: string }>, BakeCommandError>>;
}>;

export type BakeRunAction =
  | Readonly<{ kind: "pause" | "resume" | "stop" }>
  | Readonly<{ kind: "settle"; decision: "continue" | "stop" }>;

export type BakeMemberRole = BakeDeciderRole | "viewer";

type BakeDecider = Readonly<{
  userId: string;
  role: BakeMemberRole;
  via: BakeDecidedVia;
}>;

export type BakeCommand =
  | Readonly<{
      kind: "stock_changes";
      changes: readonly CounterStockChange[];
    }>
  | Readonly<{
      /** The Portal chat agent proposes a bake for the person who asked. */
      kind: "propose";
      inventoryItemId: string;
      pieces: number | null;
      requester: Readonly<{ userId: string; role: BakeMemberRole }>;
    }>
  | Readonly<{
      kind: "decide";
      proposalId: string;
      /** The Case of the card's thread, for a decision from a Slack card. */
      caseId?: string;
      decision: "approve" | "reject";
      reason: string | null;
      decider: BakeDecider;
    }>
  | Readonly<{
      /** The bake run of an approved proposal ended (Plan 24 S4). */
      kind: "end";
      proposalId: string;
      reason: string;
    }>
  | Readonly<{
      /** Starts the run of an approved proposal again, with its approval. */
      kind: "start_run";
      proposalId: string;
      requester: Readonly<{ userId: string; role: BakeMemberRole }>;
    }>
  | Readonly<{
      /** A pause from a person or from the agent for the person who asked. */
      kind: "run_action";
      proposalId: string;
      action: BakeRunAction;
      requester: Readonly<{
        userId: string;
        role: BakeMemberRole;
        via: "person" | "agent";
      }>;
    }>
  | Readonly<{
      /** The check of the released pieces, which raises the counter stock. */
      kind: "check_run";
      proposalId: string;
      goodPieces: number;
      checker: Readonly<{ userId: string; role: BakeMemberRole }>;
    }>;

export type BakeCommandError = Readonly<{
  code:
    | "bake_level_missing"
    | "bake_recipe_missing"
    | "bake_quantity_required"
    | "bake_quantity_invalid"
    | "bake_proposal_taken"
    | "bake_proposal_missing"
    | "bake_proposal_waiting"
    | "bake_proposal_not_approved"
    | "bake_role_insufficient"
    | "bake_reason_required"
    | "bake_oven_missing"
    | "bake_run_missing"
    | "bake_run_not_completed"
    | "bake_run_refused"
    | "bake_run_shadow"
    | "bake_stock_unavailable";
  message: string;
}>;

export type BakeCommandOutcome =
  | Readonly<{ kind: "checked"; opened: readonly BakeProposal[] }>
  | Readonly<{ kind: "proposed"; proposal: BakeProposal }>
  | Readonly<{
      kind: "decided" | "ended";
      proposal: BakeProposal;
      opened: BakeProposal | null;
    }>
  /** A run action or a start was accepted; read the run for its state. */
  | Readonly<{ kind: "run"; proposal: BakeProposal }>
  | Readonly<{
      kind: "run_checked";
      proposal: BakeProposal;
      receiptId: string;
      goodPieces: number;
    }>
  /** The proposal was decided or ended before: nothing changed. */
  | Readonly<{ kind: "unchanged"; proposal: BakeProposal }>;

const MAX_PIECES = 10_000;
const REASON_LIMIT = 500;

function refuse(
  code: BakeCommandError["code"],
  message: string,
): Result<never, BakeCommandError> {
  return { ok: false, error: { code, message } };
}

export function mayDecideBakes(role: BakeMemberRole): role is BakeDeciderRole {
  return role === "owner" || role === "admin" || role === "operator";
}

/** The shortfall, rounded up to whole mould groups. */
function bakeQuantity(
  pieces: number,
  piecesPerGroup: number,
): Readonly<{ quantityPieces: number; mouldGroups: number }> {
  const mouldGroups = Math.max(1, Math.ceil(pieces / piecesPerGroup));
  return { quantityPieces: mouldGroups * piecesPerGroup, mouldGroups };
}

function randomProposalId(): string {
  return `bake_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export async function runBakeCommand(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: BakeCommand,
  ports: BakeKitchenPorts,
  now: number,
): Promise<Result<BakeCommandOutcome, BakeCommandError>> {
  switch (command.kind) {
    case "stock_changes":
      return {
        ok: true,
        value: {
          kind: "checked",
          opened: await checkCounterStock(
            db,
            organisationId,
            command.changes,
            ports,
            now,
          ),
        },
      };
    case "propose":
      return proposeBake(db, organisationId, command, ports, now);
    case "decide":
      return decideBakeProposal(db, organisationId, command, ports, now);
    case "end":
      return endBakeProposal(
        db,
        organisationId,
        command.proposalId,
        command.reason,
        ports,
        now,
      );
    case "start_run":
      return restartBakeRun(db, organisationId, command, ports, now);
    case "run_action":
      return controlBakeRun(db, organisationId, command, ports);
    case "check_run":
      return checkBakeRun(db, organisationId, command, ports, now);
  }
}

/**
 * The first fall of a product's counter stock below its level opens one
 * proposal. Later sales below the level cross nothing, so they open none. A
 * fall while the product has an active proposal makes one that waits.
 */
async function checkCounterStock(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  changes: readonly CounterStockChange[],
  ports: BakeKitchenPorts,
  now: number,
): Promise<readonly BakeProposal[]> {
  if (changes.length === 0) return [];
  const levels = await readBakeStockLevelsOf(
    db,
    organisationId,
    changes.map((change) => change.inventoryItemId),
  );
  const opened: BakeProposal[] = [];
  for (const level of levels) {
    const crossing = changes.find(
      (change) =>
        change.inventoryItemId === level.inventoryItemId &&
        change.beforePieces !== null &&
        change.beforePieces >= level.levelPieces &&
        change.afterPieces < level.levelPieces,
    );
    if (crossing === undefined) continue;
    // A waiting proposal whose predecessor ended without opening it (a lost
    // reply) answers this fall.
    const reopened = await openWaiting(
      db,
      organisationId,
      level.inventoryItemId,
      ports,
      now,
    );
    if (reopened !== null) {
      opened.push(reopened);
      continue;
    }
    const draft = await proposalDraft(db, organisationId, level, ports, {
      origin: "stock",
      pieces: level.levelPieces - crossing.afterPieces,
      stock: { locationId: crossing.locationId, pieces: crossing.afterPieces },
      proposedBy: "platform",
      now,
    });
    // A level whose recipe has no applied revision proposes nothing; the
    // Bakes page shows the level's missing recipe.
    if (!draft.ok) continue;
    const proposal = await insertBakeProposal(db, organisationId, draft.value);
    if (proposal?.state !== "open") continue;
    await ports.announce(proposal);
    opened.push(proposal);
  }
  return opened;
}

async function proposalDraft(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  level: BakeStockLevel,
  ports: BakeKitchenPorts,
  input: Readonly<{
    origin: "stock" | "agent";
    pieces: number;
    stock: CounterStock | null;
    proposedBy: string;
    now: number;
  }>,
): Promise<Result<Parameters<typeof insertBakeProposal>[2], BakeCommandError>> {
  const recipe = await readAppliedWorkflowHead(
    db,
    organisationId,
    level.workflowId,
  );
  if (recipe === null)
    return refuse(
      "bake_recipe_missing",
      `The recipe workflow ${level.workflowId} has no applied revision. Apply it in Kitchen first.`,
    );
  const proposalId = randomProposalId();
  const caseId = await deriveStableCaseId(
    `${organisationId}:bake_proposal:${proposalId}`,
  );
  if (caseId === null) throw new Error("A bake proposal has no Case id.");
  return {
    ok: true,
    value: {
      proposalId,
      inventoryItemId: level.inventoryItemId,
      productName: level.productName,
      origin: input.origin,
      caseId: caseId.caseId,
      workflowId: level.workflowId,
      workflowRevision: recipe.revision,
      workflowDigest: recipe.digest,
      ...bakeQuantity(input.pieces, level.piecesPerGroup),
      piecesPerGroup: level.piecesPerGroup,
      kitchenLocation: level.kitchenLocation,
      oven: await ports.findOven(level.kitchenLocation),
      stockLocationId: input.stock?.locationId ?? null,
      stockAvailable: Math.max(0, input.stock?.pieces ?? 0),
      stockLevel: level.levelPieces,
      proposedBy: input.proposedBy,
      proposedAt: input.now,
    },
  };
}

async function proposeBake(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<BakeCommand, "propose">,
  ports: BakeKitchenPorts,
  now: number,
): Promise<Result<BakeCommandOutcome, BakeCommandError>> {
  if (!mayDecideBakes(command.requester.role))
    return refuse(
      "bake_role_insufficient",
      "Only an operator, an admin or the owner may ask for a bake.",
    );
  const level = await readBakeStockLevel(
    db,
    organisationId,
    command.inventoryItemId,
  );
  if (level === null)
    return refuse(
      "bake_level_missing",
      "This product has no stock level. An admin sets one on the Bakes page.",
    );
  const stock = await ports.counterStock(level.inventoryItemId);
  const pieces =
    command.pieces ??
    (stock === null ? null : level.levelPieces - stock.pieces);
  if (pieces === null || pieces <= 0)
    return refuse(
      "bake_quantity_required",
      `The counter stock is at or above its level of ${level.levelPieces}. Give the number of pieces to bake.`,
    );
  if (!Number.isInteger(pieces) || pieces > MAX_PIECES)
    return refuse(
      "bake_quantity_invalid",
      `Give a whole number of pieces from 1 to ${MAX_PIECES}.`,
    );
  const draft = await proposalDraft(db, organisationId, level, ports, {
    origin: "agent",
    pieces,
    stock,
    proposedBy: command.requester.userId,
    now,
  });
  if (!draft.ok) return draft;
  const proposal = await insertBakeProposal(db, organisationId, draft.value);
  if (proposal === null)
    return refuse(
      "bake_proposal_taken",
      "This product already has an active proposal and one that waits. Nothing was stored.",
    );
  if (proposal.state === "open") await ports.announce(proposal);
  return { ok: true, value: { kind: "proposed", proposal } };
}

/**
 * The one decision of a bake proposal, for the Portal and for Slack. The
 * decider needs the operator role or a higher one. An approval needs an oven,
 * and a rejection keeps its reason. A second decision changes nothing.
 */
async function decideBakeProposal(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<BakeCommand, "decide">,
  ports: BakeKitchenPorts,
  now: number,
): Promise<Result<BakeCommandOutcome, BakeCommandError>> {
  const proposal = await readBakeProposal(
    db,
    organisationId,
    command.proposalId,
  );
  if (
    proposal === null ||
    (command.caseId !== undefined && command.caseId !== proposal.caseId)
  )
    return refuse(
      "bake_proposal_missing",
      "This bake proposal does not exist.",
    );
  const reason = command.reason?.trim() ?? "";
  const role = command.decider.role;
  const guards = {
    decider_may_operate: () => mayDecideBakes(role),
    oven_named: () => proposal.oven !== null,
    reason_given: () => reason.length > 0 && reason.length <= REASON_LIMIT,
  };
  const move =
    command.decision === "approve"
      ? machineTransition(
          BAKE_PROPOSAL_MACHINE,
          proposal.state,
          "approve",
          guards,
        )
      : machineTransition(
          BAKE_PROPOSAL_MACHINE,
          proposal.state,
          "reject",
          guards,
        );
  if (!move.allowed) {
    if (move.refusal.code === "invalid_transition")
      return proposal.state === "waiting"
        ? refuse(
            "bake_proposal_waiting",
            "This proposal waits for the product's active proposal to end.",
          )
        : { ok: true, value: { kind: "unchanged", proposal } };
    switch (move.refusal.guard) {
      case "decider_may_operate":
        return refuse(
          "bake_role_insufficient",
          "Only an operator, an admin or the owner may decide a bake.",
        );
      case "oven_named":
        return refuse(
          "bake_oven_missing",
          `No active oven with the bake capability is enrolled at ${proposal.kitchenLocation}. Enroll one on the Devices page, or reject this proposal.`,
        );
      default:
        return refuse(
          "bake_reason_required",
          `Give a reason for the rejection, at most ${REASON_LIMIT} characters.`,
        );
    }
  }
  if (!mayDecideBakes(role)) throw new Error("A guard let a viewer decide.");
  const written = await writeBakeDecision(db, organisationId, {
    proposalId: proposal.proposalId,
    state: move.to,
    by: command.decider.userId,
    role,
    via: command.decider.via,
    reason: move.to === "rejected" ? reason : null,
    at: now,
  });
  const decided = await readBakeProposal(
    db,
    organisationId,
    proposal.proposalId,
  );
  if (decided === null) throw new Error("A decided bake proposal is missing.");
  if (!written)
    return { ok: true, value: { kind: "unchanged", proposal: decided } };
  await ports.announce(decided);
  // The approval starts the run (D1). A run that cannot start keeps its
  // reason for the Bakes page; the approval stands.
  if (decided.state === "approved")
    await startProposalRun(db, organisationId, decided, ports.launchRun, now);
  const opened =
    decided.state === "rejected"
      ? await openWaiting(
          db,
          organisationId,
          decided.inventoryItemId,
          ports,
          now,
        )
      : null;
  return { ok: true, value: { kind: "decided", proposal: decided, opened } };
}

/**
 * Ends an approved proposal when its bake run ends (Plan 24 S4 calls it
 * through the Organisation Actor), and opens the product's waiting proposal.
 */
async function endBakeProposal(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  proposalId: string,
  reason: string,
  ports: BakeKitchenPorts,
  now: number,
): Promise<Result<BakeCommandOutcome, BakeCommandError>> {
  const proposal = await readBakeProposal(db, organisationId, proposalId);
  if (proposal === null)
    return refuse(
      "bake_proposal_missing",
      "This bake proposal does not exist.",
    );
  if (proposal.state === "ended")
    return { ok: true, value: { kind: "unchanged", proposal } };
  const move = machineTransition(BAKE_PROPOSAL_MACHINE, proposal.state, "end");
  if (!move.allowed)
    return refuse(
      "bake_proposal_not_approved",
      "Only an approved proposal ends with its bake run.",
    );
  const text = reason.trim().slice(0, 200) || "The bake run ended.";
  const written = await writeBakeEnd(db, organisationId, proposalId, text, now);
  const ended = await readBakeProposal(db, organisationId, proposalId);
  if (ended === null) throw new Error("An ended bake proposal is missing.");
  if (!written)
    return { ok: true, value: { kind: "unchanged", proposal: ended } };
  await ports.announce(ended);
  const opened = await openWaiting(
    db,
    organisationId,
    ended.inventoryItemId,
    ports,
    now,
  );
  return { ok: true, value: { kind: "ended", proposal: ended, opened } };
}

async function openWaiting(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  inventoryItemId: string,
  ports: BakeKitchenPorts,
  now: number,
): Promise<BakeProposal | null> {
  const { active, waiting } = await readProductProposals(
    db,
    organisationId,
    inventoryItemId,
  );
  if (active !== null || waiting === null) return null;
  const recipe = await readAppliedWorkflowHead(
    db,
    organisationId,
    waiting.workflowId,
  );
  const opened = await openWaitingBakeProposal(
    db,
    organisationId,
    waiting.proposalId,
    {
      workflowRevision: recipe?.revision ?? waiting.workflowRevision,
      workflowDigest: recipe?.digest ?? waiting.workflowDigest,
      oven: await ports.findOven(waiting.kitchenLocation),
    },
    now,
  );
  if (opened !== null) await ports.announce(opened);
  return opened;
}

/** The approved proposal that a bake run starts from (Plan 24 S4). */
export async function readApprovedBakeProposal(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  proposalId: string,
): Promise<BakeProposal | null> {
  const proposal = await readBakeProposal(db, organisationId, proposalId);
  return proposal?.state === "approved" ? proposal : null;
}

async function approvedProposal(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  proposalId: string,
): Promise<Result<BakeProposal, BakeCommandError>> {
  const proposal = await readBakeProposal(db, organisationId, proposalId);
  if (proposal === null)
    return refuse(
      "bake_proposal_missing",
      "This bake proposal does not exist.",
    );
  if (proposal.state !== "approved" && proposal.state !== "ended")
    return refuse(
      "bake_proposal_not_approved",
      "Only an approved proposal has a bake run.",
    );
  return { ok: true, value: proposal };
}

/** A person starts a run that did not start, with the proposal's approval. */
async function restartBakeRun(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<BakeCommand, "start_run">,
  ports: BakeKitchenPorts,
  now: number,
): Promise<Result<BakeCommandOutcome, BakeCommandError>> {
  if (!mayDecideBakes(command.requester.role))
    return refuse(
      "bake_role_insufficient",
      "Only an operator, an admin or the owner may start a bake run.",
    );
  const proposal = await approvedProposal(
    db,
    organisationId,
    command.proposalId,
  );
  if (!proposal.ok) return proposal;
  const started = await startProposalRun(
    db,
    organisationId,
    proposal.value,
    ports.launchRun,
    now,
  );
  if (!started.ok) return refuse("bake_run_refused", started.error.message);
  return { ok: true, value: { kind: "run", proposal: proposal.value } };
}

/**
 * A pause, a resume, a stop or a settle of a run. Each needs the operator
 * role or a higher one now; the agent only pauses, for the person who asked.
 */
async function controlBakeRun(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<BakeCommand, "run_action">,
  ports: BakeKitchenPorts,
): Promise<Result<BakeCommandOutcome, BakeCommandError>> {
  const { requester, action } = command;
  if (!mayDecideBakes(requester.role))
    return refuse(
      "bake_role_insufficient",
      "Only an operator, an admin or the owner may pause, resume, stop or settle a bake run.",
    );
  if (requester.via === "agent" && action.kind !== "pause")
    return refuse(
      "bake_role_insufficient",
      "The agent may only request a pause. A person resumes, stops or settles a run.",
    );
  const proposal = await approvedProposal(
    db,
    organisationId,
    command.proposalId,
  );
  if (!proposal.ok) return proposal;
  const run = await readBakeRun(
    db,
    organisationId,
    bakeRunIdOf(proposal.value.proposalId),
  );
  if (run === null || run.actorId === null)
    return refuse(
      "bake_run_missing",
      "This proposal's bake run has not started.",
    );
  const done = await ports.controlRun(run.runId, action, {
    kind: requester.via === "agent" ? "agent" : "person",
    id: requester.userId,
  });
  if (!done.ok) return refuse("bake_run_refused", done.error.message);
  return { ok: true, value: { kind: "run", proposal: proposal.value } };
}

/**
 * The check of the released pieces (D4). Only this check raises the counter
 * stock, through the commerce authority, with its receipt. Then the proposal
 * ends. A second check changes nothing.
 */
async function checkBakeRun(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  command: Variant<BakeCommand, "check_run">,
  ports: BakeKitchenPorts,
  now: number,
): Promise<Result<BakeCommandOutcome, BakeCommandError>> {
  const role = command.checker.role;
  if (!mayDecideBakes(role))
    return refuse(
      "bake_role_insufficient",
      "Only an operator, an admin or the owner may record the check of a bake.",
    );
  const proposal = await approvedProposal(
    db,
    organisationId,
    command.proposalId,
  );
  if (!proposal.ok) return proposal;
  const runId = bakeRunIdOf(proposal.value.proposalId);
  const run = await readBakeRun(db, organisationId, runId);
  if (run?.state === "checked" && run.check !== null)
    return {
      ok: true,
      value: {
        kind: "run_checked",
        proposal: proposal.value,
        receiptId: run.check.receiptId,
        goodPieces: run.check.goodPieces,
      },
    };
  if (run?.mode === "shadow")
    return refuse(
      "bake_run_shadow",
      "A shadow run changes no stock. Count the pieces on the Stock page.",
    );
  if (run?.state !== "completed")
    return refuse(
      "bake_run_not_completed",
      "The bake run has not completed. Check the pieces after the unload.",
    );
  if (
    !Number.isInteger(command.goodPieces) ||
    command.goodPieces < 0 ||
    command.goodPieces > proposal.value.quantityPieces
  )
    return refuse(
      "bake_quantity_invalid",
      `Give the good pieces, from 0 to ${proposal.value.quantityPieces}.`,
    );
  const raised =
    command.goodPieces === 0
      ? { ok: true as const, value: { receiptId: `none_${runId}` } }
      : await ports.raiseCounterStock(proposal.value, {
          pieces: command.goodPieces,
          key: `bake_check_${runId}`,
          checkedBy: command.checker.userId,
        });
  if (!raised.ok) return raised;
  if (!mayDecideBakes(role)) throw new Error("A guard let a viewer check.");
  await writeBakeRunCheck(db, organisationId, {
    runId,
    by: command.checker.userId,
    role,
    goodPieces: command.goodPieces,
    receiptId: raised.value.receiptId,
    now,
  });
  await endBakeProposal(
    db,
    organisationId,
    proposal.value.proposalId,
    `Checked: ${command.goodPieces} good pieces reached the counter.`,
    ports,
    now,
  );
  const ended = await readBakeProposal(
    db,
    organisationId,
    proposal.value.proposalId,
  );
  return {
    ok: true,
    value: {
      kind: "run_checked",
      proposal: ended ?? proposal.value,
      receiptId: raised.value.receiptId,
      goodPieces: command.goodPieces,
    },
  };
}

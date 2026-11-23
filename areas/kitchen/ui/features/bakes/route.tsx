import React from "react";
import type {
  BakeBoard,
  BakeProposalView,
  BakeStockLevelView,
} from "@purin-labs/kitchen-control-api";

import { PageSkeleton, RecoverableError } from "@purin-labs/ui/page-components";
import {
  Button,
  CrmTable,
  SideDrawer,
  useLatestRead,
  useMutation,
  type CrmColumn,
} from "@purin-labs/ui/index";
import { Select } from "@purin-labs/ui/select";
import { decideBake, readBakes, refusalText, saveBakeLevel } from "./requests";
import { BakeAuthorityList } from "./authority";
import { BakeRunPanel } from "./run-panel";
import "./bakes.css";

/**
 * The Bakes page of Kitchen (Plan 24 S1). The stock level of each fresh
 * product, which an admin sets, and the bake proposals that a fall of the
 * counter stock opens. A row opens a side drawer. An operator, an admin or the
 * owner approves or rejects an open proposal there, or on its Slack card; a
 * rejection keeps its reason.
 */

const REFRESH_MS = 15_000;

const STATE_LABELS: Readonly<Record<BakeProposalView["state"], string>> = {
  waiting: "Waits",
  open: "To decide",
  approved: "Approved",
  rejected: "Rejected",
  ended: "Baked",
};

export function BakesRoute(
  props: Readonly<{ organisationId: string }>,
): React.ReactNode {
  const { organisationId } = props;
  const [levelOpen, setLevelOpen] = React.useState<
    BakeStockLevelView | "new" | null
  >(null);
  const [proposalId, setProposalId] = React.useState<string | null>(null);
  const read = React.useCallback(
    (signal: AbortSignal) => readBakes(organisationId, signal),
    [organisationId],
  );
  const {
    read: loaded,
    reload,
    retry,
  } = useLatestRead(read, {
    everyMs: REFRESH_MS,
    pauseWhenHidden: true,
  });

  if (loaded.kind === "loading") return <PageSkeleton label="Loading bakes" />;
  if (loaded.kind === "failed")
    return (
      <RecoverableError
        message="The bakes could not be read."
        action={<Button onClick={() => void retry()}>Try again</Button>}
      />
    );
  const board = loaded.value;
  // The Platform says what this person may do; the page shows no control
  // that the Platform would refuse.
  const { mayEditLevels, mayDecide } = board.access;
  const proposal =
    board.proposals.find((item) => item.proposalId === proposalId) ?? null;

  return (
    <div className="bakes">
      <section className="bakes-section" aria-labelledby="bakes-levels">
        <div className="bakes-heading">
          <h2 id="bakes-levels">Stock levels</h2>
          {mayEditLevels ? (
            <Button variant="primary" onClick={() => setLevelOpen("new")}>
              Add level
            </Button>
          ) : null}
        </div>
        <CrmTable
          label="Stock levels"
          rows={board.levels}
          columns={LEVEL_COLUMNS}
          rowId={(level) => level.inventoryItemId}
          rowLabel={(level) => level.productName}
          onRowClick={(level) => setLevelOpen(level)}
          emptyTitle="No stock levels"
          emptyDescription={
            mayEditLevels
              ? "Add a level for each fresh product."
              : "An admin sets the level of each fresh product."
          }
        />
      </section>
      <section className="bakes-section" aria-labelledby="bakes-authority">
        <div className="bakes-heading">
          <h2 id="bakes-authority">Authority</h2>
        </div>
        <BakeAuthorityList
          organisationId={organisationId}
          authority={board.authority}
          mayEdit={mayEditLevels}
          saved={() => void reload()}
        />
      </section>
      <section className="bakes-section" aria-labelledby="bakes-proposals">
        <div className="bakes-heading">
          <h2 id="bakes-proposals">Proposals</h2>
        </div>
        <CrmTable
          label="Bake proposals"
          rows={board.proposals}
          columns={PROPOSAL_COLUMNS}
          rowId={(item) => item.proposalId}
          rowLabel={(item) => `${item.productName}, ${item.quantityPieces}`}
          onRowClick={(item) => setProposalId(item.proposalId)}
          isRowActive={(item) => item.proposalId === proposalId}
          emptyTitle="No proposals"
          emptyDescription="A proposal opens when the counter stock falls below its level."
        />
      </section>
      <LevelDrawer
        key={
          levelOpen === null || levelOpen === "new"
            ? "new"
            : levelOpen.inventoryItemId
        }
        organisationId={organisationId}
        board={board}
        level={levelOpen}
        mayEdit={mayEditLevels}
        close={() => setLevelOpen(null)}
        saved={() => {
          setLevelOpen(null);
          void reload();
        }}
      />
      <ProposalDrawer
        key={proposal?.proposalId ?? "none"}
        organisationId={organisationId}
        proposal={proposal}
        hasRun={board.runs.some((run) => run.proposalId === proposalId)}
        mayDecide={mayDecide}
        close={() => setProposalId(null)}
        decided={() => void reload()}
      />
    </div>
  );
}

const LEVEL_COLUMNS: readonly CrmColumn<BakeStockLevelView>[] = [
  {
    id: "product",
    label: "Product",
    kind: "text",
    value: (level) => level.productName,
    render: (level) => level.productName,
  },
  {
    id: "level",
    label: "Level",
    kind: "number",
    align: "end",
    value: (level) => level.levelPieces,
    render: (level) => level.levelPieces,
  },
  {
    id: "counter",
    label: "Counter stock",
    kind: "number",
    align: "end",
    value: (level) => level.counterPieces,
    render: (level) => level.counterPieces ?? "Not counted",
  },
  {
    id: "group",
    label: "Mould group",
    kind: "number",
    align: "end",
    value: (level) => level.piecesPerGroup,
    render: (level) => level.piecesPerGroup,
  },
  {
    id: "recipe",
    label: "Recipe",
    kind: "text",
    value: (level) => level.recipe?.title ?? null,
    render: (level) =>
      level.recipe === null
        ? "No applied revision"
        : `${level.recipe.title}, revision ${level.recipe.revision}`,
  },
  {
    id: "kitchen",
    label: "Kitchen",
    kind: "text",
    value: (level) => level.kitchenLocation,
    render: (level) => level.kitchenLocation,
  },
];

const PROPOSAL_COLUMNS: readonly CrmColumn<BakeProposalView>[] = [
  {
    id: "product",
    label: "Product",
    kind: "text",
    value: (item) => item.productName,
    render: (item) => item.productName,
  },
  {
    id: "quantity",
    label: "Pieces",
    kind: "number",
    align: "end",
    value: (item) => item.quantityPieces,
    render: (item) => item.quantityPieces,
  },
  {
    id: "groups",
    label: "Mould groups",
    kind: "number",
    align: "end",
    value: (item) => item.mouldGroups,
    render: (item) => item.mouldGroups,
  },
  {
    id: "oven",
    label: "Oven",
    kind: "text",
    value: (item) => item.oven?.name ?? null,
    render: (item) => item.oven?.name ?? "None",
  },
  {
    id: "state",
    label: "State",
    kind: "text",
    value: (item) => STATE_LABELS[item.state],
    render: (item) => (
      <span className={`bakes-state bakes-state-${item.state}`}>
        {STATE_LABELS[item.state]}
      </span>
    ),
  },
  {
    id: "proposed",
    label: "Proposed",
    kind: "number",
    align: "end",
    value: (item) => item.proposedAt,
    render: (item) => clockTime(item.proposedAt),
  },
];

function clockTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(at));
}

type LevelForm = Readonly<{
  inventoryItemId: string;
  levelPieces: string;
  piecesPerGroup: string;
  workflowId: string;
  kitchenLocation: string;
}>;

function LevelDrawer(
  props: Readonly<{
    organisationId: string;
    board: BakeBoard;
    level: BakeStockLevelView | "new" | null;
    mayEdit: boolean;
    close: () => void;
    saved: () => void;
  }>,
): React.ReactNode {
  const { board, level, mayEdit } = props;
  const existing = level === "new" || level === null ? null : level;
  const [form, setForm] = React.useState<LevelForm>(() => ({
    inventoryItemId:
      existing?.inventoryItemId ?? board.products[0]?.inventoryItemId ?? "",
    levelPieces: String(existing?.levelPieces ?? 12),
    piecesPerGroup: String(existing?.piecesPerGroup ?? 6),
    workflowId: existing?.workflowId ?? board.workflows[0]?.workflowId ?? "",
    kitchenLocation:
      existing?.kitchenLocation ?? board.kitchenLocations[0] ?? "",
  }));
  const save = useMutation((input: LevelForm, idempotencyKey: string) =>
    saveBakeLevel(
      props.organisationId,
      {
        inventoryItemId: input.inventoryItemId,
        productName:
          board.products.find(
            (product) => product.inventoryItemId === input.inventoryItemId,
          )?.name ??
          existing?.productName ??
          input.inventoryItemId,
        levelPieces: Number(input.levelPieces),
        piecesPerGroup: Number(input.piecesPerGroup),
        workflowId: input.workflowId,
        kitchenLocation: input.kitchenLocation,
        expectedRevision: existing?.revision ?? null,
      },
      idempotencyKey,
    ),
  );
  const state = save.state("level");
  const productItems = board.products.map((product) => ({
    value: product.inventoryItemId,
    label: product.name,
  }));
  const workflowItems = board.workflows.map((workflow) => ({
    value: workflow.workflowId,
    label: `${workflow.title}, revision ${workflow.revision}`,
  }));
  const locationItems = board.kitchenLocations.map((location) => ({
    value: location,
    label: location,
  }));
  const set = (field: keyof LevelForm) => (value: string | null) => {
    if (value !== null) setForm((current) => ({ ...current, [field]: value }));
  };
  return (
    <SideDrawer
      open={level !== null}
      title={existing === null ? "Add stock level" : existing.productName}
      close={props.close}
      footer={
        mayEdit ? (
          <Button
            variant="primary"
            disabled={state.kind === "running"}
            onClick={() => {
              void save.run("level", form).then((outcome) => {
                if (outcome.kind === "done") props.saved();
              });
            }}
          >
            Save level
          </Button>
        ) : undefined
      }
    >
      <div className="side-drawer-body bakes-form">
        {mayEdit ? (
          <>
            {existing === null ? (
              <FormSelect
                label="Product"
                items={productItems}
                value={form.inventoryItemId}
                onChange={set("inventoryItemId")}
              />
            ) : null}
            <label className="bakes-field">
              Level in pieces
              <input
                inputMode="numeric"
                value={form.levelPieces}
                onChange={(event) => set("levelPieces")(event.target.value)}
              />
            </label>
            <label className="bakes-field">
              Pieces in one mould group
              <input
                inputMode="numeric"
                value={form.piecesPerGroup}
                onChange={(event) => set("piecesPerGroup")(event.target.value)}
              />
            </label>
            <FormSelect
              label="Recipe workflow"
              items={workflowItems}
              value={form.workflowId}
              onChange={set("workflowId")}
            />
            <FormSelect
              label="Kitchen location"
              items={locationItems}
              value={form.kitchenLocation}
              onChange={set("kitchenLocation")}
            />
            {state.kind === "failed" ? (
              <p className="bakes-refusal" role="alert">
                {refusalText(state.error)}
              </p>
            ) : null}
          </>
        ) : existing === null ? null : (
          <dl className="bakes-facts">
            <dt>Level</dt>
            <dd>{existing.levelPieces} pieces</dd>
            <dt>Mould group</dt>
            <dd>{existing.piecesPerGroup} pieces</dd>
            <dt>Recipe</dt>
            <dd>{existing.recipe?.title ?? existing.workflowId}</dd>
            <dt>Kitchen</dt>
            <dd>{existing.kitchenLocation}</dd>
          </dl>
        )}
      </div>
    </SideDrawer>
  );
}

function FormSelect(
  props: Readonly<{
    label: string;
    items: readonly Readonly<{ value: string; label: string }>[];
    value: string;
    onChange: (value: string | null) => void;
  }>,
): React.ReactNode {
  return (
    <label className="bakes-field">
      {props.label}
      <Select.Root
        items={props.items}
        value={props.value}
        onValueChange={props.onChange}
      >
        <Select.Trigger>
          <Select.Value />
        </Select.Trigger>
        <Select.Popup>
          {props.items.map((item) => (
            <Select.Item key={item.value} value={item.value}>
              {item.label}
            </Select.Item>
          ))}
        </Select.Popup>
      </Select.Root>
    </label>
  );
}

function ProposalDrawer(
  props: Readonly<{
    organisationId: string;
    proposal: BakeProposalView | null;
    hasRun: boolean;
    mayDecide: boolean;
    close: () => void;
    decided: () => void;
  }>,
): React.ReactNode {
  const { proposal } = props;
  const [reason, setReason] = React.useState("");
  const decide = useMutation(
    (
      input: Readonly<
        { decision: "approve" } | { decision: "reject"; reason: string }
      >,
      idempotencyKey: string,
    ) =>
      proposal === null
        ? Promise.resolve()
        : decideBake(
            props.organisationId,
            proposal.proposalId,
            input,
            idempotencyKey,
          ),
    () => props.decided(),
  );
  const state = decide.state("decision");
  const open = proposal?.state === "open" && props.mayDecide;
  return (
    <SideDrawer
      open={proposal !== null}
      title={
        proposal === null
          ? "Bake proposal"
          : `${proposal.quantityPieces} ${proposal.productName}`
      }
      close={props.close}
      footer={
        open ? (
          <div className="bakes-actions">
            <Button
              variant="danger"
              disabled={state.kind === "running" || reason.trim() === ""}
              onClick={() =>
                void decide.run("decision", {
                  decision: "reject",
                  reason: reason.trim(),
                })
              }
            >
              Reject
            </Button>
            <Button
              variant="primary"
              disabled={state.kind === "running" || proposal?.oven === null}
              onClick={() =>
                void decide.run("decision", { decision: "approve" })
              }
            >
              Approve bake
            </Button>
          </div>
        ) : undefined
      }
    >
      {proposal === null ? null : (
        <div className="side-drawer-body bakes-form">
          <dl className="bakes-facts">
            <dt>State</dt>
            <dd>{STATE_LABELS[proposal.state]}</dd>
            <dt>Quantity</dt>
            <dd>
              {proposal.quantityPieces} pieces in {proposal.mouldGroups} mould
              groups of {proposal.piecesPerGroup}
            </dd>
            <dt>Recipe</dt>
            <dd>
              {proposal.workflowId}, revision {proposal.workflowRevision}
            </dd>
            <dt>Oven</dt>
            <dd>
              {proposal.oven === null
                ? `None at ${proposal.kitchenLocation}. Enroll an oven with the bake capability on the Devices page.`
                : `${proposal.oven.name} at ${proposal.kitchenLocation}`}
            </dd>
            <dt>Counter stock</dt>
            <dd>
              {proposal.stockAvailable} of a level of {proposal.stockLevel}
            </dd>
            <dt>Proposed by</dt>
            <dd>
              {proposal.origin === "stock"
                ? "Purin Pantry, from the counter stock"
                : "The Portal chat agent, for a person"}
            </dd>
            {proposal.decision === null ? null : (
              <>
                <dt>Decision</dt>
                <dd>
                  {proposal.decision.reason === null ? "Approved" : "Rejected"}{" "}
                  {proposal.decision.via === "slack"
                    ? "in Slack"
                    : "in the Portal"}{" "}
                  by a member with the {proposal.decision.role} role
                </dd>
                {proposal.decision.reason === null ? null : (
                  <>
                    <dt>Reason</dt>
                    <dd>{proposal.decision.reason}</dd>
                  </>
                )}
              </>
            )}
          </dl>
          {open ? (
            <label className="bakes-field">
              Reason for a rejection
              <textarea
                rows={3}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          ) : null}
          {state.kind === "failed" ? (
            <p className="bakes-refusal" role="alert">
              {refusalText(state.error)}
            </p>
          ) : null}
          {props.hasRun ? (
            <BakeRunPanel
              organisationId={props.organisationId}
              proposalId={proposal.proposalId}
            />
          ) : null}
        </div>
      )}
    </SideDrawer>
  );
}

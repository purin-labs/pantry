import { Select } from "../../ui/select";
import React from "react";
import { Link } from "react-router";
import {
  parseInventoryProductionContext,
  parseInventoryQuantityText,
  parseProductionDemand,
  type InventoryProductionCreation,
  type InventoryProductionTransition,
  type InventoryProductionContext,
  type InventoryProductionRecipe,
  type InventoryProductionRequest,
} from "@purin-labs/kitchen-control-api";
import { assertNever, isRecord } from "@purin-labs/std";
import { StatusChip, type StatusChipStatus } from "../../page-components";
import type { Quantity } from "@purin-labs/commerce-contracts";
import { ControlApiError, controlRead } from "../../control-client";
import { cancelDialog, DialogHeading, syncDialog } from "../../dialog";
import {
  readProductionSubmission,
  storeProductionSubmission,
  clearProductionSubmission,
  productionFailure,
  productionReceipt,
  type ProductionSubmission,
  type ProductionSubmissionScope,
} from "./inventory-production-submission";
import {
  StockDialogCancel,
  StockDialogContext,
  StockDialogDone,
  StockDialogRetry,
} from "./stock-dialog";
import type { CommerceMutationTransport } from "./entity-plane/api";
import { ProductionPlanPanel } from "./production-plan";
import {
  defaultNeededByDate,
  formatNeededBy,
  neededByDateInput,
  neededByTimestamp,
} from "./needed-by";
import type { Variant } from "@purin-labs/type-utils";

type Props = Readonly<{
  userId: string;
  canManage: boolean;
  organisationId: string;
  positionId: string;
  requestsHref: string;
  mutate: CommerceMutationTransport;
  close: () => void;
}>;

type Draft = Readonly<{ recipe: string; quantity: string; neededBy: string }>;

type State =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{
      kind: "editing" | "refreshing" | "saving";
      context: InventoryProductionContext;
      draft: Draft;
      message: string | null;
      discard: boolean;
    }>
  | Readonly<{
      kind: "uncertain" | "submitting";
      submission: ProductionSubmission<InventoryProductionCreation>;
      message: string;
    }>
  | Readonly<{ kind: "requested" }>;

export class InventoryProductionDialog extends React.Component<Props, State> {
  state: State = { kind: "loading" };
  private readonly dialog = React.createRef<HTMLDialogElement>();
  private readonly requestedAt = new Date().toISOString();
  private readonly intent = `inventory.production:${crypto.randomUUID()}`;
  private active = true;
  private dirty = false;
  componentDidMount() {
    syncDialog(this.dialog, true);
    void this.restore();
  }
  componentWillUnmount() {
    this.active = false;
    syncDialog(this.dialog, false);
  }
  private scope(): ProductionSubmissionScope & { kind: "create" } {
    return {
      userId: this.props.userId,
      organisationId: this.props.organisationId,
      kind: "create",
      targetId: this.props.positionId,
    };
  }
  async restore() {
    try {
      const submission = readProductionSubmission(this.scope());
      if (submission !== null) {
        this.setState({
          kind: "uncertain",
          submission,
          message:
            "A production request is awaiting confirmation. Check its result before creating another request.",
        });
        return;
      }
      await this.load();
    } catch (error) {
      this.setState({ kind: "failed", message: productionError(error) });
    }
  }
  async load() {
    if (this.state.kind === "uncertain" || this.state.kind === "submitting") {
      return;
    }
    await this.loadContext(null);
  }
  private async loadContext(restoredDraft: Draft | null) {
    if (this.state.kind === "refreshing") {
      return;
    }
    const preserved =
      this.state.kind === "editing" || this.state.kind === "saving"
        ? this.state
        : null;
    if (preserved !== null) {
      this.setState({
        kind: "refreshing",
        context: preserved.context,
        draft: preserved.draft,
        message: null,
        discard: false,
      });
    }
    try {
      const context = parseInventoryProductionContext(
        await controlRead(
          `${productionPath(this.props.organisationId)}?position=${encodeURIComponent(this.props.positionId)}`,
        ),
      );
      const recipe = context.recipes[0] ?? context.linkableRecipes[0];
      if (this.active) {
        this.setState({
          kind: "editing",
          context,
          draft: restoredDraft ?? {
            recipe:
              preserved !== null &&
              context.recipes.some(
                recipeMatches.bind(null, preserved.draft.recipe),
              )
                ? preserved.draft.recipe
                : (recipe?.id ?? ""),
            quantity:
              preserved?.draft.quantity ??
              (recipe === undefined
                ? ""
                : String(recipe.yield.amount / 10 ** recipe.yield.scale)),
            neededBy:
              preserved?.draft.neededBy ?? defaultNeededByDate(new Date()),
          },
          message: null,
          discard: false,
        });
      }
    } catch (error) {
      if (this.active) {
        this.setState(
          preserved === null
            ? { kind: "failed", message: productionError(error) }
            : {
                kind: "editing",
                context: preserved.context,
                draft: preserved.draft,
                message: productionError(error),
                discard: false,
              },
        );
      }
    }
  }
  edit(event: React.ChangeEvent<HTMLInputElement>) {
    if (this.state.kind !== "editing") {
      return;
    }
    this.dirty = true;
    this.setState({
      kind: "editing",
      context: this.state.context,
      draft: { ...this.state.draft, [event.target.name]: event.target.value },
      message: null,
      discard: false,
    });
  }
  editRecipe(recipe: string | null) {
    if (this.state.kind !== "editing" || recipe === null) {
      return;
    }
    this.dirty = true;
    this.setState({
      kind: "editing",
      context: this.state.context,
      draft: { ...this.state.draft, recipe },
      message: null,
      discard: false,
    });
  }
  close() {
    if (
      this.state.kind === "saving" ||
      this.state.kind === "refreshing" ||
      this.state.kind === "submitting"
    ) {
      return;
    }
    if (this.dirty && this.state.kind === "editing") {
      this.setState({
        kind: "editing",
        context: this.state.context,
        draft: this.state.draft,
        message:
          "You have unsaved changes. Keep editing or discard them below.",
        discard: true,
      });
      return;
    }
    this.props.close();
  }
  async setup() {
    if (this.state.kind !== "editing") {
      return;
    }
    const { context, draft } = this.state;
    this.setState({
      kind: "saving",
      context,
      draft,
      message: null,
      discard: false,
    });
    try {
      await this.props.mutate(
        productionPath(this.props.organisationId),
        { kind: "setup" },
        `${this.intent}:setup`,
      );
      await this.load();
    } catch (error) {
      if (this.active) {
        this.setState({
          kind: "editing",
          context,
          draft,
          message: productionError(error),
          discard: false,
        });
      }
    }
  }
  async linkRecipe() {
    if (this.state.kind !== "editing") {
      return;
    }
    const { context, draft } = this.state;
    const recipe = context.linkableRecipes.find(
      recipeMatches.bind(null, draft.recipe),
    );
    if (recipe === undefined) {
      return;
    }
    this.setState({
      kind: "saving",
      context,
      draft,
      message: null,
      discard: false,
    });
    try {
      await this.props.mutate(
        productionPath(this.props.organisationId),
        {
          kind: "link_recipe",
          requestedAt: this.requestedAt,
          merchantRevision: context.merchantRevision,
          positionId: context.inventoryPositionId,
          positionRevision: context.inventoryPositionRevision,
          recipeId: recipe.id,
          recipeRevision: recipe.revision,
        },
        `${this.intent}:recipe`,
      );
      await this.load();
    } catch (error) {
      if (this.active) {
        this.setState({
          kind: "editing",
          context,
          draft,
          message: productionError(error),
          discard: false,
        });
      }
    }
  }
  async submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (this.state.kind !== "editing") {
      return;
    }
    const { context, draft } = this.state;
    try {
      const recipe = context.recipes.find(
        recipeMatches.bind(null, draft.recipe),
      );
      if (recipe === undefined) {
        throw new Error("Link a recipe that produces this stock item.");
      }
      const quantity = parseInventoryQuantityText(
        draft.quantity,
        recipe.yield.unit,
      );
      const neededBy = neededByTimestamp(draft.neededBy);
      if (context.demand.kind !== "ready") {
        throw new Error("Set up production requests before submitting.");
      }
      const submission: ProductionSubmission<InventoryProductionCreation> = {
        idempotencyKey: `production:${crypto.randomUUID()}`,
        body: {
          kind: "create",
          requestedAt: this.requestedAt,
          merchantRevision: context.merchantRevision,
          listRevision: context.demand.listRevision,
          positionId: context.inventoryPositionId,
          positionRevision: context.inventoryPositionRevision,
          inventoryItemId: context.inventoryItemId,
          locationId: context.locationId,
          recipeId: recipe.id,
          recipeRevision: recipe.revision,
          quantity,
          neededBy,
        },
      };
      storeProductionSubmission(this.scope(), submission);
      await this.sendSubmission(submission);
    } catch (error) {
      if (this.active) {
        this.setState({
          kind: "editing",
          context,
          draft,
          message: productionError(error),
          discard: false,
        });
      }
    }
  }
  async retrySubmission() {
    if (this.state.kind === "uncertain") {
      await this.sendSubmission(this.state.submission);
    }
  }
  private async sendSubmission(
    submission: ProductionSubmission<InventoryProductionCreation>,
  ) {
    this.setState({
      kind: "submitting",
      submission,
      message: "Checking the production request…",
    });
    try {
      const response = await this.props.mutate(
        productionPath(this.props.organisationId),
        submission.body,
        { kind: "prepared", idempotencyKey: submission.idempotencyKey },
      );
      const requestId = productionReceipt(response);
      if (requestId !== `production_request_${submission.idempotencyKey}`) {
        throw new Error("The production receipt does not match this request.");
      }
      clearProductionSubmission(this.scope());
      this.dirty = false;
      if (this.active) {
        this.setState({ kind: "requested" });
      }
    } catch (error) {
      if (
        productionFailure(error) === "rejected" &&
        submission.body.kind === "create"
      ) {
        try {
          clearProductionSubmission(this.scope());
          await this.loadContext(creationDraft(submission.body));
          if (this.active && this.state.kind === "editing") {
            this.setState({
              kind: "editing",
              context: this.state.context,
              draft: this.state.draft,
              discard: false,
              message: productionError(error),
            });
          }
          return;
        } catch {
          // A retained submission must remain recoverable before another command is allowed.
        }
      }
      if (this.active) {
        this.setState({
          kind: "uncertain",
          submission,
          message: productionError(error),
        });
      }
    }
  }
  render(): React.ReactNode {
    const state = this.state;
    const recipe =
      state.kind === "editing" ||
      state.kind === "refreshing" ||
      state.kind === "saving"
        ? state.context.recipes.find(
            recipeMatches.bind(null, state.draft.recipe),
          )
        : undefined;
    const linking =
      (state.kind === "editing" ||
        state.kind === "refreshing" ||
        state.kind === "saving") &&
      state.context.recipes.length === 0;
    const title = linking ? "Link a recipe" : "Request production";
    return (
      <dialog
        ref={this.dialog}
        className="stock-dialog"
        aria-labelledby="production-request-heading"
        onCancel={cancelDialog.bind(null, this.close.bind(this))}
      >
        <DialogHeading
          id="production-request-heading"
          title={title}
          close={this.close.bind(this)}
        />
        {state.kind === "loading" && (
          <div className="stock-dialog-body" role="status">
            Loading recipes and ingredient availability…
          </div>
        )}
        {state.kind === "failed" && (
          <StockDialogRetry
            message={state.message}
            close={this.close.bind(this)}
            retry={this.restore.bind(this)}
          />
        )}
        {(state.kind === "uncertain" || state.kind === "submitting") && (
          <>
            <div className="stock-dialog-body">
              <p role={state.kind === "uncertain" ? "alert" : "status"}>
                {state.message}
              </p>
              <p>
                The submitted request is saved in this tab. Checking it reuses
                the same request and quantity.
              </p>
            </div>
            <footer className="stock-dialog-actions">
              <button
                type="button"
                disabled={state.kind === "submitting"}
                onClick={this.close.bind(this)}
              >
                Close
              </button>
              <button
                type="button"
                className="connection-primary-action"
                disabled={state.kind === "submitting"}
                onClick={this.retrySubmission.bind(this)}
              >
                {state.kind === "submitting"
                  ? "Checking…"
                  : "Check request result"}
              </button>
            </footer>
          </>
        )}
        {state.kind === "requested" && (
          <StockDialogDone close={this.close.bind(this)}>
            <p role="status">
              Production requested. Stock will increase when a confirmed batch
              is recorded.
            </p>
            <Link to={this.props.requestsHref}>Open Kitchen requests</Link>
          </StockDialogDone>
        )}
        {(state.kind === "editing" ||
          state.kind === "refreshing" ||
          state.kind === "saving") && (
          <form
            className="stock-dialog-form"
            onSubmit={this.submit.bind(this)}
            aria-busy={state.kind !== "editing"}
          >
            <div className="stock-dialog-body">
              <StockDialogContext
                label="Production item"
                name={state.context.itemName}
                detail="Finished product"
              >
                {recipe !== undefined && (
                  <dl>
                    <div>
                      <dt>Recipe yield</dt>
                      <dd>
                        {formatProductionQuantity(
                          recipe.yield.amount / 10 ** recipe.yield.scale,
                          recipe.yield.unit,
                        )}
                      </dd>
                    </div>
                  </dl>
                )}
              </StockDialogContext>
              {state.context.demand.kind === "inactive" && (
                <div className="stock-dialog-notice stock-dialog-setup">
                  <div>
                    <strong>Enable production requests</strong>
                    <p>
                      {this.props.canManage
                        ? "Set up once for this workspace."
                        : "An administrator can enable requests for this workspace."}
                    </p>
                  </div>
                  {this.props.canManage && (
                    <button
                      type="button"
                      onClick={this.setup.bind(this)}
                      disabled={state.kind !== "editing"}
                    >
                      Set up requests
                    </button>
                  )}
                </div>
              )}
              {state.context.demand.kind === "unavailable" && (
                <p className="stock-dialog-notice" role="alert">
                  Production requests could not be loaded. Refresh before
                  submitting.
                </p>
              )}
              {state.context.recipes.length === 0 ? (
                <div className="stock-dialog-link-recipe">
                  <p>
                    Choose a stocked recipe to create a linked recipe for this
                    item. Its recorded ingredients and batch yield are retained.
                  </p>
                  {state.context.linkableRecipes.length === 0 ? (
                    <p>
                      No compatible stocked recipes are available. Create a
                      recipe in Kitchen → Recipes.
                    </p>
                  ) : (
                    <>
                      <label>
                        Recipe to link
                        <Select.Root
                          name="recipe"
                          items={state.context.linkableRecipes.map(recipeItem)}
                          disabled={state.kind !== "editing"}
                          value={state.draft.recipe}
                          onValueChange={this.editRecipe.bind(this)}
                        >
                          <Select.Trigger>
                            <Select.Value />
                          </Select.Trigger>
                          <Select.Popup>
                            {state.context.linkableRecipes.map(recipeOption)}
                          </Select.Popup>
                        </Select.Root>
                      </label>
                    </>
                  )}
                </div>
              ) : (
                <>
                  <fieldset
                    className="stock-dialog-fields"
                    disabled={state.kind !== "editing"}
                  >
                    <label className="stock-dialog-full-width">
                      Recipe *
                      <Select.Root
                        name="recipe"
                        items={state.context.recipes.map(recipeItem)}
                        value={state.draft.recipe}
                        onValueChange={this.editRecipe.bind(this)}
                        required
                      >
                        <Select.Trigger>
                          <Select.Value />
                        </Select.Trigger>
                        <Select.Popup>
                          {state.context.recipes.map(recipeOption)}
                        </Select.Popup>
                      </Select.Root>
                    </label>
                    <label>
                      Quantity to produce ({recipe?.yield.unit}) *
                      <input
                        name="quantity"
                        type="number"
                        inputMode="decimal"
                        required
                        min={recipe?.yield.unit === "each" ? 1 : 0.000001}
                        step={recipe?.yield.unit === "each" ? 1 : "any"}
                        autoFocus
                        value={state.draft.quantity}
                        onChange={this.edit.bind(this)}
                      />
                    </label>
                    <label>
                      Needed by *
                      <input
                        name="neededBy"
                        type="date"
                        required
                        min={neededByDateInput(new Date())}
                        value={state.draft.neededBy}
                        onChange={this.edit.bind(this)}
                      />
                    </label>
                  </fieldset>
                  {recipe !== undefined && (
                    <table className="stock-dialog-ingredients">
                      <caption>Ingredients for this request</caption>
                      <thead>
                        <tr>
                          <th scope="col">Ingredient</th>
                          <th scope="col">Needed</th>
                          <th scope="col">Available</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recipe.inputs.map(
                          ingredientReview.bind(
                            null,
                            recipe,
                            state.draft.quantity,
                          ),
                        )}
                      </tbody>
                    </table>
                  )}
                  <p className="stock-footnote">
                    * Required. This creates demand for Kitchen. Stock
                    increases after a confirmed batch; shortages must be
                    resolved before baking.
                  </p>
                </>
              )}
              {state.message !== null && (
                <div className="stock-dialog-notice">
                  <p role="alert">{state.message}</p>
                  <button type="button" onClick={this.load.bind(this)}>
                    Refresh and review
                  </button>
                </div>
              )}
            </div>
            <footer className="stock-dialog-actions">
              <StockDialogCancel
                discard={state.discard}
                discardChanges={this.props.close}
                close={this.close.bind(this)}
              />
              {linking ? (
                <button
                  type="button"
                  className="connection-primary-action"
                  disabled={
                    state.kind !== "editing" ||
                    state.context.linkableRecipes.length === 0
                  }
                  onClick={this.linkRecipe.bind(this)}
                >
                  Link recipe{state.kind === "saving" ? "…" : ""}
                </button>
              ) : (
                <button
                  type="submit"
                  className="connection-primary-action"
                  disabled={
                    state.kind !== "editing" ||
                    state.context.demand.kind !== "ready"
                  }
                >
                  Create request{state.kind === "saving" ? "…" : ""}
                </button>
              )}
            </footer>
          </form>
        )}
      </dialog>
    );
  }
}

type RequestsProps = Readonly<{
  userId: string;
  canManage: boolean;
  organisationId: string;
  canOperate: boolean;
  productsHref: string;
  mutate: CommerceMutationTransport;
}>;

type RequestsWork =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading"; cursor: string | null }>
  | Readonly<{ kind: "acting"; requestId: string }>
  | Readonly<{ kind: "retry"; cursor: string | null; message: string }>
  | Readonly<{
      kind: "pending";
      requestId: string;
      submission: ProductionSubmission<InventoryProductionTransition>;
    }>
  | Readonly<{ kind: "settled"; requestId: string }>;

type RequestsState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{
      kind: "ready";
      demand: InventoryProductionContext["demand"];
      work: RequestsWork;
      continuation: "current" | "restart_required";
      message: string | null;
    }>;

export class InventoryProductionRequestsPage extends React.Component<
  RequestsProps,
  RequestsState
> {
  state: RequestsState = { kind: "loading" };
  private active = true;
  private search = window.location.search;
  componentDidMount() {
    void this.load();
  }
  componentDidUpdate() {
    // A plan link changes the location filter in the address only.
    if (window.location.search === this.search) {
      return;
    }
    this.search = window.location.search;
    void this.load();
  }
  componentWillUnmount() {
    this.active = false;
  }
  async load(cursor: string | null = null) {
    const previous = this.state.kind === "ready" ? this.state : null;
    if (
      previous !== null &&
      previous.work.kind !== "idle" &&
      previous.work.kind !== "retry"
    ) {
      return;
    }
    if (previous !== null) {
      this.setState({
        kind: "ready",
        demand: previous.demand,
        continuation: previous.continuation,
        work: { kind: "loading", cursor },
        message: null,
      });
    }
    try {
      const raw = await controlRead(
        productionRequestsPath(this.props.organisationId, cursor),
      );
      if (!isRecord(raw) || raw.ok !== true) {
        throw new Error("Production requests are unavailable.");
      }
      const page = parseProductionDemand(raw.demand);
      if (page.kind === "unavailable") {
        throw new Error("Production requests are unavailable.");
      }
      let demand: InventoryProductionContext["demand"] = page;
      if (cursor !== null) {
        if (
          previous?.demand.kind !== "ready" ||
          page.kind !== "ready" ||
          previous.demand.merchantRevision !== page.merchantRevision
        ) {
          throw new ControlApiError(
            "Requests changed while loading.",
            "production_cursor_stale",
          );
        }
        demand = {
          kind: "ready",
          merchantRevision: page.merchantRevision,
          listRevision: page.listRevision,
          requests: [...previous.demand.requests, ...page.requests],
          invalidRequests: [
            ...previous.demand.invalidRequests,
            ...page.invalidRequests,
          ],
          nextCursor: page.nextCursor,
        };
      }
      if (this.active) {
        this.setState({
          kind: "ready",
          demand,
          continuation: "current",
          work: { kind: "idle" },
          message: null,
        });
      }
    } catch (error) {
      if (!this.active) {
        return;
      }
      if (previous === null) {
        this.setState({ kind: "failed", message: productionError(error) });
        return;
      }
      const stale =
        error instanceof ControlApiError &&
        error.kind === "production_cursor_stale";
      this.setState({
        kind: "ready",
        demand: previous.demand,
        continuation: stale ? "restart_required" : previous.continuation,
        work: stale
          ? { kind: "idle" }
          : { kind: "retry", cursor, message: productionError(error) },
        message: null,
      });
    }
  }
  loadMore() {
    if (
      this.state.kind === "ready" &&
      this.state.work.kind === "idle" &&
      this.state.continuation === "current" &&
      this.state.demand.kind === "ready" &&
      this.state.demand.nextCursor !== null
    ) {
      void this.load(this.state.demand.nextCursor);
    }
  }
  retryLoad() {
    if (this.state.kind === "ready" && this.state.work.kind === "retry") {
      void this.load(this.state.work.cursor);
    }
  }
  private scope(
    requestId: string,
  ): ProductionSubmissionScope & { kind: "transition" } {
    return {
      userId: this.props.userId,
      organisationId: this.props.organisationId,
      kind: "transition",
      targetId: requestId,
    };
  }
  async setup() {
    if (this.state.kind !== "ready" || this.state.work.kind !== "idle") {
      return;
    }
    const { demand, continuation } = this.state;
    this.setState({
      kind: "ready",
      demand,
      continuation,
      work: { kind: "acting", requestId: "setup" },
      message: null,
    });
    try {
      await this.props.mutate(
        productionPath(this.props.organisationId),
        { kind: "setup" },
        `production:setup:${crypto.randomUUID()}`,
      );
      const raw = await controlRead(productionPath(this.props.organisationId));
      if (!isRecord(raw) || raw.ok !== true) {
        throw new Error("Production requests are unavailable.");
      }
      const updated = parseProductionDemand(raw.demand);
      if (this.active) {
        this.setState({
          kind: "ready",
          demand: updated,
          continuation: "current",
          work: { kind: "idle" },
          message: null,
        });
      }
    } catch (error) {
      if (this.active) {
        this.setState({
          kind: "ready",
          demand,
          continuation,
          work: { kind: "idle" },
          message: productionError(error),
        });
      }
    }
  }
  async advance(request: InventoryProductionRequest) {
    if (
      this.state.kind !== "ready" ||
      (this.state.work.kind !== "idle" && this.state.work.kind !== "retry")
    ) {
      return;
    }
    const { demand, continuation } = this.state;
    this.setState({
      kind: "ready",
      demand,
      continuation,
      work: { kind: "acting", requestId: request.id },
      message: null,
    });
    try {
      const pending = readProductionSubmission(this.scope(request.id));
      if (pending !== null) {
        await this.sendTransition(request.id, pending);
        return;
      }
      const updated = await this.readRequest(request.id);
      const target = updated.requests[0];
      if (
        target === undefined ||
        target.id !== request.id ||
        target.revision !== request.revision ||
        target.status !== request.status ||
        target.status === "scheduled"
      ) {
        throw new Error(
          "This request changed. Refresh requests before continuing.",
        );
      }
      const submission: ProductionSubmission<InventoryProductionTransition> = {
        idempotencyKey: `production:${crypto.randomUUID()}`,
        body: {
          kind: target.status === "requested" ? "accept" : "schedule",
          requestedAt: new Date().toISOString(),
          merchantRevision: updated.merchantRevision,
          listRevision: updated.listRevision,
          requestId: target.id,
          requestRevision: target.revision,
          recipeId: target.recipeId,
          recipeRevision: target.recipeRevision,
          locationId: target.locationId,
          quantity: target.quantity,
          neededBy: target.neededBy,
        },
      };
      storeProductionSubmission(this.scope(request.id), submission);
      await this.sendTransition(request.id, submission);
    } catch (error) {
      if (this.active) {
        this.setState({
          kind: "ready",
          demand,
          continuation,
          work: { kind: "idle" },
          message: productionError(error),
        });
      }
    }
  }
  async retryAction() {
    if (this.state.kind !== "ready") {
      return;
    }
    if (this.state.work.kind === "pending") {
      await this.sendTransition(
        this.state.work.requestId,
        this.state.work.submission,
      );
    } else if (this.state.work.kind === "settled") {
      await this.refreshRequest(this.state.work.requestId);
    }
  }
  private async sendTransition(
    id: string,
    submission: ProductionSubmission<InventoryProductionTransition>,
  ) {
    if (this.state.kind !== "ready") {
      return;
    }
    const { demand, continuation } = this.state;
    this.setState({
      kind: "ready",
      demand,
      continuation,
      work: { kind: "acting", requestId: id },
      message: null,
    });
    try {
      const response = await this.props.mutate(
        productionPath(this.props.organisationId),
        submission.body,
        { kind: "prepared", idempotencyKey: submission.idempotencyKey },
      );
      if (productionReceipt(response) !== id) {
        throw new Error("The production receipt does not match this request.");
      }
      clearProductionSubmission(this.scope(id));
    } catch (error) {
      if (productionFailure(error) === "rejected") {
        try {
          clearProductionSubmission(this.scope(id));
          if (this.active) {
            this.setState({
              kind: "ready",
              demand,
              continuation: "restart_required",
              work: { kind: "idle" },
              message: productionError(error),
            });
          }
          return;
        } catch {
          // Preserve recovery when browser storage cannot be cleared.
        }
      }
      if (this.active) {
        this.setState({
          kind: "ready",
          demand,
          continuation,
          work: { kind: "pending", requestId: id, submission },
          message: productionError(error),
        });
      }
      return;
    }
    await this.refreshRequest(id);
  }
  private async readRequest(
    id: string,
  ): Promise<Variant<InventoryProductionContext["demand"], "ready">> {
    const raw = await controlRead(
      `${productionPath(this.props.organisationId)}?request=${encodeURIComponent(id)}`,
    );
    if (!isRecord(raw) || raw.ok !== true) {
      throw new Error("The updated request could not be loaded.");
    }
    const updated = parseProductionDemand(raw.demand);
    if (
      updated.kind !== "ready" ||
      updated.requests.length !== 1 ||
      updated.requests[0]?.id !== id
    ) {
      throw new Error("The updated request could not be loaded.");
    }
    return updated;
  }
  private async refreshRequest(id: string) {
    if (this.state.kind !== "ready") {
      return;
    }
    const { demand } = this.state;
    this.setState({
      kind: "ready",
      demand,
      continuation: "restart_required",
      work: { kind: "acting", requestId: id },
      message: null,
    });
    try {
      const updated = await this.readRequest(id);
      const target = updated.requests[0];
      if (target === undefined || demand.kind !== "ready") {
        throw new Error("The updated request could not be loaded.");
      }
      if (this.active) {
        this.setState({
          kind: "ready",
          demand: {
            kind: "ready",
            merchantRevision: updated.merchantRevision,
            listRevision: updated.listRevision,
            requests: demand.requests.map(
              replaceProductionRequest.bind(null, target),
            ),
            invalidRequests: demand.invalidRequests,
            nextCursor: demand.nextCursor,
          },
          continuation: "restart_required",
          work: { kind: "idle" },
          message: null,
        });
      }
    } catch (error) {
      if (this.active) {
        this.setState({
          kind: "ready",
          demand,
          continuation: "restart_required",
          work: { kind: "settled", requestId: id },
          message: `The update was accepted. ${productionError(error)}`,
        });
      }
    }
  }
  renderRequest(request: InventoryProductionRequest): React.ReactNode {
    return (
      <li key={request.id} className="stock-production-request">
        <header className="stock-production-request-heading">
          <h3>{request.name}</h3>
          <StatusChip status={productionRequestStatus(request.status)} />
        </header>
        <p>
          {formatProductionQuantity(
            request.quantity.amount / 10 ** request.quantity.scale,
            request.quantity.unit,
          )}{" "}
          · Needed {formatNeededBy(request.neededBy)}
        </p>
        <div className="stock-operation-actions">
          <Link
            to={`${this.props.productsHref}?inventoryItem=${encodeURIComponent(request.itemId)}`}
          >
            Open product stock
          </Link>
          {this.props.canOperate && request.status !== "scheduled" && (
            <button
              type="button"
              className="connection-primary-action"
              disabled={
                this.state.kind !== "ready" ||
                (this.state.work.kind !== "idle" &&
                  this.state.work.kind !== "retry")
              }
              onClick={this.advance.bind(this, request)}
            >
              {request.status === "requested"
                ? "Accept request"
                : "Mark scheduled"}
            </button>
          )}
        </div>
        {request.batches.length > 0 ? (
          <ul>{request.batches.map(completedBatch)}</ul>
        ) : null}
      </li>
    );
  }
  render(): React.ReactNode {
    const state = this.state;
    if (state.kind === "loading") {
      return <p role="status">Loading production requests…</p>;
    }
    if (state.kind === "failed") {
      return (
        <div>
          <p role="alert">{state.message}</p>
          <button onClick={this.load.bind(this, null)}>Try again</button>
        </div>
      );
    }
    const requests = state.demand.kind === "ready" ? state.demand.requests : [];
    const locationId = selectedLocation();
    return (
      <section className="stock-page">
        <p>
          Requests record demand. Confirmed batches below record actual output.
        </p>
        {state.demand.kind === "ready" &&
          (locationId === null ? (
            planLocations(requests).length > 0 && (
              <nav
                className="production-plan-locations"
                aria-label="Production plans"
              >
                {planLocations(requests).map(planLocationLink)}
              </nav>
            )
          ) : (
            <ProductionPlanPanel
              organisationId={this.props.organisationId}
              locationId={locationId}
              requests={requests.filter(waitsAtLocation.bind(null, locationId))}
              settledRequestIds={requests
                .filter(settledAtLocation.bind(null, locationId))
                .map(requestIdentity)}
              canOperate={this.props.canOperate}
              canManage={this.props.canManage}
              mutate={this.props.mutate}
              onAccepted={this.load.bind(this, null)}
            />
          ))}
        {state.demand.kind === "inactive" && (
          <div>
            <p>Production requests have not been set up.</p>
            {this.props.canManage && (
              <button
                disabled={state.work.kind !== "idle"}
                onClick={this.setup.bind(this)}
              >
                Set up production requests
              </button>
            )}
          </div>
        )}
        {state.demand.kind === "unavailable" && (
          <p role="alert">Production requests could not be loaded.</p>
        )}
        {state.demand.kind === "ready" &&
          state.demand.invalidRequests.length > 0 && (
            <div role="alert">
              <p>Some stored requests need correction:</p>
              <ul>{state.demand.invalidRequests.map(invalidRequestNotice)}</ul>
            </div>
          )}
        {state.demand.kind === "ready" &&
          (requests.length === 0 ? (
            <p>No production requests. Start from a shortage in Products.</p>
          ) : (
            <ul className="stock-production-requests">
              {requests.map(this.renderRequest.bind(this))}
            </ul>
          ))}
        {state.continuation === "restart_required" && (
          <div>
            <p role="status">
              Requests changed. Refresh requests to continue loading.
            </p>
            <button
              type="button"
              disabled={
                state.work.kind !== "idle" && state.work.kind !== "retry"
              }
              onClick={this.load.bind(this, null)}
            >
              Refresh requests
            </button>
          </div>
        )}
        {state.work.kind === "retry" && (
          <div>
            <p role="alert">{state.work.message}</p>
            <button type="button" onClick={this.retryLoad.bind(this)}>
              {state.work.cursor === null
                ? "Retry refresh"
                : "Retry loading more"}
            </button>
          </div>
        )}
        {(state.work.kind === "idle" || state.work.kind === "loading") &&
          state.continuation === "current" &&
          state.demand.kind === "ready" &&
          state.demand.nextCursor !== null && (
            <button
              type="button"
              disabled={state.work.kind === "loading"}
              onClick={this.loadMore.bind(this)}
            >
              {state.work.kind === "loading"
                ? "Loading requests…"
                : "Load more requests"}
            </button>
          )}
        {state.work.kind === "loading" && state.work.cursor === null && (
          <p role="status">Refreshing requests…</p>
        )}
        {(state.work.kind === "pending" || state.work.kind === "settled") && (
          <button type="button" onClick={this.retryAction.bind(this)}>
            {state.work.kind === "pending"
              ? "Check update result"
              : "Reload accepted request"}
          </button>
        )}
        {state.message !== null && <p role="alert">{state.message}</p>}
      </section>
    );
  }
}

function productionRequestStatus(
  status: InventoryProductionRequest["status"],
): StatusChipStatus {
  switch (status) {
    case "requested":
      return { kind: "warning", label: "Needs acceptance" };
    case "accepted":
      return { kind: "info", label: "Accepted" };
    case "scheduled":
      return { kind: "success", label: "Scheduled" };
    default:
      return assertNever(status, "Unknown production request status");
  }
}

function productionPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/inventory/production-requests`;
}

function productionError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Production could not be updated.";
}

function recipeMatches(id: string, recipe: InventoryProductionRecipe): boolean {
  return recipe.id === id;
}

function recipeItem(recipe: InventoryProductionRecipe) {
  return {
    value: recipe.id,
    label: `${recipe.name} · revision ${recipe.revision}`,
  };
}

function recipeOption(recipe: InventoryProductionRecipe) {
  return (
    <Select.Item key={recipe.id} value={recipe.id}>
      {recipe.name} · revision {recipe.revision}
    </Select.Item>
  );
}

function completedBatch(batch: InventoryProductionRequest["batches"][number]) {
  return (
    <li key={batch.id}>
      Confirmed batch {batch.id}:{" "}
      {batch.actualYield.amount / 10 ** batch.actualYield.scale}{" "}
      {batch.actualYield.unit} produced.
    </li>
  );
}

function ingredientReview(
  recipe: InventoryProductionRecipe,
  requested: string,
  input: InventoryProductionRecipe["inputs"][number],
) {
  const batches =
    requested.trim() === ""
      ? NaN
      : Math.ceil(
          Number(requested) / (recipe.yield.amount / 10 ** recipe.yield.scale),
        );
  const required =
    (input.quantity.amount / 10 ** input.quantity.scale) * batches;
  const available =
    input.available === null
      ? null
      : input.available.amount / 10 ** input.available.scale;
  const compatible =
    input.available !== null && input.available.unit === input.quantity.unit;
  const shortage =
    Number.isFinite(required) &&
    (!compatible || available === null || available < required);
  return (
    <tr key={input.name}>
      <th scope="row">{input.name}</th>
      <td>
        {Number.isFinite(required)
          ? formatProductionQuantity(required, input.quantity.unit)
          : "—"}
      </td>
      <td>
        <span className="stock-dialog-availability" data-shortage={shortage}>
          {input.available === null
            ? "Unknown"
            : formatProductionQuantity(
                input.available.amount / 10 ** input.available.scale,
                input.available.unit,
              )}
          {shortage && <small>{compatible ? "Short" : "Check stock"}</small>}
        </span>
      </td>
    </tr>
  );
}

function formatProductionQuantity(
  amount: number,
  unit: Quantity["unit"],
): string {
  const labels = {
    each: "each",
    gram: "g",
    kilogram: "kg",
    milliliter: "ml",
    liter: "L",
  };
  return `${amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${labels[unit]}`;
}

function productionRequestsPath(
  organisationId: string,
  cursor: string | null,
): string {
  const selected = new URLSearchParams(window.location.search);
  const query = new URLSearchParams();
  for (const name of ["inventoryItem", "location"]) {
    const value = selected.get(name);
    if (value !== null) {
      query.set(name, value);
    }
  }
  if (cursor !== null) {
    query.set("cursor", cursor);
  }
  return `${productionPath(organisationId)}${query.size === 0 ? "" : `?${query}`}`;
}

function selectedLocation(): string | null {
  return new URLSearchParams(window.location.search).get("location");
}

/** The locations whose requests wait for acceptance, for the plan links. */
function planLocations(
  requests: readonly InventoryProductionRequest[],
): string[] {
  const locations = new Set<string>();
  for (const request of requests) {
    if (request.status === "requested") {
      locations.add(request.locationId);
    }
  }
  return [...locations].sort();
}

function planLocationLink(locationId: string): React.ReactNode {
  return (
    <Link key={locationId} to={`?location=${encodeURIComponent(locationId)}`}>
      Plan for {locationId}
    </Link>
  );
}

function waitsAtLocation(
  locationId: string,
  request: InventoryProductionRequest,
): boolean {
  return request.status === "requested" && request.locationId === locationId;
}

function settledAtLocation(
  locationId: string,
  request: InventoryProductionRequest,
): boolean {
  return request.status !== "requested" && request.locationId === locationId;
}

function requestIdentity(request: InventoryProductionRequest): string {
  return request.id;
}

function replaceProductionRequest(
  updated: InventoryProductionRequest,
  current: InventoryProductionRequest,
): InventoryProductionRequest {
  return current.id === updated.id ? updated : current;
}

function creationDraft(body: InventoryProductionCreation): Draft {
  return {
    recipe: body.recipeId,
    quantity: String(body.quantity.amount / 10 ** body.quantity.scale),
    neededBy: neededByDateInput(new Date(body.neededBy)),
  };
}

function invalidRequestNotice(request: {
  id: string;
  message: string;
}): React.ReactNode {
  return (
    <li key={request.id}>
      <code>{request.id}</code> — {request.message}
    </li>
  );
}

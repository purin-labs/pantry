import React from "react";
import { Link, useBlocker } from "react-router";
import { DraftLeaveDialog } from "../collaboration/draft-leave-dialog";
import type { RecipeRevision } from "@purin-labs/commerce-contracts";
import {
  calculateBakeryCostsAndMargins,
  parseCostsOverview,
  parseRecipeCollection,
  type CalculatedRecipeCost,
  type RecipeCollection,
} from "@purin-labs/control-api";
import { controlRead } from "../../control-client";
import { formatMoneyMinor } from "../../formatting";
import { costsPath } from "../costs/api";
import {
  recipesPath,
  quantityText,
  recipeError,
  type RecipeMutation,
} from "./api";
import { PageSkeleton, RecoverableError } from "../../page-components";
import { RecipeEditor } from "./editor";
import "./styles.css";
import type { Variant } from "@purin-labs/type-utils";

type Props = Readonly<{
  organisationId: string;
  canEdit: boolean;
  mutate: RecipeMutation;
  costsHref?: string;
}>;
type State =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      collection: RecipeCollection;
      recipeCosts: ReadonlyMap<string, CalculatedRecipeCost>;
      currency: string;
      query: string;
      selected: RecipeRevision | null;
      editor: "closed" | "open";
      notice: string;
    };

class RecipesWorkspace extends React.Component<Props, State> {
  state: State = { kind: "loading" };
  private mounted = false;
  readonly editorRef = React.createRef<RecipeEditor>();
  hasUnsavedChanges(): boolean {
    return this.editorRef.current?.hasUnsavedChanges() ?? false;
  }
  componentDidMount(): void {
    this.mounted = true;
    void this.load();
  }
  componentWillUnmount(): void {
    this.mounted = false;
  }
  private async load(): Promise<void> {
    this.setState({ kind: "loading" });
    try {
      const [rawRecipes, rawCosts] = await Promise.all([
        controlRead(recipesPath(this.props.organisationId)),
        controlRead(costsPath(this.props.organisationId)).catch(() => null),
      ]);
      const collection = parseRecipeCollection(rawRecipes);
      let currency = "JPY";
      const recipeCosts = new Map<string, CalculatedRecipeCost>();
      if (rawCosts !== null) {
        try {
          const overview = parseCostsOverview(rawCosts);
          currency = overview.currency;
          const calculated = calculateBakeryCostsAndMargins({ overview });
          for (const entry of calculated.recipes) {
            recipeCosts.set(entry.recipeId, entry);
          }
        } catch {
          // Keep recipes available even when cost terms are not ready.
        }
      }
      if (this.mounted)
        this.setState({
          kind: "ready",
          collection,
          recipeCosts,
          currency,
          query: "",
          selected: null,
          editor: "closed",
          notice: "",
        });
    } catch (error) {
      if (this.mounted)
        this.setState({ kind: "failed", message: recipeError(error) });
    }
  }
  private search(event: React.ChangeEvent<HTMLInputElement>): void {
    if (this.state.kind === "ready")
      this.setState(
        readyState(
          this.state,
          this.state.collection,
          event.currentTarget.value,
          this.state.selected,
          "closed",
          "",
        ),
      );
  }
  private select(recipe: RecipeRevision): void {
    if (this.state.kind === "ready")
      this.setState(
        readyState(
          this.state,
          this.state.collection,
          this.state.query,
          recipe,
          "closed",
          "",
        ),
      );
  }
  private create(): void {
    if (this.state.kind === "ready")
      this.setState(
        readyState(
          this.state,
          this.state.collection,
          this.state.query,
          null,
          "open",
          "",
        ),
      );
  }
  private edit(): void {
    if (this.state.kind === "ready")
      this.setState(
        readyState(
          this.state,
          this.state.collection,
          this.state.query,
          this.state.selected,
          "open",
          "",
        ),
      );
  }
  private close(): void {
    if (this.state.kind === "ready")
      this.setState(
        readyState(
          this.state,
          this.state.collection,
          this.state.query,
          this.state.selected,
          "closed",
          "",
        ),
      );
  }
  private saved(collection: RecipeCollection, recipeId: string): void {
    if (this.state.kind !== "ready") return;
    const selected =
      collection.recipes.find(recipeHasId.bind(null, recipeId)) ?? null;
    this.setState(
      readyState(
        this.state,
        collection,
        this.state.query,
        selected,
        "closed",
        "Recipe saved.",
      ),
    );
  }
  private itemName(id: string): string {
    if (this.state.kind !== "ready") return id;
    return (
      this.state.collection.items.find(itemHasId.bind(null, id))?.name ?? id
    );
  }
  private row(recipe: RecipeRevision): React.ReactNode {
    const selected =
      this.state.kind === "ready" &&
      this.state.selected?.recipeId === recipe.recipeId;
    const cost =
      this.state.kind === "ready"
        ? this.state.recipeCosts.get(recipe.recipeId)
        : undefined;
    const currency = this.state.kind === "ready" ? this.state.currency : "JPY";
    return (
      <li key={recipe.recipeId}>
        <button
          type="button"
          className="recipe-list-item"
          aria-pressed={selected}
          onClick={this.select.bind(this, recipe)}
        >
          <strong>{recipe.name}</strong>
          <span>
            {recipe.output.kind === "stocked"
              ? `${quantityText(recipe.output.yieldQuantity)} ${recipe.output.yieldQuantity.unit} per batch`
              : "Made to order"}{" "}
            · Revision {recipe.revision}
          </span>
          <small>
            {recipe.inputs.length} ingredients · {recipe.lifecycle.state}
            {cost !== undefined && cost.missingCostItemIds.length === 0
              ? ` · ${formatMoneyMinor(cost.totalBatchCostMinor, currency)} batch · ${formatMoneyMinor(cost.rawUnitCostMinor, currency)} / unit`
              : ""}
          </small>
        </button>
      </li>
    );
  }
  private ingredient(input: RecipeRevision["inputs"][number]): React.ReactNode {
    return (
      <tr key={input.inventoryItemId}>
        <th scope="row">{this.itemName(input.inventoryItemId)}</th>
        <td>
          {quantityText(input.quantity)} {input.quantity.unit}
        </td>
      </tr>
    );
  }
  render(): React.ReactNode {
    const state = this.state;
    if (state.kind === "loading")
      return <PageSkeleton label="Loading recipes" />;
    if (state.kind === "failed")
      return (
        <RecoverableError
          message={state.message}
          action={<button onClick={this.load.bind(this)}>Try again</button>}
        />
      );
    if (state.editor === "open")
      return (
        <RecipeEditor
          ref={this.editorRef}
          organisationId={this.props.organisationId}
          collection={state.collection}
          source={state.selected}
          mutate={this.props.mutate}
          saved={this.saved.bind(this)}
          cancel={this.close.bind(this)}
        />
      );
    const visible = state.collection.recipes.filter(
      matchesQuery.bind(null, state.query),
    );
    const selected = state.selected;
    return (
      <section className="recipes-page" aria-label="Recipes">
        <header className="recipes-toolbar">
          <div>
            <h2>Recipe library</h2>
            <p>
              {state.collection.recipes.length}{" "}
              {state.collection.recipes.length === 1 ? "recipe" : "recipes"}
            </p>
          </div>
          <div className="recipes-actions">
            {this.props.costsHref !== undefined && (
              <Link to={this.props.costsHref}>Costs & margins</Link>
            )}
            <button type="button" onClick={this.load.bind(this)}>
              Refresh
            </button>
            {this.props.canEdit && (
              <button className="primary-button" onClick={this.create.bind(this)}>
                Create recipe
              </button>
            )}
          </div>
        </header>
        <p role="status">{state.notice}</p>
        <label className="recipe-search">
          Search recipes
          <input
            type="search"
            value={state.query}
            onChange={this.search.bind(this)}
            placeholder="Search by name"
          />
        </label>
        <div className="recipes-workspace">
          <div>
            {visible.length === 0 ? (
              <p>
                {state.collection.recipes.length === 0
                  ? "No recipes yet. Create a recipe from your inventory ingredients."
                  : "No recipes match your search."}
              </p>
            ) : (
              <ul className="recipe-list">
                {visible.map(this.row.bind(this))}
              </ul>
            )}
          </div>
          <section className="recipe-detail" aria-label="Recipe details">
            {selected === null ? (
              <p>Select a recipe to see its ingredients and output.</p>
            ) : (
              <>
                <header className="recipes-toolbar">
                  <div>
                    <h2>{selected.name}</h2>
                    <p>
                      Revision {selected.revision} · {selected.lifecycle.state}
                    </p>
                  </div>
                  {this.props.canEdit && (
                    <button onClick={this.edit.bind(this)}>Edit recipe</button>
                  )}
                </header>
                <h3>Output</h3>
                <p>
                  {selected.output.kind === "stocked"
                    ? `${quantityText(selected.output.yieldQuantity)} ${selected.output.yieldQuantity.unit} of ${this.itemName(selected.output.inventoryItemId)} per batch`
                    : "Made to order for immediate service"}
                </p>
                <h3>Ingredients per batch</h3>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Ingredient</th>
                      <th scope="col">Quantity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.inputs.map(this.ingredient.bind(this))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        </div>
      </section>
    );
  }
}
function recipeHasId(id: string, recipe: RecipeRevision): boolean {
  return recipe.recipeId === id;
}
function itemHasId(
  id: string,
  item: RecipeCollection["items"][number],
): boolean {
  return item.id === id;
}
function matchesQuery(query: string, recipe: RecipeRevision): boolean {
  return recipe.name
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
}

function readyState(
  previous: Variant<State, "ready">,
  collection: RecipeCollection,
  query: string,
  selected: RecipeRevision | null,
  editor: "open" | "closed",
  notice: string,
): State {
  return {
    kind: "ready",
    collection,
    recipeCosts: previous.recipeCosts,
    currency: previous.currency,
    query,
    selected,
    editor,
    notice,
  };
}

export function RecipesPage(props: Props): React.ReactNode {
  const workspace = React.useRef<RecipesWorkspace | null>(null);
  const blocker = useBlocker(hasUnsavedRecipe.bind(null, workspace));
  return (
    <>
      <RecipesWorkspace ref={workspace} {...props} />
      {blocker.state === "blocked" && (
        <DraftLeaveDialog blocker={blocker} draftName="recipe" />
      )}
    </>
  );
}
function hasUnsavedRecipe(
  workspace: React.RefObject<RecipesWorkspace | null>,
): boolean {
  return workspace.current?.hasUnsavedChanges() ?? false;
}

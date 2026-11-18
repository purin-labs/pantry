import { isRecord } from "@seams/std";
import { parseMutationResult } from "@seams/commerce-client";
import React from "react";
import type { RecipeRevision } from "@seams/contracts";
import {
  parseInventoryQuantityText,
  parseRecipeCollection,
  parseRecipeWrite,
  type RecipeCollection,
  type RecipeItem,
  type RecipeWrite,
} from "@seams/control-api";
import { controlRead, ControlApiError } from "../../control-client";
import { Select } from "../../ui/select";
import {
  recipesPath,
  recipeError,
  quantityText,
  type RecipeMutation,
} from "./api";

type Ingredient = Readonly<{ key: string; itemId: string; amount: string }>;
type Output =
  | { kind: "immediate"; itemId?: never; amount?: never }
  | { kind: "stocked"; itemId: string; amount: string };
type Draft = Readonly<{
  name: string;
  ingredients: readonly Ingredient[];
  output: Output;
}>;
type Submission = Readonly<{ body: RecipeWrite; key: string }>;
type Operation =
  | { kind: "idle" }
  | { kind: "saving"; submission: Submission }
  | { kind: "uncertain"; submission: Submission; message: string }
  | { kind: "failed"; message: string }
  | { kind: "saved"; recipeId: string; message: string };
type Props = Readonly<{
  organisationId: string;
  collection: RecipeCollection;
  source: RecipeRevision | null;
  mutate: RecipeMutation;
  saved(collection: RecipeCollection, id: string): void;
  cancel(): void;
}>;
type State = { draft: Draft; operation: Operation; dirty: boolean };

export class RecipeEditor extends React.Component<Props, State> {
  state: State = {
    draft: recipeDraft(this.props.source),
    operation: { kind: "idle" },
    dirty: false,
  };
  hasUnsavedChanges(): boolean {
    return this.state.dirty;
  }
  private readonly recipeId =
    this.props.source?.recipeId ?? `recipe_${crypto.randomUUID()}`;
  componentDidMount(): void {
    window.addEventListener("beforeunload", this.beforeUnload);
  }
  componentWillUnmount(): void {
    window.removeEventListener("beforeunload", this.beforeUnload);
  }
  private beforeUnload = (event: BeforeUnloadEvent): void => {
    if (this.state.dirty) event.preventDefault();
  };
  private change(draft: Draft): void {
    this.setState({ draft, dirty: true, operation: { kind: "idle" } });
  }
  private name(event: React.ChangeEvent<HTMLInputElement>): void {
    this.change({ ...this.state.draft, name: event.currentTarget.value });
  }
  private add(): void {
    this.change({
      ...this.state.draft,
      ingredients: [...this.state.draft.ingredients, blankIngredient()],
    });
  }
  private remove(key: string): void {
    this.change({
      ...this.state.draft,
      ingredients: this.state.draft.ingredients.filter(
        otherIngredient.bind(null, key),
      ),
    });
  }
  private ingredient(
    key: string,
    field: "itemId" | "amount",
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    this.ingredientValue(key, field, event.currentTarget.value);
  }
  private ingredientValue(
    key: string,
    field: "itemId" | "amount",
    value: string | null,
  ): void {
    if (value === null) return;
    this.change({
      ...this.state.draft,
      ingredients: this.state.draft.ingredients.map(
        changeIngredient.bind(null, key, field, value),
      ),
    });
  }
  private outputKind(value: string | null): void {
    if (value === null) return;
    this.change({
      ...this.state.draft,
      output:
        value === "stocked"
          ? { kind: "stocked", itemId: "", amount: "" }
          : { kind: "immediate" },
    });
  }
  private output(
    field: "itemId" | "amount",
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    this.outputValue(field, event.currentTarget.value);
  }
  private outputValue(field: "itemId" | "amount", value: string | null): void {
    const output = this.state.draft.output;
    if (output.kind === "stocked" && value !== null)
      this.change({
        ...this.state.draft,
        output: {
          kind: "stocked",
          itemId: field === "itemId" ? value : output.itemId,
          amount: field === "amount" ? value : output.amount,
        },
      });
  }
  private cancel(): void {
    if (!this.state.dirty || window.confirm("Discard unsaved recipe changes?"))
      this.props.cancel();
  }
  private async save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (this.state.operation.kind === "saving") return;
    let submission: Submission;
    try {
      submission =
        this.state.operation.kind === "uncertain"
          ? this.state.operation.submission
          : {
              body: writeRecipe(this.props, this.recipeId, this.state.draft),
              key: crypto.randomUUID(),
            };
    } catch (error) {
      this.setState({
        operation: { kind: "failed", message: recipeError(error) },
      });
      return;
    }
    this.setState({ operation: { kind: "saving", submission } });
    try {
      const response = await this.props.mutate(
        recipesPath(this.props.organisationId),
        submission.body,
        { kind: "prepared", idempotencyKey: submission.key },
      );
      if (!isRecord(response) || response.ok !== true)
        throw new Error("The save receipt is unavailable.");
      const result = parseMutationResult(response.result);
      if (result.outcome === "rejected")
        throw new Error("The recipe was refused.");
    } catch (error) {
      if (
        error instanceof ControlApiError &&
        (error.kind === "commerce_revision_conflict" ||
          error.kind === "idempotency_key_conflict" ||
          error.kind === "forbidden")
      ) {
        this.setState({
          operation: {
            kind: "failed",
            message:
              "The recipe could not be saved. Return to the library and refresh before you retry. Your changes remain here.",
          },
        });
      } else
        this.setState({
          operation: {
            kind: "uncertain",
            submission,
            message:
              "The save result is unknown. Retry the same save to check its result.",
          },
        });
      return;
    }
    this.setState({
      dirty: false,
      operation: {
        kind: "saved",
        recipeId: this.recipeId,
        message: "Recipe saved. Refresh the library to see it.",
      },
    });
    await this.refresh();
  }
  private async refresh(): Promise<void> {
    try {
      const collection = parseRecipeCollection(
        await controlRead(recipesPath(this.props.organisationId)),
      );
      this.props.saved(collection, this.recipeId);
    } catch (error) {
      this.setState({
        operation: {
          kind: "saved",
          recipeId: this.recipeId,
          message: `Recipe saved. ${recipeError(error)}`,
        },
      });
    }
  }
  private ingredientRow(
    ingredient: Ingredient,
    index: number,
  ): React.ReactNode {
    const item = this.props.collection.items.find(
      itemWithId.bind(null, ingredient.itemId),
    );
    return (
      <div className="recipe-ingredient" key={ingredient.key}>
        <label>
          Ingredient {index + 1}
          <Select.Root
            required
            items={[
              { value: "", label: "Choose an ingredient" },
              ...this.props.collection.items.map(recipeItem),
            ]}
            value={ingredient.itemId}
            onValueChange={this.ingredientValue.bind(
              this,
              ingredient.key,
              "itemId",
            )}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>
              <Select.Item value="">Choose an ingredient</Select.Item>
              {this.props.collection.items.map(itemOption)}
            </Select.Popup>
          </Select.Root>
        </label>
        <label>
          Quantity ({item?.baseUnit ?? "select ingredient"})
          <input
            required
            inputMode="decimal"
            value={ingredient.amount}
            onChange={this.ingredient.bind(this, ingredient.key, "amount")}
          />
        </label>
        <button
          type="button"
          aria-label={`Remove ingredient ${index + 1}`}
          onClick={this.remove.bind(this, ingredient.key)}
        >
          Remove
        </button>
      </div>
    );
  }
  render(): React.ReactNode {
    const { draft, operation } = this.state;
    const locked =
      operation.kind === "saving" ||
      operation.kind === "uncertain" ||
      operation.kind === "saved";
    const outputItem =
      draft.output.kind === "stocked"
        ? this.props.collection.items.find(
            itemWithId.bind(null, draft.output.itemId),
          )
        : undefined;
    return (
      <section
        className="recipes-page recipe-editor"
        aria-label="Recipe editor"
      >
        <header>
          <h2>
            {this.props.source === null
              ? "Create recipe"
              : `Edit ${this.props.source.name}`}
          </h2>
          <p>
            Save a new revision. Existing menus and production requests keep
            their selected revision.
          </p>
        </header>
        <form onSubmit={this.save.bind(this)}>
          <fieldset disabled={locked}>
            <label>
              Recipe name
              <input
                autoFocus
                required
                maxLength={200}
                value={draft.name}
                onChange={this.name.bind(this)}
              />
            </label>
            <h3>Output</h3>
            <label>
              Output type
              <Select.Root
                items={OUTPUT_KINDS}
                value={draft.output.kind}
                onValueChange={this.outputKind.bind(this)}
              >
                <Select.Trigger>
                  <Select.Value />
                </Select.Trigger>
                <Select.Popup>
                  {OUTPUT_KINDS.map((kind) => (
                    <Select.Item key={kind.value} value={kind.value}>
                      {kind.label}
                    </Select.Item>
                  ))}
                </Select.Popup>
              </Select.Root>
            </label>
            {draft.output.kind === "stocked" && (
              <div className="recipe-output">
                <label>
                  Output inventory item
                  <Select.Root
                    required
                    items={[
                      { value: "", label: "Choose an item" },
                      ...this.props.collection.items.map(recipeItem),
                    ]}
                    value={draft.output.itemId}
                    onValueChange={this.outputValue.bind(this, "itemId")}
                  >
                    <Select.Trigger>
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Popup>
                      <Select.Item value="">Choose an item</Select.Item>
                      {this.props.collection.items.map(itemOption)}
                    </Select.Popup>
                  </Select.Root>
                </label>
                <label>
                  Batch yield ({outputItem?.baseUnit ?? "select item"})
                  <input
                    required
                    inputMode="decimal"
                    value={draft.output.amount}
                    onChange={this.output.bind(this, "amount")}
                  />
                </label>
              </div>
            )}
            <h3>Ingredients per batch</h3>
            <p>
              Use each inventory item's base unit. Each ingredient can appear
              once.
            </p>
            {draft.ingredients.map(this.ingredientRow.bind(this))}
            <button type="button" onClick={this.add.bind(this)}>
              Add ingredient
            </button>
          </fieldset>
          {operation.kind !== "idle" && operation.kind !== "saving" && (
            <p role={operation.kind === "saved" ? "status" : "alert"}>
              {operation.message}
            </p>
          )}
          <footer className="recipes-actions">
            <button
              type="button"
              disabled={
                operation.kind === "saving" || operation.kind === "uncertain"
              }
              onClick={this.cancel.bind(this)}
            >
              Cancel
            </button>
            {operation.kind === "saved" ? (
              <button type="button" onClick={this.refresh.bind(this)}>
                Refresh library
              </button>
            ) : (
              <button
                className="primary-button"
                type="submit"
                disabled={operation.kind === "saving"}
              >
                {operation.kind === "saving"
                  ? "Saving…"
                  : operation.kind === "uncertain"
                    ? "Retry save"
                    : "Save recipe"}
              </button>
            )}
          </footer>
        </form>
      </section>
    );
  }
}
function blankIngredient(): Ingredient {
  return { key: crypto.randomUUID(), itemId: "", amount: "" };
}
function ingredientDraft(input: RecipeRevision["inputs"][number]): Ingredient {
  return {
    key: crypto.randomUUID(),
    itemId: input.inventoryItemId,
    amount: quantityText(input.quantity),
  };
}
function recipeDraft(source: RecipeRevision | null): Draft {
  if (source === null)
    return {
      name: "",
      ingredients: [blankIngredient()],
      output: { kind: "immediate" },
    };
  return {
    name: source.name,
    ingredients: source.inputs.map(ingredientDraft),
    output:
      source.output.kind === "immediate"
        ? { kind: "immediate" }
        : {
            kind: "stocked",
            itemId: source.output.inventoryItemId,
            amount: quantityText(source.output.yieldQuantity),
          },
  };
}
function itemWithId(id: string, item: RecipeItem): boolean {
  return item.id === id;
}
const OUTPUT_KINDS = [
  { value: "immediate", label: "Made to order" },
  { value: "stocked", label: "Add finished stock" },
];
function recipeItem(item: RecipeItem): { value: string; label: string } {
  return {
    value: item.id,
    label: `${item.name} · ${item.baseUnit}${item.lifecycle === "active" ? "" : " (inactive)"}`,
  };
}
function itemOption(item: RecipeItem): React.ReactNode {
  return (
    <Select.Item
      key={item.id}
      value={item.id}
      disabled={item.lifecycle !== "active"}
    >
      {item.name} · {item.baseUnit}
      {item.lifecycle === "active" ? "" : " (inactive)"}
    </Select.Item>
  );
}
function otherIngredient(key: string, ingredient: Ingredient): boolean {
  return ingredient.key !== key;
}
function changeIngredient(
  key: string,
  field: "itemId" | "amount",
  value: string,
  ingredient: Ingredient,
): Ingredient {
  if (ingredient.key !== key) return ingredient;
  return {
    key,
    itemId: field === "itemId" ? value : ingredient.itemId,
    amount: field === "amount" ? value : ingredient.amount,
  };
}
function requireItem(items: RecipeCollection["items"], id: string): RecipeItem {
  const item = items.find(itemWithId.bind(null, id));
  if (item === undefined || item.lifecycle !== "active")
    throw new Error("Choose an active inventory item.");
  return item;
}
function ingredientInput(
  items: RecipeCollection["items"],
  ingredient: Ingredient,
): RecipeRevision["inputs"][number] {
  const item = requireItem(items, ingredient.itemId);
  return {
    inventoryItemId: item.id,
    quantity: parseInventoryQuantityText(ingredient.amount, item.baseUnit),
  };
}
function writeRecipe(
  props: Props,
  recipeId: string,
  draft: Draft,
): RecipeWrite {
  let output: RecipeRevision["output"] = { kind: "immediate" };
  if (draft.output.kind === "stocked") {
    const item = requireItem(props.collection.items, draft.output.itemId);
    output = {
      kind: "stocked",
      inventoryItemId: item.id,
      yieldQuantity: parseInventoryQuantityText(
        draft.output.amount,
        item.baseUnit,
      ),
    };
  }
  const recipe = {
    recipeId,
    name: draft.name.trim(),
    inputs: draft.ingredients.map(
      ingredientInput.bind(null, props.collection.items),
    ),
    output,
  };
  return parseRecipeWrite(
    props.source === null
      ? {
          kind: "create",
          merchantRevision: props.collection.merchantRevision,
          requestedAt: new Date().toISOString(),
          recipe,
        }
      : {
          kind: "edit",
          merchantRevision: props.collection.merchantRevision,
          expectedRecipeRevision: props.source.revision,
          requestedAt: new Date().toISOString(),
          recipe,
        },
  );
}

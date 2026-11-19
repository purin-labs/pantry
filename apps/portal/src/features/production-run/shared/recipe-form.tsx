import React from "react";
import { errorMessage } from "@purin-labs/std";
import { Select } from "../../../ui/select";

type Choice<Value extends string> = Readonly<{ value: Value; label: string }>;

/** One item of a recipe dropdown. */
export function renderChoice(item: Choice<string>): React.ReactNode {
  return (
    <Select.Item key={item.value} value={item.value}>
      {item.label}
    </Select.Item>
  );
}

/** A labelled dropdown of a recipe author or a scenario form. */
export function RecipeChoice<Value extends string>(
  props: Readonly<{
    label: React.ReactNode;
    items: readonly Choice<Value>[];
    value: Value;
    choose(value: Value): void;
    /** The trigger's own accessible name, when the label does not give it. */
    triggerLabel?: string;
  }>,
): React.ReactNode {
  return (
    <label>
      {props.label}
      <Select.Root
        items={props.items}
        value={props.value}
        onValueChange={(value) => {
          if (value !== null) {
            props.choose(value);
          }
        }}
      >
        <Select.Trigger aria-label={props.triggerLabel}>
          <Select.Value />
        </Select.Trigger>
        <Select.Popup>{props.items.map(renderChoice)}</Select.Popup>
      </Select.Root>
    </label>
  );
}

type Prepared<Source> =
  | Readonly<{ ok: true; value: Source }>
  | Readonly<{ ok: false; error: string }>;

/**
 * Prepares the recipe of an author form. A refusal or an error returns its
 * reason; an author that closed meanwhile shows nothing.
 */
export async function prepareRecipe<Source>(
  author: Readonly<{
    mounted(): boolean;
    prepared(source: Source): void;
    failed(notice: string): void;
  }>,
  prepare: () => Promise<Prepared<Source>>,
  fallback = "The recipe could not be prepared.",
): Promise<void> {
  try {
    const result = await prepare();
    if (!author.mounted()) {
      return;
    }
    if (result.ok) {
      author.prepared(result.value);
    } else {
      author.failed(result.error);
    }
  } catch (error) {
    if (author.mounted()) {
      author.failed(errorMessage(error, fallback));
    }
  }
}

/** The scenario form of a recipe workspace: its fields, the submit button and the notice. */
export function RecipeScenarioForm(
  props: Readonly<{
    label?: string;
    notice: string;
    /** The submit button's words; "Apply scenario" when none. */
    submit?: string;
    apply(): void;
    children: React.ReactNode;
  }>,
): React.ReactNode {
  return (
    <form
      aria-label={props.label}
      onSubmit={(event) => {
        event.preventDefault();
        props.apply();
      }}
    >
      {props.children}
      <button type="submit">{props.submit ?? "Apply scenario"}</button>
      <p role="status">{props.notice}</p>
    </form>
  );
}

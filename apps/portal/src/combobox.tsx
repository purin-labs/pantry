import React from "react";

/**
 * The typeahead resource picker. Long provider lists (channels, accounts,
 * catalogs) are unusable as a native `<select>`: the operator cannot type to
 * narrow them, and a disabled option gives no reason for being unreachable.
 *
 * The accessibility contract is the one the workspace command palette already
 * proves: a text input owning `role="combobox"`, a listbox it controls, and
 * `aria-activedescendant` moving through options while focus stays in the
 * input. Selection is mirrored into a hidden input so the surrounding form
 * submits the canonical value rather than the visible label.
 */

export type ComboboxOption = {
  readonly value: string;
  readonly label: string;
  /** Secondary text shown after the label and included in matching. */
  readonly detail: string | null;
  /** A resource the workspace can no longer reach; shown, never selectable. */
  readonly unavailable: boolean;
};

type ComboboxProps = {
  readonly id: string;
  /** Field name the surrounding form reads the canonical value from. */
  readonly name: string;
  readonly options: readonly ComboboxOption[];
  readonly defaultValue: string;
  readonly placeholder: string;
  /** Shown when the query matches nothing, or when there is nothing to match. */
  readonly emptyLabel: string;
  readonly invalid: boolean;
  readonly describedBy: string | undefined;
  readonly disabled: boolean;
  readonly onSelect: ((value: string) => void) | null;
};

type ComboboxState = {
  readonly query: string;
  readonly open: boolean;
  /**
   * While the list is open the field belongs to the query, not to the
   * selection: leaving the settled label in the box makes the first keystroke
   * append to it, which matches nothing.
   */
  readonly editing: boolean;
  readonly activeIndex: number;
  /** null while the operator is typing a query that has selected nothing. */
  readonly selected: ComboboxOption | null;
};

export function Combobox(props: ComboboxProps): React.ReactNode {
  const initial = findOptionByValue(props.options, props.defaultValue);
  const [state, setState] = React.useState<ComboboxState>({
    query: "",
    open: false,
    editing: false,
    activeIndex: 0,
    selected: initial,
  });
  const container = React.useRef<HTMLDivElement>(null);
  const listboxId = `${props.id}-listbox`;
  // A query only filters once the operator types; reopening a settled field
  // shows the whole list rather than just the current selection.
  const matches = filterOptions(props.options, state.query);
  React.useEffect(bindOutsidePointerDown.bind(null, container, setState), []);
  return (
    <div className="combobox" ref={container}>
      <input
        type="hidden"
        name={props.name}
        value={state.selected?.value ?? ""}
      />
      <input
        id={props.id}
        className="combobox-input"
        type="text"
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        disabled={props.disabled}
        placeholder={props.placeholder}
        value={visibleText(state)}
        aria-expanded={state.open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId(props.id, matches, state)}
        aria-invalid={props.invalid ? true : undefined}
        aria-describedby={props.describedBy}
        onChange={changeQuery.bind(null, setState)}
        onFocus={openList.bind(null, setState)}
        onClick={openList.bind(null, setState)}
        onKeyDown={handleKeyDown.bind(null, props, matches, state, setState)}
      />
      <ComboboxCaret />
      {state.open ? (
        <div
          className="combobox-listbox"
          id={listboxId}
          role="listbox"
          aria-label={props.placeholder}
        >
          {matches.length === 0 ? (
            <p className="combobox-empty">{props.emptyLabel}</p>
          ) : (
            matches.map(renderOption.bind(null, props, state, setState))
          )}
        </div>
      ) : null}
    </div>
  );
}

function renderOption(
  props: ComboboxProps,
  state: ComboboxState,
  setState: React.Dispatch<React.SetStateAction<ComboboxState>>,
  option: ComboboxOption,
  index: number,
): React.ReactNode {
  const active = state.activeIndex === index;
  const selected = state.selected?.value === option.value;
  return (
    <button
      type="button"
      key={option.value}
      id={optionId(props.id, option)}
      className={optionClassName(active, option.unavailable)}
      role="option"
      aria-selected={selected}
      aria-disabled={option.unavailable ? true : undefined}
      tabIndex={-1}
      onMouseMove={setActiveIndex.bind(null, setState, index)}
      onClick={chooseOption.bind(null, props, setState, option)}
    >
      <span className="combobox-option-label">{option.label}</span>
      {option.detail === null ? null : <small>{option.detail}</small>}
      {option.unavailable ? (
        <small className="combobox-option-note">Unavailable</small>
      ) : null}
    </button>
  );
}

function optionClassName(active: boolean, unavailable: boolean): string {
  const names = ["combobox-option"];
  if (active) names.push("combobox-option-active");
  if (unavailable) names.push("combobox-option-unavailable");
  return names.join(" ");
}

/**
 * A settled field reads as its label; an open one reads as whatever is being
 * typed, so the placeholder and the full list are available on the first
 * keystroke.
 */
function visibleText(state: ComboboxState): string {
  if (state.editing) return state.query;
  return state.selected === null ? "" : state.selected.label;
}

function filterOptions(
  options: readonly ComboboxOption[],
  query: string,
): readonly ComboboxOption[] {
  const terms = query.toLowerCase().split(/\s+/u).filter(isSearchTerm);
  if (terms.length === 0) return options;
  return options.filter(optionMatchesTerms.bind(null, terms));
}

function isSearchTerm(term: string): boolean {
  return term.length > 0;
}

function optionMatchesTerms(
  terms: readonly string[],
  option: ComboboxOption,
): boolean {
  const haystack = `${option.label} ${option.detail ?? ""}`.toLowerCase();
  return terms.every(termAppearsIn.bind(null, haystack));
}

function termAppearsIn(haystack: string, term: string): boolean {
  return haystack.includes(term);
}

function findOptionByValue(
  options: readonly ComboboxOption[],
  value: string,
): ComboboxOption | null {
  for (const option of options) {
    if (option.value === value) return option;
  }
  return null;
}

function optionId(id: string, option: ComboboxOption): string {
  return `${id}-option-${option.value}`;
}

function activeOptionId(
  id: string,
  matches: readonly ComboboxOption[],
  state: ComboboxState,
): string | undefined {
  if (!state.open) return undefined;
  const option = matches[state.activeIndex];
  return option === undefined ? undefined : optionId(id, option);
}

function changeQuery(
  setState: React.Dispatch<React.SetStateAction<ComboboxState>>,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  const query = event.currentTarget.value;
  setState(applyQuery.bind(null, query));
}

function applyQuery(query: string, state: ComboboxState): ComboboxState {
  return { ...state, query, open: true, editing: true, activeIndex: 0 };
}

function openList(
  setState: React.Dispatch<React.SetStateAction<ComboboxState>>,
): void {
  setState(applyOpen);
}

function applyOpen(state: ComboboxState): ComboboxState {
  return state.open
    ? state
    : { ...state, open: true, editing: true, query: "", activeIndex: 0 };
}

function closeList(
  setState: React.Dispatch<React.SetStateAction<ComboboxState>>,
): void {
  setState(applyClose);
}

function applyClose(state: ComboboxState): ComboboxState {
  return { ...state, open: false, editing: false, query: "" };
}

function setActiveIndex(
  setState: React.Dispatch<React.SetStateAction<ComboboxState>>,
  index: number,
): void {
  setState(applyActiveIndex.bind(null, index));
}

function applyActiveIndex(index: number, state: ComboboxState): ComboboxState {
  return state.activeIndex === index ? state : { ...state, activeIndex: index };
}

function chooseOption(
  props: ComboboxProps,
  setState: React.Dispatch<React.SetStateAction<ComboboxState>>,
  option: ComboboxOption,
): void {
  if (option.unavailable) return;
  setState(applySelection.bind(null, option));
  if (props.onSelect !== null) props.onSelect(option.value);
}

function applySelection(
  option: ComboboxOption,
  state: ComboboxState,
): ComboboxState {
  return {
    ...state,
    selected: option,
    query: "",
    open: false,
    editing: false,
    activeIndex: 0,
  };
}

function handleKeyDown(
  props: ComboboxProps,
  matches: readonly ComboboxOption[],
  state: ComboboxState,
  setState: React.Dispatch<React.SetStateAction<ComboboxState>>,
  event: React.KeyboardEvent<HTMLInputElement>,
): void {
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      if (!state.open) {
        openList(setState);
        return;
      }
      setActiveIndex(setState, stepIndex(matches.length, state.activeIndex, 1));
      return;
    case "ArrowUp":
      event.preventDefault();
      setActiveIndex(
        setState,
        stepIndex(matches.length, state.activeIndex, -1),
      );
      return;
    case "Home":
      if (!state.open) return;
      event.preventDefault();
      setActiveIndex(setState, 0);
      return;
    case "End":
      if (!state.open) return;
      event.preventDefault();
      setActiveIndex(setState, Math.max(0, matches.length - 1));
      return;
    case "Enter": {
      if (!state.open) return;
      const option = matches[state.activeIndex];
      if (option === undefined) return;
      // Enter commits the highlighted option rather than submitting the form
      // that surrounds the field.
      event.preventDefault();
      chooseOption(props, setState, option);
      return;
    }
    case "Escape":
      if (!state.open) return;
      // Contained here so a combobox inside a dialog does not close it.
      event.preventDefault();
      event.stopPropagation();
      closeList(setState);
      return;
    case "Tab":
      closeList(setState);
      return;
    default:
      return;
  }
}

/** Wraps at both ends so a long channel list reaches its tail quickly. */
function stepIndex(count: number, activeIndex: number, delta: number): number {
  if (count === 0) return 0;
  return (activeIndex + delta + count) % count;
}

function bindOutsidePointerDown(
  container: React.RefObject<HTMLDivElement | null>,
  setState: React.Dispatch<React.SetStateAction<ComboboxState>>,
): () => void {
  const handler = closeOnOutsidePointerDown.bind(null, container, setState);
  document.addEventListener("pointerdown", handler);
  return removeOutsidePointerDown.bind(null, handler);
}

function closeOnOutsidePointerDown(
  container: React.RefObject<HTMLDivElement | null>,
  setState: React.Dispatch<React.SetStateAction<ComboboxState>>,
  event: PointerEvent,
): void {
  const node = container.current;
  if (
    node === null ||
    !(event.target instanceof Node) ||
    node.contains(event.target)
  )
    return;
  closeList(setState);
}

function removeOutsidePointerDown(
  handler: (event: PointerEvent) => void,
): void {
  document.removeEventListener("pointerdown", handler);
}

function ComboboxCaret(): React.ReactNode {
  return (
    <svg
      className="combobox-caret"
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2.5 4.5 6 8l3.5-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

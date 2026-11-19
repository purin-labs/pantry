import { Select } from "../../ui/select";
import React from "react";

import type { EvalSenderChoice } from "@purin-labs/control-api";

import { Notice } from "../../page-components";
import {
  canAddCriterion,
  canAddScenario,
  criterionKindLabel,
  EVAL_OUTCOMES,
  newCriterionDraft,
  newScenarioDraft,
  senderKey,
  type CriterionDraft,
  type ScenarioDraft,
} from "./eval-editor-model";
import { outcomeLabel } from "./evals-model";

/** The verified contacts that a scenario can name as its sender. */
export type SenderChoices =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; choices: readonly EvalSenderChoice[] }>;

const EDITOR_ID = "brain-eval-editor";

function scenarioFieldId(draft: ScenarioDraft): string {
  return `brain-scenario-${draft.scenarioId}`;
}

const CRITERION_KINDS: readonly CriterionDraft["kind"][] = [
  "outcome",
  "reply_includes",
  "reply_excludes",
];
const CRITERION_KIND_ITEMS = CRITERION_KINDS.map((kind) => ({
  value: kind,
  label: criterionKindLabel(kind),
}));
const OUTCOME_ITEMS = EVAL_OUTCOMES.map((outcome) => ({
  value: outcome,
  label: outcomeLabel(outcome),
}));
const SCENARIO_ROLES = [
  { value: "target", label: "The behaviour under test" },
  { value: "control", label: "A case that must stay the same" },
];

/**
 * The scenarios of one Eval as a form. A person adds, changes and removes
 * scenarios. Saving makes a new version to review: runs keep the reviewed
 * scenarios until someone accepts it.
 */
export function ScenarioEditor(props: {
  readonly drafts: readonly ScenarioDraft[];
  readonly senders: SenderChoices;
  readonly busy: boolean;
  /** What a person must correct before the scenarios can be saved. */
  readonly problem: string | null;
  readonly onChange: (drafts: readonly ScenarioDraft[]) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}): React.ReactNode {
  const { drafts } = props;
  const choices = props.senders.kind === "ready" ? props.senders.choices : [];
  const replace = (index: number, next: ScenarioDraft): void =>
    props.onChange(drafts.map((draft, at) => (at === index ? next : draft)));
  // The control that opened the form is gone, so the keyboard moves here.
  const form = React.useRef<HTMLFormElement>(null);
  React.useLayoutEffect(() => {
    form.current?.focus();
  }, []);
  // A field that was added takes the keyboard in the render that shows it.
  // A control that was removed gives it to the element named here.
  const focusNext = React.useRef<string | null>(null);
  React.useLayoutEffect(() => {
    if (focusNext.current === null) return;
    document.getElementById(focusNext.current)?.focus();
    focusNext.current = null;
  });
  const focusOn = (id: string): void => {
    focusNext.current = id;
  };
  return (
    <form
      ref={form}
      id={EDITOR_ID}
      tabIndex={-1}
      className="brain-form brain-eval-editor"
      aria-label="Scenarios of this eval"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave();
      }}
    >
      {props.senders.kind === "failed" ? (
        <Notice tone="warning" announcement="polite">
          {props.senders.message}
        </Notice>
      ) : null}
      {drafts.map((draft, index) => (
        <ScenarioFields
          key={draft.scenarioId}
          number={index + 1}
          draft={draft}
          choices={choices}
          loadingSenders={props.senders.kind === "loading"}
          removable={drafts.length > 1}
          disabled={props.busy}
          onChange={(next) => replace(index, next)}
          onFocus={focusOn}
          onRemove={() => {
            focusOn(EDITOR_ID);
            props.onChange(drafts.filter((_, at) => at !== index));
          }}
        />
      ))}
      <div className="proposal-decision">
        <button
          type="button"
          className="secondary"
          disabled={props.busy || !canAddScenario(drafts)}
          onClick={() => {
            const added = newScenarioDraft(drafts.at(-1), choices, Date.now());
            focusOn(`${scenarioFieldId(added)}-title`);
            props.onChange([...drafts, added]);
          }}
        >
          Add a scenario
        </button>
      </div>
      {props.problem === null ? null : (
        <Notice tone="warning" announcement="polite">
          {props.problem}
        </Notice>
      )}
      <p className="brain-muted">
        Saving makes a new version to review. Runs keep the reviewed scenarios
        until someone accepts it.
      </p>
      <div className="proposal-decision">
        <button
          type="submit"
          className="connection-primary-action"
          disabled={props.busy}
        >
          Save for review
        </button>
        <button
          type="button"
          className="secondary"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ScenarioFields(props: {
  readonly number: number;
  readonly draft: ScenarioDraft;
  readonly choices: readonly EvalSenderChoice[];
  readonly loadingSenders: boolean;
  readonly removable: boolean;
  readonly disabled: boolean;
  readonly onChange: (draft: ScenarioDraft) => void;
  /** Names the element that takes the keyboard after the next change. */
  readonly onFocus: (id: string) => void;
  readonly onRemove: () => void;
}): React.ReactNode {
  const { draft } = props;
  const id = scenarioFieldId(draft);
  const set = (change: Partial<ScenarioDraft>): void =>
    props.onChange({ ...draft, ...change });
  const known = props.choices.some(
    (choice) => senderKey(choice) === draft.sender,
  );
  const senderItems = [
    ...(known || draft.sender === ""
      ? []
      : [
          {
            value: draft.sender,
            label: props.loadingSenders
              ? "The contact that it names now"
              : "A contact that is no longer verified",
          },
        ]),
    ...props.choices.map((choice) => ({
      value: senderKey(choice),
      label: choice.address,
    })),
  ];
  const setCriterion = (index: number, next: CriterionDraft): void =>
    set({
      criteria: draft.criteria.map((criterion, at) =>
        at === index ? next : criterion,
      ),
    });
  return (
    <fieldset className="brain-scenario brain-scenario-fields">
      <legend>Scenario {props.number}</legend>
      <div className="brain-form-row">
        <div>
          <label htmlFor={`${id}-title`}>Title</label>
          <input
            id={`${id}-title`}
            required
            maxLength={160}
            value={draft.title}
            onChange={(event) => set({ title: event.target.value })}
          />
        </div>
        <div>
          <label htmlFor={`${id}-role`}>What it checks</label>
          <Select.Root
            items={SCENARIO_ROLES}
            value={draft.role}
            onValueChange={(value) => {
              if (value !== null)
                set({ role: value === "target" ? "target" : "control" });
            }}
          >
            <Select.Trigger id={`${id}-role`}>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>
              {SCENARIO_ROLES.map((item) => (
                <Select.Item key={item.value} value={item.value}>
                  {item.label}
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Root>
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-sender`}>The message is from</label>
        <Select.Root
          required
          items={senderItems}
          value={draft.sender === "" ? null : draft.sender}
          onValueChange={(value) => set({ sender: value ?? "" })}
        >
          <Select.Trigger
            id={`${id}-sender`}
            aria-describedby={`${id}-sender-hint`}
          >
            <Select.Value placeholder="Choose a verified contact" />
          </Select.Trigger>
          <Select.Popup>
            {senderItems.map((item) => (
              <Select.Item key={item.value} value={item.value}>
                {item.label}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
        <span className="brain-muted" id={`${id}-sender-hint`}>
          {props.loadingSenders
            ? "Reading the verified contacts of this mailbox."
            : known || draft.sender === ""
              ? "Only a verified contact of this mailbox can be the sender."
              : "This scenario cannot run until you choose a verified contact."}
        </span>
      </div>
      <div>
        <label htmlFor={`${id}-subject`}>Subject</label>
        <input
          id={`${id}-subject`}
          required
          maxLength={200}
          value={draft.subject}
          onChange={(event) => set({ subject: event.target.value })}
        />
      </div>
      <div>
        <label htmlFor={`${id}-body`}>Message</label>
        <textarea
          id={`${id}-body`}
          required
          rows={4}
          maxLength={4000}
          value={draft.body}
          onChange={(event) => set({ body: event.target.value })}
        />
      </div>
      <div className="brain-form-row">
        <div>
          <label htmlFor={`${id}-arrives`}>Arrives</label>
          <input
            id={`${id}-arrives`}
            type="datetime-local"
            required
            value={draft.arrives}
            onChange={(event) => set({ arrives: event.target.value })}
          />
        </div>
        <div>
          <label htmlFor={`${id}-timezone`}>Time zone</label>
          <input
            id={`${id}-timezone`}
            required
            maxLength={64}
            aria-describedby={`${id}-timezone-hint`}
            value={draft.timezone}
            onChange={(event) => set({ timezone: event.target.value })}
          />
          <span className="brain-muted" id={`${id}-timezone-hint`}>
            For example, Australia/Sydney.
          </span>
        </div>
      </div>
      <fieldset className="brain-criteria-fields">
        <legend>Expected results</legend>
        {draft.criteria.map((criterion, index) => (
          <div key={criterion.criterionId} className="brain-criterion-row">
            <label
              className="visually-hidden"
              htmlFor={`${id}-kind-${criterion.criterionId}`}
            >
              Kind of expected result {index + 1}
            </label>
            <Select.Root
              items={CRITERION_KIND_ITEMS}
              value={criterion.kind}
              onValueChange={(value) => {
                const kind = CRITERION_KINDS.find((entry) => entry === value);
                if (kind !== undefined)
                  setCriterion(index, { ...criterion, kind });
              }}
            >
              <Select.Trigger id={`${id}-kind-${criterion.criterionId}`}>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {CRITERION_KINDS.map((kind) => (
                  <Select.Item key={kind} value={kind}>
                    {criterionKindLabel(kind)}
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Root>
            <label
              className="visually-hidden"
              htmlFor={`${id}-value-${criterion.criterionId}`}
            >
              Expected result {index + 1}
            </label>
            {criterion.kind === "outcome" ? (
              <Select.Root
                items={OUTCOME_ITEMS}
                value={criterion.expected}
                onValueChange={(value) => {
                  const expected = EVAL_OUTCOMES.find(
                    (entry) => entry === value,
                  );
                  if (expected !== undefined)
                    setCriterion(index, { ...criterion, expected });
                }}
              >
                <Select.Trigger id={`${id}-value-${criterion.criterionId}`}>
                  <Select.Value />
                </Select.Trigger>
                <Select.Popup>
                  {EVAL_OUTCOMES.map((outcome) => (
                    <Select.Item key={outcome} value={outcome}>
                      {outcomeLabel(outcome)}
                    </Select.Item>
                  ))}
                </Select.Popup>
              </Select.Root>
            ) : (
              <input
                id={`${id}-value-${criterion.criterionId}`}
                required
                maxLength={200}
                placeholder="Words of the reply"
                value={criterion.text}
                onChange={(event) =>
                  setCriterion(index, {
                    ...criterion,
                    text: event.target.value,
                  })
                }
              />
            )}
            <button
              type="button"
              className="secondary"
              disabled={props.disabled || draft.criteria.length === 1}
              aria-label={`Remove expected result ${String(index + 1)} of scenario ${String(props.number)}`}
              onClick={() => {
                props.onFocus(`${id}-add-result`);
                set({
                  criteria: draft.criteria.filter((_, at) => at !== index),
                });
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="proposal-decision">
          <button
            type="button"
            className="secondary"
            id={`${id}-add-result`}
            disabled={props.disabled || !canAddCriterion(draft)}
            onClick={() => {
              const added = newCriterionDraft();
              props.onFocus(`${id}-kind-${added.criterionId}`);
              set({ criteria: [...draft.criteria, added] });
            }}
          >
            Add an expected result
          </button>
        </div>
      </fieldset>
      {props.removable ? (
        <div className="proposal-decision">
          <button
            type="button"
            className="secondary"
            disabled={props.disabled}
            onClick={props.onRemove}
          >
            Remove scenario {props.number}
          </button>
        </div>
      ) : null}
    </fieldset>
  );
}

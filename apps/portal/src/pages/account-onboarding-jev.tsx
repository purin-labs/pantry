import React from "react";
import { Link } from "react-router";
import type { JevFeature } from "@purin-labs/control-api/portal/jev-features";
import {
  changeJevFeature,
  jevFeatureErrorMessage,
} from "../features/jev-features/api";
import { organisationPath, workspacePagePath } from "../route";

/**
 * The optional Jev step of the setup (Plan 88 section 5). One choice turns on
 * the three Jev switches through Settings › Jev's own route. A switch that
 * cannot turn on says why, and the setup continues.
 */
export type JevSetupResult = readonly Readonly<{
  feature: JevFeature;
  label: string;
  /** Null when the switch is on; else the reason in one short sentence. */
  problem: string | null;
}>[];

export type JevSetupState =
  | Readonly<{ kind: "choose" }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "result"; result: JevSetupResult }>;

const FEATURES: readonly Readonly<{
  feature: JevFeature;
  label: string;
  sent: string;
}>[] = [
  {
    feature: "mail_classification",
    label: "Mail sorting",
    sent: "The subject, sender and text of each new email go to TypeSafe.",
  },
  {
    feature: "related_cases",
    label: "Related Cases",
    sent: "Parts of the email and Case summaries go to TypeSafe.",
  },
  {
    feature: "screen_relevance",
    label: "Screen suggestions",
    sent: "The page title and visible labels go to TypeSafe.",
  },
];

/** Turns on each switch in turn. A refusal of one does not stop the others. */
export async function turnOnJevFeatures(
  organisationId: string,
): Promise<JevSetupResult> {
  const result: JevSetupResult[number][] = [];
  for (const item of FEATURES) {
    try {
      await changeJevFeature(organisationId, {
        feature: item.feature,
        enabled: true,
      });
      result.push({ feature: item.feature, label: item.label, problem: null });
    } catch (error) {
      result.push({
        feature: item.feature,
        label: item.label,
        problem: jevFeatureErrorMessage(error),
      });
    }
  }
  return result;
}

/** Settings › Jev of the new organisation, or the organisation's start page. */
export function jevSettingsPath(
  organisationHandle: string,
  workspaceHandle: string | null,
): string {
  return workspaceHandle === null
    ? organisationPath(organisationHandle)
    : workspacePagePath(organisationHandle, workspaceHandle, "jev");
}

export function JevSetupBody(props: {
  readonly heading: React.RefObject<HTMLHeadingElement | null>;
  readonly state: JevSetupState;
  readonly settingsPath: string;
}): React.ReactNode {
  const { state } = props;
  return (
    <>
      <div className="account-setup-intro">
        <h4 ref={props.heading} tabIndex={-1} className="account-setup-heading">
          Use Jev for mail sorting, related Cases and screen suggestions
        </h4>
        <p className="account-setup-lead">
          Jev is a small AI model. TypeSafe runs it and processes the data for
          Seams. This step is optional.
        </p>
      </div>
      {state.kind === "result" ? (
        <JevSetupOutcome result={state.result} />
      ) : (
        <dl className="account-setup-summary">
          {FEATURES.map(renderJevFeature)}
        </dl>
      )}
      <p
        className="account-setup-note"
        role={state.kind === "choose" ? undefined : "status"}
      >
        {state.kind === "busy"
          ? "Pantry turns on the Jev switches."
          : state.kind === "result"
            ? "You can change each switch later in "
            : "If you skip, every switch stays off. You can change them later in "}
        {state.kind === "busy" ? null : (
          <>
            <Link to={props.settingsPath}>Settings › Jev</Link>.
          </>
        )}
      </p>
    </>
  );
}

function renderJevFeature(item: (typeof FEATURES)[number]): React.ReactNode {
  return (
    <div key={item.feature}>
      <dt>{item.label}</dt>
      <dd>{item.sent}</dd>
    </div>
  );
}

function JevSetupOutcome(props: {
  readonly result: JevSetupResult;
}): React.ReactNode {
  const missed = props.result.some(hasProblem);
  return (
    <>
      <dl className="account-setup-summary">
        {props.result.map(renderJevOutcome)}
      </dl>
      {missed ? (
        <p className="account-setup-note">
          Some switches are not on. The setup continues without them.
        </p>
      ) : null}
    </>
  );
}

function hasProblem(item: JevSetupResult[number]): boolean {
  return item.problem !== null;
}

function renderJevOutcome(item: JevSetupResult[number]): React.ReactNode {
  return (
    <div key={item.feature}>
      <dt>{item.label}</dt>
      <dd>{item.problem === null ? "On" : `Not on. ${item.problem}`}</dd>
    </div>
  );
}

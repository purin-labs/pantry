import type React from "react";
import type { NavigateFunction } from "react-router";
import {
  customConnectorRevisionPath,
  mutateCustomConnector,
  readCustomConnectorCatalog,
  readCustomConnectorDetail,
  type CustomConnectorDetail,
} from "@purin-labs/area-integrations-contract/ui/features/integrations/custom-connector-api";
import type {
  CustomConnectorAction,
  CustomConnectorMutationResult,
  CustomConnectorRevisionView,
  CustomConnectorSetupAttempt,
  CustomConnectorSummary,
} from "@purin-labs/control-api/portal/custom-connectors";
import { errorMessage, isRecord } from "@purin-labs/std";

export type Loadable<Value> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: Value }
  | { readonly kind: "failed"; readonly message: string };

export type MutationKeys = React.MutableRefObject<Map<string, string>>;

/** What a press needs: the version it starts from and where it reports. */
export type PressOwner = Readonly<{
  organisationId: string;
  configurationVersion: number;
  mutationKeys: MutationKeys;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setFeedback: React.Dispatch<React.SetStateAction<string | null>>;
  setConfigurationVersion: React.Dispatch<React.SetStateAction<number>>;
}>;

/** The props of the open connector, which each of its actions reads. */
export type ConnectorDetailProps = PressOwner &
  Readonly<{
    navigate: NavigateFunction;
    canManage: boolean;
    basePath: string;
    accessPath: string;
    detail: Loadable<CustomConnectorDetail>;
    attempt: CustomConnectorSetupAttempt | null;
    action: Loadable<CustomConnectorAction> | null;
    busy: boolean;
    feedback: string | null;
    setAttempt: React.Dispatch<
      React.SetStateAction<CustomConnectorSetupAttempt | null>
    >;
    setAction: React.Dispatch<
      React.SetStateAction<Loadable<CustomConnectorAction> | null>
    >;
    setDetail: React.Dispatch<
      React.SetStateAction<Loadable<CustomConnectorDetail>>
    >;
    setCatalog: React.Dispatch<
      React.SetStateAction<Loadable<readonly CustomConnectorSummary[]>>
    >;
  }>;

/**
 * The mutations of one press. Each step sends the configuration version that
 * the step before it returned.
 */
export type MutationChain = { readonly owner: PressOwner; version: number };

export type MutationStep = Readonly<{
  path: string;
  method: "DELETE" | "POST";
  body: Readonly<Record<string, unknown>>;
  /** One idempotency key for each intent, kept until the step succeeds. */
  intent: string;
}>;

export async function sendMutation(
  chain: MutationChain,
  step: MutationStep,
): Promise<CustomConnectorMutationResult> {
  const keys = chain.owner.mutationKeys.current;
  const result = await mutateCustomConnector(
    step.path,
    step.method,
    step.body,
    chain.version,
    mutationKey(keys, step.intent),
  );
  keys.delete(step.intent);
  chain.version = result.configurationVersion;
  return result;
}

/**
 * Runs one press. The drawer is busy for all of its steps. The first step
 * that the server refuses stops the rest, and its message is the feedback.
 * Each server check stays: the press only sends the steps in order.
 */
export async function runPress(
  owner: PressOwner,
  press: (chain: MutationChain) => Promise<string>,
): Promise<boolean> {
  owner.setBusy(true);
  owner.setFeedback(null);
  const chain: MutationChain = {
    owner,
    version: owner.configurationVersion,
  };
  try {
    owner.setFeedback(await press(chain));
    return true;
  } catch (error) {
    owner.setFeedback(
      error instanceof Error
        ? error.message
        : "Unable to save. Check your connection and try again.",
    );
    return false;
  } finally {
    owner.setConfigurationVersion(chain.version);
    owner.setBusy(false);
  }
}

export function mutationKey(keys: Map<string, string>, intent: string): string {
  const current = keys.get(intent);
  if (current !== undefined) return current;
  const created = `portal-${crypto.randomUUID()}`;
  keys.set(intent, created);
  return created;
}

/** The check of a draft against the definition rules of Pantry. */
export function validateStep(
  organisationId: string,
  connectorId: string,
  revision: CustomConnectorRevisionView,
): MutationStep {
  return {
    path: customConnectorRevisionPath(
      organisationId,
      connectorId,
      revision.revision,
      "validate",
    ),
    method: "POST",
    body: { authoringDigest: revision.authoringDigest },
    intent: `custom-connector-revision:${connectorId}:${revision.revision}:validate`,
  };
}

export function requireRevision(
  result: CustomConnectorMutationResult,
): CustomConnectorRevisionView {
  if (result.revision === null)
    throw new Error("The server returned no connector revision.");
  return result.revision;
}

export function requireAttempt(
  result: CustomConnectorMutationResult,
): CustomConnectorSetupAttempt {
  if (result.attempt === null)
    throw new Error("The server returned no connector setup.");
  return result.attempt;
}

export async function refreshDetail(
  props: ConnectorDetailProps,
  connectorId: string,
): Promise<void> {
  try {
    const [detail, catalog] = await Promise.all([
      readCustomConnectorDetail(props.organisationId, connectorId),
      readCustomConnectorCatalog(props.organisationId),
    ]);
    props.setDetail({ kind: "ready", value: detail });
    props.setCatalog({ kind: "ready", value: catalog });
  } catch (error) {
    props.setFeedback(
      errorMessage(error, "Unable to load custom connectors. Try again."),
    );
  }
}

export function customConnectorHref(
  basePath: string,
  connectorId: string,
  attemptId: string | null,
): string {
  const origin =
    typeof window === "undefined"
      ? "https://portal.invalid"
      : window.location.origin;
  const url = new URL(basePath, origin);
  url.searchParams.set("customConnector", connectorId);
  if (attemptId !== null) url.searchParams.set("setupAttempt", attemptId);
  return `${url.pathname}${url.search}`;
}

export function replaceCustomConnectorLocation(
  navigate: NavigateFunction,
  basePath: string,
  connectorId: string,
  attemptId: string | null,
): void {
  const path = customConnectorHref(basePath, connectorId, attemptId);
  const current = new URLSearchParams(window.location.search);
  const url = new URL(path, window.location.origin);
  const query = current.get("q");
  if (query !== null) url.searchParams.set("q", query);
  void navigate(`${url.pathname}${url.search}`, {
    replace: true,
    preventScrollReset: true,
  });
}

export type OperationReview = Readonly<{
  id: string;
  description: string;
  effect: "read" | "external_record_create" | "external_record_update";
  idempotencyHeader: string | null;
}>;

/**
 * The definition that the drawer shows for a revision: the validated one, or
 * the authoring document of a draft.
 */
export function shownDefinition(
  revision: CustomConnectorRevisionView,
): Readonly<Record<string, unknown>> {
  return revision.definition ?? revision.authoringDocument;
}

export function readOperationReviews(
  definition: Readonly<Record<string, unknown>>,
): readonly OperationReview[] {
  if (!Array.isArray(definition.operations)) return [];
  const operations: OperationReview[] = [];
  for (const raw of definition.operations) {
    if (!isRecord(raw) || typeof raw.id !== "string") continue;
    const effect = readEffect(raw.effect);
    if (effect === null) continue;
    operations.push({
      id: raw.id,
      description:
        typeof raw.description === "string" ? raw.description : raw.id,
      effect,
      idempotencyHeader: readIdempotencyHeader(raw.effect),
    });
  }
  return operations;
}

/**
 * What the person approves: the destination and the effects that the drawer
 * showed. The server compares them with the validated definition and refuses
 * the approval if they differ.
 */
export function approvalReview(revision: CustomConnectorRevisionView): {
  readonly origin: string;
  readonly effects: readonly { operationId: string; effect: string }[];
} {
  const definition = shownDefinition(revision);
  return {
    origin: typeof definition.origin === "string" ? definition.origin : "",
    effects: readOperationReviews(definition).map(operationApproval),
  };
}

export function matchesRevisionNumber(
  revision: number,
  value: CustomConnectorRevisionView,
): boolean {
  return value.revision === revision;
}

function operationApproval(operation: OperationReview): {
  operationId: string;
  effect: string;
} {
  return { operationId: operation.id, effect: operation.effect };
}

function readEffect(
  raw: unknown,
): "read" | "external_record_create" | "external_record_update" | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  if (
    raw.kind === "read" ||
    raw.kind === "external_record_create" ||
    raw.kind === "external_record_update"
  ) {
    return raw.kind;
  }
  return null;
}

function readIdempotencyHeader(effect: unknown): string | null {
  return isRecord(effect) &&
    isRecord(effect.retryPolicy) &&
    effect.retryPolicy.kind === "provider_idempotent" &&
    typeof effect.retryPolicy.header === "string"
    ? effect.retryPolicy.header
    : null;
}

import React from "react";
import { ControlApiError } from "../../control-client";
import type { Variant } from "@seams/type-utils";
import type {
  IntegrationsRouteData,
  IntegrationsRouteProps,
  SettingsMutationFeedback,
  SettingsRouteContent,
  WorkspaceSettingsRouteData,
  WorkspaceSettingsRouteProps,
} from "./settings-types";

export async function loadIntegrationsRoute(
  props: IntegrationsRouteProps,
  requestRevision: { current: number },
  setContent: React.Dispatch<
    React.SetStateAction<SettingsRouteContent<IntegrationsRouteData>>
  >,
): Promise<void> {
  const revision = ++requestRevision.current;
  setContent(refreshingSettingsRouteContent);
  try {
    const data = await props.transport.readOverview(props.organisationId);
    if (requestRevision.current !== revision) return;
    setContent(readySettingsRouteContent(data));
  } catch (error) {
    if (requestRevision.current !== revision) return;
    setContent(
      applyIntegrationsRouteRefreshFailure.bind(
        null,
        error,
        "Your role cannot access connected systems.",
      ),
    );
  }
}

export function applyIntegrationsRouteRefreshFailure(
  error: unknown,
  unauthorizedMessage: string,
  content: SettingsRouteContent<IntegrationsRouteData>,
): SettingsRouteContent<IntegrationsRouteData> {
  return integrationsRouteRefreshFailure(error, unauthorizedMessage, content);
}

export function integrationsRouteRefreshFailure<T>(
  error: unknown,
  unauthorizedMessage: string,
  content: SettingsRouteContent<T>,
): SettingsRouteContent<T> {
  const failure = settingsRouteFailureContent<T>(error, unauthorizedMessage);
  if (failure.kind !== "failed" || content.kind !== "ready") return failure;
  return {
    ...content,
    freshness: {
      kind: "delayed",
      observedAt: new Date().toISOString(),
      explanation: `Connected systems could not be refreshed. ${failure.problem}`,
    },
    updating: false,
  };
}

export function beginWorkspaceSettingsRouteLoad(
  props: WorkspaceSettingsRouteProps,
  requestRevision: { current: number },
  setContent: React.Dispatch<
    React.SetStateAction<SettingsRouteContent<WorkspaceSettingsRouteData>>
  >,
  setFeedback: React.Dispatch<React.SetStateAction<SettingsMutationFeedback>>,
): () => void {
  setFeedback(null);
  void loadWorkspaceSettingsRoute(props, requestRevision, setContent);
  return invalidateSettingsRouteRequest.bind(null, requestRevision);
}

export function retryWorkspaceSettingsRoute(
  props: WorkspaceSettingsRouteProps,
  requestRevision: { current: number },
  setContent: React.Dispatch<
    React.SetStateAction<SettingsRouteContent<WorkspaceSettingsRouteData>>
  >,
  setFeedback: React.Dispatch<React.SetStateAction<SettingsMutationFeedback>>,
): void {
  setFeedback(null);
  void loadWorkspaceSettingsRoute(props, requestRevision, setContent);
}

export async function loadWorkspaceSettingsRoute(
  props: WorkspaceSettingsRouteProps,
  requestRevision: { current: number },
  setContent: React.Dispatch<
    React.SetStateAction<SettingsRouteContent<WorkspaceSettingsRouteData>>
  >,
): Promise<void> {
  const revision = ++requestRevision.current;
  setContent(refreshingSettingsRouteContent);
  try {
    const data = await props.transport.read(props.organisationId);
    if (requestRevision.current !== revision) return;
    setContent(readySettingsRouteContent(data));
  } catch (error) {
    if (requestRevision.current !== revision) return;
    setContent(
      settingsRouteFailureContent(
        error,
        "Your role cannot access workspace settings.",
      ),
    );
  }
}

export function invalidateSettingsRouteRequest(requestRevision: {
  current: number;
}): void {
  requestRevision.current += 1;
}

export function lastIntegrationsRouteContent(
  props: IntegrationsRouteProps,
): SettingsRouteContent<IntegrationsRouteData> {
  const last = props.transport.lastOverview?.(props.organisationId) ?? null;
  return last === null
    ? { kind: "loading" }
    : { ...readySettingsRouteContent(last), updating: true };
}

export function refreshingSettingsRouteContent<T>(
  content: SettingsRouteContent<T>,
): SettingsRouteContent<T> {
  return content.kind === "ready"
    ? { ...content, updating: true }
    : { kind: "loading" };
}

export function readySettingsRouteContent<T>(
  data: T,
): Variant<SettingsRouteContent<T>, "ready"> {
  return {
    kind: "ready",
    data,
    freshness: { kind: "current" },
    updating: false,
  };
}

export function settingsRouteFailureContent<T>(
  error: unknown,
  unauthorizedMessage: string,
): Variant<SettingsRouteContent<T>, "failed" | "unauthorized"> {
  if (error instanceof ControlApiError && error.kind === "forbidden") {
    return { kind: "unauthorized", reason: unauthorizedMessage };
  }
  return {
    kind: "failed",
    problem: settingsRouteProblem(error),
    recovery: { label: "Try again" },
  };
}

export function settingsRouteProblem(error: unknown): string {
  return error instanceof ControlApiError
    ? error.message
    : "Settings could not be loaded. Try again.";
}

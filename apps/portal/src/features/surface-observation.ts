import React from "react";
import { useLocation } from "react-router";
import {
  parseSurfaceObservation,
  surfaceCommandTarget,
  surfaceObservationBytes,
  type SurfacePageCommandV1,
  SURFACE_OBSERVATION_MAX_BYTES,
  type PortalPageViewSection,
  type PortalPageViewV1,
  type SurfaceArea,
  type SurfaceObservationV2,
  type SurfaceRecord,
  type SurfaceSource,
} from "@purin-labs/control-api";
import { pageAddress } from "../page-address";
import { showAgentLabel } from "./agent-surface-label";
import {
  readPortalRoute,
  workspacePageDescriptor,
  type WorkspaceDetailPage,
} from "../route";

/**
 * The page on the person's screen, for the chat beside it (Plan 87). Every
 * page gives a default observation with no page code: its title, its
 * navigation group, its path and the record that it has open. A page that
 * registers a view source adds what it shows, as Costs does.
 */
export interface SurfaceViewSource {
  pageOrganisationId(): string;
  /** The Portal page that shows this view. */
  surfacePage(): WorkspaceDetailPage;
  capturePageView(): PortalPageViewV1 | null;
  /** The view commands that the agent may run on the page now (phase 4). */
  surfaceCommands?(): readonly string[];
  /** Runs an agent's view command with the page's own state changes. */
  runSurfaceCommand?(
    command: SurfacePageCommandV1["command"],
  ): Promise<SurfaceCommandOutcome>;
}

export type SurfaceCommandOutcome =
  Readonly<{ kind: "done" }> | Readonly<{ kind: "rejected"; message: string }>;

/** What a page command did, for the receipt that the bridge sends. */
type PageCommandResult =
  | Readonly<{ kind: "completed"; observation: SurfaceObservationV2 }>
  | Readonly<{ kind: "rejected"; message: string }>
  | Readonly<{ kind: "unavailable"; message: string }>;

type SurfaceOnScreen = Readonly<{
  page: WorkspaceDetailPage;
  path: string;
  record: SurfaceRecord | null;
  surfaceSessionId: string;
}>;

const BROWSER_INSTANCE_ID = crypto.randomUUID();
const RECORD_LABEL_LENGTH = 120;
const MAX_TABLE_ROWS = 200;
// About 5 KB of the 24 KiB limit, so the names never crowd out the view.
const MAX_SOURCES = 60;
const SOURCE_KIND = /^[a-z][a-z0-9_]{0,59}$/;

let onScreen: SurfaceOnScreen | null = null;
const viewSources: SurfaceViewSource[] = [];
const openRecords: SurfaceRecord[] = [];
const shownSources: (readonly SurfaceSource[])[] = [];

/** Follows the page on screen. The Portal frame calls it once. */
export function useSurfaceOnScreen(): void {
  const pathname = pageAddress(useLocation()).pathname;
  React.useEffect(followSurfaceOnScreen.bind(null, pathname), [pathname]);
}

function followSurfaceOnScreen(pathname: string): () => void {
  onScreen = surfaceOnScreen(pathname);
  publishSurfaceOnScreen();
  return leaveSurfaceOnScreen.bind(null, onScreen);
}

function leaveSurfaceOnScreen(left: SurfaceOnScreen | null): void {
  if (onScreen !== left) return;
  onScreen = null;
  publishSurfaceOnScreen();
}

/** The page on screen as the composer chip names it. */
export type SurfaceOnScreenView = Readonly<{
  page: WorkspaceDetailPage;
  area: SurfaceArea;
  title: string;
  record: SurfaceRecord | null;
  surfaceSessionId: string;
}>;

const screenListeners = new Set<() => void>();
let screenView: SurfaceOnScreenView | null = null;

/** The page on screen now, for a component that shows it. */
export function useSurfaceOnScreenView(): SurfaceOnScreenView | null {
  return React.useSyncExternalStore(subscribeSurfaceOnScreen, readScreenView);
}

export function surfaceOnScreenView(): SurfaceOnScreenView | null {
  return screenView;
}

function readScreenView(): SurfaceOnScreenView | null {
  return screenView;
}

function subscribeSurfaceOnScreen(listener: () => void): () => void {
  screenListeners.add(listener);
  return unsubscribeSurfaceOnScreen.bind(null, listener);
}

function unsubscribeSurfaceOnScreen(listener: () => void): void {
  screenListeners.delete(listener);
}

function publishSurfaceOnScreen(): void {
  const screen = onScreen;
  screenView =
    screen === null
      ? null
      : {
          page: screen.page,
          area: workspacePageDescriptor(screen.page).group,
          title: workspacePageDescriptor(screen.page).title,
          record: openRecords.at(-1) ?? screen.record,
          surfaceSessionId: screen.surfaceSessionId,
        };
  for (const listener of screenListeners) listener();
}

function surfaceOnScreen(pathname: string): SurfaceOnScreen | null {
  const route = readPortalRoute(pathname);
  if (route.kind !== "workspace") return null;
  const destination = route.destination;
  // The full chat page shows no other page.
  if (destination.page === "chat") return null;
  return {
    page: destination.page,
    path: pathname,
    record:
      destination.kind === "resource"
        ? pageSurfaceRecord(
            destination.page,
            destination.resourceId,
            clip(destination.resourceId),
          )
        : null,
    surfaceSessionId: crypto.randomUUID(),
  };
}

const RECORD_KINDS = {
  products: "product",
  orders: "customer_order",
  suppliers: "supplier",
} as const;

/** The record that a Products, Orders or Suppliers detail page shows. */
export function pageSurfaceRecord(
  page: keyof typeof RECORD_KINDS,
  id: string,
  label: string,
): SurfaceRecord {
  return { kind: RECORD_KINDS[page], id, label };
}

/**
 * Names the record that a page has open, such as the order in a side
 * drawer, while `record` is not null. The newest open record wins.
 */
export function useSurfaceRecord(record: SurfaceRecord | null): void {
  const key = record === null ? null : JSON.stringify(record);
  React.useEffect(openSurfaceRecord.bind(null, record), [key]);
}

function openSurfaceRecord(
  record: SurfaceRecord | null,
): (() => void) | undefined {
  if (record === null) return undefined;
  const opened = { ...record, label: clip(record.label) };
  openRecords.push(opened);
  publishSurfaceOnScreen();
  return closeSurfaceRecord.bind(null, opened);
}

function closeSurfaceRecord(record: SurfaceRecord): void {
  const index = openRecords.lastIndexOf(record);
  if (index >= 0) openRecords.splice(index, 1);
  publishSurfaceOnScreen();
}

/**
 * Names the saved records that a page shows, each by kind, id and revision,
 * while the page shows them (Plan 87 D19). The observation carries the names
 * and no value. A page passes the same array while its records do not change.
 */
export function useSurfaceSources(sources: readonly SurfaceSource[]): void {
  const key = JSON.stringify(sources);
  React.useEffect(showSurfaceSources.bind(null, sources), [key]);
}

function showSurfaceSources(
  sources: readonly SurfaceSource[],
): (() => void) | undefined {
  if (sources.length === 0) return undefined;
  shownSources.push(sources);
  return hideSurfaceSources.bind(null, sources);
}

function hideSurfaceSources(sources: readonly SurfaceSource[]): void {
  const index = shownSources.lastIndexOf(sources);
  if (index >= 0) shownSources.splice(index, 1);
}

// Each record one time, the newest page part first. A name that the contract
// refuses is left out, so it cannot remove the whole observation.
function captureSources(): SurfaceSource[] {
  const sources: SurfaceSource[] = [];
  const seen = new Set<string>();
  for (let index = shownSources.length - 1; index >= 0; index -= 1) {
    for (const source of shownSources[index] ?? []) {
      if (sources.length === MAX_SOURCES) return sources;
      const key = `${source.kind}\u0000${source.id}`;
      if (seen.has(key) || !validSource(source)) continue;
      seen.add(key);
      sources.push(source);
    }
  }
  return sources;
}

function validSource(source: SurfaceSource): boolean {
  return (
    SOURCE_KIND.test(source.kind) &&
    source.id.length >= 1 &&
    source.id.length <= 200 &&
    (source.revision === null ||
      (source.revision.length >= 1 && source.revision.length <= 120))
  );
}

/** Registers what a page shows while it is mounted. */
export function registerSurfaceView(source: SurfaceViewSource): () => void {
  viewSources.push(source);
  return unregisterSurfaceView.bind(null, source);
}

function unregisterSurfaceView(source: SurfaceViewSource): void {
  const index = viewSources.lastIndexOf(source);
  if (index >= 0) viewSources.splice(index, 1);
}

/** The page on screen now, or null when no Portal page is on screen. */
export function captureSurfaceObservation(
  organisationId: string,
): SurfaceObservationV2 | null {
  const screen = onScreen;
  if (screen === null) return null;
  const descriptor = workspacePageDescriptor(screen.page);
  const observation: SurfaceObservationV2 = {
    kind: "surface-observation",
    schemaVersion: 2,
    surface: screen.page,
    area: descriptor.group,
    instance: {
      browserInstanceId: BROWSER_INSTANCE_ID,
      surfaceSessionId: screen.surfaceSessionId,
      epoch: 0,
    },
    title: descriptor.title,
    path: screen.path,
    record: openRecords.at(-1) ?? screen.record,
    capturedAt: Date.now(),
    view: captureView(organisationId, screen.page),
    state: null,
    commands: captureCommands(organisationId, screen.page),
    sources: captureSources(),
  };
  // The server refuses a malformed observation with the whole message, so
  // an observation that fails the contract here is left out instead.
  return parseSurfaceObservation(fitSurfaceObservation(observation));
}

function captureView(
  organisationId: string,
  page: WorkspaceDetailPage,
): PortalPageViewSection[] {
  const source = viewSource(organisationId, page);
  if (source === null) return [];
  try {
    return source.capturePageView()?.sections.map(capTableRows) ?? [];
  } catch {
    return [];
  }
}

function captureCommands(
  organisationId: string,
  page: WorkspaceDetailPage,
): string[] {
  return [...(viewSource(organisationId, page)?.surfaceCommands?.() ?? [])];
}

// The newest source of the page wins, as a remount registers again.
function viewSource(
  organisationId: string,
  page: WorkspaceDetailPage,
): SurfaceViewSource | null {
  for (let index = viewSources.length - 1; index >= 0; index -= 1) {
    const source = viewSources[index];
    if (source?.pageOrganisationId() !== organisationId) continue;
    if (source.surfacePage() === page) return source;
  }
  return null;
}

/**
 * Runs an agent's command on the page on screen, then shows the agent's
 * label on its target and captures the page again (Plan 87 phase 4). A
 * command for a page instance that is no longer on screen does not run.
 */
export async function runPageCommand(
  organisationId: string,
  command: SurfacePageCommandV1,
): Promise<PageCommandResult> {
  const screen = onScreen;
  const source =
    screen === null ? null : viewSource(organisationId, screen.page);
  if (
    screen === null ||
    screen.page !== command.surface ||
    screen.surfaceSessionId !== command.target.surfaceSessionId ||
    source?.runSurfaceCommand === undefined
  )
    return {
      kind: "unavailable",
      message: "The page of this command is no longer on the person's screen.",
    };
  const outcome = await source.runSurfaceCommand(command.command);
  if (outcome.kind === "rejected") return outcome;
  showAgentLabel(surfaceCommandTarget(command.command), command.agentLabel);
  const observation = captureSurfaceObservation(organisationId);
  return observation === null
    ? { kind: "rejected", message: "The page could not be captured again." }
    : { kind: "completed", observation };
}

/**
 * Drops the last rows of the largest table until the observation fits the
 * size limit. A table keeps its `totalRows`, so the model knows rows are
 * missing.
 */
function fitSurfaceObservation(
  observation: SurfaceObservationV2,
): SurfaceObservationV2 | null {
  let fitted = observation;
  while (surfaceObservationBytes(fitted) > SURFACE_OBSERVATION_MAX_BYTES) {
    const largest = largestTable(fitted.view);
    if (largest < 0) return null;
    fitted = {
      ...fitted,
      view: fitted.view.map(dropRows.bind(null, largest)),
    };
  }
  return fitted;
}

function largestTable(view: readonly PortalPageViewSection[]): number {
  let largest = -1;
  let rows = 0;
  view.forEach(function findLargest(section, index) {
    const count = section.table?.rows.length ?? 0;
    if (count > rows) {
      largest = index;
      rows = count;
    }
  });
  return largest;
}

function dropRows(
  largest: number,
  section: PortalPageViewSection,
  index: number,
): PortalPageViewSection {
  if (index !== largest || section.table === null) return section;
  const keep = Math.floor(section.table.rows.length * 0.8);
  return {
    ...section,
    table: { ...section.table, rows: section.table.rows.slice(0, keep) },
  };
}

function capTableRows(section: PortalPageViewSection): PortalPageViewSection {
  if (section.table === null || section.table.rows.length <= MAX_TABLE_ROWS)
    return section;
  return {
    ...section,
    table: {
      ...section.table,
      rows: section.table.rows.slice(0, MAX_TABLE_ROWS),
    },
  };
}

function clip(label: string): string {
  return label.length <= RECORD_LABEL_LENGTH
    ? label
    : `${label.slice(0, RECORD_LABEL_LENGTH - 1)}…`;
}

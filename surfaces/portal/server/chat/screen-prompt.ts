import type {
  ChatOrigin,
  SurfaceObservationV2,
  SurfaceRecord,
} from "@purin-labs/control-api";

/**
 * Two facts for the model (Plan 87): where the chat started, which is a
 * label and not page content, and which page, if any, the current request
 * carries from the operator's screen.
 */
export function screenContextLine(
  origin: ChatOrigin | undefined,
  observation: SurfaceObservationV2 | undefined,
): string {
  const started =
    origin === undefined
      ? ""
      : `This chat started on ${pageName(origin.title, origin.record)}; that is a label, not page content. `;
  const carries =
    observation === undefined
      ? "The current request carries no page from the operator's screen."
      : `The current request carries ${pageName(observation.title, observation.record)} from the operator's screen.`;
  return `${started}${carries}`;
}

function pageName(title: string, record: SurfaceRecord | null): string {
  return record === null ? title : `${title}, ${record.label}`;
}

/** What the model reads of an observation: no browser identity or empty fields. */
export function promptObservation(
  observation: SurfaceObservationV2,
): Readonly<Record<string, unknown>> {
  return {
    page: observation.title,
    area: observation.area,
    path: observation.path,
    record: observation.record,
    capturedAt: observation.capturedAt,
    ...(observation.view.length === 0 ? {} : { view: observation.view }),
  };
}

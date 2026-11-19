import type { SurfaceSource } from "@purin-labs/control-api";
import type { CommerceEntity } from "@purin-labs/contracts";
import {
  pageSurfaceRecord,
  useSurfaceRecord,
  useSurfaceSources,
} from "../../surface-observation";
import type { CommerceEntityDossierModel } from "./models";

/**
 * Names a record page for the chat beside it (Plan 87): the open record, and
 * the saved records that the page shows, which are the open record and the
 * records that it links to. Each name is a kind, an id and a revision.
 */
export function useDossierSurface(
  page: "products" | "orders" | "suppliers",
  model: CommerceEntityDossierModel,
  label: string,
): void {
  useSurfaceRecord(
    pageSurfaceRecord(page, model.entity.reference.entityId, label),
  );
  useSurfaceSources(dossierSources(page, model));
}

function dossierSources(
  page: "products" | "orders" | "suppliers",
  model: CommerceEntityDossierModel,
): SurfaceSource[] {
  const open = model.entity.reference.entityId;
  const sources: SurfaceSource[] = [
    {
      // The kind of the open record, so that the source equals the record.
      kind: pageSurfaceRecord(page, open, "-").kind,
      id: open,
      revision: String(model.entity.revision),
    },
  ];
  for (const entity of model.traversal.entities) {
    if (entity.reference.entityId !== open) sources.push(entitySource(entity));
  }
  return sources;
}

function entitySource(entity: CommerceEntity): SurfaceSource {
  return {
    kind: entity.reference.typeId,
    id: entity.reference.entityId,
    revision: String(entity.revision),
  };
}

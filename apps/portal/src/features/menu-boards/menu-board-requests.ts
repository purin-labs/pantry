import type {
  MenuDraftSnapshot,
  MenuItem,
  MenuSection,
} from "@seams/menu-draft-crdt";
import { isNonNegativeInteger, isPositiveInteger, isRecord } from "@seams/std";
import { controlRead } from "../../control-client";

/** A control route of the Organisation, such as `menu-boards`. */
export function controlPath(organisationId: string, suffix: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/${suffix}`;
}

/** The shop's saved menu draft, which names the sections and items. */
export async function readMenuDraft(
  organisationId: string,
): Promise<Readonly<{ revision: number; draft: MenuDraftSnapshot }> | null> {
  const raw = await controlRead(
    controlPath(organisationId, "collaboration/menu-draft"),
  ).catch(() => null);
  if (
    !isRecord(raw) ||
    !isRecord(raw.value) ||
    !isPositiveInteger(raw.value.revision) ||
    !isRecord(raw.value.draft) ||
    typeof raw.value.draft.title !== "string" ||
    !Array.isArray(raw.value.draft.sections) ||
    !Array.isArray(raw.value.draft.items)
  )
    return null;
  const sections: MenuSection[] = [];
  for (const section of raw.value.draft.sections) {
    if (
      !isRecord(section) ||
      typeof section.id !== "string" ||
      typeof section.title !== "string" ||
      !isNonNegativeInteger(section.order)
    )
      return null;
    sections.push({
      id: section.id,
      title: section.title,
      order: section.order,
    });
  }
  const items: MenuItem[] = [];
  for (const item of raw.value.draft.items) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.productId !== "string" ||
      typeof item.displayName !== "string" ||
      typeof item.description !== "string" ||
      !isRecord(item.placement) ||
      typeof item.placement.sectionId !== "string" ||
      !isNonNegativeInteger(item.placement.order)
    )
      return null;
    items.push({
      id: item.id,
      productId: item.productId,
      displayName: item.displayName,
      description: item.description,
      placement: {
        sectionId: item.placement.sectionId,
        order: item.placement.order,
      },
    });
  }
  return {
    revision: raw.value.revision,
    draft: { title: raw.value.draft.title, sections, items },
  };
}

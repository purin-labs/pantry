import type {
  MenuDraftSnapshot,
  MenuItem,
  MenuSection,
} from "@purin-labs/menu-draft-crdt";
import { isNonNegativeInteger, isPositiveInteger, isRecord } from "@purin-labs/std";

export type MenuDraftReview = Readonly<{
  reviewId: string;
  documentId: "cafe-menu";
  documentRevision: number;
  reviewedAt: number;
  draft: MenuDraftSnapshot;
}>;

export function parseMenuReview(value: unknown): MenuDraftReview | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.value))
    return null;
  const review = value.value;
  if (
    typeof review.reviewId !== "string" ||
    review.documentId !== "cafe-menu" ||
    !isPositiveInteger(review.documentRevision) ||
    !isPositiveInteger(review.reviewedAt)
  )
    return null;
  const draft = parseMenuSnapshot(review.draft);
  return draft === null
    ? null
    : {
        reviewId: review.reviewId,
        documentId: "cafe-menu",
        documentRevision: review.documentRevision,
        reviewedAt: review.reviewedAt,
        draft,
      };
}

export function parseMenuSnapshot(value: unknown): MenuDraftSnapshot | null {
  if (
    !isRecord(value) ||
    typeof value.title !== "string" ||
    !Array.isArray(value.sections) ||
    !Array.isArray(value.items)
  ) {
    return null;
  }
  const sections: MenuSection[] = [];
  for (const section of value.sections) {
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
  for (const item of value.items) {
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
  return { title: value.title, sections, items };
}

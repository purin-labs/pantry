import { Type, type Static } from "typebox";

/**
 * What a Portal page shows when a person sends a chat message from it. The
 * browser builds it from the page's own state, so it includes values that
 * the person has not saved yet. The model reads it as an observation of the
 * screen: it grants no authority and proves no saved record.
 */
const label = Type.String({ minLength: 1, maxLength: 120 });
const cell = Type.String({ maxLength: 400 });

export const portalPageViewFactSchema = Type.Object({
  label,
  value: cell,
});

export const portalPageViewTableSchema = Type.Object({
  columns: Type.Array(label, { minItems: 1, maxItems: 24 }),
  rows: Type.Array(Type.Array(cell, { maxItems: 24 }), { maxItems: 200 }),
  /** The number of rows on the page; rows past the limit are left out. */
  totalRows: Type.Integer({ minimum: 0 }),
});

export const portalPageViewSectionSchema = Type.Object({
  title: label,
  facts: Type.Array(portalPageViewFactSchema, { maxItems: 40 }),
  table: Type.Union([portalPageViewTableSchema, Type.Null()]),
});

export const portalPageViewSchema = Type.Object({
  kind: Type.Literal("portal-page-view"),
  schemaVersion: Type.Literal(1),
  /** A stable page name, such as `costs`. */
  page: Type.String({ minLength: 1, maxLength: 60, pattern: "^[a-z0-9-]+$" }),
  title: label,
  path: Type.String({ minLength: 1, maxLength: 400, pattern: "^/" }),
  capturedAt: Type.Integer({ minimum: 0 }),
  sections: Type.Array(portalPageViewSectionSchema, { maxItems: 12 }),
});

export type PortalPageViewFact = Static<typeof portalPageViewFactSchema>;
export type PortalPageViewTable = Static<typeof portalPageViewTableSchema>;
export type PortalPageViewSection = Static<typeof portalPageViewSectionSchema>;
export type PortalPageViewV1 = Static<typeof portalPageViewSchema>;

import { Type, type Static } from "typebox";
import { recordParser } from "@purin-labs/contract-schema";

/**
 * Comments pinned to a board's elements (Plan 40B phase 5, slice 6), as
 * the Portal and the agent read them. The Actor writes the author and the
 * time; a release never carries a comment.
 */

const boardId = Type.String({ pattern: "^[A-Za-z0-9_:-]{1,128}$" });

export const menuBoardCommentSchema = Type.Object({
  commentId: boardId,
  body: Type.String({ minLength: 1, maxLength: 1000 }),
  author: Type.Object({
    kind: Type.Union([Type.Literal("person"), Type.Literal("agent")]),
    name: Type.String({ maxLength: 256 }),
  }),
  /** The reader wrote this comment, so they may delete it. */
  mine: Type.Boolean(),
  createdAt: Type.Integer({ minimum: 0 }),
});

export const menuBoardCommentThreadSchema = Type.Object({
  threadId: boardId,
  /** The element that the thread is pinned to. */
  elementId: boardId,
  /** False when the draft no longer has the element. */
  onBoard: Type.Boolean(),
  resolvedAt: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  resolvedBy: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
  comments: Type.Array(menuBoardCommentSchema, { minItems: 1, maxItems: 300 }),
});

export const menuBoardCommentListSchema = Type.Object({
  threads: Type.Array(menuBoardCommentThreadSchema, { maxItems: 300 }),
});

export type MenuBoardComment = Static<typeof menuBoardCommentSchema>;
export type MenuBoardCommentThread = Static<typeof menuBoardCommentThreadSchema>;

const decodeCommentList = recordParser(menuBoardCommentListSchema);

/** A board's comment threads from untrusted JSON, or null. */
export function parseMenuBoardCommentThreads(
  raw: unknown,
): readonly MenuBoardCommentThread[] | null {
  const decoded = decodeCommentList({ threads: raw });
  return decoded.ok ? decoded.value.threads : null;
}

/**
 * One saved version of a board's draft (Plan 40B phase 5, slice 7): a
 * frozen copy that a person or the agent can restore.
 */
export const menuBoardVersionSchema = Type.Object({
  versionId: Type.String({ pattern: "^[A-Za-z0-9_:-]{1,128}$" }),
  kind: Type.Union([
    Type.Literal("created"),
    Type.Literal("named"),
    Type.Literal("published"),
    Type.Literal("before_restore"),
    Type.Literal("auto"),
  ]),
  /** The name a person gave it; empty for the versions the Portal saves. */
  label: Type.String({ maxLength: 80 }),
  documentRevision: Type.Integer({ minimum: 1 }),
  createdBy: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
  createdAt: Type.Integer({ minimum: 0 }),
});

export type MenuBoardVersionSummary = Static<typeof menuBoardVersionSchema>;

const decodeVersionList = recordParser(
  Type.Object({ versions: Type.Array(menuBoardVersionSchema, { maxItems: 40 }) }),
);

/** A board's versions from untrusted JSON, or null. */
export function parseMenuBoardVersions(
  raw: unknown,
): readonly MenuBoardVersionSummary[] | null {
  const decoded = decodeVersionList({ versions: raw });
  return decoded.ok ? decoded.value.versions : null;
}

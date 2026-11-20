import {
  isMenuScreenCode,
  type MenuScreenSummary,
} from "@purin-labs/cafe-control-api";
import {
  isMenuBoardLayout,
  isMenuBoardStart,
  isMenuBoardText,
  menuBoardStartFits,
} from "@purin-labs/menu-board-crdt/board";
import { encodeBase64Url } from "@purin-labs/std";
import { requireActiveOrganisationActor } from "../../actors/actor-router";
import type {
  MenuBoardCommand,
  MenuBoardCommandReply,
} from "../../actors/menu-board-commands";
import { menuScreenToken } from "../../actors/menu-screens";
import { readMenuScreenFacts } from "./menu-screens";
import type { Env } from "../../env";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError, controlJson, readJsonRecord } from "../http";
import {
  type MenuBoardSocketRoute,
  authorizeMenuBoardSocketRequest,
} from "../admission/menu-boards";
import {
  claimScreenPairing,
  readOpenScreenPairing,
} from "../../data/screen-pairing";
import type { Variant } from "@purin-labs/type-utils";

/**
 * The Portal's routes for menu boards and screens (Plan 40B phase 1):
 *
 *   GET  …/menu-boards                       list (viewer)
 *   GET  …/menu-boards/facts                 the menu's live facts (viewer)
 *   POST …/menu-boards                       create from a layout (operator)
 *   GET  …/menu-boards/:boardId/socket       the board's shared draft
 *   POST …/menu-boards/:boardId/releases     publish the draft seen (operator)
 *   POST …/menu-boards/:boardId/archive      archive or restore (admin)
 *   GET  …/menu-screens                      list (viewer)
 *   POST …/menu-screens                      pair a screen by its code (operator)
 *   PUT  …/menu-screens/:screenId            show another board (operator)
 *   DELETE …/menu-screens/:screenId          end the pairing (operator)
 *   GET  …/menu-boards/:boardId/comments     comment threads (viewer)
 *   POST …/menu-boards/:boardId/comments     a comment or a reply (operator)
 *   PATCH …/menu-boards/:boardId/comments/:threadId   resolve (operator)
 *   DELETE …/menu-boards/:boardId/comments/:commentId own comment (operator)
 *   GET  …/menu-boards/:boardId/versions     saved versions (viewer)
 *   POST …/menu-boards/:boardId/versions     save a named version (operator)
 *   POST …/menu-boards/:boardId/versions/:versionId/restore   (operator)
 *
 * Staff (`operator`) publish a board at once: a board holds no price, and a
 * price change keeps its own approval path.
 */
export type MenuBoardControlRoute = Readonly<{
  kind: "menuBoards";
  organisationIdRaw: string;
  target:
    | Readonly<{ kind: "boards" }>
    | Readonly<{ kind: "facts" }>
    | Readonly<{ kind: "board_releases"; boardId: string }>
    | Readonly<{ kind: "board_archive"; boardId: string }>
    | Readonly<{ kind: "board_comments"; boardId: string }>
    | Readonly<{ kind: "board_comment"; boardId: string; commentId: string }>
    | Readonly<{ kind: "board_versions"; boardId: string }>
    | Readonly<{
        kind: "board_version_restore";
        boardId: string;
        versionId: string;
      }>
    | Readonly<{ kind: "screens" }>
    | Readonly<{ kind: "screen"; screenId: string }>;
}>;

const PAIRING_SCREEN_NAME_LIMIT = 80;

export function matchMenuBoardControlRoute(
  pathname: string,
): MenuBoardControlRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/(menu-boards|menu-screens)(?:\/([A-Za-z0-9_-]{1,128})(?:\/(releases|comments|versions|archive)(?:\/([A-Za-z0-9_:-]{1,128})(?:\/(restore))?)?)?)?$/u.exec(
      pathname,
    );
  if (match === null) return null;
  const organisationIdRaw = decodeURIComponent(match[1] ?? "");
  const id = match[3];
  const sub = match[5];
  if (match[2] === "menu-boards" && id !== undefined && match[4] === "versions") {
    if (sub === undefined && match[6] === undefined)
      return {
        kind: "menuBoards",
        organisationIdRaw,
        target: { kind: "board_versions", boardId: id },
      };
    return sub !== undefined && match[6] === "restore"
      ? {
          kind: "menuBoards",
          organisationIdRaw,
          target: { kind: "board_version_restore", boardId: id, versionId: sub },
        }
      : null;
  }
  if (
    match[6] !== undefined ||
    (sub !== undefined && (match[4] !== "comments" || id === undefined))
  )
    return null;
  if (match[2] === "menu-boards" && id !== undefined && match[4] === "comments")
    return {
      kind: "menuBoards",
      organisationIdRaw,
      target:
        sub === undefined
          ? { kind: "board_comments", boardId: id }
          : { kind: "board_comment", boardId: id, commentId: sub },
    };
  if (match[2] === "menu-boards") {
    if (id === undefined)
      return {
        kind: "menuBoards",
        organisationIdRaw,
        target: { kind: "boards" },
      };
    if (id === "facts" && match[4] === undefined)
      return {
        kind: "menuBoards",
        organisationIdRaw,
        target: { kind: "facts" },
      };
    if (match[4] === "archive")
      return {
        kind: "menuBoards",
        organisationIdRaw,
        target: { kind: "board_archive", boardId: id },
      };
    return match[4] === "releases"
      ? {
          kind: "menuBoards",
          organisationIdRaw,
          target: { kind: "board_releases", boardId: id },
        }
      : null;
  }
  if (match[4] !== undefined) return null;
  return id === undefined
    ? { kind: "menuBoards", organisationIdRaw, target: { kind: "screens" } }
    : {
        kind: "menuBoards",
        organisationIdRaw,
        target: { kind: "screen", screenId: id },
      };
}

export async function handleMenuBoardSocketRoute(
  request: Request,
  env: Env,
  route: MenuBoardSocketRoute,
): Promise<Response> {
  const authorized = await authorizeMenuBoardSocketRequest(request, env, route);
  if (!authorized.ok) return authorized.response;
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: route.organisationId,
      now: Date.now(),
    });
    return organisation.fetch(request);
  } catch {
    return controlError("menu_board_unavailable", 503);
  }
}

export async function handleMenuBoardControlRoute(
  request: Request,
  env: Env,
  route: MenuBoardControlRoute,
): Promise<Response> {
  if (
    route.target.kind === "board_comments" ||
    route.target.kind === "board_comment"
  )
    return handleCommentRoute(request, env, route.organisationIdRaw, route.target);
  if (
    route.target.kind === "board_versions" ||
    route.target.kind === "board_version_restore"
  )
    return handleVersionRoute(request, env, route.organisationIdRaw, route.target);
  if (route.target.kind === "board_archive")
    return handleArchiveRoute(request, env, route.organisationIdRaw, route.target.boardId);
  const read = request.method === "GET";
  if (
    !read &&
    !(
      request.method === "POST" &&
      route.target.kind !== "screen" &&
      route.target.kind !== "facts"
    ) &&
    !(
      (request.method === "PUT" || request.method === "DELETE") &&
      route.target.kind === "screen"
    )
  )
    return controlError("method_not_allowed", 405);
  if (
    read &&
    route.target.kind !== "boards" &&
    route.target.kind !== "facts" &&
    route.target.kind !== "screens"
  )
    return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    read ? "viewer" : "operator",
    !read,
  );
  if (!authorized.ok) return authorized.response;
  const userId = authorized.authenticated.session.userId;
  const target = route.target;
  switch (target.kind) {
    case "boards": {
      if (read) {
        const listed = await command(env, authorized, { kind: "list_boards" });
        return listed.ok
          ? controlJson({
              ok: true,
              boards: listed.value.boards,
              archivedBoards: listed.value.archivedBoards,
            })
          : controlError(listed.error.code, 503);
      }
      const body = await readJsonRecord(request);
      const title = body.ok ? body.value.title : undefined;
      const layout = body.ok ? body.value.layout : undefined;
      // The start screen's choice; a body without one starts from the
      // layout's template.
      const start = body.ok ? (body.value.start ?? "template") : undefined;
      if (
        typeof title !== "string" ||
        title.trim().length === 0 ||
        !isMenuBoardText(title) ||
        !isMenuBoardLayout(layout) ||
        !isMenuBoardStart(start) ||
        !menuBoardStartFits(start, layout)
      )
        return controlError("menu_board_invalid", 422);
      const created = await command(env, authorized, {
        kind: "create_board",
        title: title.trim(),
        layout,
        start,
        userId,
      });
      if (!created.ok)
        return controlError(
          created.error.code,
          created.error.code === "menu_board_limit" ? 409 : 503,
        );
      return controlJson({ ok: true, board: created.value }, 201);
    }
    case "facts":
      return controlJson({
        ok: true,
        facts: await readMenuScreenFacts(env, authorized.organisationId),
      });
    case "board_releases": {
      const body = await readJsonRecord(request);
      const documentRevision = body.ok
        ? body.value.documentRevision
        : undefined;
      const expected = body.ok ? body.value.expectedReleaseRevision : undefined;
      if (
        typeof documentRevision !== "number" ||
        !Number.isSafeInteger(documentRevision) ||
        documentRevision < 1 ||
        !(
          expected === null ||
          (typeof expected === "number" &&
            Number.isSafeInteger(expected) &&
            expected >= 1)
        )
      )
        return controlError("menu_board_release_invalid", 422);
      const published = await command(env, authorized, {
        kind: "publish_board",
        boardId: target.boardId,
        documentRevision,
        expectedReleaseRevision: expected,
        userId,
      });
      if (published.ok)
        return controlJson(
          {
            ok: true,
            release: {
              releaseRevision: published.value.release.releaseRevision,
              digest: published.value.release.digest,
              publishedAt: published.value.release.publishedAt,
            },
          },
          published.value.replayed ? 200 : 201,
        );
      const error = published.error;
      switch (error.code) {
        case "menu_board_missing":
          return controlError(error.code, 404);
        case "menu_board_unavailable":
        case "menu_board_media_unavailable":
        case "organisation_placement_conflict":
          return controlError(error.code, 503);
        case "menu_board_changed":
        case "menu_board_release_conflict":
          return controlJson({ ok: false, ...error, error: error.code }, 409);
        case "menu_board_empty":
        case "menu_board_unplaced":
        case "menu_board_binding_missing":
          return controlJson({ ok: false, ...error, error: error.code }, 422);
        default:
          return error satisfies never;
      }
    }
    case "screens": {
      if (read) {
        const listed = await command(env, authorized, { kind: "list_screens" });
        return listed.ok
          ? controlJson({ ok: true, screens: listed.value.screens })
          : controlError(listed.error.code, 503);
      }
      return pairScreen(request, env, authorized);
    }
    case "screen": {
      if (request.method === "DELETE") {
        const removed = await command(env, authorized, {
          kind: "remove_screen",
          screenId: target.screenId,
        });
        return removed.ok
          ? controlJson({ ok: true })
          : controlError(
              removed.error.code,
              removed.error.code === "menu_screen_missing" ? 404 : 503,
            );
      }
      const body = await readJsonRecord(request);
      const boardId = body.ok ? body.value.boardId : undefined;
      if (
        typeof boardId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(boardId)
      )
        return controlError("menu_screen_invalid", 422);
      const assigned = await command(env, authorized, {
        kind: "assign_screen",
        screenId: target.screenId,
        boardId,
      });
      return assigned.ok
        ? controlJson({ ok: true })
        : controlError(
            assigned.error.code,
            assigned.error.code === "organisation_placement_conflict"
              ? 503
              : 404,
          );
    }
    default:
      return target satisfies never;
  }
}

/**
 * Pairs the screen that shows `code` with a board. The Actor keeps the new
 * screen first; the pairing then takes its token, once. A code that another
 * member took meanwhile leaves the new screen removed.
 */
async function pairScreen(
  request: Request,
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<Response> {
  const body = await readJsonRecord(request);
  const rawCode = body.ok ? body.value.code : undefined;
  const code = typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
  const name = body.ok ? body.value.name : undefined;
  const boardId = body.ok ? body.value.boardId : undefined;
  if (
    !isMenuScreenCode(code) ||
    typeof name !== "string" ||
    name.trim().length === 0 ||
    name.trim().length > PAIRING_SCREEN_NAME_LIMIT ||
    !isMenuBoardText(name) ||
    typeof boardId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(boardId)
  )
    return controlError("menu_screen_invalid", 422);
  const now = Date.now();
  const pairing = await readOpenScreenPairing(env.DB, code, now);
  if (pairing === null) return controlError("menu_screen_code_unknown", 404);
  if (pairing.claimed_at !== null)
    return controlError("menu_screen_code_used", 409);
  const screenId = `screen_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const secret = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const userId = authorized.authenticated.session.userId;
  const paired = await command(env, authorized, {
    kind: "pair_screen",
    screenId,
    secret,
    name: name.trim(),
    boardId,
    userId,
  });
  if (!paired.ok)
    return controlError(
      paired.error.code,
      paired.error.code === "menu_board_missing"
        ? 404
        : paired.error.code === "menu_screen_limit"
          ? 409
          : 503,
    );
  const claimed = await claimScreenPairing(env.DB, {
    pairingId: pairing.pairing_id,
    organisationId: String(authorized.organisationId),
    screenToken: menuScreenToken(
      String(authorized.organisationId),
      screenId,
      secret,
    ),
    now,
  });
  if (!claimed) {
    await command(env, authorized, { kind: "remove_screen", screenId });
    return controlError("menu_screen_code_used", 409);
  }
  return controlJson(
    { ok: true, screen: { screenId, name: name.trim(), boardId } },
    201,
  );
}

/**
 * Comments pinned to a board's elements (Plan 40B phase 5, slice 6). Every
 * member reads them; staff and above write them. The Actor names the
 * author, and only the author deletes a comment.
 */
async function handleCommentRoute(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  target:
    | Readonly<{ kind: "board_comments"; boardId: string }>
    | Readonly<{ kind: "board_comment"; boardId: string; commentId: string }>,
): Promise<Response> {
  const method = request.method;
  const allowed =
    target.kind === "board_comments"
      ? method === "GET" || method === "POST"
      : method === "PATCH" || method === "DELETE";
  if (!allowed) return controlError("method_not_allowed", 405);
  const read = method === "GET";
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    read ? "viewer" : "operator",
    !read,
  );
  if (!authorized.ok) return authorized.response;
  const userId = authorized.authenticated.session.userId;
  let input: MenuBoardCommand;
  if (target.kind === "board_comment") {
    if (method === "DELETE")
      input = {
        kind: "delete_comment",
        boardId: target.boardId,
        commentId: target.commentId,
        userId,
      };
    else {
      const body = await readJsonRecord(request);
      const resolved = body.ok ? body.value.resolved : undefined;
      if (typeof resolved !== "boolean")
        return controlError("menu_board_comment_invalid", 422);
      input = {
        kind: "resolve_comment",
        boardId: target.boardId,
        threadId: target.commentId,
        resolved,
        userId,
      };
    }
  } else if (read)
    input = { kind: "list_comments", boardId: target.boardId, userId };
  else {
    const body = await readJsonRecord(request);
    const value = body.ok ? body.value : {};
    const id = (raw: unknown): raw is string | null =>
      raw === null ||
      (typeof raw === "string" && /^[A-Za-z0-9_:-]{1,128}$/u.test(raw));
    if (
      !id(value.elementId) ||
      !id(value.threadId) ||
      (value.elementId === null) === (value.threadId === null) ||
      typeof value.body !== "string" ||
      value.body.length > 4000 ||
      typeof value.operationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(value.operationId)
    )
      return controlError("menu_board_comment_invalid", 422);
    input = {
      kind: "add_comment",
      boardId: target.boardId,
      elementId: value.elementId,
      threadId: value.threadId,
      body: value.body,
      operationId: value.operationId,
      userId,
    };
  }
  const result = (await command(env, authorized, input)) as Awaited<
    MenuBoardCommandReply<Variant<MenuBoardCommand, "list_comments">>
  >;
  if (result.ok)
    return controlJson(
      { ok: true, threads: result.value.threads },
      input.kind === "add_comment" ? 201 : 200,
    );
  const code = result.error.code;
  return controlError(code, commentStatus(code));
}

/**
 * The version history of a board (Plan 40B phase 5, slice 7). Every member
 * reads it; staff and above save a named version and restore one. A
 * restore changes the draft only: screens change when a person publishes.
 */
async function handleVersionRoute(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  target:
    | Readonly<{ kind: "board_versions"; boardId: string }>
    | Readonly<{ kind: "board_version_restore"; boardId: string; versionId: string }>,
): Promise<Response> {
  const read = request.method === "GET";
  if (
    !(read && target.kind === "board_versions") &&
    request.method !== "POST"
  )
    return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    read ? "viewer" : "operator",
    !read,
  );
  if (!authorized.ok) return authorized.response;
  let input: MenuBoardCommand;
  if (read) input = { kind: "list_versions", boardId: target.boardId };
  else {
    const body = await readJsonRecord(request);
    const value = body.ok ? body.value : {};
    const label = target.kind === "board_versions" ? value.label : target.versionId;
    if (
      typeof label !== "string" ||
      label.trim().length === 0 ||
      label.length > 80 ||
      !isMenuBoardText(label) ||
      typeof value.operationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(value.operationId)
    )
      return controlError("menu_board_version_invalid", 422);
    input = {
      kind: target.kind === "board_versions" ? "save_version" : "restore_version",
      boardId: target.boardId,
      value: label,
      operationId: value.operationId,
      userId: authorized.authenticated.session.userId,
      controlSessionId: authorized.authenticated.session.controlSessionId,
    };
  }
  const result = (await command(env, authorized, input)) as Awaited<
    MenuBoardCommandReply<Variant<MenuBoardCommand, "list_versions">>
  >;
  if (result.ok)
    return controlJson(
      { ok: true, versions: result.value.versions },
      input.kind === "save_version" ? 201 : 200,
    );
  const code = result.error.code;
  return controlError(
    code,
    code === "menu_board_version_missing"
      ? 404
      : code === "menu_board_version_invalid"
        ? 422
        : commentStatus(code),
  );
}

function commentStatus(code: string): number {
  switch (code) {
    case "menu_board_missing":
    case "menu_board_comment_missing":
      return 404;
    case "menu_board_element_missing":
    case "menu_board_comment_invalid":
      return 422;
    case "menu_board_comment_limit":
      return 409;
    case "menu_board_comment_not_author":
    case "access_revoked":
      return 403;
    default:
      return 503;
  }
}

/**
 * Archives a board that no screen shows, or restores it (Plan 40B, board
 * removal). Only an owner or admin may: a board is shared shop work.
 */
async function handleArchiveRoute(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  boardId: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  const archived = body.ok ? body.value.archived : undefined;
  if (typeof archived !== "boolean")
    return controlError("menu_board_archive_invalid", 422);
  const changed = await command(env, authorized, {
    kind: "set_board_archived",
    boardId,
    archived,
    userId: authorized.authenticated.session.userId,
  });
  if (changed.ok) return controlJson({ ok: true, ...changed.value });
  switch (changed.error.code) {
    case "menu_board_missing":
      return controlError(changed.error.code, 404);
    case "menu_board_on_screen":
      return controlJson(
        { ok: false, error: changed.error.code, screens: changed.error.screens },
        409,
      );
    case "menu_board_limit":
      return controlError(changed.error.code, 409);
    case "organisation_placement_conflict":
      return controlError(changed.error.code, 503);
    default:
      return changed.error satisfies never;
  }
}

/** The Organisation's screens for the Devices page, or null if unread. */
export async function readMenuScreenList(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<readonly MenuScreenSummary[] | null> {
  const listed = await command(env, authorized, { kind: "list_screens" });
  return listed.ok ? listed.value.screens : null;
}

async function command<C extends MenuBoardCommand>(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  input: C,
): Promise<MenuBoardCommandReply<C>> {
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: authorized.organisationId,
      now: Date.now(),
    });
    return (await organisation.menuBoardCommand({
      organisationId: authorized.organisationId,
      command: input,
    })) as MenuBoardCommandReply<C>;
  } catch {
    return {
      ok: false,
      error: { code: "organisation_placement_conflict" },
    };
  }
}

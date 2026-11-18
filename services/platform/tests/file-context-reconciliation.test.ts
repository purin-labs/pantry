import { describe, expect, it } from "vitest";

import { observeFileGrantScope } from "../src/context/files/reconciliation";

describe("file context reconciliation cursors", () => {
  it("preserves Dropbox admissions when the durable cursor has no changes", async () => {
    const fetcher = new SequenceFetcher([
      Response.json({ entries: [], cursor: "cursor-2", has_more: false }),
    ]);

    await expect(
      observeFileGrantScope(
        {
          kind: "dropbox_folder",
          providerFolderId: "id:recipes",
          pathDisplay: "/Recipes",
        },
        { kind: "dropbox", accessToken: "token", homeNamespaceId: "ns-home" },
        { kind: "dropbox", cursor: "cursor-1" },
        fetcher.fetch.bind(fetcher),
      ),
    ).resolves.toEqual({
      ok: true,
      value: {
        kind: "unchanged",
        cursor: { kind: "dropbox", cursor: "cursor-2" },
      },
    });
    expect(requestPath(fetcher.requests[0])).toBe(
      "/2/files/list_folder/continue",
    );
  });

  it("rebuilds a Dropbox snapshot when the cursor reports a deletion", async () => {
    const fetcher = new SequenceFetcher([
      Response.json({
        entries: [
          {
            ".tag": "deleted",
            name: "old.md",
            path_display: "/Recipes/old.md",
          },
        ],
        cursor: "cursor-change",
        has_more: false,
      }),
      Response.json({
        entries: [dropboxFile()],
        cursor: "cursor-snapshot",
        has_more: false,
      }),
    ]);

    const result = await observeFileGrantScope(
      {
        kind: "dropbox_folder",
        providerFolderId: "id:recipes",
        pathDisplay: "/Recipes",
      },
      { kind: "dropbox", accessToken: "token", homeNamespaceId: "ns-home" },
      { kind: "dropbox", cursor: "cursor-1" },
      fetcher.fetch.bind(fetcher),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "snapshot",
        cursor: { kind: "dropbox", cursor: "cursor-snapshot" },
        files: [
          { providerFileId: "id:recipe", displayPath: "/Recipes/recipe.md" },
        ],
      },
    });
    expect(fetcher.requests.map(requestPath)).toEqual([
      "/2/files/list_folder/continue",
      "/2/files/list_folder",
    ]);
  });

  it("invalidates Dropbox folder authority when the provider denies the scope", async () => {
    const fetcher = new SequenceFetcher([
      Response.json({ error_summary: "path/not_found/" }, { status: 409 }),
    ]);

    await expect(
      observeFileGrantScope(
        {
          kind: "dropbox_folder",
          providerFolderId: "id:recipes",
          pathDisplay: "/Recipes",
        },
        { kind: "dropbox", accessToken: "token", homeNamespaceId: "ns-home" },
        { kind: "dropbox", cursor: "cursor-1" },
        fetcher.fetch.bind(fetcher),
      ),
    ).resolves.toEqual({ ok: true, value: { kind: "unavailable" } });
  });

  it("revalidates exact Drive files when the cursor has unrelated changes", async () => {
    const fetcher = new SequenceFetcher([
      Response.json({
        changes: [{ fileId: "other-file", removed: true }],
        newStartPageToken: "page-2",
      }),
      Response.json(googleDriveFile()),
    ]);

    const result = await observeFileGrantScope(
      {
        kind: "gdrive_file",
        providerFileId: "drive-file-1",
        name: "recipe.md",
      },
      { kind: "google_drive", accessToken: "token" },
      { kind: "gdrive", pageToken: "page-1" },
      fetcher.fetch.bind(fetcher),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "snapshot",
        cursor: { kind: "gdrive", pageToken: "page-2" },
        files: [{ providerFileId: "drive-file-1", displayName: "recipe.md" }],
      },
    });
    expect(fetcher.requests.map(requestPath)).toEqual([
      "/drive/v3/changes",
      "/drive/v3/files/drive-file-1",
    ]);
  });

  it("turns a removed Drive file into an empty current snapshot", async () => {
    const fetcher = new SequenceFetcher([
      Response.json({
        changes: [{ fileId: "drive-file-1", removed: true }],
        newStartPageToken: "page-2",
      }),
      Response.json({ error: { code: 404 } }, { status: 404 }),
    ]);

    await expect(
      observeFileGrantScope(
        {
          kind: "gdrive_file",
          providerFileId: "drive-file-1",
          name: "recipe.md",
        },
        { kind: "google_drive", accessToken: "token" },
        { kind: "gdrive", pageToken: "page-1" },
        fetcher.fetch.bind(fetcher),
      ),
    ).resolves.toEqual({
      ok: true,
      value: {
        kind: "snapshot",
        cursor: { kind: "gdrive", pageToken: "page-2" },
        files: [],
      },
    });
  });
});

class SequenceFetcher {
  readonly requests: Request[] = [];

  constructor(private readonly responses: Response[]) {}

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.requests.push(new Request(input, init));
    const response = this.responses.shift();
    if (response === undefined) throw new Error("missing fixture response");
    return response;
  }
}

function dropboxFile(): Readonly<Record<string, unknown>> {
  return {
    ".tag": "file",
    id: "id:recipe",
    name: "recipe.md",
    path_display: "/Recipes/recipe.md",
    rev: "016",
    server_modified: "2026-08-29T00:00:00Z",
    size: 6,
    is_downloadable: true,
    content_hash: "hash",
  };
}

function googleDriveFile(): Readonly<Record<string, unknown>> {
  return {
    id: "drive-file-1",
    name: "recipe.md",
    mimeType: "text/markdown",
    size: "6",
    version: "7",
    modifiedTime: "2026-08-29T00:00:00.000Z",
    headRevisionId: "head-7",
    trashed: false,
    webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
    parents: ["folder-1"],
  };
}

function requestPath(request: Request | undefined): string {
  if (request === undefined) throw new Error("missing request");
  return new URL(request.url).pathname;
}

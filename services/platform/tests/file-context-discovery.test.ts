import { describe, expect, it } from "vitest";

import { discoverFileResources } from "../src/context/files";

describe("file resource discovery", () => {
  it("lists one bounded Dropbox folder page and filters its entries", async () => {
    const requests: Request[] = [];
    const fetcher = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push(new Request(input, init));
      return Response.json({
        entries: [
          {
            ".tag": "folder",
            id: "id:recipes",
            name: "Recipes",
            path_display: "/Recipes",
          },
          {
            ".tag": "file",
            id: "id:contract",
            name: "Supplier contract.md",
            path_display: "/Supplier contract.md",
            rev: "015",
            server_modified: "2026-08-29T00:00:00Z",
            size: 12,
            is_downloadable: true,
            content_hash: "hash",
          },
        ],
        cursor: "cursor-next",
        has_more: true,
      });
    };

    await expect(
      discoverFileResources({
        access: {
          kind: "dropbox",
          accessToken: "token",
          homeNamespaceId: "ns-home",
        },
        path: "",
        query: "recipe",
        cursor: null,
        fetcher,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        provider: "dropbox",
        entries: [
          {
            kind: "dropbox_folder",
            providerFolderId: "id:recipes",
            name: "Recipes",
            pathDisplay: "/Recipes",
          },
        ],
        nextCursor: "cursor-next",
      },
    });
    expect(await requests[0]?.json()).toMatchObject({
      recursive: false,
      limit: 100,
    });
    expect(requests[0]?.headers.get("dropbox-api-path-root")).toBe(
      JSON.stringify({ ".tag": "namespace_id", namespace_id: "ns-home" }),
    );
  });

  it("routes Google Drive discovery to the owner-interactive picker", async () => {
    await expect(
      discoverFileResources({
        access: { kind: "google_drive", accessToken: "picker-is-separate" },
        path: "",
        query: "",
        cursor: null,
        fetcher: fetch,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "file_resource_picker_required" },
    });
  });

  it("rejects oversized discovery input before a provider request", async () => {
    let called = false;
    const fetcher = async (): Promise<Response> => {
      called = true;
      return Response.json({});
    };
    await expect(
      discoverFileResources({
        access: {
          kind: "dropbox",
          accessToken: "token",
          homeNamespaceId: "ns-home",
        },
        path: "",
        query: "x".repeat(257),
        cursor: null,
        fetcher,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "file_resource_discovery_invalid" },
    });
    expect(called).toBe(false);
  });
});

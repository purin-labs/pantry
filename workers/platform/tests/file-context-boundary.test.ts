import { describe, expect, it } from "vitest";

import {
  encodeCapabilityKey,
  parseCapabilityKey,
} from "@purin-labs/authority/authorization/access-grants/index";
import { parseAccessGrantTarget } from "@purin-labs/authority/data/access-grants";
import { FILE_EXTRACTED_TEXT_MAX_BYTES } from "@purin-labs/agent/context/files/domain";
import { normalizeFileText } from "@purin-labs/agent/context/files/projection";

describe("file context boundaries", () => {
  it("bounds normalized extracted text without splitting UTF-8", () => {
    const normalized = normalizeFileText(
      `  ${"é".repeat(FILE_EXTRACTED_TEXT_MAX_BYTES)}  `,
    );
    const bytes = new TextEncoder().encode(normalized);

    expect(bytes.byteLength).toBeLessThanOrEqual(FILE_EXTRACTED_TEXT_MAX_BYTES);
    expect(normalized.endsWith("é")).toBe(true);
  });

  it("round-trips a typed Dropbox folder capability", () => {
    const target = {
      kind: "file_resource" as const,
      capabilityId: "file.read",
      capabilityVersion: 1,
      integrationAccountId: "ia_files",
      scope: {
        kind: "dropbox_folder" as const,
        providerFolderId: "id:recipes:v1",
        pathDisplay: "/Recipes",
      },
    };

    const encoded = encodeCapabilityKey(target);
    expect(parseCapabilityKey(encoded)).toEqual({ ok: true, value: target });
    expect(parseAccessGrantTarget(target)).toEqual({ ok: true, value: target });
  });

  it("rejects mixed provider scope fields", () => {
    expect(
      parseAccessGrantTarget({
        kind: "file_resource",
        capabilityId: "file.read",
        capabilityVersion: 1,
        integrationAccountId: "ia_files",
        scope: {
          kind: "dropbox_folder",
          providerFolderId: "id:recipes",
          pathDisplay: "/Recipes",
          name: "Drive field",
        },
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_grant_target", field: "target.scope" },
    });
  });

  it("rejects write authority for file grants", () => {
    expect(
      parseAccessGrantTarget({
        kind: "file_resource",
        capabilityId: "file.write",
        capabilityVersion: 1,
        integrationAccountId: "ia_files",
        scope: {
          kind: "gdrive_file",
          providerFileId: "drive-file-1",
          name: "Recipe",
        },
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_grant_target", field: "target.capabilityId" },
    });
  });
});

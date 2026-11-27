import { describe, expect, it, vi } from "vitest";

import { settleGoogleDrivePicker } from "@purin-labs/area-organisation-contract/ui/features/access/file-resource-boundary";

const PICKER = {
  Action: { PICKED: "picked", CANCEL: "cancel", ERROR: "error" },
  Response: { ACTION: "action", DOCUMENTS: "docs" },
  Document: { ID: "id", NAME: "name" },
};

describe("Google Drive Picker", () => {
  it("waits through intermediate actions before settling the selected file", () => {
    const resolve = vi.fn();
    const reject = vi.fn();

    settleGoogleDrivePicker(PICKER, resolve, reject, { action: "loaded" });

    expect(resolve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();

    settleGoogleDrivePicker(PICKER, resolve, reject, {
      action: "picked",
      docs: [{ id: "drive-file-1", name: "plan-34-google-drive-canary.md" }],
    });

    expect(resolve).toHaveBeenCalledWith({
      providerFileId: "drive-file-1",
      name: "plan-34-google-drive-canary.md",
    });
    expect(reject).not.toHaveBeenCalled();
  });

  it("rejects a terminal Picker error", () => {
    const resolve = vi.fn();
    const reject = vi.fn();

    settleGoogleDrivePicker(PICKER, resolve, reject, { action: "error" });

    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(
      new Error("Google Drive Picker failed."),
    );
  });
});

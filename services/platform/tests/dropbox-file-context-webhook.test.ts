import {
  describe,
  expect,
  it,
} from "vitest";

import { parseDropboxWebhookAccountIds } from "../src/gateway/dropbox-webhook";

describe("Dropbox file-context webhook boundary", () => {
  it("accepts only bounded account hint payloads and removes duplicates", () => {
    expect(
      parseDropboxWebhookAccountIds(
        JSON.stringify({
          list_folder: { accounts: ["dbid:one", "dbid:one", "dbid:two"] },
        }),
      ),
    ).toEqual(["dbid:one", "dbid:two"]);
    expect(
      parseDropboxWebhookAccountIds(
        JSON.stringify({
          list_folder: { accounts: ["dbid:one", 2] },
        }),
      ),
    ).toBeNull();
    expect(parseDropboxWebhookAccountIds("not-json")).toBeNull();
  });
});

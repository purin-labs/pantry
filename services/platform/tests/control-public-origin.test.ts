import { describe, expect, it } from "vitest";

import { requirePublicOrigin } from "@purin-labs/kernel/public-origin";

describe("control public origin", () => {
  it("accepts HTTPS origins and HTTP loopback origins", () => {
    expect(requirePublicOrigin("https://pantry.example")).toBe(
      "https://pantry.example",
    );
    expect(requirePublicOrigin("http://127.0.0.1:7700")).toBe(
      "http://127.0.0.1:7700",
    );
    expect(requirePublicOrigin("http://localhost:7700")).toBe(
      "http://localhost:7700",
    );
  });

  it("rejects insecure remote hosts and non-origin URL components", () => {
    expect(() => requirePublicOrigin("http://pantry.example")).toThrow(
      /loopback HTTP origin/u,
    );
    expect(() => requirePublicOrigin("http://127.0.0.1:7700/portal")).toThrow(
      /loopback HTTP origin/u,
    );
    expect(() => requirePublicOrigin("https://user@pantry.example")).toThrow(
      /loopback HTTP origin/u,
    );
  });
});

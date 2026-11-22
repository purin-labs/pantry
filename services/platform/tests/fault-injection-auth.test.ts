import { describe, expect, test } from "vitest";

import { authorizeFaultInjectionBearer } from "@purin-labs/kernel/fault-injection-auth";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("fault injection authentication", function faultInjectionAuthenticationSuite() {
  test("accepts the exact configured bearer", function acceptsConfiguredBearer() {
    expect(
      authorizeFaultInjectionBearer({
        authorization: `Bearer ${TOKEN}`,
        configuredToken: TOKEN,
      }),
    ).toBe(true);
  });

  test.each([
    {
      name: "missing configuration",
      authorization: `Bearer ${TOKEN}`,
      configuredToken: undefined,
    },
    {
      name: "short configuration",
      authorization: "Bearer short",
      configuredToken: "short",
    },
    { name: "missing credential", authorization: null, configuredToken: TOKEN },
    {
      name: "wrong scheme",
      authorization: `Basic ${TOKEN}`,
      configuredToken: TOKEN,
    },
    {
      name: "wrong token",
      authorization: `Bearer ${TOKEN}0`,
      configuredToken: TOKEN,
    },
    {
      name: "padded token",
      authorization: `Bearer ${TOKEN} `,
      configuredToken: TOKEN,
    },
  ])("rejects $name", function rejectsInvalidFaultCredential(input) {
    expect(
      authorizeFaultInjectionBearer({
        authorization: input.authorization,
        configuredToken: input.configuredToken,
      }),
    ).toBe(false);
  });
});

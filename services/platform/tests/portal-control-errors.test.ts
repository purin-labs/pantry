import { describe, expect, it } from "vitest";

import {
  controlApiProblemMessage,
  parseControlApiProblem,
} from "@purin-labs/control-api/portal/errors";
import { parseAgentOperationsResponse } from "@purin-labs/commerce-control-api/portal/agent-operations";

describe("portal control error boundary", () => {
  it("recognizes the exact saved-run missing response", () => {
    expect(parseControlApiProblem({ error: "bakery_run_not_found" }).kind).toBe(
      "bakery_run_not_found",
    );
  });

  it("explains missing provider configuration from a retryable failure", () => {
    const problem = parseControlApiProblem({
      kind: "retryable_failure",
      reason_code: "provider_configuration_missing",
      support_reference: "support_123",
    });
    expect(problem).toEqual({
      kind: "provider_configuration_missing",
      message:
        "This integration is unavailable. Ask your Purin Pantry administrator to configure it, then try again.",
      supportReference: "support_123",
    });
  });

  it("does not expose unknown server codes or messages", () => {
    const problem = parseControlApiProblem({
      error: "provider_internal_secret_failure",
      message: "raw provider stack and credential detail",
      support_reference: "support_123",
    });
    expect(problem.kind).toBe("unknown");
    expect(controlApiProblemMessage(problem)).toBe(
      "Pantry could not complete this request. Try again. Support reference: support_123",
    );
    expect(
      parseControlApiProblem({
        error: "provider_internal_secret_failure",
        support_reference: 42,
      }).supportReference,
    ).toBeNull();
    expect(parseControlApiProblem("raw provider stack").message).toBe(
      "Pantry could not complete this request. Try again.",
    );
  });

  it("keeps agent-operation envelope errors behind the same safe boundary", () => {
    expect(() =>
      parseAgentOperationsResponse({
        ok: false,
        error: "provider_internal_secret_failure",
      }),
    ).toThrow("Agent operations are unavailable.");
  });
});

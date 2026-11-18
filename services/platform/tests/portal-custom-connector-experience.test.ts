// @ts-expect-error React runtime declarations are scoped to apps/portal.
import React from "../../../apps/portal/node_modules/react";
// @ts-expect-error React DOM runtime declarations are scoped to apps/portal.
import { renderToStaticMarkup } from "../../../apps/portal/node_modules/react-dom/server";
import { describe, expect, it } from "vitest";
// @ts-expect-error The portal build type-checks its JSX modules.
import { CustomConnectorWriteFields } from "../../../apps/portal/src/features/integrations/custom-connectors";

function writeFieldReview(): string {
  return renderToStaticMarkup(
    React.createElement(CustomConnectorWriteFields, {
      preview: {
        kind: "available",
        accountDisplayName: "Kyoto bakery",
        operationLabel: "Create stock request",
        origin: "https://inventory.example",
        method: "POST",
        path: "/requests",
        fields: [
          { path: "body.quantity", value: 20 },
          { path: "body.note", value: "" },
          { path: "body.reference", value: "<stock & flour>" },
          {
            path: "body.delivery",
            value: { location: "Kyoto", urgent: false },
          },
        ],
      },
    }),
  );
}

describe("custom connector experience", function customConnectorExperienceSuite() {
  it("reviews actual request values, including structured fields, with escaped provider content", function reviewRequestValues() {
    const markup = writeFieldReview();
    expect(markup).toContain("body.quantity");
    expect(markup).toContain("&quot;&quot;");
    expect(markup).toContain(">20<");
    expect(markup).toContain("&lt;stock &amp; flour&gt;");
    expect(markup).toContain("Kyoto");
    expect(markup).toContain("false");
    expect(markup).toContain("https://inventory.example/requests");
    const unavailable = renderToStaticMarkup(
      React.createElement(CustomConnectorWriteFields, {
        preview: { kind: "unavailable", reason: "permission_required" },
      }),
    );
    expect(unavailable).toContain("workspace admin");
    expect(unavailable).not.toContain("body.quantity");
  });
});

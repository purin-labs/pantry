import { isMerchantReportName } from "../../entity-plane/merchant-reports";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { hasExactKeys, isRecord } from "@purin-labs/std";
import type { HarnessMerchantReportRequest } from "./services";
import { jsonSchema } from "@purin-labs/agent-tools/define-tool";
import { defineCommerceTool } from "./services";

export const merchantReport = defineCommerceTool({
  name: "commerce_merchant_report",
  description:
    "Run one named merchant report and return its headline number, the exact records behind it, " +
    "the metric it measures, its unit, its operating window, freshness, and merchant revision. " +
    "Call as tools.commerce_merchant_report({ request: { name } }). " +
    "Report names: open_orders, low_stock_exposure, payment_failures, fulfillment_exceptions, " +
    "product_sales. A report the read surface cannot execute returns kind 'unavailable' with the " +
    "reason; report that plainly instead of substituting another number.",
  input: jsonSchema({
    type: "object",
    properties: {
      request: {
        type: "object",
        properties: {
          name: {
            type: "string",
            enum: [
              "open_orders",
              "low_stock_exposure",
              "payment_failures",
              "fulfillment_exceptions",
              "product_sales",
            ],
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    required: ["request"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) => parseMerchantReportArgs([input]),
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceEntityPlaneContext,
  },
  unavailable: "commerce merchant report is unavailable",
  handler: ({ readMerchantReport }) =>
    readMerchantReport === undefined
      ? undefined
      : (request) => readMerchantReport(request),
});

function parseMerchantReportArgs(
  args: readonly unknown[],
): HarnessMerchantReportRequest {
  if (
    args.length !== 1 ||
    !isRecord(args[0]) ||
    Object.keys(args[0]).length !== 1 ||
    !Object.hasOwn(args[0], "request")
  ) {
    throw new TypeError("commerce_merchant_report requires one request object");
  }
  const request = args[0].request;
  if (
    !isRecord(request) ||
    !hasExactKeys(request, ["name"]) ||
    !isMerchantReportName(request.name)
  ) {
    throw new TypeError("commerce_merchant_report arguments are invalid");
  }
  return { name: request.name };
}

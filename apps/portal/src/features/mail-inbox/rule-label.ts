import type { MailRule } from "@seams/control-api";
import { assertNever } from "@seams/std";

export function mailRuleLabel(rule: MailRule): string {
  switch (rule.kind) {
    case "categorize":
      return rule.category;
    case "prioritize":
      return "Important";
    case "investigate_supplier_delay":
      return "Supplier delay reply";
    default:
      return assertNever(rule);
  }
}

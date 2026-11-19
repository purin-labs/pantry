import type { RackLayoutDraft, RackLayoutProposal } from "./rack-layout";
import type { TransferInput } from "@purin-labs/production-simulation/recipes/bakery/workcell-input";
import type { Variant } from "@purin-labs/type-utils";

declare const blocked: Variant<RackLayoutProposal, "blocked">;
declare const input: TransferInput;
// @ts-expect-error Blocked proposals cannot carry an executable request through a spread.
const executableBlocked: RackLayoutProposal = { ...blocked, input };
// @ts-expect-error A draft requires its evaluated fit result.
const unevaluated: RackLayoutDraft = {
  kind: "draft",
  previous: blocked.previous,
  epoch: blocked.epoch,
  layout: blocked.layout,
};
void [executableBlocked, unevaluated];

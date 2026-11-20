import type { CheckoutProfile } from "@purin-labs/commerce-contracts";
import React from "react";
import { assertNever } from "@purin-labs/std";

export function ProfileState(props: {
  readonly state: CheckoutProfile["lifecycle"]["state"];
}): React.ReactNode {
  return (
    <span
      className={`checkout-profile-state checkout-profile-state-${props.state}`}
    >
      {profileStateLabel(props.state)}
    </span>
  );
}

function profileStateLabel(
  state: CheckoutProfile["lifecycle"]["state"],
): string {
  switch (state) {
    case "draft":
      return "Draft";
    case "published":
      return "Published";
    case "retired":
      return "Retired";
    default:
      return assertNever(state, "Unexpected checkout profile lifecycle");
  }
}

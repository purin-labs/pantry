export type ExistingCustomConnectorSetupKind =
  "rotate_account" | "upgrade_account" | "resume_account";

type CustomConnectorSetupAccountLifecycle = Readonly<{
  readonly account: "active" | "degraded" | "reauth_required" | "disabled";
  readonly connection: "active" | "reauth_required" | "disabled";
  readonly binding: "active" | "disabled";
}>;

export function parseCustomConnectorSetupAccountLifecycle(input: {
  readonly account: unknown;
  readonly connection: unknown;
  readonly binding: unknown;
}): CustomConnectorSetupAccountLifecycle | null {
  if (
    input.account !== "active" &&
    input.account !== "degraded" &&
    input.account !== "reauth_required" &&
    input.account !== "disabled"
  ) {
    return null;
  }
  if (
    input.connection !== "active" &&
    input.connection !== "reauth_required" &&
    input.connection !== "disabled"
  ) {
    return null;
  }
  if (input.binding !== "active" && input.binding !== "disabled") {
    return null;
  }
  return {
    account: input.account,
    connection: input.connection,
    binding: input.binding,
  };
}

export function customConnectorSetupLifecycleAllows(
  kind: ExistingCustomConnectorSetupKind,
  lifecycle: CustomConnectorSetupAccountLifecycle,
): boolean {
  switch (kind) {
    case "rotate_account":
      return (
        (lifecycle.account === "active" ||
          lifecycle.account === "degraded" ||
          lifecycle.account === "reauth_required") &&
        (lifecycle.connection === "active" ||
          lifecycle.connection === "reauth_required") &&
        lifecycle.binding === "active"
      );
    case "upgrade_account":
      return (
        lifecycle.account === "active" &&
        lifecycle.connection === "active" &&
        lifecycle.binding === "active"
      );
    case "resume_account":
      return (
        lifecycle.account === "disabled" &&
        lifecycle.connection === "disabled" &&
        lifecycle.binding === "disabled"
      );
  }
}

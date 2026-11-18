import { OrganisationExecutionScope } from "../src/organisation-execution-scope";

declare const scope: OrganisationExecutionScope;

// @ts-expect-error Execution scopes must come from the placement boundary.
const fabricated: OrganisationExecutionScope = {
  database: scope.database,
  organisationId: scope.organisationId,
  placement: scope.placement,
  fenceToken: scope.fenceToken,
  isActive: scope.isActive,
};
// @ts-expect-error Spreading fields cannot carry the private scope identity.
const spread: OrganisationExecutionScope = {
  ...scope,
  isActive: scope.isActive,
};
// @ts-expect-error A caller cannot construct a scope with an arbitrary database.
new OrganisationExecutionScope(
  scope.database,
  scope.organisationId,
  scope.placement,
  scope.fenceToken,
);

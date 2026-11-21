# Pantry Kitchen model

This package holds Pantry's Kitchen modules: the bakery scenario, procedure,
physics, robot, surface and run-snapshot contracts that the Portal, Platform
and the production simulation share. Each module is a subpath export, such as
`@purin-labs/bakery-model/bakery-physics`. The package has no root export.

The Commerce client is
[`packages/commerce-client`](../commerce-client/README.md)
(`@purin-labs/commerce-client`). Import it directly.

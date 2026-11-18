---
title: Onboarding operations
description: Triage provider authorization, lifecycle, and readiness incidents.
---

# Onboarding operations

Onboarding incidents are handled from the organisation's durable lifecycle state.
Operators inspect the exact organisation, connection, credential generation,
authority revision, and readiness reason before retrying a transition.

## Common workflow

1. Identify the organisation and operation identity.
2. Read the current lifecycle state and the last durable receipt.
3. Check the provider connection, credential generation, and authority
   selection independently.
4. Re-run the narrowest failed readiness or reconciliation step.
5. Confirm that the resulting projection and audit record match the receipt.

## Provider authorization

OAuth callbacks are bound to the organisation and installation identity. A callback
that cannot be assigned to exactly one organisation fails closed. Reconnect creates a
new credential generation and closes the stale one; it does not silently
reuse an old grant.

## Credential and lifecycle incidents

Disable or revoke a connection when the provider credential is suspected to be
compromised. Use the Seams Vault lifecycle operation, then verify that an old
pinned session cannot resolve the revoked generation.

Archive and restore preserve the explicit data-retention and erasure policy.
They do not bypass provider reconciliation or restore an obsolete authority
selection.

The repository runbook is `docs/runbooks/onboarding-operations.md`.

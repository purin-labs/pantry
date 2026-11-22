---
title: Merchant onboarding
description: Connect an organisation, establish authority, and activate Purin Pantry operations safely.
---

# Merchant onboarding

The portal uses the same control plane as Slack work. It owns organisation creation,
provider OAuth, setup, readiness, activation, rotation, disable, reconnect,
archive, and restore operations.

## Organisation shape

```text
Organisation
├── Commerce system
│   ├── Purin Checkout
│   └── Shopify
├── Payment connection
│   └── Stripe
└── Communication connection
    └── Slack workspace and destination
```

The organisation selects one commerce authority. Payment and communication
connections support the operation; they do not satisfy commerce authority on
their own. Stripe is optional during onboarding — activation requires only an
AI inference source, a commerce authority, and Slack.

## Activation sequence

The portal's setup checklist walks these steps in order:

1. Sign in with Google and create the workspace. The creator becomes the
   verified owner.
2. Choose the AI inference source: the owner's ChatGPT subscription, an organisation
   OpenAI API key, or inference provided by Purin. Only an owner can connect the
   ChatGPT subscription.
3. Choose a commerce authority — set up Purin Checkout (which seeds a demo
   café and patisserie catalogue you can replace) or connect a Shopify store.
4. Connect Slack, invite the Slack app to each channel it should operate in,
   then refresh and choose the channel where updates go.
5. Save the Slack update settings. This writes the operating profile with the
   safe read-and-propose defaults.
6. Pantry re-evaluates readiness continuously and, once every check passes,
   activates the workspace on its own — there is no separate activate button.
7. Review the first operational task in the commerce dashboard and verify the
   receipt and projection path.

## Lifecycle controls

Onboarding records distinguish pending setup, readiness, active operation,
disabled access, reconnect, archive, and restore. A rotation or reconnect
changes the relevant credential generation and closes stale grants. An archive
does not erase evidence required for the configured retention policy.

## Safety rules

- Slack workspace ownership, destination routing, membership, and delivery
  state remain organisation-scoped.
- Shopify and Purin Checkout are never dual-written for the same organisation and
  environment.
- Raw credentials stay in Purin Vault. The portal receives lifecycle state and
  reason codes rather than plaintext.
- Activation fails closed when authority, identity, policy, or required
  readiness facts are missing.

For incident handling, see [Onboarding operations](/operate/onboarding).

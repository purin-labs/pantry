# Inbox — area guide

Email and WhatsApp conversations in one Portal page, with an optional agent for each channel.
Read [the root guide](../../AGENTS.md) first; this file adds only what is
particular to this area.

- **Specs:** [INB-01](../../docs/specs/areas/inbox/01-one-inbox.md) (One Inbox). A spec says
  what is built; change it in the same commit as the behavior.
- **Packages:** `@purin-labs/area-inbox` (`server/` for the Worker, `ui/` for the Portal) and
  `@purin-labs/area-inbox-contract` (`contract/`).
- **Agent tool families** (`server/agent-tools/`): `channels` (mail, WhatsApp, the mailbox
  agent and the WhatsApp agent).
- **Portal features** (`ui/features/`): `mail-inbox`, `mail-setup`.
- **Files, tables and public files:** `node scripts/check-layers.mjs --areas inbox`, or
  [the layers page](../../docs/layers.md).

## Rules of the layers

- This area imports the foundation and the contract package of another area. It imports no
  surface and no file of another area. `pnpm lint:layers` refuses a new crossing.
- Another area or a surface reaches this area through `contract/`. A contract file imports no
  implementation file of this area as a value. Do not make an implementation file public to
  remove a crossing: write a port, and let the Worker wire it.
- Only the owner of a table writes it. A write to a table of another owner calls a function of
  that owner.
- `pnpm lint:layer-debts` counts the debts that stay. Its counts only go down.

## Particular to this area

- The mail calls of Gmail come from the mail adapter of the connections module
  (`GMAIL_MAILBOX`), not from the provider catalogue.
- The Inbox registers its connection parts with the integrations area, and its turns are a
  module that the Worker registers with the Session.
- Content from a person outside the Organisation carries the outside-writer label (FND-06). A
  mailbox agent sends a direct reply only to a verified contact.
- The email and WhatsApp channels of the Connector actor (`server/actors/connector/`) are Inbox
  parts. The surfaces `surfaces/email` and `surfaces/whatsapp` keep only the provider webhooks,
  the queue messages and the relocation admin receipt, and they reach the Inbox through
  `contract/` (`channel-ingress.ts`).
- WhatsApp work is deferred: see [the blocked tasks](../../docs/blocked-deferred-tasks.md).

# Slack App Configuration credentials

Status: Active operational runbook

The Slack App Configuration Token page omits Seams from the **Generate Token**
workspace selector while any Seams token row exists, including an expired row.
Delete every existing Seams row before generating a replacement. This behavior
was confirmed against the live Seams account on 2026-07-11.

Slack rejects the Slack CLI `/slackauthticket` flow for Seams with `This
workspace is not eligible for the next generation Slack platform.` A
pre-authenticated CLI login using an existing rotating tooling token bypasses
that ticket flow.

The M6 quick and full acceptance matrices use Slack Web API bot credentials and
the signing secret. They do not require an App Configuration Token.

## Local setup

Initialize the local env file:

```bash
pnpm slack:env:init
```

Import and validate the runtime credentials with hidden prompts:

```bash
pnpm slack:m6:credentials
```

The importer derives the human and bot user ids from verified Slack token
boundaries and writes `.env.local` atomically. Then run the normal M6 check:

```bash
pnpm slack:m6:quick
```

## Authorize Slack CLI for Seams

Expired access tokens are recoverable while their refresh-token **Copy** button
remains available. To generate a clean pair instead, delete every Seams token
row, select Seams from **Generate Token**, and generate one replacement. Copy
its **Refresh Token**, then run:

```bash
pnpm slack:cli:setup
```

Paste the refresh token into the hidden terminal prompt and press Enter. The
command:

1. keeps the copied token out of terminal echo, process arguments, and shell history;
2. exchanges it for a fresh access/refresh pair with `tooling.tokens.rotate`;
3. verifies the fresh access token can export app manifest `A0BFVDZLFLM`;
4. atomically writes both replacements in `.env.local`; and
5. enforces mode `0600` on the env file.

The prompt uses Node's terminal raw mode and has no AppleScript or desktop-UI
dependency. The setup command then rotates the tooling credentials when
possible, calls `slack auth login --token` with the current `xoxe.xoxp` access
token, and verifies the saved Seams authorization via `slack auth list`. Slack
CLI's source accepts this pre-authenticated path before requesting an
authorization ticket.

The access token is transiently present in the Slack CLI process arguments while
the login command runs. It is never printed or passed through a shell.

## Run Slack CLI commands

Slack CLI's generic `api` command does not use the authorization saved by
`slack auth login`; without an explicit token it silently sends the request
unauthenticated. Use the repository wrapper, which rotates the saved pair and
injects the current access token:

```bash
pnpm slack:cli -- api apps.manifest.export app_id=A0BFVDZLFLM --team T0BGQSSG45N
```

The live Seams verification returned `ok: true` and the Pantry Dev manifest on
2026-07-11. The direct `slack api ...` equivalent returned `not_authed`, which
is expected from the CLI's documented token-resolution order.

## Validate or rotate

```bash
pnpm slack:config-token:refresh
```

When `.env.local` contains `SLACK_APP_CONFIG_REFRESH_TOKEN`, the command calls
`tooling.tokens.rotate`, verifies the returned access token, and atomically
stores both replacement credentials. Slack refresh tokens are single-use; the
old refresh token is never retained after a successful response.

Both replacements remain in `.env.local`. The access token expires after 12
hours and the refresh token is single-use; every successful rotation atomically
stores the replacement pair.

## Update Pantry Dev

```bash
pnpm slack:app:update
```

This validates or rotates the saved credential, validates the manifest, and
updates Pantry Dev for the Seams team with the current Worker event and OAuth
redirect URLs.

## Eligibility

Slack documents that some agent features require a paid plan. It also provides
fully featured developer sandboxes to developers without a paid plan when they
provide a payment method for identity verification. The Seams eligibility error
only blocks ticket authorization; the pre-authenticated tooling-token path does
not depend on workspace ticket eligibility.

If Seams moves to Slack Pro or higher, retest native authorization with `slack
login` and `/slackauthticket`. Keep the configuration-token wrapper until that
live retest proves ticket login, credential rotation, Pantry Dev linking, and a
read-only manifest export. A plan upgrade is a retest trigger, not an assumed
fix.

Official references:

- [Developing an agent](https://docs.slack.dev/ai/developing-agents/)
- [Developer sandboxes](https://docs.slack.dev/tools/developer-sandboxes/)
- [Slack CLI authorization](https://docs.slack.dev/tools/slack-cli/guides/authorizing-the-slack-cli/)
- [`tooling.tokens.rotate`](https://docs.slack.dev/reference/methods/tooling.tokens.rotate/)
- [`apps.manifest.export`](https://docs.slack.dev/reference/methods/apps.manifest.export/)

# Slack public distribution

Status: Active deployment procedure

Slack apps begin as workspace-scoped development apps. Public Distribution
allows the app's OAuth installation flow to install it in other workspaces. It
creates an unlisted distribution path; publishing the app in the Slack
Marketplace is a separate review process.

Public Distribution is Slack dashboard state. Updating or deploying an app
manifest does not activate it.

## Prerequisites

Before activation, confirm that the Slack app has:

- every required feature and OAuth scope configured;
- production OAuth redirect URLs for `/slack/install` and
  `/v1/control/providers/slack/callback`;
- HTTPS URLs for every externally reachable feature; and
- no credentials, workspace identifiers, or other deployment-specific values
  hard-coded into the app.

For the current Worker origin, the production redirect URLs are:

```text
https://satyr-edge.n6378056.workers.dev/slack/install
https://satyr-edge.n6378056.workers.dev/v1/control/providers/slack/callback
```

See [Provider callback origins](../runbooks/provider-callback-origins.md) before
changing either URL.

## Reconcile the public app manifest

The public app and the development app are separate Slack applications. Apply
the production manifest to **Satyr Local** (`A0BTDETNVJ5`) with:

```bash
pnpm slack:public-app:update
```

This command targets the public app explicitly. `pnpm slack:app:update` remains
the Satyr Dev (`A0BFVDZLFLM`) workflow.

## Activate Public Distribution

1. Open [Your Slack Apps](https://api.slack.com/apps) and select the app.
2. Open **Manage Distribution**.
3. In **Share Your App with Other Workspaces**, complete Slack's checklist:
   - **Enable Features & Functionality**
   - **Add OAuth Redirect URLs**
   - **Remove Hard Coded Information**
   - **Use HTTPS For Your Features**
4. Expand **Remove Hard Coded Information** and select **I've reviewed and
   removed any hard-coded information**.
5. Select **Activate Public Distribution**.

Slack should replace **Share Your App with Your Workspace** with **Share Your
App with Any Workspace**. The activation control should become **Deactivate
Public Distribution**.

## Verify an external installation

1. Copy the shareable installation URL from **Manage Distribution**.
2. Open it while signed in to a Slack account that belongs to at least two
   workspaces.
3. Confirm that the workspace selector offers workspaces beyond the app's
   development workspace.
4. Install the app in a disposable test workspace and complete Satyr's OAuth
   callback.
5. Confirm that the workspace appears as an active Slack account in the Satyr
   portal and that it can be removed independently.

Public Distribution was verified active for **Satyr Local** on 2026-08-30. At
verification time, Slack displayed **Share Your App with Any Workspace** and
**Deactivate Public Distribution**.

The public manifest was applied and exported successfully on 2026-08-30. The
live app has the exact runtime scope set, both production callbacks, and all
four event subscriptions. Satyr Local was reinstalled successfully in Seams on
2026-08-30, applying the updated scopes to that workspace. The remaining
acceptance step is an installation in a separate test workspace.

## Operational cautions

- Keep the production redirect URLs registered while external installations
  are supported.
- Recheck the distribution page after changing app features, scopes, event
  subscriptions, or OAuth redirects.
- Deactivating Public Distribution removes the app from workspaces other than
  its original development workspace. Treat deactivation as a destructive
  production operation.
- Marketplace submission remains optional and does not gate unlisted public
  distribution.

Official reference: [Distributing Slack apps](https://api.slack.com/docs/slack-apps-mgmt).

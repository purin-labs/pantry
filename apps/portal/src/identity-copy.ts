import { SLACK_BOT_NAME } from "@purin-labs/control-api";

export function identityServiceErrorMessage(
  code = "identity_request_failed",
): string {
  switch (code) {
    case "link_expired":
      return `This link has expired. Return to Slack and mention ${SLACK_BOT_NAME} again to get a new one.`;
    case "link_consumed":
    case "link_race_lost":
      return "This link has already been used. Return to Slack and try your request again.";
    case "control_session_missing":
    case "control_session_expired":
      return "Sign in with Google before you connect Slack.";
    case "organisation_membership_missing":
      return "This Google account does not have access to this Seams Pantry workspace. Sign in with the account you use for Pantry, or ask a workspace owner for access.";
    case "identity_conflict":
      return "This Slack account is connected to another Seams Pantry account. Ask a workspace owner for help.";
    case "identity_provider_unsupported":
      return "Use Google to connect this Slack account.";
    case "link_not_found":
    case "not_found":
      return `This link is no longer available. Return to Slack and mention ${SLACK_BOT_NAME} again to get a new one.`;
    case "origin_invalid":
    case "csrf_invalid":
      return "For your security, the connection could not be confirmed. Refresh this page and try again.";
    default:
      return `Unable to connect Slack. Refresh this page and try again. If the problem continues, return to Slack and mention ${SLACK_BOT_NAME} again.`;
  }
}

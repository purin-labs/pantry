import type { Env } from "@purin-labs/kernel/env";
import { requirePublicOrigin } from "@purin-labs/kernel/public-origin";

/** The handles of the workspace whose Portal a Slack card links to. */
export type PortalWorkspaceAddress = Readonly<{
  organisationHandle: string;
  workspaceHandle: string;
}>;

/**
 * A Portal page of the workspace, for a link on a Slack card. `page` is the
 * page's path segment with its query or fragment, already encoded.
 */
export function workspacePortalUrl(
  env: Env,
  address: PortalWorkspaceAddress,
  page: string,
): string {
  const organisation = encodeURIComponent(address.organisationHandle);
  const workspace = encodeURIComponent(address.workspaceHandle);
  return `${requirePublicOrigin(env.PANTRY_PUBLIC_ORIGIN)}/portal/${organisation}/${workspace}/${page}`;
}

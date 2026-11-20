/** The Portal link that opens an account invitation. The token stays in the hash. */
export function accountInvitationHref(
  organisationId: string,
  invitationId: string,
  token: string,
): string {
  const url = new URL("/portal", window.location.origin);
  url.searchParams.set("accountInvitationOrganisation", organisationId);
  url.searchParams.set("accountInvitationId", invitationId);
  url.hash = new URLSearchParams({ accountInvitationToken: token }).toString();
  return url.href;
}

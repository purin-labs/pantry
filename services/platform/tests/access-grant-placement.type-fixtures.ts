import {
  createVersionedAccessGrant,
  revokeVersionedAccessGrant,
} from "../src/access-control/grant-mutations";

declare const creation: Parameters<typeof createVersionedAccessGrant>[0];
declare const revocation: Parameters<typeof revokeVersionedAccessGrant>[0];

const { scope, ...withoutScope } = creation;
// @ts-expect-error Operator mutations require a resolved placement scope.
createVersionedAccessGrant(withoutScope);
// @ts-expect-error A spread cannot reproduce the private scope identity.
createVersionedAccessGrant({ ...creation, scope: { ...scope } });
const { identity, ...withoutIdentity } = revocation;
// @ts-expect-error Grant revocation includes receipt settlement in its transaction.
revokeVersionedAccessGrant(withoutIdentity);

import type {
  AdmittedOrganisationArchiveCleanup,
  HarnessHistoryErasureRequest,
  OrganisationArchiveCleanupRequest,
} from "@purin-labs/actor-runtime/actors/organisation-archive-cleanup";
import type { OrganisationDO } from "../src/actors/organisation";
import type { SessionDO } from "../src/actors/agent-session";

declare const organisation: OrganisationDO;
declare const session: SessionDO;
declare const request: OrganisationArchiveCleanupRequest;
declare const admitted: AdmittedOrganisationArchiveCleanup;
declare const erasure: HarnessHistoryErasureRequest;

// @ts-expect-error A plain request cannot establish durable admission.
const raw: AdmittedOrganisationArchiveCleanup = request;
// @ts-expect-error Copying an admitted request loses its private admission state.
const copied: AdmittedOrganisationArchiveCleanup = { ...admitted };
// @ts-expect-error Structural construction cannot establish admission.
const constructed: AdmittedOrganisationArchiveCleanup = {
  request,
  organisationId: request.organisationId,
  placement: request.placement,
  now: request.now,
};

const { placement, ...unscoped } = request;
// @ts-expect-error Cleanup must retain the captured placement and fence.
organisation.reconcileArchiveCleanup(unscoped);
const { expectedActorFenceToken, ...unfenced } = erasure;
// @ts-expect-error Erasure requires the activated physical Actor's fence.
session.eraseHarnessHistory(unfenced);
const { sessionId, ...unidentified } = erasure;
// @ts-expect-error Erasure requires the logical session identity.
session.eraseHarnessHistory(unidentified);
const { archiveReceiptId, ...unauthorized } = erasure;
// @ts-expect-error Erasure requires the durable organisation archive authority.
session.eraseHarnessHistory(unauthorized);

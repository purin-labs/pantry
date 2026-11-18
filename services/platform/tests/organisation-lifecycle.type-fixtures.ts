import type { OrganisationExecutionScope } from "../src/organisation-execution-scope";
import {
  archiveOrganisation,
  deleteArchivedOrganisation,
  renameOrganisation,
  restoreOrganisation,
  type ArchiveAuthority,
} from "../src/data/organisation-lifecycle";

declare const archive: Parameters<typeof archiveOrganisation>[0];
declare const rename: Parameters<typeof renameOrganisation>[0];
declare const restore: Parameters<typeof restoreOrganisation>[0];
declare const deletion: Parameters<typeof deleteArchivedOrganisation>[0];
declare const execution: OrganisationExecutionScope;
declare const supportAuthority: Extract<
  ArchiveAuthority,
  { kind: "support_admin" }
>;

const { execution: archiveExecution, ...unscopedArchive } = archive;
const { execution: renameExecution, ...unscopedRename } = rename;
const { execution: restoreExecution, ...unscopedRestore } = restore;
const { execution: deleteExecution, ...unscopedDeletion } = deletion;

// @ts-expect-error Lifecycle admission requires a captured placement scope.
archiveOrganisation(unscopedArchive);
// @ts-expect-error Rename must retain the captured placement scope.
renameOrganisation(unscopedRename);
// @ts-expect-error Restore must retain the captured placement scope.
restoreOrganisation(unscopedRestore);
// @ts-expect-error Delete must retain the captured placement scope.
deleteArchivedOrganisation(unscopedDeletion);

// @ts-expect-error A structural database/organisation pair cannot establish admission.
const constructed: OrganisationExecutionScope = {
  database: execution.database,
  organisationId: execution.organisationId,
  placement: execution.placement,
  fenceToken: execution.fenceToken,
  isActive: execution.isActive,
};
// @ts-expect-error Spreading a scope loses its private database authority.
restoreOrganisation({ ...restore, execution: { ...execution } });
deleteArchivedOrganisation({
  ...deletion,
  // @ts-expect-error A lifecycle request cannot select a separate organisation identity.
  organisationId: execution.organisationId,
});
// @ts-expect-error A lifecycle request cannot select a separate database.
renameOrganisation({ ...rename, db: execution.database });
// @ts-expect-error Support archive authority requires its support reason.
archiveOrganisation({
  ...archive,
  authority: supportAuthority,
  reasonCode: "merchant_archived",
});

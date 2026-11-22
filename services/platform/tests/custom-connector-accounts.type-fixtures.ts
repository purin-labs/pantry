import type {
  AuthorizedCustomConnectorSetupCommit,
  CustomConnectorDefinitionV1,
  CustomConnectorSetupAttempt,
} from "../src/custom-connectors";
import type { VaultHandle } from "@purin-labs/authority/credential-vault/index";
import type { VariantBy } from "@purin-labs/type-utils";

declare const attempt: VariantBy<
  CustomConnectorSetupAttempt,
  "lifecycle",
  "verified"
>;
declare const definition: CustomConnectorDefinitionV1;
declare const candidateCredentialRef: VaultHandle;

const forgedAuthorization = {
  attempt,
  definition,
  candidateCredentialRef,
};

// @ts-expect-error Setup commit authority is issued only after current-state checks.
const invalidAuthorization: AuthorizedCustomConnectorSetupCommit =
  forgedAuthorization;

void invalidAuthorization;

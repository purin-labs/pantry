// Builds Commerce's fixture Worker once before any test file runs. A build
// inside a test takes longer than the default timeout, and parallel test
// files would each build the same artifact.
import { commerceFixtureWorkerArtifact } from "./commerce-fixture-worker";

export default function setup(): void {
  process.env.COMMERCE_FIXTURE_WORKER_ARTIFACT =
    commerceFixtureWorkerArtifact();
}

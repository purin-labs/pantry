// The Worker gives the lifecycle parts when it loads. A test that calls a
// lifecycle function of tenancy directly gets the same parts here.
import { provideOrganisationLifecycleParts } from "../src/data/organisation-lifecycle-port";
import { ORGANISATION_LIFECYCLE_PARTS } from "../src/organisation-lifecycle-parts";

provideOrganisationLifecycleParts(ORGANISATION_LIFECYCLE_PARTS);

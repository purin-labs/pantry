/**
 * Physics and solver diagnostics (the Plan 70 evidence views: interval
 * histories, recorded contacts, exact solver values, equipment and mass
 * balance details) stay out of the operator Portal. Only the workflow
 * preview turns them on, when its URL carries `?evidence`, so the evidence
 * journeys in scripts/production-simulation can still read them.
 */
let visible = false;

export function showPhysicsEvidence(): void {
  visible = true;
}

export function physicsEvidenceVisible(): boolean {
  return visible;
}

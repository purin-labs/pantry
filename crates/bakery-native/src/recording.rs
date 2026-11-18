use crate::{
    artifact::*,
    assets::{Assets, Fixture, Geometry, Setup},
};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Provenance {
    engine: String,
    version: String,
    model_hash: String,
    robot_glb_sha256: String,
    assumptions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RecordedEvent {
    step: usize,
    kind: String,
    label: String,
}

impl From<&Event> for RecordedEvent {
    fn from(event: &Event) -> Self {
        let (step, kind, label) = match event {
            Event::Phase { step, label } => (*step, "phase", label.as_str()),
            Event::Pickup { step } => (*step, "pickup", "Source cleared"),
            Event::Placement { step } => (*step, "placement", "Tray supported; tool retracted"),
            Event::Failure { step } => (*step, "failure", "Transfer failed; inspect outcome"),
            Event::CarrierRemoved { step } => (
                *step,
                "carrier-removed",
                "Human handling removed the carrier",
            ),
            Event::RecoveryCompleted { step } => {
                (*step, "recovery-completed", "Empty arm returned to ready")
            }
        };
        Self {
            step,
            kind: kind.into(),
            label: label.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Recording {
    pub schema_version: u32,
    pub kind: String,
    pub request: Request,
    pub provenance: Provenance,
    pub robot_base: [f64; 7],
    pub fixture: Fixture,
    pub geometry: Vec<Geometry>,
    pub samples: Vec<Sample>,
    pub events: Vec<RecordedEvent>,
    pub outcome: Outcome,
}

impl Recording {
    pub fn from_result(artifact: &Artifact, setup: &Setup, assets: &Assets) -> Result<Self> {
        let Artifact::BakeryNativeResult {
            binding,
            samples,
            events,
            outcome,
            ..
        } = artifact
        else {
            bail!("Pending state is not terminal evidence");
        };
        Ok(Self::new(
            binding.request.clone(),
            samples.clone(),
            events,
            outcome.clone(),
            setup,
            assets,
        ))
    }

    /// The recording of one finished transfer, from its parts.
    pub fn new(
        request: Request,
        samples: Vec<Sample>,
        events: &[Event],
        outcome: Outcome,
        setup: &Setup,
        assets: &Assets,
    ) -> Self {
        Self {
            schema_version: 4,
            kind: "bakery-physics-recording".into(),
            provenance: Provenance {
                engine: "mujoco".into(), version: "4.0.0".into(),
                model_hash: request.model_hash.clone(),
                robot_glb_sha256: assets.robot_glb_sha256(request.robot).to_string(),
                assumptions: vec![
                    "Simulation evidence only; no physical robot commands or production receipts.".into(),
                    "Prototype clamp, tray mass, friction and controller parameters are uncalibrated.".into(),
                    "Ideal known-payload gravity compensation through bounded arm motors.".into(),
                    "Manufacturer inertias and model-specific frame/food-version assumptions require hardware calibration.".into(),
                    "Cold fixtures only; no latch, heat, door actuation or thermal dwell.".into(),
                ],
            },
            request,
            robot_base: setup.robot_base,
            fixture: setup.fixture.clone(), geometry: setup.geometry.clone(),
            samples, events: events.iter().map(RecordedEvent::from).collect(),
            outcome,
        }
    }
}

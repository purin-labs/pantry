use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

use crate::limits::{Margins, Measured};

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    crate::assets::require(path)?;
    ensure!(
        fs::metadata(path)?.len() <= 16 * 1024 * 1024,
        "JSON artifact exceeds 16 MiB"
    );
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Case {
    #[default]
    Nominal,
    Blocked,
    Unreachable,
    Slip,
    ClosedDoor,
}

impl Case {
    pub fn is_nominal(&self) -> bool {
        *self == Self::Nominal
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, clap::ValueEnum)]
pub enum BakeryTask {
    #[serde(rename = "table-to-rack")]
    #[value(name = "table-to-rack")]
    Rack,
    #[serde(rename = "table-to-oven")]
    #[value(name = "table-to-oven")]
    Oven,
    #[serde(rename = "oven-to-table")]
    #[value(name = "oven-to-table")]
    Unload,
}

impl BakeryTask {
    pub fn destination(self) -> &'static str {
        match self {
            Self::Rack => "rack_tray_center",
            Self::Oven => "mbco_slot_3",
            Self::Unload => "source_tray_center",
        }
    }

    pub fn supports(self) -> &'static [&'static str] {
        match self {
            Self::Rack => &["rack_rail_left", "rack_rail_right"],
            Self::Oven => &["mbco_rail_3_left", "mbco_rail_3_right"],
            Self::Unload => &["table_top"],
        }
    }

    pub fn source_supports(self) -> &'static [&'static str] {
        match self {
            Self::Rack | Self::Oven => &["table_top"],
            Self::Unload => Self::Oven.supports(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub schema_version: u32,
    pub source: String,
    pub run_id: String,
    pub bakery_task_id: BakeryTask,
    pub attempt_id: String,
    pub model_hash: String,
    pub robot: crate::robot::Robot,
    pub ingredients: IngredientLoad,
    pub clamp_force_n: f64,
    pub layout: Layout,
    pub case: Case,
    pub timestep: f64,
    pub execution: ExecutionIdentity,
    /// Test only: scales every rated joint speed down, so that a journey
    /// can prove the speed failure with the engine's own motion. Below one;
    /// it can never raise a rating. A production request has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_rating_scale: Option<f64>,
}

/// Ingredient center relative to the tray center in the fixed transfer orientation.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IngredientLoad {
    pub mass_kg: f64,
    pub forward_mm: i32,
    pub lateral_mm: i32,
}

impl IngredientLoad {
    pub fn validate(self) -> Result<()> {
        ensure!(
            self.mass_kg.is_finite() && (0.0..=4.0).contains(&self.mass_kg),
            "Ingredient mass must be between 0 and 4 kg"
        );
        ensure!(
            (-100..=100).contains(&self.forward_mm) && (-60..=60).contains(&self.lateral_mm),
            "Ingredient offsets must be within 100 mm forward and 60 mm lateral"
        );
        Ok(())
    }
}

/// Integer millimetres give UI, CLI and chat the same canonical placement.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Layout {
    Fixed,
    RackTranslation {
        #[serde(rename = "xMm")]
        x_mm: i32,
        #[serde(rename = "yMm")]
        y_mm: i32,
    },
}

impl Layout {
    pub fn rack(x_mm: i32, y_mm: i32) -> Result<Self> {
        ensure!(
            (-600..=600).contains(&x_mm) && (-600..=600).contains(&y_mm),
            "Rack translation must be within ±600 mm on each horizontal axis"
        );
        Ok(if x_mm == 0 && y_mm == 0 {
            Self::Fixed
        } else {
            Self::RackTranslation { x_mm, y_mm }
        })
    }

    pub fn offset(self) -> [f64; 2] {
        match self {
            Self::Fixed => [0., 0.],
            Self::RackTranslation { x_mm, y_mm } => {
                [f64::from(x_mm) / 1000., f64::from(y_mm) / 1000.]
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "backend", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ExecutionIdentity {
    Native {
        #[serde(rename = "controllerSourceHash")]
        controller_source_hash: String,
        #[serde(rename = "controllerHash")]
        controller_hash: String,
        #[serde(rename = "runtimeHash")]
        runtime_hash: String,
    },
    Browser {
        #[serde(rename = "controllerSourceHash")]
        controller_source_hash: String,
        #[serde(rename = "controllerHash")]
        controller_hash: String,
        #[serde(rename = "runtimeHash")]
        runtime_hash: String,
    },
}

impl ExecutionIdentity {
    pub fn current() -> Self {
        let controller_source_hash = env!("BAKERY_CONTROLLER_SOURCE_HASH").into();
        let controller_hash = env!("BAKERY_RUNNER_HASH").into();
        let runtime_hash = env!("BAKERY_RUNTIME_HASH").into();
        if cfg!(target_os = "emscripten") {
            Self::Browser {
                controller_source_hash,
                controller_hash,
                runtime_hash,
            }
        } else {
            Self::Native {
                controller_source_hash,
                controller_hash,
                runtime_hash,
            }
        }
    }
}

impl Request {
    pub fn validate(&self, model_hash: &str) -> Result<()> {
        ensure!(
            self.schema_version == 7 && self.source == "local-simulation",
            "Unsupported request authority/version"
        );
        self.ingredients.validate()?;
        ensure!(
            self.speed_rating_scale
                .is_none_or(|scale| scale.is_finite() && scale > 0. && scale < 1.),
            "A speed rating scale is below one and above zero"
        );
        ensure!(
            self.clamp_force_n.is_finite() && (20.0..=100.0).contains(&self.clamp_force_n),
            "Clamp force must be between 20 and 100 N"
        );
        if let Layout::RackTranslation { x_mm, y_mm } = self.layout {
            ensure!(
                Layout::rack(x_mm, y_mm)? == self.layout,
                "Noncanonical rack placement"
            );
            ensure!(
                self.bakery_task_id == BakeryTask::Rack && self.case == Case::Nominal,
                "Layout experiments require a standalone nominal rack transfer"
            );
        }
        ensure!(
            self.execution == ExecutionIdentity::current(),
            "Request controller/runtime differs from this runner"
        );
        ensure!(
            self.model_hash == model_hash,
            "Request model hash differs from verified assets"
        );
        ensure!(
            matches!(self.timestep, 0.001 | 0.002),
            "Unsupported timestep"
        );
        ensure!(
            self.case != Case::ClosedDoor || self.bakery_task_id == BakeryTask::Oven,
            "Closed door requires oven loading"
        );
        ensure!(
            self.bakery_task_id != BakeryTask::Unload || self.case == Case::Nominal,
            "Retrieval requires nominal loading"
        );
        for id in [&self.run_id, &self.attempt_id] {
            ensure!(
                !id.is_empty()
                    && id.len() <= 80
                    && id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'),
                "Invalid run/attempt identity"
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Binding {
    pub runtime_sha256: String,
    pub runner_sha256: String,
    pub request: Request,
    pub completion: Completion,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Completion {
    Recording,
    LoadingHandoff,
    RetrievalHandoff,
}

impl Binding {
    pub fn new(request: Request, completion: Completion) -> Result<Self> {
        ensure!(
            completion == Completion::Recording
                || (completion == Completion::LoadingHandoff
                    && request.bakery_task_id == BakeryTask::Oven
                    && request.case == Case::Nominal)
                || (completion == Completion::RetrievalHandoff
                    && request.bakery_task_id == BakeryTask::Unload
                    && request.case == Case::Nominal),
            "Handoff completion requires nominal oven loading"
        );
        Ok(Self {
            runtime_sha256: env!("BAKERY_RUNTIME_HASH").into(),
            runner_sha256: env!("BAKERY_RUNNER_HASH").into(),
            request,
            completion,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Sample {
    pub step: usize,
    pub joints: [f64; 6],
    pub tray: [f64; 7],
    pub tool: [f64; 7],
    pub jaw: [f64; 7],
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Event {
    Phase { step: usize, label: String },
    Pickup { step: usize },
    Placement { step: usize },
    Failure { step: usize },
    CarrierRemoved { step: usize },
    RecoveryCompleted { step: usize },
}

impl Event {
    pub fn step(&self) -> usize {
        match self {
            Self::Phase { step, .. }
            | Self::Pickup { step }
            | Self::Placement { step }
            | Self::Failure { step }
            | Self::CarrierRemoved { step }
            | Self::RecoveryCompleted { step } => *step,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Evidence {
    pub position_error_m: f64,
    pub orientation_error_rad: f64,
    pub linear_speed_mps: f64,
    pub angular_speed_radps: f64,
    pub settled_seconds: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Failure {
    Unreachable,
    DestinationBlocked,
    DoorObstructed,
    Collision,
    JointLimit,
    /// A joint passed its rated speed (Refactor 16, step 7). The margins of
    /// the outcome name the joint, its peak and its rating.
    JointSpeed,
    ActuatorLimit,
    LostGrasp,
    PlacementFailed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Disposition {
    Source,
    Gripped,
    Destination,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Outcome {
    Recovered {
        step: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        margins: Option<Box<Margins>>,
    },
    Completed {
        step: usize,
        evidence: Evidence,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        margins: Option<Box<Margins>>,
    },
    Failed {
        step: usize,
        reason: Failure,
        #[serde(rename = "trayDisposition")]
        tray_disposition: Disposition,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        margins: Option<Box<Margins>>,
    },
    ExecutionError {
        step: usize,
        message: String,
    },
}

impl Outcome {
    /// The outcome with the margins of the motion that led to it. A plan
    /// that fails before any step and an execution error have none.
    pub fn with_margins(mut self, measured: Margins) -> Self {
        match &mut self {
            Self::Recovered { margins, .. }
            | Self::Completed { margins, .. }
            | Self::Failed { margins, .. } => {
                if margins.is_none() {
                    *margins = Some(Box::new(measured));
                }
            }
            Self::ExecutionError { .. } => {}
        }
        self
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Progress {
    pub next_phase: usize,
    pub step: usize,
    pub angles: [f64; 6],
    pub previous_target: [f64; 3],
    pub lost_steps: usize,
    pub pickup: bool,
    pub grip_disabled: bool,
    /// The operation's measurements against the robot's limits.
    pub measured: Measured,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Prefix {
    pub progress: Progress,
    pub integration_state: Vec<f64>,
    pub samples: Vec<Sample>,
    pub events: Vec<Event>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Artifact {
    BakeryNativeCheckpoint {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        binding: Binding,
        prefix: Prefix,
        digest: String,
    },
    BakeryNativeResult {
        binding: Binding,
        samples: Vec<Sample>,
        events: Vec<Event>,
        outcome: Outcome,
        progress: Progress,
        integration_state: Vec<f64>,
    },
}

impl Artifact {
    pub fn checkpoint(binding: Binding, prefix: Prefix) -> Result<Self> {
        let digest = digest(&serde_json::to_vec(&(&binding, &prefix))?);
        Ok(Self::BakeryNativeCheckpoint {
            schema_version: 2,
            binding,
            prefix,
            digest,
        })
    }

    pub fn read_checkpoint(path: &Path, expected: &Binding) -> Result<Prefix> {
        Self::validate_checkpoint(read_json(path)?, expected)
    }

    pub fn validate_checkpoint(artifact: Self, expected: &Binding) -> Result<Prefix> {
        match artifact {
            Self::BakeryNativeCheckpoint {
                schema_version,
                binding,
                prefix,
                digest: expected_digest,
            } => {
                ensure!(schema_version == 2, "Unsupported checkpoint version");
                ensure!(
                    &binding == expected,
                    "Checkpoint fixture/request/runner mismatch"
                );
                ensure!(
                    digest(&serde_json::to_vec(&(&binding, &prefix))?) == expected_digest,
                    "Checkpoint digest mismatch"
                );
                Ok(prefix)
            }
            Self::BakeryNativeResult { .. } => anyhow::bail!("Terminal evidence cannot resume"),
        }
    }
}

/// Controller state inside the phase named by `Progress::next_phase`, at a
/// completed integration step. All fields are zero at a phase boundary.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Within {
    pub step: usize,
    pub release_offset: f64,
    pub settled_steps: usize,
}

impl Within {
    pub fn boundary() -> Self {
        Self {
            step: 0,
            release_offset: 0.,
            settled_steps: 0,
        }
    }
}

/// One planned phase, saved so a restore can prove it resumes the same plan.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PhasePlan {
    pub name: String,
    pub position: [f64; 3],
    pub seconds: f64,
    pub closed: bool,
    pub carrying: bool,
}

/// Observations and events over one contiguous step interval, bound to the
/// checkpoint it started from and the checkpoint it ends at.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Segment {
    pub schema_version: u32,
    pub run_id: String,
    pub attempt_id: String,
    pub sequence: usize,
    pub predecessor: String,
    pub start_step: usize,
    pub end_step: usize,
    pub model_hash: String,
    pub runner_sha256: String,
    pub runtime_sha256: String,
    pub samples: Vec<Sample>,
    pub contacts: ContactCapture,
    pub events: Vec<Event>,
    pub checkpoint: String,
    pub digest: String,
}

impl Segment {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        binding: &Binding,
        sequence: usize,
        predecessor: String,
        start_step: usize,
        end_step: usize,
        samples: Vec<Sample>,
        contacts: ContactCapture,
        events: Vec<Event>,
        checkpoint: String,
    ) -> Result<Self> {
        let mut segment = Self {
            schema_version: 1,
            run_id: binding.request.run_id.clone(),
            attempt_id: binding.request.attempt_id.clone(),
            sequence,
            predecessor,
            start_step,
            end_step,
            model_hash: binding.request.model_hash.clone(),
            runner_sha256: binding.runner_sha256.clone(),
            runtime_sha256: binding.runtime_sha256.clone(),
            samples,
            contacts,
            events,
            checkpoint,
            digest: String::new(),
        };
        let mut content = serde_json::to_value(&segment)?;
        content
            .as_object_mut()
            .expect("A segment serializes as an object")
            .remove("digest");
        segment.digest = digest(&serde_json::to_vec(&content)?);
        Ok(segment)
    }
}

/// Forces are recomputed by mj_forward at the recorded pose. Each observation
/// covers one newly executed step, excluding the segment's shared start step.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ContactCapture {
    NotRecorded,
    Dense {
        observations: Vec<ContactObservation>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ContactObservation {
    pub step: usize,
    pub pairs: Vec<ContactPair>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ContactShape {
    pub geometry: String,
    pub body: String,
}

/// Aggregate all penetrating contact points between two named shapes.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ContactPair {
    pub first: ContactShape,
    pub second: ContactShape,
    pub normal_force_n: f64,
    pub penetration_m: f64,
}

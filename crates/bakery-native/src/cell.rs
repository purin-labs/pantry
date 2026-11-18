//! A persistent cold cell: one world that outlives its operations. A carrier
//! enters and leaves through explicit boundary changes, and each operation
//! starts from the state the previous one left. Nothing resets the arm.
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::f64::consts::FRAC_1_SQRT_2;

use crate::{
    artifact::*,
    assets::{Assets, Cell as Fixture},
    checkpoint::{self, Kind},
    native::{Engine, OPEN_JAW_M, PARKED_TRAY},
    robot::Robot,
    transfer::{self, Operation, Start, Stop},
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, clap::ValueEnum)]
pub enum CellFixture {
    #[serde(rename = "persistent-rack/1")]
    Rack,
    #[serde(rename = "persistent-oven-rack/1")]
    OvenRack,
    #[serde(rename = "persistent-pan-staging/1")]
    PanStaging,
}

impl CellFixture {
    fn model(self) -> Fixture {
        match self {
            Self::Rack => Fixture::Separate,
            Self::OvenRack => Fixture::Combined,
            Self::PanStaging => Fixture::PanStaging,
        }
    }
    fn initial_task(self) -> BakeryTask {
        match self {
            Self::Rack | Self::PanStaging => BakeryTask::Rack,
            Self::OvenRack => BakeryTask::Oven,
        }
    }
}
/// The settled hold this controller offers. It is qualified against ordinary
/// advancement for a carrier on the table or the rack, and for an empty cell.
pub const HOLD_MODEL: &str = "cold-cell-rest.1";
/// One second of undisturbed rest admits the hold.
const HOLD_ENTRY_STEPS: usize = 500;
/// The hold is qualified against four hours of ordinary advancement.
const HOLD_QUALIFIED_STEPS: usize = 7_200_000;
/// Linear (m/s) and angular (rad/s) speeds a resting body stays below.
const HOLD_SPEED: f64 = 1e-4;
const HOLD_DRIFT_M: f64 = 1e-4;
/// 0.01 degrees.
const HOLD_DRIFT_RAD: f64 = 1.745_329_251_994_329_5e-4;
const OPEN_TOOL_M: f64 = 0.02;
/// The factory tick. A cell with another timestep cannot join the factory.
const TICK_SECONDS: f64 = 0.002;

/// What a cell's world is built from. It pins the same inputs a transfer
/// request pins; each operation adds only its attempt identity.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CellDefinition {
    pub schema_version: u32,
    pub fixture: CellFixture,
    pub run_id: String,
    pub cell_id: String,
    pub robot: Robot,
    pub ingredients: IngredientLoad,
    pub clamp_force_n: f64,
    pub timestep: f64,
    pub model_hash: String,
    pub execution: ExecutionIdentity,
    /// The fixture's case. A production cell is nominal and leaves it out,
    /// so its definition and checkpoints keep their bytes.
    #[serde(default, skip_serializing_if = "Case::is_nominal")]
    pub case: Case,
}

impl CellDefinition {
    pub fn new(
        assets: &Assets,
        run_id: String,
        cell_id: String,
        robot: Robot,
        timestep: f64,
        fixture: CellFixture,
    ) -> Result<Self> {
        let ingredients = IngredientLoad {
            mass_kg: if fixture == CellFixture::PanStaging {
                0.
            } else {
                1.
            },
            forward_mm: 0,
            lateral_mm: 0,
        };
        Self::with_load(
            assets,
            run_id,
            cell_id,
            robot,
            timestep,
            fixture,
            ingredients,
            Case::Nominal,
        )
    }

    /// A cell with another payload or fixture case, as the robot comparison
    /// runs one transfer on it.
    #[allow(clippy::too_many_arguments)]
    pub fn with_load(
        assets: &Assets,
        run_id: String,
        cell_id: String,
        robot: Robot,
        timestep: f64,
        fixture: CellFixture,
        ingredients: IngredientLoad,
        case: Case,
    ) -> Result<Self> {
        let definition = Self {
            schema_version: 1,
            fixture,
            run_id,
            cell_id,
            robot,
            ingredients,
            clamp_force_n: 100.,
            timestep,
            model_hash: assets.layout_hash(robot, fixture.model(), Layout::Fixed)?,
            execution: ExecutionIdentity::current(),
            case,
        };
        definition.validate(assets)?;
        Ok(definition)
    }

    pub fn request(&self, attempt_id: &str, task: BakeryTask) -> Request {
        Request {
            schema_version: 7,
            source: "local-simulation".into(),
            run_id: self.run_id.clone(),
            bakery_task_id: task,
            attempt_id: attempt_id.into(),
            model_hash: self.model_hash.clone(),
            robot: self.robot,
            ingredients: self.ingredients,
            clamp_force_n: self.clamp_force_n,
            layout: Layout::Fixed,
            case: self.case,
            timestep: self.timestep,
            execution: self.execution.clone(),
            speed_rating_scale: None,
        }
    }

    fn validate(&self, assets: &Assets) -> Result<()> {
        ensure!(self.schema_version == 1, "Unsupported cell definition");
        ensure!(
            self.timestep == TICK_SECONDS,
            "A cell steps at the factory's {TICK_SECONDS} s tick; this one declares {} s",
            self.timestep
        );
        validate_identity(&self.cell_id)?;
        // The request checks the runner, model, payload and clamp bounds.
        ensure!(
            self.model_hash
                == assets.layout_hash(self.robot, self.fixture.model(), Layout::Fixed)?,
            "Cell fixture and model differ"
        );
        assets.validate_request(&self.request("cell", self.fixture.initial_task()))?;
        Ok(())
    }
}

fn validate_identity(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 80
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'),
        "Invalid cell, carrier or attempt identity"
    );
    Ok(())
}

/// The cell's one carrier body. Each admission starts a new generation, which
/// separates a carrier's results from those of the carrier before it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Slot {
    Inactive {
        generation: u32,
    },
    Active {
        generation: u32,
        carrier: String,
        location: CarrierLocation,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CarrierLocation {
    Source,
    Oven,
    Returned,
    Rack,
}

impl CarrierLocation {
    fn allows(self, fixture: CellFixture, task: BakeryTask) -> bool {
        matches!(
            (fixture, self, task),
            (CellFixture::Rack, Self::Source, BakeryTask::Rack)
                | (CellFixture::PanStaging, Self::Source, BakeryTask::Rack)
                | (CellFixture::OvenRack, Self::Source, BakeryTask::Oven)
                | (CellFixture::OvenRack, Self::Oven, BakeryTask::Unload)
                | (CellFixture::OvenRack, Self::Returned, BakeryTask::Rack)
        )
    }
    fn site(self) -> &'static str {
        match self {
            Self::Source | Self::Returned => "source_tray_center",
            Self::Oven => "mbco_slot_3",
            Self::Rack => "rack_tray_center",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Posture {
    Ready,
    Retreated,
}

/// The targets the arm holds between operations.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Servo {
    pub angles: [f64; 6],
    pub target: [f64; 3],
    pub posture: Posture,
    pub jaw: f64,
}

impl Servo {
    fn start(&self, engine: &Engine, location: CarrierLocation) -> Start {
        match location {
            CarrierLocation::Oven => Start::Loaded {
                angles: self.angles,
                previous_target: self.target,
                tray: engine.sample(0).tray,
            },
            CarrierLocation::Returned => Start::Returned {
                angles: self.angles,
                previous_target: self.target,
                tray: engine.sample(0).tray,
            },
            CarrierLocation::Source | CarrierLocation::Rack => match self.posture {
                Posture::Ready => Start::Ready {
                    angles: self.angles,
                    previous_target: self.target,
                },
                Posture::Retreated => Start::Retreated {
                    angles: self.angles,
                    previous_target: self.target,
                },
            },
        }
    }
}

/// An idle cell's undisturbed rest so far. It is controller state: a cell
/// restored inside its observation second continues the same second.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Resting {
    /// Consecutive idle steps that met the hold's entry criteria.
    pub steps: usize,
    /// The resting body's pose when the observation began: the carrier's,
    /// or the reference body's in an empty cell.
    pub anchor: [f64; 7],
    /// The fixtures that carry the carrier; none in an empty cell.
    pub support: Vec<String>,
}

/// The settled hold a rested cell may enter instead of stepping.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HoldOffer {
    pub model: &'static str,
    pub support: &'static str,
    /// Steps of ordinary advancement the hold is qualified to stand for.
    pub qualified_steps: usize,
}

/// An operation in progress, saved with what its plan was derived from.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SavedOperation {
    pub attempt_id: String,
    pub task: BakeryTask,
    pub generation: u32,
    pub dispatched_step: usize,
    pub start: Start,
    pub plan: Vec<PhasePlan>,
    pub progress: Progress,
    pub within: Within,
}

/// Complete cell state at a completed integration step: the world, the
/// carrier slot, the arm's held targets and any operation in progress.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CellCheckpoint {
    pub schema_version: u32,
    pub definition: CellDefinition,
    pub slot: Slot,
    pub servo: Servo,
    /// Integration steps since the cell was created.
    pub steps: usize,
    /// A failed operation holds the cell until an explicit recovery.
    pub held: bool,
    pub grip_disabled: bool,
    pub resting: Option<Resting>,
    pub integration_state: Vec<f64>,
    pub operation: Option<SavedOperation>,
    pub digest: String,
}

impl CellCheckpoint {
    /// The exact bytes the digest names: the checkpoint without its digest,
    /// in a checkpoint envelope. A host stores these, so an artifact's own
    /// hash is the checkpoint's.
    pub fn content(&self) -> Result<Vec<u8>> {
        let mut content = serde_json::to_value(self)?;
        content
            .as_object_mut()
            .context("A checkpoint serializes as an object")?
            .remove("digest");
        Ok(checkpoint::write(Kind::RackCellCheckpoint, &content)?.into_bytes())
    }

    fn content_digest(&self) -> Result<String> {
        Ok(digest(&self.content()?))
    }

    /// Reads stored content back. Restoring it checks the digest again.
    pub fn from_content(content: &[u8], digest: &str) -> Result<Self> {
        let mut raw: serde_json::Value = checkpoint::read(Kind::RackCellCheckpoint, content)?;
        raw.as_object_mut()
            .context("A checkpoint is an object")?
            .insert("digest".into(), digest.into());
        Ok(serde_json::from_value(raw)?)
    }
}

/// Why a bounded cell advance returned.
pub enum Bounded {
    /// No operation is bound; the idle world advanced.
    Idle { recording: CellRecording },
    /// The step allowance ran out at a completed integration step.
    Allowance,
    /// A pickup occurred at the last completed step.
    Event,
    Terminal {
        attempt_id: String,
        outcome: Outcome,
    },
}

/// Idle evolution and zero-time carrier changes have no operation attempt.
/// Handoff endpoints stay separate because no solver step connects them.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CellMotion {
    Idle {
        start_step: usize,
        end_step: usize,
        sample_stride: usize,
        samples: Vec<Sample>,
        contacts: ContactCapture,
    },
    Admission {
        step: usize,
        before: Sample,
        after: Sample,
        before_slot: Slot,
        after_slot: Slot,
    },
    Removal {
        step: usize,
        before: Sample,
        after: Sample,
        before_slot: Slot,
        after_slot: Slot,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CellRecording {
    pub schema_version: u32,
    pub kind: String,
    pub cell_id: String,
    pub run_id: String,
    pub model_hash: String,
    pub runner_sha256: String,
    pub runtime_sha256: String,
    pub predecessor: String,
    pub checkpoint: String,
    pub motion: CellMotion,
}

/// The operation a cell is executing, as its host addresses it.
pub struct InProgress<'a> {
    pub attempt_id: &'a str,
    /// Completed integration steps since the operation's dispatch.
    pub step: usize,
    /// Numbers the next recording segment.
    pub sequence: usize,
}

/// What a boundary change or a step observed, for comparison across them.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub steps: usize,
    pub slot: Slot,
    pub arm: [f64; 6],
    pub tray: [f64; 7],
    pub tray_speed: [f64; 6],
    pub jaw_opening: f64,
    pub reference: [f64; 7],
    pub reference_speed: [f64; 6],
    /// Geometry in contact with the carrier body.
    pub tray_contacts: Vec<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Initial {
    Create {
        definition: CellDefinition,
    },
    /// `content` is the exact checkpoint envelope that `digest` names, as
    /// the host's `export` gives it and the command line's output holds it.
    Continue {
        content: String,
        digest: String,
        /// Numbers the next recording segment of an operation in progress.
        sequence: usize,
    },
}

/// A stored cell checkpoint: the envelope (step 6D) and its digest, the
/// form that the host's `export` and `open` exchange.
#[derive(Serialize)]
pub struct StoredCheckpoint {
    pub content: String,
    pub digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Action {
    Admit {
        carrier: String,
    },
    Remove {
        carrier: String,
    },
    Start {
        #[serde(rename = "attemptId")]
        attempt_id: String,
        task: BakeryTask,
    },
    /// Advances the running operation, or the idle world, by `steps`.
    Advance {
        steps: usize,
    },
    /// Advances the running operation to its end.
    Finish,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CellRequest {
    pub schema_version: u32,
    pub initial: Initial,
    pub actions: Vec<Action>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ActionResult {
    Admitted {
        before: String,
        after: String,
        observation: Observation,
    },
    Removed {
        before: String,
        after: String,
        observation: Observation,
    },
    Started {
        #[serde(rename = "attemptId")]
        attempt_id: String,
        plan: Vec<String>,
    },
    /// The plan failed before any step; the cell is unchanged.
    Refused {
        #[serde(rename = "attemptId")]
        attempt_id: String,
        outcome: Outcome,
    },
    Advanced {
        steps: usize,
    },
    Terminal {
        #[serde(rename = "attemptId")]
        attempt_id: String,
        outcome: Outcome,
        steps: usize,
        observation: Observation,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellOutput {
    pub kind: &'static str,
    pub schema_version: u32,
    pub results: Vec<ActionResult>,
    pub segments: Vec<Segment>,
    pub checkpoint: StoredCheckpoint,
    pub sequence: usize,
    pub observation: Observation,
    /// The settled hold the cell may enter in this state, if it has rested.
    pub hold: Option<HoldOffer>,
}

struct Running {
    attempt_id: String,
    generation: u32,
    dispatched_step: usize,
    start: Start,
    operation: Operation,
    sequence: usize,
    predecessor: String,
    segment_start: usize,
    contacts: Vec<ContactObservation>,
}

/// What names a sealed checkpoint: its digest, the length of its content
/// and its step.
#[derive(Clone)]
pub struct Seal {
    pub digest: String,
    pub byte_length: usize,
    pub steps: usize,
}

pub struct Cell {
    definition: CellDefinition,
    engine: Engine,
    slot: Slot,
    servo: Servo,
    steps: usize,
    held: bool,
    grip_disabled: bool,
    resting: Option<Resting>,
    running: Option<Running>,
    /// The seal of the present state, once it is computed. Each method that
    /// changes a value of the checkpoint calls `changed` before the change,
    /// so a kept seal always names the present state.
    seal: Option<Seal>,
}

/// Where a carrier is admitted: at rest on the source table, as the declared
/// handoff places it.
fn source_pose(engine: &Engine) -> Result<[f64; 7]> {
    let center = engine.site("source_tray_center")?;
    Ok([
        center.x,
        center.y,
        center.z,
        FRAC_1_SQRT_2,
        0.,
        0.,
        -FRAC_1_SQRT_2,
    ])
}

impl Cell {
    pub fn sample(&self) -> Sample {
        self.engine.sample(self.steps)
    }

    pub fn recording(&mut self, predecessor: String, motion: CellMotion) -> Result<CellRecording> {
        let (runner, runtime) = match &self.definition.execution {
            ExecutionIdentity::Native {
                controller_hash,
                runtime_hash,
                ..
            }
            | ExecutionIdentity::Browser {
                controller_hash,
                runtime_hash,
                ..
            } => (controller_hash, runtime_hash),
        };
        Ok(CellRecording {
            schema_version: 1,
            kind: "cell-physics-recording".into(),
            cell_id: self.definition.cell_id.clone(),
            run_id: self.definition.run_id.clone(),
            model_hash: self.definition.model_hash.clone(),
            runner_sha256: runner.clone(),
            runtime_sha256: runtime.clone(),
            predecessor,
            checkpoint: self.seal()?.digest,
            motion,
        })
    }
    /// Creates an empty cell: the arm at its ready pose, the carrier slot
    /// parked, and the reference body at rest on the table.
    pub fn create(assets: &Assets, definition: CellDefinition) -> Result<Self> {
        match Self::create_or_refuse(assets, definition)? {
            Ok(cell) => Ok(cell),
            Err((Outcome::Failed { reason, .. }, _)) => {
                bail!("No ready pose reaches the fixture: {reason:?}")
            }
            Err((outcome, _)) => bail!("No ready pose reaches the fixture: {outcome:?}"),
        }
    }

    /// Creates an empty cell, or gives the failed outcome and the sample of
    /// a fixture where no ready pose reaches the destination.
    pub fn create_or_refuse(
        assets: &Assets,
        definition: CellDefinition,
    ) -> Result<Result<Self, (Outcome, Sample)>> {
        definition.validate(assets)?;
        let request = definition.request("cell", definition.fixture.initial_task());
        // The fixture's own initial state supplies the pose planning starts from.
        let (base, _) = assets.open(&request)?;
        let mut engine = assets.open_persistent(&request)?;
        engine.set_start(&base.joints());
        engine.set_jaw(base.jaw_opening());
        engine.place_tray(&source_pose(&engine)?);
        let (angles, target) =
            match transfer::ready_or_failure(&mut engine, definition.fixture.initial_task())? {
                Ok(pose) => pose,
                Err(outcome) => return Ok(Err((outcome, engine.sample(0)))),
            };
        engine.set_start(&angles);
        engine.park_tray();
        Ok(Ok(Self {
            definition,
            engine,
            slot: Slot::Inactive { generation: 0 },
            servo: Servo {
                angles,
                target,
                posture: Posture::Ready,
                jaw: OPEN_JAW_M,
            },
            steps: 0,
            held: false,
            grip_disabled: false,
            resting: None,
            running: None,
            seal: None,
        }))
    }

    /// Restores a cell at its checkpoint's exact step, in any process built
    /// from the same runner. `sequence` numbers the next recording segment.
    pub fn restore(assets: &Assets, checkpoint: CellCheckpoint, sequence: usize) -> Result<Self> {
        ensure!(
            checkpoint.schema_version == 4,
            "Unsupported cell checkpoint version"
        );
        ensure!(
            checkpoint.content_digest()? == checkpoint.digest,
            "Checkpoint digest mismatch"
        );
        checkpoint.definition.validate(assets)?;
        let definition = checkpoint.definition;
        let mut engine = assets
            .open_persistent(&definition.request("cell", definition.fixture.initial_task()))?;
        if checkpoint.grip_disabled {
            engine.disable_grip();
        }
        // The slot's collision state is model state: apply it before the world.
        if matches!(checkpoint.slot, Slot::Inactive { .. }) {
            engine.park_tray();
        }
        engine.restore(&checkpoint.integration_state)?;
        let timestep = definition.timestep;
        // The step count is the cell's clock; see `validate_within`.
        ensure!(
            (engine.time() - checkpoint.steps as f64 * timestep).abs() < timestep / 2.,
            "Checkpoint time differs from its step count"
        );
        let parked = engine.sample(0).tray == PARKED_TRAY;
        ensure!(
            parked == matches!(checkpoint.slot, Slot::Inactive { .. }),
            "Carrier slot differs from the carrier body's state"
        );
        if checkpoint.operation.is_none() && !checkpoint.held {
            if let Slot::Active { location, .. } = checkpoint.slot {
                let tray = engine.sample(0).tray;
                let position = crate::native::Point::from_column_slice(&tray[..3]);
                ensure!(
                    (position - engine.site(location.site())?).norm() < 0.01,
                    "Carrier location differs from its physical position"
                );
            }
        }
        for (angle, (lower, upper)) in checkpoint.servo.angles.iter().zip(engine.limits()) {
            ensure!(
                angle.is_finite() && angle >= lower && angle <= upper,
                "Invalid servo target"
            );
        }
        ensure!(
            checkpoint.servo.jaw.is_finite() && (-0.01..=0.06).contains(&checkpoint.servo.jaw),
            "Invalid jaw servo target"
        );
        let running = match checkpoint.operation {
            None => {
                ensure!(sequence == 0, "An idle cell records no segment");
                None
            }
            Some(saved) => {
                ensure!(
                    matches!(
                        saved.start,
                        Start::Ready { .. }
                            | Start::Retreated { .. }
                            | Start::Loaded { .. }
                            | Start::Returned { .. }
                            | Start::Recovery { .. }
                    ),
                    "A persistent operation requires a persistent start"
                );
                let recovery = matches!(saved.start, Start::Recovery { .. });
                ensure!(
                    checkpoint.held == recovery,
                    "Operation differs from the failure hold"
                );
                let generation = match &checkpoint.slot {
                    Slot::Active {
                        generation,
                        location,
                        ..
                    } => {
                        ensure!(
                            recovery || location.allows(definition.fixture, saved.task),
                            "Saved operation differs from its carrier location"
                        );
                        ensure!(
                            !recovery || saved.progress.next_phase == 0,
                            "Recovery already removed its carrier"
                        );
                        *generation
                    }
                    Slot::Inactive { generation } => {
                        ensure!(
                            recovery && saved.progress.next_phase > 0,
                            "An operation needs an admitted carrier"
                        );
                        *generation
                    }
                };
                ensure!(
                    generation == saved.generation && saved.dispatched_step <= checkpoint.steps,
                    "Operation belongs to another carrier binding"
                );
                validate_identity(&saved.attempt_id)?;
                let binding = Binding::new(
                    definition.request(&saved.attempt_id, saved.task),
                    Completion::Recording,
                )?;
                let operation = Operation::resume(
                    &engine,
                    binding,
                    &saved.start,
                    (saved.plan, saved.progress, saved.within),
                    saved.dispatched_step as f64 * timestep,
                )?;
                ensure!(
                    saved.dispatched_step + operation.step() == checkpoint.steps,
                    "Operation progress differs from the cell's step count"
                );
                Some(Running {
                    attempt_id: saved.attempt_id,
                    generation: saved.generation,
                    dispatched_step: saved.dispatched_step,
                    start: saved.start,
                    segment_start: operation.step(),
                    contacts: Vec::new(),
                    operation,
                    sequence,
                    predecessor: checkpoint.digest,
                })
            }
        };
        Ok(Self {
            definition,
            engine,
            slot: checkpoint.slot,
            servo: checkpoint.servo,
            steps: checkpoint.steps,
            held: checkpoint.held,
            grip_disabled: checkpoint.grip_disabled,
            resting: checkpoint.resting,
            running,
            seal: None,
        })
    }

    pub fn definition(&self) -> &CellDefinition {
        &self.definition
    }

    pub fn slot(&self) -> &Slot {
        &self.slot
    }

    /// The expected integration steps of the operation in progress.
    pub fn planned_steps(&self) -> Option<usize> {
        self.running
            .as_ref()
            .map(|running| running.operation.planned_steps())
    }

    pub fn in_progress(&self) -> Option<InProgress<'_>> {
        self.running.as_ref().map(|running| InProgress {
            attempt_id: &running.attempt_id,
            step: running.operation.step(),
            sequence: running.sequence,
        })
    }

    pub fn checkpoint(&self) -> Result<CellCheckpoint> {
        Ok(self.sealed()?.0)
    }

    /// The checkpoint and the length of the content its digest names.
    pub fn sealed(&self) -> Result<(CellCheckpoint, usize)> {
        let mut checkpoint = CellCheckpoint {
            schema_version: 4,
            definition: self.definition.clone(),
            slot: self.slot.clone(),
            servo: self.servo.clone(),
            steps: self.steps,
            held: self.held,
            grip_disabled: self.grip_disabled,
            resting: self.resting.clone(),
            integration_state: self.engine.state(),
            operation: self.running.as_ref().map(|running| {
                let (plan, progress, within) = running.operation.saved();
                SavedOperation {
                    attempt_id: running.attempt_id.clone(),
                    task: running.operation.binding().request.bakery_task_id,
                    generation: running.generation,
                    dispatched_step: running.dispatched_step,
                    start: running.start.clone(),
                    plan,
                    progress,
                    within,
                }
            }),
            digest: String::new(),
        };
        let content = checkpoint.content()?;
        checkpoint.digest = digest(&content);
        Ok((checkpoint, content.len()))
    }

    /// The seal of the present state. A seal is computed at most once for
    /// each state: a command that names the state again reuses it.
    pub fn seal(&mut self) -> Result<Seal> {
        if let Some(seal) = &self.seal {
            return Ok(seal.clone());
        }
        let (checkpoint, byte_length) = self.sealed()?;
        let seal = Seal {
            digest: checkpoint.digest,
            byte_length,
            steps: checkpoint.steps,
        };
        self.seal = Some(seal.clone());
        Ok(seal)
    }

    /// Forgets the seal before a change to the checkpoint's values.
    fn changed(&mut self) {
        self.seal = None;
    }

    pub fn observe(&self) -> Observation {
        let (reference, reference_speed) = self
            .engine
            .reference()
            .expect("A persistent cell has a reference body");
        let mut tray_contacts = Vec::new();
        for contact in self.engine.live_contacts() {
            if contact.first_is_tray {
                tray_contacts.push(contact.second.to_owned());
            } else if contact.second_is_tray {
                tray_contacts.push(contact.first.to_owned());
            }
        }
        tray_contacts.sort();
        tray_contacts.dedup();
        Observation {
            steps: self.steps,
            slot: self.slot.clone(),
            arm: self.engine.joints(),
            tray: self.engine.sample(0).tray,
            tray_speed: self.engine.tray_speed(),
            jaw_opening: self.engine.jaw_opening(),
            reference,
            reference_speed,
            tray_contacts,
        }
    }

    fn idle(&self) -> Result<()> {
        ensure!(self.running.is_none(), "The cell is executing an operation");
        ensure!(
            !self.held,
            "The cell holds a failed operation until recovery"
        );
        Ok(())
    }

    /// Activates the carrier slot at the source position. Only the carrier
    /// body is written; the arm and every other body keep their exact state.
    pub fn admit(&mut self, carrier: &str) -> Result<ActionResult> {
        self.idle()?;
        validate_identity(carrier)?;
        let Slot::Inactive { generation } = self.slot else {
            bail!("The cell's carrier slot is occupied");
        };
        let before = self.seal()?.digest;
        let untouched = self.observe();
        self.changed();
        self.engine.place_tray(&source_pose(&self.engine)?);
        self.resting = None;
        self.slot = Slot::Active {
            generation: generation + 1,
            carrier: carrier.into(),
            location: CarrierLocation::Source,
        };
        let observation = self.observe();
        ensure!(
            observation.arm == untouched.arm && observation.reference == untouched.reference,
            "Admission moved a body other than the carrier"
        );
        ensure!(
            observation
                .tray_contacts
                .iter()
                .all(|name| name == "table_top"),
            "The admission position is obstructed: {:?}",
            observation.tray_contacts
        );
        Ok(ActionResult::Admitted {
            before,
            after: self.seal()?.digest,
            observation,
        })
    }

    /// Parks the carrier slot once the tool has released the carrier and it
    /// rests on a fixture. Only the carrier body is written.
    pub fn remove(&mut self, carrier: &str) -> Result<ActionResult> {
        self.idle()?;
        let Slot::Active {
            generation,
            carrier: admitted,
            ..
        } = &self.slot
        else {
            bail!("The cell's carrier slot is empty");
        };
        ensure!(admitted == carrier, "The cell holds another carrier");
        let generation = *generation;
        let before = self.seal()?.digest;
        let untouched = self.observe();
        let speed = self.engine.tray_speed();
        ensure!(
            self.engine.jaw_opening() > OPEN_JAW_M - 0.005
                && !untouched
                    .tray_contacts
                    .iter()
                    .any(|name| name.starts_with("clamp_")),
            "The tool has not released the carrier"
        );
        ensure!(
            !untouched.tray_contacts.is_empty()
                && speed[..3].iter().map(|v| v * v).sum::<f64>().sqrt() < 0.02
                && speed[3..].iter().map(|v| v * v).sum::<f64>().sqrt() < 0.05,
            "The carrier is not at rest on a fixture"
        );
        self.changed();
        self.engine.park_tray();
        self.resting = None;
        self.slot = Slot::Inactive { generation };
        let observation = self.observe();
        ensure!(
            observation.arm == untouched.arm && observation.reference == untouched.reference,
            "Removal moved a body other than the carrier"
        );
        Ok(ActionResult::Removed {
            before,
            after: self.seal()?.digest,
            observation,
        })
    }

    /// Plans a rack transfer from the arm's current pose and binds it to the
    /// admitted carrier. A plan that fails leaves the cell unchanged.
    pub fn start(&mut self, attempt_id: &str, task: BakeryTask) -> Result<ActionResult> {
        self.idle()?;
        let Slot::Active { location, .. } = self.slot else {
            bail!("An operation needs an admitted carrier");
        };
        ensure!(
            location.allows(self.definition.fixture, task),
            "Operation does not match the carrier's location and fixture"
        );
        self.start_operation(attempt_id, task, self.servo.start(&self.engine, location))
    }

    /// The human handles the carrier while the arm holds its actual joints.
    /// The declared handling ends with removal, then a real empty-arm return.
    pub fn recover(
        &mut self,
        attempt_id: &str,
        carrier: &str,
        handling_steps: usize,
    ) -> Result<ActionResult> {
        ensure!(self.running.is_none(), "Recovery requires an idle cell");
        ensure!(
            matches!(&self.slot, Slot::Active { carrier: active, .. } if active == carrier),
            "Recovery names another carrier"
        );
        let start = Start::Recovery {
            angles: self.engine.joints(),
            previous_target: self.engine.site("cell_grasp")?.into(),
            handling_steps,
        };
        self.start_operation(attempt_id, self.definition.fixture.initial_task(), start)
    }

    fn start_operation(
        &mut self,
        attempt_id: &str,
        task: BakeryTask,
        start: Start,
    ) -> Result<ActionResult> {
        validate_identity(attempt_id)?;
        let Slot::Active { generation, .. } = self.slot else {
            bail!("An operation needs an admitted carrier");
        };
        let predecessor = self.seal()?.digest;
        self.changed();
        let binding = Binding::new(
            self.definition.request(attempt_id, task),
            Completion::Recording,
        )?;
        let (operation, failed) = Operation::open(&mut self.engine, binding, None, start.clone())?;
        if let Some(outcome) = failed {
            return Ok(ActionResult::Refused {
                attempt_id: attempt_id.into(),
                outcome,
            });
        }
        let plan = operation
            .saved()
            .0
            .into_iter()
            .map(|phase| phase.name)
            .collect();
        // The factory owns the failed task and authorizes this explicit
        // removal. A refused transfer plan may have left the native cell idle.
        if matches!(start, Start::Recovery { .. }) {
            self.held = true;
        }
        self.resting = None;
        self.running = Some(Running {
            attempt_id: attempt_id.into(),
            generation,
            dispatched_step: self.steps,
            start,
            operation,
            sequence: 0,
            predecessor,
            segment_start: 0,
            contacts: Vec::new(),
        });
        Ok(ActionResult::Started {
            attempt_id: attempt_id.into(),
            plan,
        })
    }

    /// Advances by at most `steps`, in calls of at most `allowance`. An
    /// operation that ends is recorded; an idle cell holds its servo targets.
    pub fn advance(
        &mut self,
        steps: usize,
        allowance: usize,
        segments: &mut Vec<Segment>,
    ) -> Result<ActionResult> {
        ensure!(allowance >= 1, "Advance at least one step per call");
        self.changed();
        let Some(mut running) = self.running.take() else {
            self.rest(steps)?;
            return Ok(ActionResult::Advanced { steps });
        };
        let from = running.operation.step();
        loop {
            let done = running.operation.step() - from;
            if done == steps {
                self.running = Some(running);
                return Ok(ActionResult::Advanced { steps });
            }
            let stop = running.operation.advance_recorded(
                &mut self.engine,
                allowance.min(steps - done),
                &mut running.contacts,
            );
            self.steps = running.dispatched_step + running.operation.step();
            if running.operation.carrier_removed() {
                self.slot = Slot::Inactive {
                    generation: running.generation,
                };
            }
            let outcome = match stop {
                Ok(Stop::Terminal(outcome)) => outcome,
                Ok(Stop::Allowance | Stop::Event | Stop::Boundary) => continue,
                Err(error) => Outcome::ExecutionError {
                    step: running.operation.step(),
                    message: error.to_string(),
                },
            };
            return self.finish(running, outcome, segments);
        }
    }

    /// Advances the idle world while the arm holds its servo targets.
    fn rest(&mut self, steps: usize) -> Result<()> {
        self.changed();
        for _ in 0..steps {
            self.engine
                .step(&self.servo.angles, false, self.servo.jaw)?;
            self.steps += 1;
            if !self.held {
                self.watch();
            }
        }
        Ok(())
    }

    /// The fixtures in contact with the admitted carrier, apart from the
    /// carrier's own parts.
    fn supports(&self) -> Vec<String> {
        let mut supports = Vec::new();
        for contact in self.engine.live_contacts() {
            let other = if contact.first_is_tray {
                contact.second
            } else if contact.second_is_tray {
                contact.first
            } else {
                continue;
            };
            if !other.starts_with("mbco_tray") {
                supports.push(other.to_owned());
            }
        }
        supports.sort();
        supports.dedup();
        supports
    }

    /// Extends or restarts the observation of an idle cell after one step.
    /// The carrier, or the reference body in an empty cell, must stay slow
    /// and near where the observation began, with the tool open and the arm
    /// still. A support cannot change without the carrier moving, so the
    /// supports are read when an observation begins and when it qualifies.
    fn watch(&mut self) {
        self.changed();
        let (pose, speed) = match self.slot {
            Slot::Active { .. } => (self.engine.sample(0).tray, self.engine.tray_speed()),
            Slot::Inactive { .. } => self
                .engine
                .reference()
                .expect("A persistent cell has a reference body"),
        };
        let norm = |values: &[f64]| values.iter().map(|v| v * v).sum::<f64>().sqrt();
        let still = norm(&speed[..3]) < HOLD_SPEED
            && norm(&speed[3..]) < HOLD_SPEED
            && self.engine.arm_speed() < HOLD_SPEED
            && self.engine.jaw_opening() > OPEN_TOOL_M;
        let window = match self.resting.take() {
            Some(window) if still && near(&window.anchor, &pose) => Some(window),
            _ => None,
        };
        self.resting = match window {
            Some(mut window) => {
                window.steps += 1;
                // The qualifying step confirms the supports it began with.
                if window.steps == HOLD_ENTRY_STEPS && self.rested_on() != window.support {
                    None
                } else {
                    Some(window)
                }
            }
            None if still => Some(Resting {
                steps: 1,
                anchor: pose,
                support: self.rested_on(),
            }),
            None => None,
        };
    }

    fn rested_on(&self) -> Vec<String> {
        match self.slot {
            Slot::Active { .. } => self.supports(),
            Slot::Inactive { .. } => Vec::new(),
        }
    }

    /// The settled hold this cell may enter now, if its rest qualifies.
    pub fn hold(&self) -> Option<HoldOffer> {
        // Pan staging qualifies only the empty cell. A supported pan continues
        // ordinary physics until its worker handoff; the oven is unqualified.
        if self.definition.fixture == CellFixture::OvenRack
            || (self.definition.fixture == CellFixture::PanStaging
                && !matches!(self.slot, Slot::Inactive { .. }))
        {
            return None;
        }
        let resting = self.resting.as_ref()?;
        if self.running.is_some() || self.held || resting.steps < HOLD_ENTRY_STEPS {
            return None;
        }
        let names: Vec<&str> = resting.support.iter().map(String::as_str).collect();
        let support = match (&self.slot, names.as_slice()) {
            (Slot::Inactive { .. }, []) => "empty",
            (Slot::Active { .. }, ["table_top"]) => "table",
            (Slot::Active { .. }, ["rack_rail_left", "rack_rail_right"]) => "rack",
            _ => return None,
        };
        Some(HoldOffer {
            model: HOLD_MODEL,
            support,
            qualified_steps: HOLD_QUALIFIED_STEPS,
        })
    }

    /// Advances by at most `steps` in one call and returns at a pickup, at
    /// the operation's end or when the allowance runs out. Each return ends
    /// a recording segment, so every event lies on a segment's last step.
    /// With `stop_at_hold`, an idle cell also returns at the step where its
    /// hold qualifies, so that the hold starts at the same step as with one
    /// step for each call.
    pub fn bounded(
        &mut self,
        steps: usize,
        stop_at_hold: bool,
        segments: &mut Vec<Segment>,
    ) -> Result<Bounded> {
        ensure!(steps >= 1, "Advance at least one step per call");
        let Some(mut running) = self.running.take() else {
            ensure!(steps <= 32, "An idle recording covers at most 32 steps");
            let predecessor = self.seal()?.digest;
            let start_step = self.steps;
            let mut samples = Vec::with_capacity(steps + 1);
            let mut contacts = Vec::with_capacity(steps);
            samples.push(self.sample());
            let mut offered = self.hold().is_some();
            for _ in 0..steps {
                self.rest(1)?;
                samples.push(self.sample());
                contacts.push(ContactObservation {
                    step: self.steps,
                    pairs: self.engine.contact_pairs()?,
                });
                let offers = self.hold().is_some();
                if stop_at_hold && offers && !offered {
                    break;
                }
                offered = offers;
            }
            return Ok(Bounded::Idle {
                recording: self.recording(
                    predecessor,
                    CellMotion::Idle {
                        start_step,
                        end_step: self.steps,
                        sample_stride: 1,
                        samples,
                        contacts: ContactCapture::Dense {
                            observations: contacts,
                        },
                    },
                )?,
            });
        };
        self.changed();
        let stop =
            running
                .operation
                .advance_recorded(&mut self.engine, steps, &mut running.contacts);
        self.steps = running.dispatched_step + running.operation.step();
        if running.operation.carrier_removed() {
            self.slot = Slot::Inactive {
                generation: running.generation,
            };
        }
        let outcome = match stop {
            Ok(Stop::Terminal(outcome)) => outcome,
            Ok(stop) => {
                self.running = Some(running);
                self.pause(segments)?;
                return Ok(match stop {
                    Stop::Event => Bounded::Event,
                    _ => Bounded::Allowance,
                });
            }
            Err(error) => Outcome::ExecutionError {
                step: running.operation.step(),
                message: error.to_string(),
            },
        };
        let attempt_id = running.attempt_id.clone();
        self.finish(running, outcome.clone(), segments)?;
        Ok(Bounded::Terminal {
            attempt_id,
            outcome,
        })
    }

    fn finish(
        &mut self,
        mut running: Running,
        outcome: Outcome,
        segments: &mut Vec<Segment>,
    ) -> Result<ActionResult> {
        self.changed();
        running.operation.close(&self.engine, &outcome);
        let (samples, events) = running.operation.cut(&self.engine);
        let (angles, target) = running.operation.servo();
        let (_, progress, _) = running.operation.saved();
        self.held = !matches!(
            outcome,
            Outcome::Completed { .. } | Outcome::Recovered { .. }
        );
        if matches!(outcome, Outcome::Completed { .. }) {
            if let Slot::Active { location, .. } = &mut self.slot {
                *location = match running.operation.binding().request.bakery_task_id {
                    BakeryTask::Rack => CarrierLocation::Rack,
                    BakeryTask::Oven => CarrierLocation::Oven,
                    BakeryTask::Unload => CarrierLocation::Returned,
                };
            }
        }
        self.servo = Servo {
            angles: if self.held {
                self.engine.joints()
            } else {
                angles
            },
            target: if self.held {
                self.engine.site("cell_grasp")?.into()
            } else {
                target
            },
            jaw: if self.held {
                self.engine.jaw_opening()
            } else {
                OPEN_JAW_M
            },
            posture: if matches!(outcome, Outcome::Recovered { .. }) {
                Posture::Ready
            } else {
                Posture::Retreated
            },
        };
        self.grip_disabled |= progress.grip_disabled;
        self.resting = None;
        let steps = running.operation.step();
        let checkpoint = self.seal()?;
        segments.push(Segment::new(
            running.operation.binding(),
            running.sequence,
            running.predecessor,
            running.segment_start,
            steps,
            samples,
            ContactCapture::Dense {
                observations: running.contacts,
            },
            events,
            checkpoint.digest,
        )?);
        Ok(ActionResult::Terminal {
            attempt_id: running.attempt_id,
            outcome,
            steps,
            observation: self.observe(),
        })
    }

    /// Ends the recording interval of an operation still in progress.
    fn pause(&mut self, segments: &mut Vec<Segment>) -> Result<usize> {
        let Some(mut running) = self.running.take() else {
            return Ok(0);
        };
        // A cut ends a recording interval; no value of the checkpoint changes.
        let (samples, events) = running.operation.cut(&self.engine);
        let end = running.operation.step();
        self.running = Some(running);
        let checkpoint = self.seal()?;
        let running = self.running.as_mut().expect("The operation was restored");
        segments.push(Segment::new(
            running.operation.binding(),
            running.sequence,
            std::mem::replace(&mut running.predecessor, checkpoint.digest.clone()),
            running.segment_start,
            end,
            samples,
            ContactCapture::Dense {
                observations: std::mem::take(&mut running.contacts),
            },
            events,
            checkpoint.digest,
        )?);
        running.sequence += 1;
        running.segment_start = end;
        Ok(running.sequence)
    }
}

/// Whether a pose is within the hold's drift limits of where its rest began.
fn near(anchor: &[f64; 7], pose: &[f64; 7]) -> bool {
    let moved = (0..3)
        .map(|axis| (pose[axis] - anchor[axis]).powi(2))
        .sum::<f64>()
        .sqrt();
    let aligned = (3..7)
        .map(|part| pose[part] * anchor[part])
        .sum::<f64>()
        .abs()
        .min(1.);
    moved < HOLD_DRIFT_M && 2. * aligned.acos() < HOLD_DRIFT_RAD
}

/// Applies a list of actions to a new or restored cell. Any refused action
/// fails the whole request, so no output records a partial boundary change.
/// Only the native command line calls it: its idle advance rests a cell for
/// hours in one call, which the host's 32-step idle recordings do not.
pub fn run(assets: &Assets, request: CellRequest, allowance: usize) -> Result<CellOutput> {
    ensure!(
        request.schema_version == 1,
        "Unsupported cell request version"
    );
    ensure!(
        !request.actions.is_empty() && request.actions.len() <= 256,
        "Use 1–256 cell actions"
    );
    let mut cell = match request.initial {
        Initial::Create { definition } => Cell::create(assets, definition)?,
        Initial::Continue {
            content,
            digest,
            sequence,
        } => Cell::restore(
            assets,
            CellCheckpoint::from_content(content.as_bytes(), &digest)?,
            sequence,
        )?,
    };
    let mut results = Vec::new();
    let mut segments = Vec::new();
    for action in request.actions {
        results.push(match action {
            Action::Admit { carrier } => cell.admit(&carrier)?,
            Action::Remove { carrier } => cell.remove(&carrier)?,
            Action::Start { attempt_id, task } => cell.start(&attempt_id, task)?,
            Action::Advance { steps } => cell.advance(steps, allowance, &mut segments)?,
            Action::Finish => {
                ensure!(cell.running.is_some(), "No operation is running");
                cell.advance(usize::MAX, allowance, &mut segments)?
            }
        });
    }
    let sequence = cell.pause(&mut segments)?;
    let (checkpoint, _) = cell.sealed()?;
    Ok(CellOutput {
        kind: "bakery-native-cell",
        schema_version: 1,
        results,
        segments,
        checkpoint: StoredCheckpoint {
            content: String::from_utf8(checkpoint.content()?)?,
            digest: checkpoint.digest,
        },
        sequence,
        observation: cell.observe(),
        hold: cell.hold(),
    })
}

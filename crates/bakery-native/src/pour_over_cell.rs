//! Persistent pour-over station for the production host. One FR10 pours from
//! a gooseneck kettle onto a prepared bed; a human prepared the filter, the
//! grounds, the server and a hot kettle. The MuJoCo world, the Rust water
//! model and the controller advance together at every 2 ms step.
use crate::{
    appliance_motors::MotorState,
    appliance_run::{Action, Checkpoint, Controller as ApplianceController, Initial, Lab},
    appliances::{Batch, Contents, Grinder, Program},
    artifact::{ContactCapture, ContactObservation, ExecutionIdentity, digest},
    assets::Assets,
    host::{CheckpointRef, Executing, Stopped},
    native::{StationBody, StationEngine, StationModelState, StationSite},
    pour_over_control::{
        CONTROL_STRIDE, Controller, Decision, Deviation, FINGER_OPEN_M, Failure, Layout, POURS,
        Phase, Pose, Sensed,
    },
    pour_over_water::{Distribution, Placement, Point, Stream, Water, rotation_of},
    robot::Robot,
    station_reply::{self, Digested, Header, no_carrier, reference},
};
use anyhow::{Context, Result, bail, ensure};
use nalgebra::{Quaternion, UnitQuaternion};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const TIMESTEP: f64 = 0.002;
const PLAN: &[&str] = &[
    "pickup", "pour-1", "pour-2", "pour-3", "pour-4", "return", "drainage",
];

/// The scale as the controller reads it, and its true load.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaleSample {
    reading_g: Option<f64>,
    tared: bool,
    stable: bool,
    load_kg: f64,
}

/// The water model's state, in grams and degrees Celsius.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaterSample {
    kettle_g: f64,
    kettle_c: f64,
    airborne_g: f64,
    absorbed_g: f64,
    free_g: f64,
    bed_c: f64,
    server_g: f64,
    server_c: f64,
    spill_g: f64,
    evaporated_g: f64,
    poured_g: f64,
    off_bed_g: f64,
    wet_radius_m: f64,
    flow_g_s: f64,
}

/// The controller's phase and targets. An idle station has no stage.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlSample {
    phase: String,
    stage: Option<&'static str>,
    brew_s: Option<f64>,
    next_target_g: Option<f64>,
    deviations: Vec<Deviation>,
}

/// One measured pour of a finished brew.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PourReport {
    pour: usize,
    target_g: f64,
    scheduled_s: f64,
    detected_s: Option<f64>,
    final_g: Option<f64>,
    top_ups: Option<u32>,
    flow_start_s: Option<f64>,
    flow_end_s: Option<f64>,
    duration_s: Option<f64>,
    delivered_g: f64,
    max_landing_radius_m: f64,
    off_bed_g: f64,
    spill_g: f64,
}

/// The brew's measured results, recorded with its terminal sample.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pours: Vec<PourReport>,
    brew_s: Option<f64>,
    pickup_step: Option<usize>,
    fault_step: Option<usize>,
    deviations: Vec<Deviation>,
    outcome: Outcome,
}

/// One accepted solver step of the station.
#[derive(Serialize)]
pub struct Sample {
    step: usize,
    joints: [f64; 6],
    fingers: [f64; 2],
    gripper: [f64; 7],
    kettle: [f64; 7],
    dripper: [f64; 7],
    server: [f64; 7],
    scale: ScaleSample,
    water: WaterSample,
    stream: Option<Stream>,
    control: ControlSample,
    #[serde(skip_serializing_if = "Option::is_none")]
    grinder: Option<crate::appliance_run::Sample>,
    #[serde(skip_serializing_if = "Option::is_none")]
    report: Option<Report>,
}

/// A controller event of a brew segment.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Event {
    Phase { step: usize, label: String },
    Failure { step: usize },
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Outcome {
    Completed {
        measurements: Distribution,
        deviations: Vec<Deviation>,
    },
    Failed {
        reason: Failure,
        disposition: &'static str,
    },
}

/// The motion of an idle interval: every sample and contact.
#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Motion {
    Idle {
        start_step: usize,
        end_step: usize,
        sample_stride: usize,
        samples: Vec<Sample>,
        contacts: ContactCapture,
    },
}

/// An idle interval of the station.
#[derive(Serialize)]
pub struct Recording {
    #[serde(flatten)]
    header: Header,
    motion: Motion,
}

/// An interval of a brew.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    #[serde(flatten)]
    header: Header,
    attempt_id: String,
    sequence: usize,
    start_step: usize,
    end_step: usize,
    samples: Vec<Sample>,
    contacts: ContactCapture,
    events: Vec<Event>,
}

pub type Reply = station_reply::Reply<Digested<Segment>, Recording, Outcome, Sample>;
const COFFEE_G: u32 = 27;
const KETTLE_C: f64 = 93.;
/// The declared drip detector: drainage is complete at this free water.
const DRAINED_KG: f64 = 0.001;
/// Reduced drainage keeps this fraction of the nominal bed conductance.
const REDUCED_DRAINAGE: f64 = 0.4;
/// An injected grip loss, this long after the second pour starts.
const GRIP_FAULT_S: f64 = 3.;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub enum Fixture {
    #[serde(rename = "persistent-pour-over/1")]
    PourOver,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, clap::ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Drainage {
    Nominal,
    Reduced,
}

impl Drainage {
    fn factor(self) -> f64 {
        match self {
            Self::Nominal => 1.,
            Self::Reduced => REDUCED_DRAINAGE,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, clap::ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Fault {
    None,
    LostGrip,
}

/// The prepared station: what a human set out before the robot starts.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Station {
    pub kettle_water_g: u32,
    pub kettle_water_c: f64,
    pub coffee_g: u32,
    pub drainage: Drainage,
    pub fault: Fault,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grinder: Option<Grinder>,
}

impl Station {
    fn validate(&self) -> Result<()> {
        ensure!(
            (420..=700).contains(&self.kettle_water_g)
                && self.kettle_water_c == KETTLE_C
                && self.coffee_g == COFFEE_G,
            "The station holds 420–700 g of 93 °C water and a 27 g bed"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Definition {
    pub schema_version: u8,
    pub fixture: Fixture,
    pub robot: Robot,
    pub cell_id: String,
    pub run_id: String,
    pub station: Station,
    pub timestep: f64,
    pub model_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grinder_model_hash: Option<String>,
    pub execution: ExecutionIdentity,
}

impl Definition {
    pub fn new(assets: &Assets, cell_id: String, run_id: String, station: Station) -> Result<Self> {
        let grinder_model_hash = match station.grinder {
            Some(grinder) => {
                let grinder_lab = Lab::open(
                    assets.root(),
                    Initial::Fresh {
                        appliance: grinder.appliance(),
                        contents: Contents::Empty,
                    },
                )?;
                ensure!(
                    (grinder_lab.timestep() - 0.001).abs() < 1e-12,
                    "The production grinder model requires a 1 ms timestep"
                );
                Some(grinder_lab.snapshot().model_hash)
            }
            None => None,
        };
        let definition = Self {
            schema_version: 1,
            fixture: Fixture::PourOver,
            robot: Robot::FairinoFr10,
            cell_id,
            run_id,
            station,
            timestep: TIMESTEP,
            model_hash: assets.pour_over().2,
            grinder_model_hash,
            execution: ExecutionIdentity::current(),
        };
        definition.validate(assets)?;
        Ok(definition)
    }

    fn validate(&self, assets: &Assets) -> Result<()> {
        ensure!(
            self.schema_version == 1 && self.execution == ExecutionIdentity::current(),
            "Pour-over definition belongs to another build"
        );
        ensure!(
            self.robot == Robot::FairinoFr10 && self.timestep == TIMESTEP,
            "The pour-over station uses the FR10 at the factory's 2 ms tick"
        );
        ensure!(
            self.model_hash == assets.pour_over().2,
            "Pour-over model differs"
        );
        ensure!(
            self.station.grinder.is_some() == self.grinder_model_hash.is_some(),
            "Pour-over grinder definition requires a matching model hash"
        );
        self.station.validate()?;
        for id in [&self.cell_id, &self.run_id] {
            ensure!(
                !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
                "Invalid pour-over identity"
            );
        }
        Ok(())
    }
}

/// The compiled station's initial state and geometry, from the asset build.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Setup {
    initial_state: Vec<f64>,
    ready_angles: [f64; 6],
}

/// What the station holds between operations.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum Status {
    Prepared,
    Brewed,
    Held,
}

/// The servo targets the arm holds between operations.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Servo {
    angles: [f64; 6],
    fingers: f64,
}

/// Model evidence for one pour, kept beside the controller and never read by it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PourEvidence {
    pub index: usize,
    pub flow_start: Option<usize>,
    pub flow_end: Option<usize>,
    pub poured_before_kg: f64,
    pub off_bed_before_kg: f64,
    pub spill_before_kg: f64,
    pub max_landing_m: f64,
    pub reported: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Evidence {
    pours: Vec<PourEvidence>,
    pickup: Option<usize>,
    fault: Option<usize>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Operation {
    Idle,
    Running {
        attempt_id: String,
        elapsed: usize,
        sequence: usize,
        controller: Box<Controller>,
        evidence: Evidence,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Saved {
    schema_version: u8,
    definition: Definition,
    steps: usize,
    status: Status,
    servo: Servo,
    operation: Operation,
    water: Water,
    model: StationModelState,
    integration_state: Vec<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grinder: Option<Checkpoint>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Opening {
    Create {
        definition: Definition,
    },
    Restore {
        content: String,
        digest: String,
        sequence: usize,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Task {
    PourOverBrew,
}

#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Open {
        cell: String,
        opening: Opening,
    },
    Start {
        cell: String,
        attempt_id: String,
        task: Task,
    },
    Advance {
        cell: String,
        steps: usize,
    },
    Export {
        cell: String,
    },
    Observe {
        cell: String,
    },
    Dispose {
        cell: String,
    },
}

/// How one step ended an operation, if it did.
enum Ended {
    Completed,
    Failed(Failure),
}

struct World {
    definition: Definition,
    engine: StationEngine,
    grinder: Option<Lab>,
    layout: Layout,
    steps: usize,
    status: Status,
    servo: Servo,
    operation: Operation,
    water: Water,
    predecessor: String,
}

fn pose(raw: [f64; 7]) -> Pose {
    Pose::new(
        Point::new(raw[0], raw[1], raw[2]),
        UnitQuaternion::from_quaternion(Quaternion::new(raw[3], raw[4], raw[5], raw[6])),
    )
}

fn axis_x(rows: &[f64; 9]) -> Point {
    Point::new(rows[0], rows[3], rows[6])
}

fn layout(engine: &StationEngine) -> Layout {
    let kettle = pose(engine.body_pose(StationBody::Kettle));
    let inverse = kettle.orientation().inverse();
    let (outlet, rows) = engine.site(StationSite::SpoutOutlet);
    Layout {
        handle: engine.site(StationSite::HandleGrasp).0,
        bed: engine.site(StationSite::BedSurface).0,
        outlet: inverse * (outlet - kettle.point()),
        outlet_axis: inverse * axis_x(&rows),
        kettle,
    }
}

fn open_engine(assets: &Assets) -> Result<(StationEngine, Setup)> {
    let (model, setup, _) = assets.pour_over();
    let engine = StationEngine::load(&model, Robot::FairinoFr10)?;
    ensure!(
        (engine.timestep() - TIMESTEP).abs() < 1e-12,
        "The pour-over model requires a 2 ms timestep"
    );
    let setup: Setup = crate::artifact::read_json(&setup)?;
    Ok((engine, setup))
}

fn water_kg(grams: u32) -> f64 {
    f64::from(grams) / 1000.
}

impl World {
    fn create(assets: &Assets, definition: Definition) -> Result<Self> {
        let (mut engine, setup) = open_engine(assets)?;
        engine.restore(&setup.initial_state)?;
        let water = Water::prepared(
            water_kg(definition.station.kettle_water_g),
            definition.station.kettle_water_c,
            water_kg(definition.station.coffee_g),
        )?;
        let grinder = match definition.station.grinder {
            Some(grinder_model) => {
                let mut grinder_lab = Lab::open(
                    assets.root(),
                    Initial::Fresh {
                        appliance: grinder_model.appliance(),
                        contents: Contents::Empty,
                    },
                )?;
                ensure!(
                    Some(grinder_lab.snapshot().model_hash.as_str())
                        == definition.grinder_model_hash.as_deref(),
                    "Pour-over grinder model differs"
                );
                grinder_lab.command(&Action::GrindDial {
                    radians: grinder_model.pour_over_dial_rad(),
                })?;
                for _ in 0..500 {
                    grinder_lab.step()?;
                }
                Some(grinder_lab)
            }
            None => None,
        };
        let layout = layout(&engine);
        let mut world = Self {
            servo: Servo {
                angles: setup.ready_angles,
                fingers: FINGER_OPEN_M,
            },
            definition,
            engine,
            grinder,
            layout,
            steps: 0,
            status: Status::Prepared,
            operation: Operation::Idle,
            water,
            predecessor: String::new(),
        };
        world.apply_loads()?;
        Ok(world)
    }

    fn restore(assets: &Assets, saved: Saved, digest: String) -> Result<Self> {
        saved.definition.validate(assets)?;
        ensure!(
            saved.schema_version == 1
                && saved.grinder.is_some() == saved.definition.station.grinder.is_some(),
            "Unsupported pour-over checkpoint"
        );
        let (mut engine, setup) = open_engine(assets)?;
        engine.restore(&setup.initial_state)?;
        let layout = layout(&engine);
        engine.apply_model(&saved.model)?;
        engine.restore(&saved.integration_state)?;
        let grinder = match (saved.definition.station.grinder, saved.grinder) {
            (Some(grinder_model), Some(checkpoint)) => {
                ensure!(
                    Some(checkpoint.model_hash.as_str())
                        == saved.definition.grinder_model_hash.as_deref()
                        && checkpoint.appliance == grinder_model.appliance(),
                    "Invalid pour-over grinder checkpoint"
                );
                Some(Lab::open(
                    assets.root(),
                    Initial::Continue {
                        checkpoint: Box::new(checkpoint),
                    },
                )?)
            }
            (None, None) => None,
            _ => bail!("Pour-over grinder checkpoint mismatch"),
        };
        // Steps are the clock; the solver's running sum agrees within half a step.
        ensure!(
            (engine.time() - saved.steps as f64 * TIMESTEP).abs() < TIMESTEP / 2.,
            "The checkpoint's solver time differs from its steps"
        );
        saved.water.validate()?;
        ensure!(
            saved.water.initial_kg == water_kg(saved.definition.station.kettle_water_g)
                && saved.water.coffee_kg == water_kg(saved.definition.station.coffee_g),
            "The checkpoint's water differs from its station"
        );
        for (angle, (lower, upper)) in saved.servo.angles.iter().zip(engine.limits()) {
            ensure!(
                angle.is_finite()
                    && angle >= lower
                    && angle <= upper
                    && saved.servo.fingers.is_finite(),
                "Invalid pour-over servo"
            );
        }
        if let Operation::Running {
            elapsed,
            sequence,
            controller,
            evidence,
            attempt_id,
        } = &saved.operation
        {
            controller.validate(engine.limits())?;
            ensure!(
                saved.status == Status::Prepared
                    && !attempt_id.is_empty()
                    && *sequence <= *elapsed
                    && saved.steps >= *elapsed
                    && evidence.pours.len() <= POURS.len()
                    && controller.pours.len() <= evidence.pours.len()
                    && controller.completed.is_none(),
                "Invalid pour-over operation checkpoint"
            );
            let grip = saved.model.grip_enabled;
            ensure!(
                grip == evidence.fault.is_none(),
                "The checkpoint's grip differs from its fault record"
            );
        } else {
            ensure!(
                saved.model.grip_enabled || saved.status == Status::Held,
                "An idle station keeps its grip"
            );
        }
        let world = Self {
            definition: saved.definition,
            engine,
            grinder,
            layout,
            steps: saved.steps,
            status: saved.status,
            servo: saved.servo,
            operation: saved.operation,
            water: saved.water,
            predecessor: digest,
        };
        // Loads follow the water at controller ticks, so they agree to 1 g.
        let implied = world.loads()?;
        for (applied, expected) in [
            (
                saved.model.kettle_water.mass_kg,
                implied.kettle_water.mass_kg,
            ),
            (saved.model.bed_water.mass_kg, implied.bed_water.mass_kg),
            (saved.model.beverage.mass_kg, implied.beverage.mass_kg),
        ] {
            ensure!(
                (applied - expected).abs() <= 0.001,
                "The checkpoint's body loads differ from its water"
            );
        }
        Ok(world)
    }

    fn saved(&self) -> Saved {
        Saved {
            schema_version: 1,
            definition: self.definition.clone(),
            steps: self.steps,
            status: self.status,
            servo: self.servo.clone(),
            operation: self.operation.clone(),
            water: self.water.clone(),
            model: self.engine.model_state(),
            integration_state: self.engine.state(),
            grinder: self.grinder.as_ref().map(Lab::snapshot),
        }
    }

    fn seal(&self) -> Result<(String, CheckpointRef)> {
        let content = crate::checkpoint::write(
            crate::checkpoint::Kind::PourOverCellCheckpoint,
            &self.saved(),
        )?;
        let checkpoint = reference(&content, self.steps);
        Ok((content, checkpoint))
    }

    /// The water loads that the water state implies in the current pose.
    fn loads(&self) -> Result<StationModelState> {
        let kettle = pose(self.engine.body_pose(StationBody::Kettle));
        Ok(StationModelState {
            kettle_water: self.water.kettle_load(&kettle.orientation())?,
            bed_water: self.water.bed_load(),
            beverage: self.water.beverage_load(),
            grip_enabled: self.engine.model_state().grip_enabled,
        })
    }

    fn apply_loads(&mut self) -> Result<()> {
        let loads = self.loads()?;
        self.engine.apply_model(&loads)
    }

    fn placement(&self) -> Placement {
        let kettle = pose(self.engine.body_pose(StationBody::Kettle));
        let (outlet, rows) = self.engine.site(StationSite::SpoutOutlet);
        Placement {
            kettle_position: kettle.point(),
            kettle_rotation: kettle.orientation(),
            outlet,
            outlet_axis: axis_x(&rows),
            outlet_velocity: self.engine.point_velocity(StationBody::Kettle, outlet),
            bed: self.engine.site(StationSite::BedSurface).0,
        }
    }

    fn sense(&self, step: usize) -> Sensed {
        let mut left = false;
        let mut right = false;
        let mut stand = false;
        for contact in self.engine.contacts() {
            let pair = [contact.first, contact.second];
            let handle = pair.iter().any(|name| name.starts_with("po_kettle_handle"));
            if handle
                && pair
                    .iter()
                    .any(|name| name.starts_with("po_finger_left_pad"))
            {
                left = true;
            }
            if handle
                && pair
                    .iter()
                    .any(|name| name.starts_with("po_finger_right_pad"))
            {
                right = true;
            }
            if pair.contains(&"po_kettle_base") && pair.contains(&"po_kettle_stand") {
                stand = true;
            }
        }
        let tool = self.engine.site(StationSite::ToolGrasp);
        Sensed {
            step,
            tool: Pose::new(tool.0, rotation_of(&tool.1)),
            kettle: pose(self.engine.body_pose(StationBody::Kettle)),
            pads_hold_handle: left && right,
            kettle_on_stand: stand,
            kettle_speed: self.engine.body_speed(StationBody::Kettle).0,
            arm_speed: self.engine.arm_speed(),
            drained: self.water.free_kg <= DRAINED_KG && self.water.airborne.is_empty(),
        }
    }

    /// Contacts the station expects; any other contact is a collision.
    fn unexpected_contact(&self) -> Option<String> {
        for contact in self.engine.contacts() {
            let (a, b) = (contact.first, contact.second);
            let expected = |x: &str, y: &str| {
                (x.starts_with("po_finger_")
                    && x.contains("_pad")
                    && y.starts_with("po_kettle_handle"))
                    || (x == "po_kettle_base" && y == "po_kettle_stand")
                    || (x == "po_server_base" && y == "po_scale_platen_top")
                    || (x == "po_dripper_base" && y == "po_server_rim")
            };
            if !expected(a, b) && !expected(b, a) {
                return Some(format!("{a}/{b}"));
            }
        }
        None
    }

    fn sample(&self, step: usize) -> Result<Sample> {
        let engine = &self.engine;
        let water = &self.water;
        let load_kg = engine.scale_load_kg();
        let (control, scale) = match &self.operation {
            Operation::Running { controller, .. } => (
                ControlSample {
                    phase: controller.phase.label(),
                    stage: controller.stage_label(),
                    brew_s: controller.brew_seconds(step, TIMESTEP),
                    next_target_g: controller.next_target_g(),
                    deviations: controller.deviations.clone(),
                },
                ScaleSample {
                    reading_g: Some(controller.scale.reading_g),
                    tared: controller.scale.tare_kg.is_some(),
                    stable: controller.scale.stable(),
                    load_kg,
                },
            ),
            Operation::Idle => (
                ControlSample {
                    phase: match self.status {
                        Status::Prepared => "prepared",
                        Status::Brewed => "brewed",
                        Status::Held => "held",
                    }
                    .to_owned(),
                    stage: None,
                    brew_s: None,
                    next_target_g: None,
                    deviations: Vec::new(),
                },
                ScaleSample {
                    reading_g: None,
                    tared: false,
                    stable: false,
                    load_kg,
                },
            ),
        };
        Ok(Sample {
            step,
            joints: engine.joints(),
            fingers: engine.fingers(),
            gripper: engine.body_pose(StationBody::Gripper),
            kettle: engine.body_pose(StationBody::Kettle),
            dripper: engine.body_pose(StationBody::Dripper),
            server: engine.body_pose(StationBody::Server),
            scale,
            water: WaterSample {
                kettle_g: water.kettle_kg * 1000.,
                kettle_c: water.kettle_c,
                airborne_g: water.airborne_kg() * 1000.,
                absorbed_g: water.absorbed_kg * 1000.,
                free_g: water.free_kg * 1000.,
                bed_c: water.bed_c,
                server_g: water.server_kg * 1000.,
                server_c: water.server_c,
                spill_g: water.spill_kg * 1000.,
                evaporated_g: water.evaporated_kg * 1000.,
                poured_g: water.poured_kg * 1000.,
                off_bed_g: water.off_bed_kg * 1000.,
                wet_radius_m: water.wet_radius_m,
                flow_g_s: water.flow_kg_s * 1000.,
            },
            stream: water.stream.clone(),
            control,
            grinder: self.grinder.as_ref().map(Lab::sample).transpose()?,
            report: None,
        })
    }

    /// One solver step of an idle station: the arm holds its servo targets.
    fn idle_step(&mut self) -> Result<()> {
        self.engine
            .step(&self.servo.angles, self.servo.fingers, false)?;
        if let Some(grinder) = &mut self.grinder {
            grinder.step()?;
            grinder.step()?;
        }
        self.steps += 1;
        let placement = self.placement();
        self.water.step(
            self.steps,
            TIMESTEP,
            self.engine.gravity(),
            &placement,
            self.definition.station.drainage.factor(),
        )?;
        self.engine.set_dripper_force(self.water.impact_n)?;
        if self.steps.is_multiple_of(CONTROL_STRIDE) {
            self.apply_loads()?;
        }
        Ok(())
    }

    /// One solver step of the running brew, with its decisions.
    fn operation_step(&mut self, events: &mut Vec<Event>) -> Result<Option<Ended>> {
        let Operation::Running {
            elapsed,
            controller,
            evidence,
            ..
        } = &mut self.operation
        else {
            bail!("No pour-over brew is running");
        };
        let step = *elapsed + 1;
        if (step - 1).is_multiple_of(CONTROL_STRIDE) {
            let target = controller.target_for(&self.layout, step, TIMESTEP)?;
            let Some(angles) =
                self.engine
                    .solve_ik(target.point(), &target.rows(), controller.angles)
            else {
                return Ok(Some(Ended::Failed(Failure::Unreachable)));
            };
            controller.target = target;
            controller.angles = angles;
        }
        controller.fingers = controller.fingers_for(step, TIMESTEP);
        controller.carrying = controller.carrying_for();
        // The declared fault removes the finger contacts during the second pour.
        if self.definition.station.fault == Fault::LostGrip
            && evidence.fault.is_none()
            && matches!(controller.phase, Phase::Pour { index: 1, .. })
            && controller
                .pours
                .get(1)
                .is_some_and(|record| (step - record.detected) as f64 * TIMESTEP >= GRIP_FAULT_S)
        {
            let mut model = self.engine.model_state();
            model.grip_enabled = false;
            self.engine.apply_model(&model)?;
            evidence.fault = Some(step);
            events.push(Event::Phase {
                step,
                label: "injected-grip-loss".into(),
            });
        }
        let (angles, fingers, carrying) =
            (controller.angles, controller.fingers, controller.carrying);
        self.engine.step(&angles, fingers, carrying)?;
        if let Some(grinder) = &mut self.grinder {
            grinder.step()?;
            grinder.step()?;
            if step == 3450 {
                grinder.command(&Action::Purge { active: true })?;
            } else if step == 3600 {
                grinder.command(&Action::Purge { active: false })?;
            } else if step == 3750 {
                let snapshot = grinder.snapshot();
                let ApplianceController::Motor { motor, .. } = snapshot.controller else {
                    bail!("Missing pour-over grinder state")
                };
                ensure!(
                    matches!(motor.state, MotorState::Complete)
                        && motor.work_j > 0.
                        && motor.load_work_j > 0.,
                    "Pour-over grinder did not finish the dose"
                );
                grinder.command(&Action::RemoveContents)?;
            }
        }
        self.steps += 1;
        let placement = self.placement();
        self.water.step(
            self.steps,
            TIMESTEP,
            self.engine.gravity(),
            &placement,
            self.definition.station.drainage.factor(),
        )?;
        self.engine.set_dripper_force(self.water.impact_n)?;
        if step.is_multiple_of(CONTROL_STRIDE) {
            self.apply_loads()?;
        }
        let sensed = self.sense(step);
        let load = self.engine.scale_load_kg();
        let collision = self.unexpected_contact();
        let Operation::Running {
            elapsed,
            controller,
            evidence,
            ..
        } = &mut self.operation
        else {
            bail!("No pour-over brew is running");
        };
        *elapsed = step;
        controller.sense_scale(load, TIMESTEP);
        record_evidence(evidence, controller, &self.water, &placement, step);
        if evidence.pickup.is_none()
            && matches!(controller.phase, Phase::Lift { .. })
            && !sensed.kettle_on_stand
        {
            evidence.pickup = Some(step);
            events.push(Event::Phase {
                step,
                label: "kettle-lifted".into(),
            });
        }
        let decision = controller.after_step(&self.layout, &sensed, TIMESTEP)?;
        for record in &mut evidence.pours {
            if record.reported {
                continue;
            }
            let ended = controller
                .pours
                .iter()
                .any(|pour| pour.index == record.index && pour.ended.is_some());
            if let (true, Some(start), Some(end)) = (ended, record.flow_start, record.flow_end) {
                record.reported = true;
                controller.report_duration(record.index, (end - start + 1) as f64 * TIMESTEP);
            }
        }
        if let Some(pair) = collision {
            // A dropped kettle meets the station: the grip failure explains it.
            let reason = if controller.carrying && !sensed.pads_hold_handle {
                Failure::LostGrasp
            } else {
                Failure::Collision
            };
            events.push(Event::Phase {
                step,
                label: format!("contact:{pair}"),
            });
            return Ok(Some(Ended::Failed(reason)));
        }
        Ok(match decision {
            Decision::Continue => None,
            Decision::Phase(label) => {
                events.push(Event::Phase { step, label });
                None
            }
            Decision::Completed => Some(Ended::Completed),
            Decision::Failed(reason) => Some(Ended::Failed(reason)),
        })
    }

    fn disposition(&self) -> &'static str {
        let sensed = self.sense(0);
        if sensed.kettle_on_stand {
            "source"
        } else if sensed.pads_hold_handle {
            "gripped"
        } else {
            "unknown"
        }
    }

    fn advance(&mut self, allowance: usize) -> Result<Reply> {
        ensure!((1..=32).contains(&allowance), "Use 1–32 pour-over steps");
        let before = self.predecessor.clone();
        let (attempt, sequence, start) = match &self.operation {
            Operation::Idle => (None, 0, self.steps),
            Operation::Running {
                attempt_id,
                sequence,
                elapsed,
                ..
            } => (Some(attempt_id.clone()), *sequence, *elapsed),
        };
        let mut samples = vec![self.sample(start)?];
        let mut contacts = Vec::new();
        let mut events = Vec::new();
        let mut ended = None;
        for index in 0..allowance {
            let step = start + index + 1;
            if attempt.is_some() {
                ended = self.operation_step(&mut events)?;
            } else {
                self.idle_step()?;
            }
            samples.push(self.sample(step)?);
            contacts.push(ContactObservation {
                step,
                pairs: self.engine.contact_pairs()?,
            });
            if ended.is_some() {
                break;
            }
        }
        let end = start + samples.len() - 1;
        let outcome = match &ended {
            None => None,
            Some(Ended::Completed) => {
                let distribution = self.water.distribution()?;
                let deviations = match &self.operation {
                    Operation::Running { controller, .. } => controller.deviations.clone(),
                    Operation::Idle => Vec::new(),
                };
                Some(Outcome::Completed {
                    measurements: distribution,
                    deviations,
                })
            }
            Some(Ended::Failed(reason)) => {
                events.push(Event::Failure { step: end });
                Some(Outcome::Failed {
                    reason: *reason,
                    disposition: self.disposition(),
                })
            }
        };
        if let (
            Some(last),
            Some(outcome),
            Operation::Running {
                controller,
                evidence,
                ..
            },
        ) = (samples.last_mut(), &outcome, &self.operation)
        {
            last.report = Some(report(controller, evidence, &self.water, outcome.clone()));
        }
        if let Some(result) = &ended {
            let held = match &self.operation {
                Operation::Running { controller, .. } => Servo {
                    angles: controller.angles,
                    fingers: controller.fingers,
                },
                Operation::Idle => self.servo.clone(),
            };
            self.servo = held;
            self.status = match result {
                Ended::Completed => Status::Brewed,
                Ended::Failed(_) => Status::Held,
            };
            self.operation = Operation::Idle;
        } else if let Operation::Running { sequence, .. } = &mut self.operation {
            *sequence += 1;
        }
        let (_, checkpoint) = self.seal()?;
        self.predecessor = checkpoint.digest.clone();
        let header = Header::new(
            "pour-over-physics-recording",
            &self.definition.cell_id,
            &self.definition.run_id,
            &self.definition.model_hash,
            before,
            checkpoint.digest.clone(),
        );
        let contacts = ContactCapture::Dense {
            observations: contacts,
        };
        Ok(match attempt {
            Some(attempt_id) => Reply::Advanced {
                stop: if ended.is_some() {
                    Stopped::Terminal
                } else {
                    Stopped::Allowance
                },
                segment: Digested::new(Segment {
                    header,
                    attempt_id,
                    sequence,
                    start_step: start,
                    end_step: end,
                    samples,
                    contacts,
                    events,
                })?,
                checkpoint,
                outcome,
                hold: (),
            },
            None => Reply::Rested {
                stop: Stopped::Idle,
                recording: Recording {
                    header,
                    motion: Motion::Idle {
                        start_step: start,
                        end_step: end,
                        sample_stride: 1,
                        samples,
                        contacts,
                    },
                },
                checkpoint,
                hold: (),
            },
        })
    }
}

/// The brew's measured results, recorded with its terminal sample.
fn report(controller: &Controller, evidence: &Evidence, water: &Water, outcome: Outcome) -> Report {
    let seconds = |step: usize| {
        controller
            .clock_zero
            .map(|zero| (step as f64 - zero as f64) * TIMESTEP)
    };
    let mut pours = Vec::new();
    for (index, record) in evidence.pours.iter().enumerate() {
        let measured = controller
            .pours
            .iter()
            .find(|pour| pour.index == record.index);
        let poured_after = evidence
            .pours
            .get(index + 1)
            .map_or(water.poured_kg, |next| next.poured_before_kg);
        let (spill_after, off_bed_after) = evidence
            .pours
            .get(index + 1)
            .map_or((water.spill_kg, water.off_bed_kg), |next| {
                (next.spill_before_kg, next.off_bed_before_kg)
            });
        pours.push(PourReport {
            pour: record.index + 1,
            target_g: POURS[record.index].1,
            scheduled_s: POURS[record.index].0,
            detected_s: measured.and_then(|pour| seconds(pour.detected)),
            final_g: measured.and_then(|pour| pour.final_g),
            top_ups: measured.map(|pour| pour.top_ups),
            flow_start_s: record.flow_start.and_then(seconds),
            flow_end_s: record.flow_end.and_then(seconds),
            duration_s: match (record.flow_start, record.flow_end) {
                (Some(start), Some(end)) => Some((end - start + 1) as f64 * TIMESTEP),
                _ => None,
            },
            delivered_g: (poured_after - record.poured_before_kg) * 1000.,
            max_landing_radius_m: record.max_landing_m,
            off_bed_g: (off_bed_after - record.off_bed_before_kg) * 1000.,
            spill_g: (spill_after - record.spill_before_kg) * 1000.,
        });
    }
    Report {
        pours,
        brew_s: controller.completed.and_then(seconds),
        pickup_step: evidence.pickup,
        fault_step: evidence.fault,
        deviations: controller.deviations.clone(),
        outcome,
    }
}

/// Model evidence for the pour the controller is in. It never feeds control.
fn record_evidence(
    evidence: &mut Evidence,
    controller: &Controller,
    water: &Water,
    placement: &Placement,
    step: usize,
) {
    let Phase::Pour { index, .. } = controller.phase else {
        return;
    };
    if evidence.pours.len() == index {
        evidence.pours.push(PourEvidence {
            index,
            flow_start: None,
            flow_end: None,
            poured_before_kg: water.poured_kg - water.flow_kg_s * TIMESTEP,
            off_bed_before_kg: water.off_bed_kg,
            spill_before_kg: water.spill_kg,
            max_landing_m: 0.,
            reported: false,
        });
    }
    let Some(record) = evidence.pours.get_mut(index) else {
        return;
    };
    if water.flow_kg_s > 0. {
        record.flow_start.get_or_insert(step);
        record.flow_end = Some(step);
    }
    if let Some(stream) = &water.stream {
        let radius = ((stream.landing[0] - placement.bed.x).powi(2)
            + (stream.landing[1] - placement.bed.y).powi(2))
        .sqrt();
        record.max_landing_m = record.max_landing_m.max(radius);
    }
}

#[derive(Default)]
pub struct Host {
    cells: BTreeMap<String, World>,
}

impl Host {
    pub fn handle(&mut self, assets: &Assets, command: Command) -> Result<Reply> {
        match command {
            Command::Open { cell, opening } => {
                ensure!(
                    !self.cells.contains_key(&cell),
                    "Pour-over cell already open"
                );
                let mut world = match opening {
                    Opening::Create { definition } => {
                        definition.validate(assets)?;
                        World::create(assets, definition)?
                    }
                    Opening::Restore {
                        content,
                        digest: expected,
                        sequence,
                    } => {
                        ensure!(
                            content.len() <= 64 * 1024 * 1024
                                && digest(content.as_bytes()) == expected,
                            "Pour-over checkpoint digest differs"
                        );
                        let saved: Saved = crate::checkpoint::read(
                            crate::checkpoint::Kind::PourOverCellCheckpoint,
                            content.as_bytes(),
                        )?;
                        match &saved.operation {
                            Operation::Running {
                                sequence: current, ..
                            } => ensure!(
                                *current == sequence,
                                "The checkpoint's next segment differs"
                            ),
                            Operation::Idle => {
                                ensure!(sequence == 0, "Idle pour-over checkpoint has no sequence")
                            }
                        }
                        World::restore(assets, saved, expected)?
                    }
                };
                ensure!(
                    world.definition.cell_id == cell,
                    "Pour-over definition names another cell"
                );
                let (_, checkpoint) = world.seal()?;
                world.predecessor = checkpoint.digest.clone();
                let operation = match &world.operation {
                    Operation::Idle => None,
                    Operation::Running {
                        attempt_id,
                        elapsed,
                        sequence,
                        ..
                    } => Some(Executing {
                        attempt_id: attempt_id.clone(),
                        step: *elapsed,
                        sequence: *sequence,
                    }),
                };
                self.cells.insert(cell, world);
                Ok(Reply::Opened {
                    checkpoint,
                    slot: no_carrier(),
                    operation,
                })
            }
            Command::Start {
                cell,
                attempt_id,
                task: Task::PourOverBrew,
            } => {
                let world = self
                    .cells
                    .get_mut(&cell)
                    .context("Unknown pour-over cell")?;
                ensure!(
                    matches!(world.operation, Operation::Idle),
                    "Pour-over cell is busy"
                );
                ensure!(
                    world.status == Status::Prepared,
                    "The station needs a new preparation before another brew"
                );
                ensure!(
                    !attempt_id.is_empty() && attempt_id.len() <= 128,
                    "Invalid pour-over attempt"
                );
                let tool = world.engine.site(StationSite::ToolGrasp);
                let controller = Controller::new(
                    Pose::new(tool.0, rotation_of(&tool.1)),
                    world.servo.angles,
                    world.engine.scale_load_kg(),
                );
                let coffee_g = world.definition.station.coffee_g;
                if let Some(grinder) = &mut world.grinder {
                    let before_grinder = grinder.snapshot();
                    let prepare_result = (|| -> Result<()> {
                        grinder.command(&Action::RemoveContents)?;
                        grinder.command(&Action::Reset)?;
                        grinder.command(&Action::SetContents {
                            contents: Contents::Loaded {
                                batch: Batch::coffee_dose(
                                    format!("{attempt_id}-beans"),
                                    f64::from(coffee_g),
                                    0.25,
                                ),
                            },
                        })?;
                        grinder.command(&Action::Start {
                            program: Program::Grind { duration_s: 6.75 },
                        })
                    })();
                    if let Err(error) = prepare_result {
                        *grinder = Lab::open(
                            assets.root(),
                            Initial::Continue {
                                checkpoint: Box::new(before_grinder),
                            },
                        )?;
                        return Err(error);
                    }
                }
                world.operation = Operation::Running {
                    attempt_id: attempt_id.clone(),
                    elapsed: 0,
                    sequence: 0,
                    controller: Box::new(controller),
                    evidence: Evidence {
                        pours: Vec::new(),
                        pickup: None,
                        fault: None,
                    },
                };
                Ok(Reply::Started {
                    attempt_id,
                    plan: PLAN,
                })
            }
            Command::Advance { cell, steps } => {
                let world = self
                    .cells
                    .get_mut(&cell)
                    .context("Unknown pour-over cell")?;
                let before = world.saved();
                let predecessor = world.predecessor.clone();
                match world.advance(steps) {
                    Ok(reply) => Ok(reply),
                    Err(error) => {
                        // A refused advance keeps the accepted state.
                        let restored = World::restore(assets, before, predecessor)?;
                        self.cells.insert(cell, restored);
                        Err(error)
                    }
                }
            }
            Command::Observe { cell } => {
                let world = self.cells.get(&cell).context("Unknown pour-over cell")?;
                let step = match &world.operation {
                    Operation::Idle => world.steps,
                    Operation::Running { elapsed, .. } => *elapsed,
                };
                Ok(Reply::Observed {
                    model_hash: world.definition.model_hash.clone(),
                    sample: world.sample(step)?,
                    grinder_sample: None,
                })
            }
            Command::Export { cell } => {
                let world = self.cells.get(&cell).context("Unknown pour-over cell")?;
                let (content, checkpoint) = world.seal()?;
                let sequence = match &world.operation {
                    Operation::Idle => 0,
                    Operation::Running { sequence, .. } => *sequence,
                };
                Ok(Reply::Exported {
                    content,
                    checkpoint,
                    sequence,
                })
            }
            Command::Dispose { cell } => {
                self.cells.remove(&cell).context("Unknown pour-over cell")?;
                Ok(Reply::Disposed)
            }
        }
    }
}

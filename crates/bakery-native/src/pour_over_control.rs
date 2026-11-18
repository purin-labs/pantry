//! The pour-over controller: kettle handling, a scale-fed pour regulator and
//! the Blue Bottle schedule. It sees what a robot cell could sense: arm and
//! tool poses, contacts, the scale reading and the declared drip detector.
//! It never reads the water model's kettle, stream or bed quantities.
use anyhow::{Result, bail, ensure};
use nalgebra::{UnitQuaternion, Vector3};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::f64::consts::PI;

pub type Point = Vector3<f64>;

/// Controller decisions run every fifth 2 ms step.
pub const CONTROL_STRIDE: usize = 5;
/// The published schedule, in seconds from the first pour: start, cumulative
/// water in grams and spiral laps outward (the same number return inward).
pub const POURS: [(f64, f64, u32); 4] = [
    (0., 50., 3),
    (40., 150., 5),
    (70., 250., 5),
    (100., 350., 5),
];
pub const POUR_SECONDS: f64 = 10.;
/// Declared acceptance tolerances. They are reported, never enforced by
/// changing later targets or the recipe clock.
pub const START_TOLERANCE_S: f64 = 1.;
pub const MASS_TOLERANCE_G: f64 = 1.;
pub const DURATION_TOLERANCE_S: f64 = 2.;
pub const BREW_WINDOW_S: (f64, f64) = (150., 210.);
/// Drainage that has not finished by then fails the brew.
pub const DRAINAGE_TIMEOUT_S: f64 = 330.;

const APPROACH_S: f64 = 2.;
const INSERT_S: f64 = 2.;
const GRASP_S: f64 = 1.;
const LIFT_S: f64 = 1.5;
const TRANSFER_S: f64 = 4.;
const RAISE_S: f64 = 1.;
const CARRY_S: f64 = 4.;
const LOWER_S: f64 = 2.;
const RELEASE_S: f64 = 1.;
const RETREAT_S: f64 = 2.;
const REST_S: f64 = 1.;
const PRE_GRASP_M: [f64; 3] = [-0.12, 0., 0.];
const LIFT_M: f64 = 0.06;
const RAISE_M: f64 = 0.03;
const PLACE_CLEARANCE_M: f64 = 0.001;
/// The outlet hovers this far above the bed surface.
const HOVER_M: f64 = 0.06;
pub const FINGER_OPEN_M: f64 = 0.016;
const FINGER_CLOSED_M: f64 = -0.009;
/// Grip loss: the kettle leaves its held pose for this long.
const GRIP_DRIFT_M: f64 = 0.015;
const GRIP_DRIFT_RAD: f64 = 10. * PI / 180.;
const LOST_GRIP_S: f64 = 0.06;
/// The landing spiral, measured from the dripper axis on the bed surface.
const SPIRAL_MIN_M: f64 = 0.003;
const SPIRAL_MAX_M: f64 = 0.024;
const REGULATE_S: f64 = 8.6;
/// Scale instrument: a calibrated platen offset, a first-order filter and
/// a 0.1 g display. Stability is a 0.5 s spread of at most 0.2 g.
const PLATEN_KG: f64 = 0.35;
const SCALE_FILTER_S: f64 = 0.08;
const SCALE_RESOLUTION_G: f64 = 0.1;
const STABLE_TICKS: usize = 50;
const STABLE_SPREAD_G: f64 = 0.2;
const FLOW_TICKS: usize = 30;
const DETECT_G: f64 = 0.4;
/// Pour regulation in degrees and grams.
const FLOW_GAIN_DEG_PER_G: f64 = 2.;
const MAX_TILT_RATE_DEG_S: f64 = 15.;
const CUT_RATE_DEG_S: f64 = 40.;
const PRETILT_RATE_DEG_S: f64 = 20.;
const FIRST_APPROACH_DEG_S: f64 = 10.;
const APPROACH_DEG_S: f64 = 8.;
const TOP_UP_DEG_S: f64 = 4.;
const FIRST_PRETILT_DEG: f64 = 2.;
const MAX_TILT_DEG: f64 = 60.;
const MARGIN_G: f64 = 0.3;
const TOP_UP_BELOW_G: f64 = 0.45;
const TOP_UP_MARGIN_G: f64 = 0.15;
const TOP_UP_LAG_S: f64 = 0.35;
const MAX_TOP_UPS: u32 = 3;
const INITIAL_STOP_LAG_S: f64 = 0.2;
const MIN_WANTED_G_S: f64 = 1.5;
/// The controller's tool model of the spout, used only to aim the stream.
const SPOUT_DISCHARGE_KG_S_PER_SQRT_M: f64 = 1000. * 0.62 * PI * 0.003 * 0.003;
const SPOUT_VELOCITY_COEFFICIENT: f64 = 0.95;
const GRAVITY: f64 = 9.81;

fn steps(seconds: f64, dt: f64) -> usize {
    (seconds / dt).round() as usize
}

fn radians(degrees: f64) -> f64 {
    degrees * PI / 180.
}

/// A tool-site pose in world coordinates.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Pose {
    pub position: [f64; 3],
    /// WXYZ.
    pub rotation: [f64; 4],
}

impl Pose {
    pub fn new(position: Point, rotation: UnitQuaternion<f64>) -> Self {
        let q = rotation.quaternion();
        Self {
            position: position.into(),
            rotation: [q.w, q.i, q.j, q.k],
        }
    }
    pub fn point(&self) -> Point {
        Point::from(self.position)
    }
    pub fn orientation(&self) -> UnitQuaternion<f64> {
        let [w, x, y, z] = self.rotation;
        UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(w, x, y, z))
    }
    /// The quintic blend between two poses at `fraction`.
    fn blend(&self, to: &Pose, fraction: f64) -> Pose {
        let blend = fraction.powi(3) * (10. - 15. * fraction + 6. * fraction * fraction);
        Pose::new(
            self.point() + (to.point() - self.point()) * blend,
            self.orientation().slerp(&to.orientation(), blend),
        )
    }
    pub fn rows(&self) -> [f64; 9] {
        let matrix = self.orientation().to_rotation_matrix().into_inner();
        let mut rows = [0.; 9];
        for row in 0..3 {
            for column in 0..3 {
                rows[row * 3 + column] = matrix[(row, column)];
            }
        }
        rows
    }
    fn valid(&self) -> bool {
        self.position
            .iter()
            .chain(&self.rotation)
            .all(|v| v.is_finite())
            && (self.rotation.iter().map(|v| v * v).sum::<f64>() - 1.).abs() < 1e-6
    }
}

/// The station as the model places it when the world is created.
#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    pub handle: Point,
    pub kettle: Pose,
    pub bed: Point,
    /// The outlet and its jet axis in the kettle frame.
    pub outlet: Point,
    pub outlet_axis: Point,
}

impl Layout {
    fn grasp(&self) -> Pose {
        Pose::new(self.handle, UnitQuaternion::identity())
    }
    fn pre_grasp(&self) -> Pose {
        Pose::new(
            self.handle + Point::from(PRE_GRASP_M),
            UnitQuaternion::identity(),
        )
    }
    fn lifted(&self) -> Pose {
        Pose::new(
            self.handle + Point::new(0., 0., LIFT_M),
            UnitQuaternion::identity(),
        )
    }
}

/// The kettle as the closed fingers hold it, in the tool frame. It is
/// measured once, after the lift, and used to aim the spout.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Grip {
    pub offset: [f64; 3],
    /// WXYZ, kettle relative to tool.
    pub rotation: [f64; 4],
}

impl Grip {
    fn measure(tool: &Pose, kettle: &Pose) -> Self {
        let inverse = tool.orientation().inverse();
        let relative = inverse * kettle.orientation();
        let q = relative.quaternion();
        Self {
            offset: (inverse * (kettle.point() - tool.point())).into(),
            rotation: [q.w, q.i, q.j, q.k],
        }
    }
    fn orientation(&self) -> UnitQuaternion<f64> {
        let [w, x, y, z] = self.rotation;
        UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(w, x, y, z))
    }
    /// How far the held kettle moved from this grip, linearly and angularly.
    fn drift(&self, tool: &Pose, kettle: &Pose) -> (f64, f64) {
        let actual = Grip::measure(tool, kettle);
        (
            (Point::from(actual.offset) - Point::from(self.offset)).norm(),
            self.orientation().angle_to(&actual.orientation()),
        )
    }
}

/// The scale as an instrument: what it displays and whether it settled.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Scale {
    pub filtered_kg: f64,
    pub tare_kg: Option<f64>,
    pub reading_g: f64,
    /// Displayed readings at controller ticks, newest last.
    pub history: VecDeque<f64>,
}

impl Scale {
    pub fn new(load_kg: f64) -> Self {
        Self {
            filtered_kg: load_kg - PLATEN_KG,
            tare_kg: None,
            reading_g: 0.,
            history: VecDeque::new(),
        }
    }
    /// Filters the supported load at every solver step.
    pub fn sense(&mut self, load_kg: f64, dt: f64) {
        self.filtered_kg +=
            (load_kg - PLATEN_KG - self.filtered_kg) * -(-dt / SCALE_FILTER_S).exp_m1();
        let net = (self.filtered_kg - self.tare_kg.unwrap_or(0.)) * 1000.;
        self.reading_g = (net / SCALE_RESOLUTION_G).round() * SCALE_RESOLUTION_G;
    }
    fn tick(&mut self) {
        self.history.push_back(self.reading_g);
        while self.history.len() > STABLE_TICKS.max(FLOW_TICKS) {
            self.history.pop_front();
        }
    }
    pub fn stable(&self) -> bool {
        if self.history.len() < STABLE_TICKS {
            return false;
        }
        let window = self.history.iter().rev().take(STABLE_TICKS);
        let (low, high) = window.fold((f64::INFINITY, f64::NEG_INFINITY), |(low, high), v| {
            (low.min(*v), high.max(*v))
        });
        high - low <= STABLE_SPREAD_G + 1e-9
    }
    /// The least-squares slope of recent readings, in g/s.
    fn flow_g_s(&self, dt: f64) -> f64 {
        let count = self.history.len().min(FLOW_TICKS);
        if count < 3 {
            return 0.;
        }
        let interval = dt * CONTROL_STRIDE as f64;
        let start = self.history.len() - count;
        let mean_t = (count - 1) as f64 / 2.;
        let mean_y: f64 = self.history.iter().skip(start).sum::<f64>() / count as f64;
        let mut numerator = 0.;
        let mut denominator = 0.;
        for (index, value) in self.history.iter().skip(start).enumerate() {
            let t = index as f64 - mean_t;
            numerator += t * (value - mean_y);
            denominator += t * t;
        }
        numerator / denominator / interval
    }
    fn valid(&self) -> bool {
        self.filtered_kg.is_finite()
            && self.reading_g.is_finite()
            && self.tare_kg.is_none_or(f64::is_finite)
            && self.history.len() <= STABLE_TICKS.max(FLOW_TICKS)
            && self.history.iter().all(|v| v.is_finite())
    }
}

/// A recipe or process result outside its declared tolerance. The brew keeps
/// its actual result; later targets and the recipe clock are unchanged.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Deviation {
    PourStart { pour: usize, offset_s: f64 },
    PourMass { pour: usize, error_g: f64 },
    PourDuration { pour: usize, seconds: f64 },
    BrewTime { seconds: f64 },
    KettleExhausted { pour: usize },
}

/// One pour as the controller measured it on the scale.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PourRecord {
    pub index: usize,
    pub target_g: f64,
    /// The scale first rose, in operation steps.
    pub detected: usize,
    pub cut_reading_g: Option<f64>,
    pub cut_flow_g_s: Option<f64>,
    pub settled_g: Option<f64>,
    pub final_g: Option<f64>,
    pub top_ups: u32,
    pub ended: Option<usize>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Leg {
    Raise,
    Carry,
    Lower,
    Release,
    Retreat,
    Settle,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Stage {
    /// Before the pour's start: from the held pose to the first aim, tilted `to`.
    Pretilt {
        from: Pose,
        to: f64,
        step: usize,
    },
    /// Tilting at a slow rate until the scale rises.
    Approach {
        tilt: f64,
    },
    Regulate {
        tilt: f64,
    },
    CutOff {
        tilt: f64,
    },
    Settle {
        tilt: f64,
        since: usize,
    },
    TopUp {
        tilt: f64,
    },
    /// Returning upright after the pour's final reading.
    Upright {
        from: f64,
        step: usize,
    },
}

/// Operation progress with each branch's own data.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Phase {
    Approach {
        from: Pose,
        step: usize,
    },
    Insert {
        step: usize,
    },
    Grasp {
        step: usize,
    },
    Lift {
        step: usize,
    },
    Transfer {
        step: usize,
        to: Pose,
    },
    Tare {
        step: usize,
    },
    Pour {
        index: usize,
        stage: Stage,
    },
    /// Returning to the upright hover above the bed, then holding it until
    /// the next pour's pretilt.
    Rest {
        index: usize,
        from: Pose,
        step: usize,
    },
    Return {
        leg: Leg,
        from: Pose,
        step: usize,
    },
    Drain,
}

impl Phase {
    pub fn label(&self) -> String {
        match self {
            Self::Approach { .. } => "approach".into(),
            Self::Insert { .. } => "insert".into(),
            Self::Grasp { .. } => "grasp".into(),
            Self::Lift { .. } => "lift".into(),
            Self::Transfer { .. } => "transfer".into(),
            Self::Tare { .. } => "tare".into(),
            Self::Pour { index, .. } => format!("pour-{}", index + 1),
            Self::Rest { index, .. } => format!("rest-{}", index),
            Self::Return { leg, .. } => format!(
                "return-{}",
                match leg {
                    Leg::Raise => "raise",
                    Leg::Carry => "carry",
                    Leg::Lower => "lower",
                    Leg::Release => "release",
                    Leg::Retreat => "retreat",
                    Leg::Settle => "settle",
                }
            ),
            Self::Drain => "drainage".into(),
        }
    }
}

/// What the cell senses after a solver step.
pub struct Sensed {
    pub step: usize,
    pub tool: Pose,
    pub kettle: Pose,
    pub pads_hold_handle: bool,
    pub kettle_on_stand: bool,
    pub kettle_speed: f64,
    pub arm_speed: f64,
    /// The declared drip detector: free water above the bed is at most 1 g.
    pub drained: bool,
}

/// Why an operation failed.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Failure {
    LostGrasp,
    Collision,
    Unreachable,
    PlacementFailed,
    DrainageTimeout,
}

/// The controller's decision for the next solver step.
pub enum Decision {
    Continue,
    /// The phase changed; the label names the new phase.
    Phase(String),
    Completed,
    Failed(Failure),
}

/// Complete controller state between any two solver steps.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Controller {
    pub phase: Phase,
    pub target: Pose,
    pub angles: [f64; 6],
    pub fingers: f64,
    pub carrying: bool,
    pub grip: Option<Grip>,
    pub scale: Scale,
    /// The recipe clock's zero: the step at which the scale first rose.
    pub clock_zero: Option<usize>,
    pub pours: Vec<PourRecord>,
    pub onset: Option<f64>,
    pub stop_lag_s: f64,
    pub flow_g_s: f64,
    pub lost_steps: usize,
    pub deviations: Vec<Deviation>,
    pub completed: Option<usize>,
}

impl Controller {
    pub fn new(tool: Pose, angles: [f64; 6], load_kg: f64) -> Self {
        Self {
            phase: Phase::Approach {
                from: tool,
                step: 0,
            },
            target: tool,
            angles,
            fingers: FINGER_OPEN_M,
            carrying: false,
            grip: None,
            scale: Scale::new(load_kg),
            clock_zero: None,
            pours: Vec::new(),
            onset: None,
            stop_lag_s: INITIAL_STOP_LAG_S,
            flow_g_s: 0.,
            lost_steps: 0,
            deviations: Vec::new(),
            completed: None,
        }
    }

    pub fn validate(&self, limits: &[(f64, f64); 6]) -> Result<()> {
        ensure!(
            self.target.valid()
                && self.scale.valid()
                && self.fingers.is_finite()
                && self.stop_lag_s.is_finite()
                && self.flow_g_s.is_finite()
                && self.onset.is_none_or(f64::is_finite)
                && self.pours.len() <= POURS.len()
                && self.deviations.len() <= 32,
            "Invalid pour-over controller state"
        );
        for (angle, (lower, upper)) in self.angles.iter().zip(limits) {
            ensure!(
                angle.is_finite() && angle >= lower && angle <= upper,
                "Invalid pour-over servo target"
            );
        }
        if let Phase::Pour { index, .. } | Phase::Rest { index, .. } = &self.phase {
            ensure!(*index < POURS.len(), "Invalid pour index");
        }
        Ok(())
    }

    pub fn brew_seconds(&self, step: usize, dt: f64) -> Option<f64> {
        self.clock_zero
            .map(|zero| step.saturating_sub(zero) as f64 * dt)
    }

    pub fn next_target_g(&self) -> Option<f64> {
        match &self.phase {
            Phase::Pour { index, .. } | Phase::Rest { index, .. } => Some(POURS[*index].1),
            Phase::Tare { .. } => Some(POURS[0].1),
            _ => None,
        }
    }

    pub fn stage_label(&self) -> Option<&'static str> {
        match &self.phase {
            Phase::Pour { stage, .. } => Some(match stage {
                Stage::Pretilt { .. } => "pretilt",
                Stage::Approach { .. } => "approach",
                Stage::Regulate { .. } => "regulate",
                Stage::CutOff { .. } => "cut-off",
                Stage::Settle { .. } => "settle",
                Stage::TopUp { .. } => "top-up",
                Stage::Upright { .. } => "upright",
            }),
            _ => None,
        }
    }

    /// The tool pose that places the outlet at `outlet` with the kettle
    /// tilted `tilt` about the tool's X axis, spout down.
    fn pose_for_outlet(&self, layout: &Layout, outlet: Point, tilt: f64) -> Result<Pose> {
        let Some(grip) = &self.grip else {
            bail!("A pour requires a measured grip");
        };
        let tool = UnitQuaternion::from_axis_angle(&Vector3::x_axis(), -tilt);
        let kettle = tool * grip.orientation();
        let kettle_origin = outlet - kettle * layout.outlet;
        Ok(Pose::new(
            kettle_origin - tool * Point::from(grip.offset),
            tool,
        ))
    }

    /// Where the outlet must be so the predicted stream lands on the spiral.
    fn aim(
        &self,
        layout: &Layout,
        laps: u32,
        seconds: f64,
        tilt: f64,
        flow_g_s: f64,
    ) -> Result<Point> {
        let Some(grip) = &self.grip else {
            bail!("A pour requires a measured grip");
        };
        let tool = UnitQuaternion::from_axis_angle(&Vector3::x_axis(), -tilt);
        let axis = tool * grip.orientation() * layout.outlet_axis;
        let flow = (flow_g_s / 1000.).max(0.);
        let head = (flow / SPOUT_DISCHARGE_KG_S_PER_SQRT_M).powi(2) / (2. * GRAVITY);
        let velocity =
            axis.normalize() * (SPOUT_VELOCITY_COEFFICIENT * (2. * GRAVITY * head).sqrt());
        let drop = HOVER_M;
        let flight =
            (velocity.z + (velocity.z * velocity.z + 2. * GRAVITY * drop).sqrt()) / GRAVITY;
        let landing = Self::spiral(layout, laps, seconds, flight);
        Ok(Point::new(
            landing.x - velocity.x * flight,
            landing.y - velocity.y * flight,
            layout.bed.z + HOVER_M,
        ))
    }

    /// The outlet's spiral offset `seconds` into a pour of `laps` each way,
    /// leading by `flight` so the moving outlet's stream lands on the spiral.
    fn spiral(layout: &Layout, laps: u32, seconds: f64, flight: f64) -> Point {
        let laps = f64::from(laps);
        let turns = (2. * laps) * (seconds / REGULATE_S).max(0.);
        let progress = (turns / (2. * laps)).min(1.);
        let shape = 1. - (2. * progress - 1.).abs();
        let radius = SPIRAL_MIN_M + (SPIRAL_MAX_M - SPIRAL_MIN_M) * shape;
        let angle = 2. * PI * turns;
        let ramp = (seconds / 0.2).clamp(0., 1.) * ((REGULATE_S - seconds) / 0.2).clamp(0., 1.);
        let lead = ramp * (2. * PI * (2. * laps) / REGULATE_S) * flight;
        let radial = Point::new(angle.cos(), angle.sin(), 0.);
        let tangent = Point::new(-angle.sin(), angle.cos(), 0.);
        layout.bed + (radial - tangent * lead) * (radius / (1. + lead * lead))
    }

    /// The pour pose at `tilt`. Before the scale detects flow, the outlet
    /// stands above the spiral's start; then the aim follows measured flow.
    fn pour_pose(
        &self,
        layout: &Layout,
        index: usize,
        step: usize,
        tilt: f64,
        dt: f64,
    ) -> Result<Pose> {
        let (seconds, flow) = match self.pours.get(index) {
            Some(record) if record.index == index => {
                ((step - record.detected) as f64 * dt, self.flow_g_s.max(0.))
            }
            _ => (0., 0.),
        };
        let outlet = self.aim(layout, POURS[index].2, seconds, tilt, flow)?;
        self.pose_for_outlet(layout, outlet, tilt)
    }

    fn hover(&self, layout: &Layout) -> Result<Pose> {
        self.pose_for_outlet(layout, layout.bed + Point::new(0., 0., HOVER_M), 0.)
    }

    /// The tool pose that sets the kettle back where it was taken, just
    /// above its stand, using the measured grip.
    fn placed(&self, layout: &Layout, clearance: f64) -> Result<Pose> {
        let Some(grip) = &self.grip else {
            bail!("A return requires a measured grip");
        };
        let tool = layout.kettle.orientation() * grip.orientation().inverse();
        let origin = layout.kettle.point() + Point::new(0., 0., clearance);
        Ok(Pose::new(origin - tool * Point::from(grip.offset), tool))
    }

    /// The tool pose this step should hold, before the solver step.
    pub fn target_for(&self, layout: &Layout, step: usize, dt: f64) -> Result<Pose> {
        let fraction = |from: usize, seconds: f64| {
            ((step - from) as f64 / steps(seconds, dt) as f64).clamp(0., 1.)
        };
        Ok(match &self.phase {
            Phase::Approach { from, step: start } => {
                from.blend(&layout.pre_grasp(), fraction(*start, APPROACH_S))
            }
            Phase::Insert { step: start } => layout
                .pre_grasp()
                .blend(&layout.grasp(), fraction(*start, INSERT_S)),
            Phase::Grasp { .. } => layout.grasp(),
            Phase::Lift { step: start } => layout
                .grasp()
                .blend(&layout.lifted(), fraction(*start, LIFT_S)),
            Phase::Transfer { step: start, to } => {
                layout.lifted().blend(to, fraction(*start, TRANSFER_S))
            }
            Phase::Tare { .. } => self.hover(layout)?,
            Phase::Rest {
                from, step: start, ..
            } => from.blend(&self.hover(layout)?, fraction(*start, REST_S)),
            Phase::Pour {
                index,
                stage:
                    Stage::Pretilt {
                        from,
                        to,
                        step: start,
                    },
            } => {
                let span = to.abs() / radians(PRETILT_RATE_DEG_S);
                from.blend(
                    &self.pour_pose(layout, *index, step, *to, dt)?,
                    fraction(*start, span.max(REST_S)),
                )
            }
            Phase::Pour { index, stage } => {
                let tilt = match stage {
                    Stage::Pretilt { to, .. } => *to,
                    Stage::Upright { from, step: start } => {
                        let span = from.abs() / radians(PRETILT_RATE_DEG_S);
                        from * (1. - fraction(*start, span.max(dt)))
                    }
                    Stage::Approach { tilt }
                    | Stage::Regulate { tilt }
                    | Stage::CutOff { tilt }
                    | Stage::Settle { tilt, .. }
                    | Stage::TopUp { tilt } => *tilt,
                };
                self.pour_pose(layout, *index, step, tilt, dt)?
            }
            Phase::Return {
                leg,
                from,
                step: start,
            } => {
                let (to, seconds) = match leg {
                    Leg::Raise => (
                        Pose::new(
                            from.point() + Point::new(0., 0., RAISE_M),
                            from.orientation(),
                        ),
                        RAISE_S,
                    ),
                    Leg::Carry => (self.placed(layout, LIFT_M)?, CARRY_S),
                    Leg::Lower => (self.placed(layout, PLACE_CLEARANCE_M)?, LOWER_S),
                    Leg::Release => (*from, RELEASE_S),
                    Leg::Retreat => (
                        Pose::new(
                            from.point() + from.orientation() * Point::from(PRE_GRASP_M),
                            from.orientation(),
                        ),
                        RETREAT_S,
                    ),
                    Leg::Settle => (*from, REST_S),
                };
                from.blend(&to, fraction(*start, seconds))
            }
            Phase::Drain => self.target,
        })
    }

    /// The finger command for this step.
    pub fn fingers_for(&self, step: usize, dt: f64) -> f64 {
        let fraction = |from: usize, seconds: f64| {
            let f = ((step - from) as f64 / steps(seconds, dt) as f64).clamp(0., 1.);
            f.powi(3) * (10. - 15. * f + 6. * f * f)
        };
        match &self.phase {
            Phase::Approach { .. } | Phase::Insert { .. } => FINGER_OPEN_M,
            Phase::Grasp { step: start } => {
                FINGER_OPEN_M + (FINGER_CLOSED_M - FINGER_OPEN_M) * fraction(*start, GRASP_S)
            }
            Phase::Return {
                leg: Leg::Release,
                step: start,
                ..
            } => FINGER_CLOSED_M + (FINGER_OPEN_M - FINGER_CLOSED_M) * fraction(*start, RELEASE_S),
            Phase::Return {
                leg: Leg::Retreat | Leg::Settle,
                ..
            }
            | Phase::Drain => FINGER_OPEN_M,
            _ => FINGER_CLOSED_M,
        }
    }

    pub fn carrying_for(&self) -> bool {
        !matches!(
            self.phase,
            Phase::Approach { .. }
                | Phase::Insert { .. }
                | Phase::Grasp { .. }
                | Phase::Return {
                    leg: Leg::Release | Leg::Retreat | Leg::Settle,
                    ..
                }
                | Phase::Drain
        )
    }

    /// The scale instrument at every solver step.
    pub fn sense_scale(&mut self, load_kg: f64, dt: f64) {
        self.scale.sense(load_kg, dt);
    }

    fn deviation(&mut self, deviation: Deviation) {
        if self.deviations.len() < 32 {
            self.deviations.push(deviation);
        }
    }

    fn previous_target(index: usize) -> f64 {
        if index == 0 { 0. } else { POURS[index - 1].1 }
    }

    /// Advances the decision state after a solver step. Called at every
    /// step; pour decisions run at controller ticks.
    pub fn after_step(&mut self, layout: &Layout, sensed: &Sensed, dt: f64) -> Result<Decision> {
        let step = sensed.step;
        let tick = step.is_multiple_of(CONTROL_STRIDE);
        if tick {
            self.scale.tick();
            self.flow_g_s = self.scale.flow_g_s(dt);
        }
        // Grip supervision while the kettle is held off its stand.
        if self.carrying && !matches!(self.phase, Phase::Lift { .. }) {
            let held = match &self.grip {
                Some(grip) => {
                    let (linear, angular) = grip.drift(&sensed.tool, &sensed.kettle);
                    sensed.pads_hold_handle && linear < GRIP_DRIFT_M && angular < GRIP_DRIFT_RAD
                }
                None => sensed.pads_hold_handle,
            };
            self.lost_steps = if held { 0 } else { self.lost_steps + 1 };
            if self.lost_steps as f64 * dt >= LOST_GRIP_S {
                return Ok(Decision::Failed(Failure::LostGrasp));
            }
        }
        if let Some(zero) = self.clock_zero
            && !matches!(self.phase, Phase::Drain | Phase::Return { .. })
            && (step - zero) as f64 * dt > DRAINAGE_TIMEOUT_S
        {
            return Ok(Decision::Failed(Failure::DrainageTimeout));
        }
        let elapsed = |from: usize| (step - from) as f64 * dt;
        let phase = self.phase.clone();
        let next = match phase {
            Phase::Approach { step: start, .. } if elapsed(start) >= APPROACH_S => {
                Some(Phase::Insert { step })
            }
            Phase::Insert { step: start } if elapsed(start) >= INSERT_S => {
                Some(Phase::Grasp { step })
            }
            Phase::Grasp { step: start } if elapsed(start) >= GRASP_S => {
                if !sensed.pads_hold_handle {
                    return Ok(Decision::Failed(Failure::LostGrasp));
                }
                Some(Phase::Lift { step })
            }
            Phase::Lift { step: start } if elapsed(start) >= LIFT_S => {
                if sensed.kettle_on_stand || !sensed.pads_hold_handle {
                    return Ok(Decision::Failed(Failure::LostGrasp));
                }
                self.grip = Some(Grip::measure(&sensed.tool, &sensed.kettle));
                let to = self.hover(layout)?;
                Some(Phase::Transfer { step, to })
            }
            Phase::Transfer { step: start, .. } if elapsed(start) >= TRANSFER_S => {
                Some(Phase::Tare { step })
            }
            Phase::Tare { step: start } if tick && elapsed(start) >= 1. && self.scale.stable() => {
                self.scale.tare_kg = Some(self.scale.filtered_kg);
                self.scale.reading_g = 0.;
                self.scale.history.clear();
                Some(Phase::Pour {
                    index: 0,
                    stage: Stage::Pretilt {
                        from: self.target,
                        to: radians(FIRST_PRETILT_DEG),
                        step,
                    },
                })
            }
            Phase::Rest { index, .. } => {
                let zero = self.clock_zero.unwrap_or(step);
                let to = (self.onset.unwrap_or(radians(FIRST_PRETILT_DEG)) - radians(1.)).max(0.);
                let span = (to / radians(PRETILT_RATE_DEG_S)).max(REST_S);
                if tick && elapsed(zero) >= POURS[index].0 - 0.6 - span - 0.2 {
                    Some(Phase::Pour {
                        index,
                        stage: Stage::Pretilt {
                            from: self.target,
                            to,
                            step,
                        },
                    })
                } else {
                    None
                }
            }
            Phase::Pour { index, stage } if tick => self.pour(layout, sensed, dt, index, stage)?,
            Phase::Return {
                leg, step: start, ..
            } => {
                let seconds = match leg {
                    Leg::Raise => RAISE_S,
                    Leg::Carry => CARRY_S,
                    Leg::Lower => LOWER_S,
                    Leg::Release => RELEASE_S,
                    Leg::Retreat => RETREAT_S,
                    Leg::Settle => REST_S,
                };
                if elapsed(start) < seconds {
                    None
                } else {
                    let from = self.target;
                    match leg {
                        Leg::Raise => Some(Phase::Return {
                            leg: Leg::Carry,
                            from,
                            step,
                        }),
                        Leg::Carry => Some(Phase::Return {
                            leg: Leg::Lower,
                            from,
                            step,
                        }),
                        // The kettle is set down 1 mm above its stand and drops
                        // onto it as the fingers open; the settle leg checks it.
                        Leg::Lower => Some(Phase::Return {
                            leg: Leg::Release,
                            from,
                            step,
                        }),
                        Leg::Release => Some(Phase::Return {
                            leg: Leg::Retreat,
                            from,
                            step,
                        }),
                        Leg::Retreat => Some(Phase::Return {
                            leg: Leg::Settle,
                            from,
                            step,
                        }),
                        Leg::Settle => {
                            if !sensed.kettle_on_stand
                                || sensed.pads_hold_handle
                                || sensed.kettle_speed > 1e-3
                            {
                                return Ok(Decision::Failed(Failure::PlacementFailed));
                            }
                            Some(Phase::Drain)
                        }
                    }
                }
            }
            Phase::Drain if tick => {
                let zero = self.clock_zero.unwrap_or(step);
                let seconds = elapsed(zero);
                if sensed.drained && sensed.kettle_on_stand && sensed.arm_speed < 0.01 {
                    if seconds < BREW_WINDOW_S.0 || seconds > BREW_WINDOW_S.1 {
                        self.deviation(Deviation::BrewTime { seconds });
                    }
                    self.completed = Some(step);
                    return Ok(Decision::Completed);
                }
                if seconds > DRAINAGE_TIMEOUT_S {
                    return Ok(Decision::Failed(Failure::DrainageTimeout));
                }
                None
            }
            _ => None,
        };
        let Some(next) = next else {
            return Ok(Decision::Continue);
        };
        let changed = next.label() != self.phase.label();
        self.phase = next;
        self.carrying = self.carrying_for();
        Ok(if changed {
            Decision::Phase(self.phase.label())
        } else {
            Decision::Continue
        })
    }

    /// One controller tick of a pour.
    fn pour(
        &mut self,
        _layout: &Layout,
        sensed: &Sensed,
        dt: f64,
        index: usize,
        stage: Stage,
    ) -> Result<Option<Phase>> {
        let step = sensed.step;
        let tick_s = dt * CONTROL_STRIDE as f64;
        let target_g = POURS[index].1;
        let reading = self.scale.reading_g;
        let flow = self.flow_g_s;
        let max_tilt = radians(MAX_TILT_DEG);
        let pour = |stage| Some(Phase::Pour { index, stage });
        Ok(match stage {
            Stage::Pretilt {
                to, step: start, ..
            } => {
                let span = (to / radians(PRETILT_RATE_DEG_S)).max(REST_S);
                let due = match self.clock_zero {
                    None => true,
                    Some(zero) => (step - zero) as f64 * dt >= POURS[index].0 - 0.6,
                };
                if (step - start) as f64 * dt >= span && due {
                    pour(Stage::Approach { tilt: to })
                } else {
                    None
                }
            }
            Stage::Approach { tilt } => {
                if reading >= Self::previous_target(index) + DETECT_G {
                    let zero = *self.clock_zero.get_or_insert(step);
                    let offset = (step - zero) as f64 * dt - POURS[index].0;
                    if offset.abs() > START_TOLERANCE_S {
                        self.deviation(Deviation::PourStart {
                            pour: index,
                            offset_s: offset,
                        });
                    }
                    self.onset = Some(tilt - radians(1.5));
                    self.pours.push(PourRecord {
                        index,
                        target_g,
                        detected: step,
                        cut_reading_g: None,
                        cut_flow_g_s: None,
                        settled_g: None,
                        final_g: None,
                        top_ups: 0,
                        ended: None,
                    });
                    pour(Stage::Regulate { tilt })
                } else if tilt >= max_tilt {
                    self.deviation(Deviation::KettleExhausted { pour: index });
                    self.end_pour(index, step, reading)
                } else {
                    let rate = if self.clock_zero.is_none() {
                        FIRST_APPROACH_DEG_S
                    } else {
                        APPROACH_DEG_S
                    };
                    pour(Stage::Approach {
                        tilt: (tilt + radians(rate) * tick_s).min(max_tilt),
                    })
                }
            }
            Stage::Regulate { tilt } => {
                let detected = self.pours.last().map_or(step, |record| record.detected);
                let remaining = ((detected as f64 * dt + REGULATE_S) - step as f64 * dt).max(0.8);
                let landing = reading + flow * self.stop_lag_s;
                if landing >= target_g - MARGIN_G {
                    if let Some(record) = self.pours.last_mut() {
                        record.cut_reading_g = Some(reading);
                        record.cut_flow_g_s = Some(flow);
                    }
                    pour(Stage::CutOff { tilt })
                } else if tilt >= max_tilt && flow < MIN_WANTED_G_S / 2. {
                    self.deviation(Deviation::KettleExhausted { pour: index });
                    pour(Stage::CutOff { tilt })
                } else {
                    let wanted = ((target_g - MARGIN_G - landing) / remaining).max(MIN_WANTED_G_S);
                    let rate = (FLOW_GAIN_DEG_PER_G * (wanted - flow))
                        .clamp(-MAX_TILT_RATE_DEG_S, MAX_TILT_RATE_DEG_S);
                    pour(Stage::Regulate {
                        tilt: (tilt + radians(rate) * tick_s).clamp(0., max_tilt),
                    })
                }
            }
            Stage::CutOff { tilt } => {
                let stop = self.onset.unwrap_or(0.) - radians(3.);
                let next = tilt - radians(CUT_RATE_DEG_S) * tick_s;
                if next <= stop.max(0.) {
                    pour(Stage::Settle {
                        tilt: stop.max(0.),
                        since: step,
                    })
                } else {
                    pour(Stage::CutOff { tilt: next })
                }
            }
            Stage::Settle { tilt, since } => {
                if (step - since) as f64 * dt < 0.6 || !self.scale.stable() {
                    return Ok(None);
                }
                let first = self
                    .pours
                    .last()
                    .is_some_and(|record| record.settled_g.is_none());
                if first && let Some(record) = self.pours.last_mut() {
                    record.settled_g = Some(reading);
                    if let (Some(cut), Some(cut_flow)) = (record.cut_reading_g, record.cut_flow_g_s)
                        && cut_flow > 0.5
                    {
                        self.stop_lag_s = ((reading - cut) / cut_flow).clamp(0.05, 0.6);
                    }
                }
                let top_ups = self.pours.last().map_or(0, |record| record.top_ups);
                if reading < target_g - TOP_UP_BELOW_G && top_ups < MAX_TOP_UPS && tilt < max_tilt {
                    if let Some(record) = self.pours.last_mut() {
                        record.top_ups += 1;
                    }
                    pour(Stage::TopUp {
                        tilt: self.onset.unwrap_or(tilt).max(tilt),
                    })
                } else {
                    self.end_pour(index, step, reading)
                }
            }
            Stage::TopUp { tilt } => {
                if reading + flow * TOP_UP_LAG_S >= target_g - TOP_UP_MARGIN_G {
                    pour(Stage::CutOff { tilt })
                } else if tilt >= max_tilt {
                    self.deviation(Deviation::KettleExhausted { pour: index });
                    pour(Stage::CutOff { tilt })
                } else {
                    pour(Stage::TopUp {
                        tilt: (tilt + radians(TOP_UP_DEG_S) * tick_s).min(max_tilt),
                    })
                }
            }
            Stage::Upright { from, step: start } => {
                let span = from.abs() / radians(PRETILT_RATE_DEG_S);
                if (step - start) as f64 * dt < span {
                    None
                } else if index + 1 < POURS.len() {
                    Some(Phase::Rest {
                        index: index + 1,
                        from: self.target,
                        step,
                    })
                } else {
                    Some(Phase::Return {
                        leg: Leg::Raise,
                        from: self.target,
                        step,
                    })
                }
            }
        })
    }

    fn end_pour(&mut self, index: usize, step: usize, reading: f64) -> Option<Phase> {
        let target = POURS[index].1;
        if (reading - target).abs() > MASS_TOLERANCE_G {
            self.deviation(Deviation::PourMass {
                pour: index,
                error_g: reading - target,
            });
        }
        if let Some(record) = self.pours.last_mut()
            && record.index == index
        {
            record.final_g = Some(reading);
            record.ended = Some(step);
        }
        let from = match &self.phase {
            Phase::Pour {
                stage:
                    Stage::Settle { tilt, .. }
                    | Stage::Approach { tilt }
                    | Stage::Regulate { tilt }
                    | Stage::CutOff { tilt }
                    | Stage::TopUp { tilt },
                ..
            } => *tilt,
            _ => 0.,
        };
        Some(Phase::Pour {
            index,
            stage: Stage::Upright { from, step },
        })
    }

    /// Records the measured duration of a pour, from evidence the cell keeps.
    pub fn report_duration(&mut self, index: usize, seconds: f64) {
        if (seconds - POUR_SECONDS).abs() > DURATION_TOLERANCE_S {
            self.deviation(Deviation::PourDuration {
                pour: index,
                seconds,
            });
        }
    }
}

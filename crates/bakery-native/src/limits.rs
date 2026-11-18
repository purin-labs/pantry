//! The rated limits of each robot, and the margins of one transfer against
//! them (Refactor 16, step 7).
//!
//! The ratings have one source: the `joints.json` of each robot under
//! `assets/bakery-robots/`, which `scripts/bakery-robots/generate.py` writes
//! from the vendor's robot description. The engine compiles them in (so they
//! are part of the engine identity) and reports them in each reply; the
//! TypeScript side reads them only from the reply. The torque clamp is the
//! compiled model's actuator force range, which the same generator writes
//! from the same effort values; `Ratings::check` proves that they agree.
//!
//! An operation measures, at each integration step: the speed of each arm
//! joint, which arm actuators are at their force clamp, the deepest
//! penetration of a contact of the carried tray or the tool, and the slip of
//! the grip on the tray while the arm carries the tray free of any support.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

use crate::robot::Robot;

/// A contact that penetrates deeper than this warns. The tray, clamp and
/// fixture geometry use MuJoCo's default contact (solimp 0.9, 0.95, 1 mm):
/// its impedance rises over the first 1 mm of penetration and stays at its
/// highest after it, so a deeper contact is a load that the soft contact
/// does not hold as a solid part would. The tray's floor is 2 mm thick, so
/// 1 mm is also half of it.
pub const PENETRATION_BOUND_M: f64 = 0.001;
/// A grip that slides farther than this on the carried tray warns. The
/// tray slides along the forks, which the controller does not correct. In
/// a rack transfer the slip moves the placed tray by the same distance, so
/// a slip as large as the placement tolerance (10 mm, `placement_with` in
/// `transfer.rs`) would fail the placement alone. In an oven transfer the
/// oven centering corrects part of the slip, so the placement error is
/// smaller than the slip. The lost-grasp failure (25 mm for 60 ms) stays
/// the failure.
pub const SLIP_BOUND_M: f64 = 0.010;
/// An arm actuator that stays at its force clamp longer than this, without
/// a break, warns. At its clamp a motor gives all its torque and no longer
/// follows its servo target. The controller sets a new target every 10 ms,
/// so a short clamp at a contact passes within one or two updates; a clamp
/// through five updates is a motor that cannot do the move. The lost-grasp
/// rule allows a tray 60 ms out of place, so 50 ms warns before it.
pub const CLAMP_BOUND_S: f64 = 0.05;

/// One joint of a robot description file.
#[derive(Deserialize)]
struct DescribedJoint {
    name: String,
    source_effort_nm: f64,
    source_velocity_rad_s: f64,
}

#[derive(Deserialize)]
struct Description {
    joint_order: Vec<DescribedJoint>,
    /// Present when the effort values are not a rating (the CR10's come
    /// from a vendor simulation file).
    effort_limit_status: Option<String>,
}

fn description(robot: Robot) -> &'static str {
    match robot {
        Robot::FairinoFr10 => {
            include_str!("../../../assets/bakery-robots/fairino-fr10/joints.json")
        }
        Robot::FairinoFr5 => include_str!("../../../assets/bakery-robots/fairino-fr5/joints.json"),
        Robot::UfactoryXarm6 => {
            include_str!("../../../assets/bakery-robots/ufactory-xarm6/joints.json")
        }
        Robot::FanucCrx10ial => {
            include_str!("../../../assets/bakery-robots/fanuc-crx10ial/joints.json")
        }
        Robot::UniversalRobotsUr5e => {
            include_str!("../../../assets/bakery-robots/universal-robots-ur5e/joints.json")
        }
        Robot::DobotCr10 => include_str!("../../../assets/bakery-robots/dobot-cr10/joints.json"),
    }
}

/// A rated limit, or none in the repository.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Rating {
    Rated { value: f64 },
    NoRatedValue,
}

impl Rating {
    fn from(value: f64, rated: bool) -> Self {
        if rated && value.is_finite() && value > 0. {
            Self::Rated { value }
        } else {
            Self::NoRatedValue
        }
    }

    fn value(self) -> Option<f64> {
        match self {
            Self::Rated { value } => Some(value),
            Self::NoRatedValue => None,
        }
    }
}

/// The rated limits of a robot's six arm joints.
pub struct Ratings {
    robot: Robot,
    names: [String; 6],
    speed: [Rating; 6],
    torque: [Rating; 6],
    effort: [f64; 6],
}

impl Ratings {
    pub fn of(robot: Robot) -> Result<Self> {
        let described: Description = serde_json::from_str(description(robot))?;
        ensure!(
            described.joint_order.len() == 6,
            "A robot description has six arm joints"
        );
        let rated_torque = described.effort_limit_status.is_none();
        let joint = |index: usize| &described.joint_order[index];
        Ok(Self {
            robot,
            names: std::array::from_fn(|index| joint(index).name.clone()),
            speed: std::array::from_fn(|index| {
                Rating::from(joint(index).source_velocity_rad_s, true)
            }),
            torque: std::array::from_fn(|index| {
                Rating::from(joint(index).source_effort_nm, rated_torque)
            }),
            effort: std::array::from_fn(|index| joint(index).source_effort_nm),
        })
    }

    /// The model's force clamp of each arm actuator must be the described
    /// effort, so the clamp that the margins measure is the one that the
    /// description names (a rating, or the CR10's simulation value).
    pub fn check(&self, clamps: &[f64; 6]) -> Result<()> {
        for (index, (clamp, effort)) in clamps.iter().zip(self.effort).enumerate() {
            ensure!(
                (clamp - effort).abs() <= 1e-9 * effort.max(1.),
                "The force clamp of {} differs from its description",
                self.names[index]
            );
        }
        Ok(())
    }

    /// The source file of these ratings, from the repository root.
    pub fn source(&self) -> String {
        format!("assets/bakery-robots/{}/joints.json", self.robot.slug())
    }
}

/// What one step of the arm read: the speed of each joint (rad/s), which
/// arm actuators are at their force clamp, the deepest penetration of a
/// tray or tool contact (m), and the grasp site in the tray's frame while
/// the arm carries the tray and nothing else touches it (m).
pub struct Reading<'a> {
    pub speeds: [f64; 6],
    pub clamped: [bool; 6],
    pub penetration: f64,
    /// The two geometries of the deepest contact, if any penetrates.
    pub deepest: Option<[&'a str; 2]>,
    pub carried: Option<[f64; 3]>,
}

/// The joint whose speed passed its rating, and by how much. With a test
/// scale, `rated_rad_s` is the scaled rating that the joint passed.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Overspeed {
    pub joint: String,
    pub peak_rad_s: f64,
    pub rated_rad_s: f64,
}

/// The measurements of one operation so far. An operation saves them with
/// its progress, so an operation that resumes from a checkpoint reports
/// the same margins as one that ran without a pause.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Measured {
    pub steps: usize,
    pub peak_speed_rad_s: [f64; 6],
    pub clamp_steps: [usize; 6],
    pub longest_clamp_steps: [usize; 6],
    /// Steps of the clamp interval that is still open, for each actuator.
    pub open_clamp_steps: [usize; 6],
    pub peak_penetration_m: f64,
    /// The two geometries of the deepest contact.
    pub deepest_contact: Option<[String; 2]>,
    pub peak_slip_m: f64,
    /// The grasp site in the tray's frame at the first step of the free
    /// carry in progress. Slip is the farthest the grip moves from it.
    pub carry_origin: Option<[f64; 3]>,
}

impl Measured {
    /// Adds one integration step. Returns the first joint that passed its
    /// rated speed at this step.
    /// `scale` is a test request's speed rating scale (below one), or one.
    pub fn add(&mut self, ratings: &Ratings, scale: f64, reading: &Reading) -> Option<Overspeed> {
        self.steps += 1;
        let mut overspeed = None;
        for index in 0..6 {
            let speed = reading.speeds[index];
            self.peak_speed_rad_s[index] = self.peak_speed_rad_s[index].max(speed);
            if let Some(rated) = ratings.speed[index].value().map(|rated| rated * scale)
                && speed > rated
                && overspeed.is_none()
            {
                overspeed = Some(Overspeed {
                    joint: ratings.names[index].clone(),
                    peak_rad_s: speed,
                    rated_rad_s: rated,
                });
            }
            if reading.clamped[index] {
                self.clamp_steps[index] += 1;
                self.open_clamp_steps[index] += 1;
                self.longest_clamp_steps[index] =
                    self.longest_clamp_steps[index].max(self.open_clamp_steps[index]);
            } else {
                self.open_clamp_steps[index] = 0;
            }
        }
        if reading.penetration > self.peak_penetration_m {
            self.peak_penetration_m = reading.penetration;
            self.deepest_contact = reading.deepest.map(|pair| pair.map(str::to_owned));
        }
        match (reading.carried, self.carry_origin) {
            (Some(position), None) => self.carry_origin = Some(position),
            (Some(position), Some(origin)) => {
                let slip = (0..3)
                    .map(|axis| (position[axis] - origin[axis]).powi(2))
                    .sum::<f64>()
                    .sqrt();
                self.peak_slip_m = self.peak_slip_m.max(slip);
            }
            (None, _) => self.carry_origin = None,
        }
        overspeed
    }

    /// The margins of the operation for its reply.
    pub fn report(
        &self,
        ratings: &Ratings,
        clamps: &[f64; 6],
        timestep: f64,
        speed_rating_scale: Option<f64>,
        overspeed: Option<Overspeed>,
    ) -> Margins {
        let mut warnings = Vec::new();
        let joints = (0..6)
            .map(|index| {
                let longest = self.longest_clamp_steps[index] as f64 * timestep;
                if longest > CLAMP_BOUND_S {
                    warnings.push(Warning::TorqueClamp {
                        joint: ratings.names[index].clone(),
                        seconds: longest,
                        bound_seconds: CLAMP_BOUND_S,
                    });
                }
                JointMargin {
                    joint: ratings.names[index].clone(),
                    peak_speed_rad_s: self.peak_speed_rad_s[index],
                    rated_speed: ratings.speed[index],
                    torque_clamp_nm: clamps[index],
                    rated_torque: ratings.torque[index],
                    clamp_seconds: self.clamp_steps[index] as f64 * timestep,
                    longest_clamp_seconds: longest,
                }
            })
            .collect();
        if self.peak_penetration_m > PENETRATION_BOUND_M {
            warnings.push(Warning::Penetration {
                value_m: self.peak_penetration_m,
                bound_m: PENETRATION_BOUND_M,
            });
        }
        if self.peak_slip_m > SLIP_BOUND_M {
            warnings.push(Warning::Slip {
                value_m: self.peak_slip_m,
                bound_m: SLIP_BOUND_M,
            });
        }
        Margins {
            schema_version: 1,
            rating_source: ratings.source(),
            measured_seconds: self.steps as f64 * timestep,
            joints,
            peak_penetration_m: self.peak_penetration_m,
            deepest_contact: self.deepest_contact.clone(),
            peak_slip_m: self.peak_slip_m,
            warnings,
            speed_rating_scale,
            overspeed,
        }
    }
}

/// A limit that the operation came close to or passed, with its value.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Warning {
    TorqueClamp {
        joint: String,
        seconds: f64,
        bound_seconds: f64,
    },
    Penetration {
        value_m: f64,
        bound_m: f64,
    },
    Slip {
        value_m: f64,
        bound_m: f64,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JointMargin {
    pub joint: String,
    pub peak_speed_rad_s: f64,
    pub rated_speed: Rating,
    pub torque_clamp_nm: f64,
    pub rated_torque: Rating,
    /// All the time at the force clamp, and its longest interval.
    pub clamp_seconds: f64,
    pub longest_clamp_seconds: f64,
}

/// An operation's margins against the robot's rated limits.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Margins {
    pub schema_version: u32,
    pub rating_source: String,
    pub measured_seconds: f64,
    pub joints: Vec<JointMargin>,
    pub peak_penetration_m: f64,
    /// The two geometries of the deepest contact; none if nothing touched.
    pub deepest_contact: Option<[String; 2]>,
    pub peak_slip_m: f64,
    pub warnings: Vec<Warning>,
    /// A test request's scale of every rated speed; absent in production.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_rating_scale: Option<f64>,
    /// Present when a joint passed its rated speed; the operation failed.
    pub overspeed: Option<Overspeed>,
}

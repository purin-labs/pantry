//! The pour-over station world: an arm with a two-finger tool, a free kettle,
//! a dripper on a server on a spring-mounted scale platen.
use anyhow::{Result, ensure};
use std::path::Path;

use super::{GeomNames, Point, point, pose, required, restore_state};
use crate::artifact::ContactPair;
use crate::ik::{self, Orientation};
use crate::mj::{self, Data, Model, Object, Stages};
use crate::robot::Robot;
use crate::servo::{self, Arm, Payload};

/// The solver limits of the pour-over station.
const IK: ik::Limits = ik::Limits {
    iterations: 200,
    tolerance: 1e-7,
    damping: 1e-6,
};

/// A body of the pour-over station that the controller observes or loads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StationBody {
    Kettle,
    Dripper,
    Server,
    Platen,
    Gripper,
    FingerLeft,
    FingerRight,
    /// Geometry-free bodies welded inside each vessel. Only their loads change.
    KettleWater,
    BedWater,
    Beverage,
}

impl StationBody {
    const ALL: [Self; 10] = [
        Self::Kettle,
        Self::Dripper,
        Self::Server,
        Self::Platen,
        Self::Gripper,
        Self::FingerLeft,
        Self::FingerRight,
        Self::KettleWater,
        Self::BedWater,
        Self::Beverage,
    ];
    fn name(self) -> &'static str {
        match self {
            Self::Kettle => "po_kettle",
            Self::Dripper => "po_dripper",
            Self::Server => "po_server",
            Self::Platen => "po_scale_platen",
            Self::Gripper => "po_gripper",
            Self::FingerLeft => "po_finger_left",
            Self::FingerRight => "po_finger_right",
            Self::KettleWater => "po_kettle_water",
            Self::BedWater => "po_bed_water",
            Self::Beverage => "po_beverage",
        }
    }
    fn index(self) -> usize {
        self as usize
    }
}

/// A site of the pour-over station, by its role.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StationSite {
    ToolGrasp,
    HandleGrasp,
    SpoutOutlet,
    BedSurface,
    StandCentre,
}

impl StationSite {
    const ALL: [Self; 5] = [
        Self::ToolGrasp,
        Self::HandleGrasp,
        Self::SpoutOutlet,
        Self::BedSurface,
        Self::StandCentre,
    ];
    fn name(self) -> &'static str {
        match self {
            Self::ToolGrasp => "po_tool_grasp",
            Self::HandleGrasp => "po_handle_grasp",
            Self::SpoutOutlet => "po_spout_outlet",
            Self::BedSurface => "po_bed_surface",
            Self::StandCentre => "po_stand_centre",
        }
    }
    fn index(self) -> usize {
        self as usize
    }
}

/// The inertial load of a water body: its mass, centre of mass and principal
/// inertia in its vessel's frame. Water changes these during a brew.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BodyLoad {
    pub mass_kg: f64,
    pub centre_m: [f64; 3],
    pub inertia_kgm2: [f64; 3],
}

impl BodyLoad {
    fn valid(&self) -> bool {
        self.mass_kg.is_finite()
            && self.mass_kg >= 0.
            && self.centre_m.iter().all(|v| v.is_finite())
            && self.inertia_kgm2.iter().all(|v| v.is_finite() && *v >= 0.)
    }
}

/// Model fields the station changes after compilation. A checkpoint keeps
/// them so that a restored world integrates the same model.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StationModelState {
    pub kettle_water: BodyLoad,
    pub bed_water: BodyLoad,
    pub beverage: BodyLoad,
    pub grip_enabled: bool,
}

/// One penetrating contact, by geometry and body name.
pub struct StationContact<'a> {
    pub first: &'a str,
    pub second: &'a str,
}

pub struct StationEngine {
    model: Model,
    live: Data,
    ik: Data,
    arm: Arm,
    /// The qpos address and the actuator of each finger.
    fingers: [(usize, usize); 2],
    bodies: [usize; 10],
    sites: [usize; 5],
    scale_qpos: usize,
    scale_stiffness: f64,
    /// Colliding pad geometry of both fingers with its compiled masks.
    pads: Vec<(usize, i32, i32)>,
    names: GeomNames,
    stages: Stages,
}

fn id(model: &Model, kind: Object, name: &str) -> Result<usize> {
    required(model, kind, name, "station")
}

impl StationEngine {
    pub fn load(path: &Path, robot: Robot) -> Result<Self> {
        let model = Model::load(path, "the station model")?;
        let names = GeomNames::read(&model);
        let (mut live, ik) = (model.make_data()?, model.make_data()?);
        let lookup = |kind, name: &str| id(&model, kind, name);
        let arm = Arm::bind(&model, robot, lookup)?;
        let mut fingers = [(0, 0); 2];
        let mut pads = Vec::new();
        for (index, side) in ["left", "right"].into_iter().enumerate() {
            let joint = lookup(Object::Joint, &format!("po_finger_{side}_slide"))?;
            fingers[index] = (
                model.jnt_qposadr()[joint] as usize,
                lookup(Object::Actuator, &format!("po_finger_{side}_servo"))?,
            );
            let prefix = format!("po_finger_{side}_pad");
            for geom in 0..model.ngeom() {
                let contype = model.geom_contype()[geom];
                let conaffinity = model.geom_conaffinity()[geom];
                if names.geometry[geom].starts_with(&prefix) && (contype | conaffinity) != 0 {
                    pads.push((geom, contype, conaffinity));
                }
            }
        }
        ensure!(pads.len() == 4, "The gripper needs two ribs on each pad");
        let mut bodies = [0; 10];
        for body in StationBody::ALL {
            bodies[body.index()] = lookup(Object::Body, body.name())?;
        }
        let mut sites = [0; 5];
        for site in StationSite::ALL {
            sites[site.index()] = lookup(Object::Site, site.name())?;
        }
        let scale = lookup(Object::Joint, "po_scale_cell")?;
        ensure!(
            model.jnt_type()[scale] == mj::JOINT_SLIDE,
            "The scale cell must be a slide joint"
        );
        let scale_stiffness = model.jnt_stiffness()[scale];
        ensure!(scale_stiffness > 0., "The scale cell needs a stiffness");
        model.forward(&mut live);
        Ok(Self {
            scale_qpos: model.jnt_qposadr()[scale] as usize,
            scale_stiffness,
            arm,
            fingers,
            bodies,
            sites,
            pads,
            names,
            stages: Stages::default(),
            live,
            ik,
            model,
        })
    }

    pub fn timestep(&self) -> f64 {
        self.model.timestep()
    }

    pub fn gravity(&self) -> f64 {
        -self.model.gravity()[2]
    }

    pub fn time(&self) -> f64 {
        self.live.time()
    }

    pub fn limits(&self) -> &[(f64, f64); 6] {
        &self.arm.limits
    }

    pub fn state(&self) -> Vec<f64> {
        self.model.state(&self.live)
    }

    pub fn restore(&mut self, state: &[f64]) -> Result<()> {
        let free = [
            StationBody::Kettle,
            StationBody::Dripper,
            StationBody::Server,
        ]
        .map(|body| self.free_qpos(body));
        restore_state(&self.model, &mut self.live, state, "station ", |data| {
            for address in free {
                let quat = &data.qpos()[address + 3..address + 7];
                ensure!(
                    (quat.iter().map(|v| v * v).sum::<f64>() - 1.).abs() < 1e-6,
                    "Invalid station body quaternion"
                );
            }
            Ok(())
        })
    }

    fn free_qpos(&self, body: StationBody) -> usize {
        let id = self.bodies[body.index()];
        self.model.jnt_qposadr()[self.model.body_jntadr()[id] as usize] as usize
    }

    /// The model fields a brew changes: three water loads and the grip.
    pub fn model_state(&self) -> StationModelState {
        let (pad, contype, conaffinity) = self.pads[0];
        StationModelState {
            kettle_water: self.load_of(StationBody::KettleWater),
            bed_water: self.load_of(StationBody::BedWater),
            beverage: self.load_of(StationBody::Beverage),
            grip_enabled: self.model.geom_contype()[pad] == contype
                && self.model.geom_conaffinity()[pad] == conaffinity,
        }
    }

    fn load_of(&self, body: StationBody) -> BodyLoad {
        let id = self.bodies[body.index()];
        BodyLoad {
            mass_kg: self.model.body_mass()[id],
            centre_m: self.model.body_ipos()[id * 3..id * 3 + 3]
                .try_into()
                .unwrap(),
            inertia_kgm2: self.model.body_inertia()[id * 3..id * 3 + 3]
                .try_into()
                .unwrap(),
        }
    }

    /// Applies body loads and the grip state, then recomputes the model's
    /// derived constants. The integration state is unchanged.
    pub fn apply_model(&mut self, state: &StationModelState) -> Result<()> {
        self.stages.clear();
        ensure!(
            state.kettle_water.valid() && state.bed_water.valid() && state.beverage.valid(),
            "Invalid station water load"
        );
        if *state == self.model_state() {
            return Ok(());
        }
        let integration = self.state();
        for (body, load) in [
            (StationBody::KettleWater, &state.kettle_water),
            (StationBody::BedWater, &state.bed_water),
            (StationBody::Beverage, &state.beverage),
        ] {
            let id = self.bodies[body.index()];
            self.model.body_mass_mut()[id] = load.mass_kg;
            self.model.body_ipos_mut()[id * 3..id * 3 + 3].copy_from_slice(&load.centre_m);
            self.model.body_inertia_mut()[id * 3..id * 3 + 3].copy_from_slice(&load.inertia_kgm2);
        }
        for &(pad, contype, conaffinity) in &self.pads {
            self.model.geom_contype_mut()[pad] = if state.grip_enabled { contype } else { 0 };
            self.model.geom_conaffinity_mut()[pad] =
                if state.grip_enabled { conaffinity } else { 0 };
        }
        self.model.set_const(&mut self.live);
        self.restore(&integration)
    }

    /// Writes the arm and finger positions at rest. Used only to create a world.
    pub fn set_start(&mut self, angles: &[f64; 6], fingers: f64) {
        self.arm.set_joints(&mut self.live, angles);
        for (qpos, _) in self.fingers {
            self.live.qpos_mut()[qpos] = fingers;
        }
        self.model.forward(&mut self.live);
    }

    pub fn joints(&self) -> [f64; 6] {
        self.arm.joints(&self.live)
    }

    pub fn fingers(&self) -> [f64; 2] {
        let qpos = self.live.qpos();
        [qpos[self.fingers[0].0], qpos[self.fingers[1].0]]
    }

    /// The fastest arm joint, in rad/s.
    pub fn arm_speed(&self) -> f64 {
        self.arm.speed(&self.live)
    }

    pub fn body_pose(&self, body: StationBody) -> [f64; 7] {
        pose(&self.live, self.bodies[body.index()])
    }

    /// Linear speed (m/s) and angular speed (rad/s) of a free body.
    pub fn body_speed(&self, body: StationBody) -> (f64, f64) {
        let velocity = self
            .model
            .body_velocity(&self.live, self.bodies[body.index()]);
        (
            Point::from_column_slice(&velocity[3..]).norm(),
            Point::from_column_slice(&velocity[..3]).norm(),
        )
    }

    /// The world velocity of a point fixed to a body.
    pub fn point_velocity(&self, body: StationBody, at: Point) -> Point {
        let id = self.bodies[body.index()];
        let velocity = self.model.body_velocity(&self.live, id);
        let origin = point(self.live.xpos(), id);
        Point::from_column_slice(&velocity[3..])
            + Point::from_column_slice(&velocity[..3]).cross(&(at - origin))
    }

    /// A site's world position and row-major rotation matrix.
    pub fn site(&self, site: StationSite) -> (Point, [f64; 9]) {
        let id = self.sites[site.index()];
        (
            point(self.live.site_xpos(), id),
            self.live.site_xmat()[id * 9..id * 9 + 9]
                .try_into()
                .unwrap(),
        )
    }

    /// The scale cell's supported load in kilograms, from its spring deflection.
    pub fn scale_load_kg(&self) -> f64 {
        -self.scale_stiffness * self.live.qpos()[self.scale_qpos] / self.gravity()
    }

    /// A downward force on the dripper for the next step, such as a stream's
    /// momentum. It stays in the integration state until replaced.
    pub fn set_dripper_force(&mut self, downward_n: f64) -> Result<()> {
        ensure!(
            downward_n.is_finite() && downward_n >= 0.,
            "Invalid stream force"
        );
        let id = self.bodies[StationBody::Dripper.index()];
        let force = &mut self.live.xfrc_applied_mut()[id * 6..id * 6 + 6];
        force.fill(0.);
        force[2] = -downward_n;
        Ok(())
    }

    /// Solves the arm angles that place the tool site at `position` with the
    /// row-major rotation `rotation`, starting from `seed`.
    pub fn solve_ik(
        &mut self,
        position: Point,
        rotation: &[f64; 9],
        seed: [f64; 6],
    ) -> Option<[f64; 6]> {
        ik::solve(
            &self.model,
            &mut self.ik,
            &self.arm,
            self.sites[StationSite::ToolGrasp.index()],
            position,
            Orientation::Rows(rotation),
            seed,
            &IK,
            &mut 0,
        )
    }

    /// One integration step. The servos hold `angles` with model-based bias
    /// compensation; a carried kettle with its water adds ideal known-payload
    /// compensation through the tool Jacobian. Both fingers receive `fingers`.
    pub fn step(&mut self, angles: &[f64; 6], fingers: f64, carrying: bool) -> Result<()> {
        let kettle = self.bodies[StationBody::Kettle.index()];
        let payload = carrying.then(|| Payload {
            body: self.bodies[StationBody::Gripper.index()],
            point: self.live.subtree_com()[kettle * 3..kettle * 3 + 3]
                .try_into()
                .unwrap(),
            mass: self.model.body_subtreemass()[kettle],
        });
        servo::command(&self.model, &mut self.live, &self.arm, angles, payload);
        for (_, actuator) in self.fingers {
            self.live.ctrl_mut()[actuator] = fingers;
        }
        self.model.step(&mut self.live, &mut self.stages);
        servo::settle(
            &self.model,
            &mut self.live,
            &mut self.stages,
            "MuJoCo warning or nonfinite station state",
        )
    }

    /// Penetrating contacts by geometry name, in MuJoCo's order.
    pub fn contacts(&self) -> Vec<StationContact<'_>> {
        GeomNames::penetrating(&self.live)
            .map(|(first, second)| StationContact {
                first: &self.names.geometry[first],
                second: &self.names.geometry[second],
            })
            .collect()
    }

    pub fn contact_pairs(&self) -> Result<Vec<ContactPair>> {
        self.names.pairs(&self.model, &self.live)
    }
}

//! The robot transfer world: an arm with a clamp gripper, a free tray, a
//! table, a rack or an oven, and in a persistent cell a free reference body.
use anyhow::{Context, Result, ensure};
use std::path::Path;

use super::{GeomNames, Point, point, pose, required, restore_state};
use crate::artifact::{ContactPair, IngredientLoad, Layout, Sample};
use crate::ik::{self, Orientation};
use crate::limits::{Ratings, Reading};
use crate::mj::{self, Data, Model, Object, Spec, Stages};
use crate::robot::Robot;
use crate::servo::{self, Arm, Payload};

pub const OPEN_JAW_M: f64 = 0.025;
pub const SPANNER_OPEN_JAW_M: f64 = 0.045;
pub const SPANNER_CLOSED_JAW_M: f64 = -0.015;
pub const SPANNER_MAX_CLAMP_N: f64 = 15.5;
/// Where a cell keeps its carrier body while no carrier is admitted: below the
/// floor, clear of every fixture, with its collisions disabled.
pub const PARKED_TRAY: [f64; 7] = [0., 0., -10., 1., 0., 0., 0.];

/// The solver limits of the transfer world.
const IK: ik::Limits = ik::Limits {
    iterations: 350,
    tolerance: 1e-5,
    damping: 1e-5,
};

/// A penetrating contact. Its names borrow the engine's geometry table.
pub struct Contact<'a> {
    pub first: &'a str,
    pub second: &'a str,
    pub involves_arm: bool,
    pub first_is_tray: bool,
    pub second_is_tray: bool,
}

pub struct Engine {
    model: Model,
    live: Data,
    ik: Data,
    probe: Data,
    arm: Arm,
    grasp: usize,
    tray: usize,
    tool: usize,
    jaw: usize,
    tray_qpos: usize,
    tray_dof: usize,
    clamp_qpos: usize,
    clamp_actuator: usize,
    is_spanner: bool,
    // The tray's geometry with the collision masks it was compiled with.
    tray_geoms: Vec<(usize, i32, i32)>,
    parked: bool,
    reference: Option<usize>,
    names: GeomNames,
    /// For each geometry: the robot owns it.
    arm_geoms: Vec<bool>,
    stages: Stages,
    /// Solver steps computed so far: integration steps, inverse-kinematics
    /// iterations and probe poses. An operation's budget counts them.
    work: u64,
    ratings: Ratings,
    /// The force clamp of each arm actuator, in N·m.
    clamps: [f64; 6],
}

fn id(model: &Model, kind: Object, name: &str) -> Result<usize> {
    required(model, kind, name, "model")
}

/// The fixture with the cell's layout, ingredient load and table, compiled.
fn compile(
    path: &Path,
    layout: Layout,
    ingredients: IngredientLoad,
    persistent: bool,
) -> Result<Model> {
    let mut spec = Spec::parse(path)?;
    if layout != Layout::Fixed {
        let rack = spec
            .body_position(c"cell_rack")
            .context("Fixture has no named rack body")?;
        let offset = layout.offset();
        rack[0] += offset[0];
        rack[1] += offset[1];
    }
    let mut contents = spec
        .geom(c"cold_contents")
        .context("Fixture has no ingredient geometry")?;
    contents.set_mass(ingredients.mass_kg);
    if ingredients.mass_kg == 0. {
        contents.set_collisions(0, 0);
    }
    // Tray local Y points forward; local X points toward negative lateral.
    let position = contents.position();
    position[0] = -f64::from(ingredients.lateral_mm) / 1000.;
    position[1] = f64::from(ingredients.forward_mm) / 1000.;
    // Every world has one table (Refactor 16, step 5). The tray overhangs the
    // table's edge. With the default contact it sinks 0.18 mm there, tilts,
    // and creeps down that slope at 1 µm/s. A steel top does not yield: give
    // it the stiffest contact a 2 ms step supports, taking priority over the
    // tray's.
    let table_top_z = {
        let mut top = spec
            .geom(c"table_top")
            .context("Fixture has no table top")?;
        let z = top.position()[2];
        top.set_contact(1, [0.004, 1.], [0.99, 0.999, 0.001, 0.5, 2.]);
        z
    };
    if persistent {
        let table = spec
            .body_position(c"cell_table")
            .map(|table| *table)
            .context("Fixture has no source table for a reference body")?;
        // A 40 mm block resting on the table beyond the tray's far edge.
        // Every table_top box has half-height 0.02 m, so the top sits at table_top_z + 0.02 m.
        spec.add_free_box(
            c"world",
            [
                c"cell_reference",
                c"cell_reference_free",
                c"cell_reference_block",
            ],
            [table[0] + 0.22, table[1], table_top_z + 0.04],
            [0.02, 0.02, 0.02],
            0.2,
        )
        .context("Fixture has no source table for a reference body")?;
    }
    spec.compile()
}

impl Engine {
    pub fn load(
        path: &Path,
        layout: Layout,
        robot: Robot,
        ingredients: IngredientLoad,
    ) -> Result<Self> {
        Self::compile(path, layout, robot, ingredients, false)
    }

    /// The same fixture for a persistent cell: it adds a free reference body
    /// on the source table that no operation touches.
    pub fn load_persistent(
        path: &Path,
        layout: Layout,
        robot: Robot,
        ingredients: IngredientLoad,
    ) -> Result<Self> {
        Self::compile(path, layout, robot, ingredients, true)
    }

    fn compile(
        path: &Path,
        layout: Layout,
        robot: Robot,
        ingredients: IngredientLoad,
        persistent: bool,
    ) -> Result<Self> {
        ingredients.validate()?;
        let model = compile(path, layout, ingredients, persistent)?;
        let names = GeomNames::read(&model);
        let arm_geoms = names
            .geometry
            .iter()
            .map(|name| robot.owns_geometry(name))
            .collect();
        let (live, ik, probe) = (model.make_data()?, model.make_data()?, model.make_data()?);
        let lookup = |kind, name: &str| id(&model, kind, name);
        let arm = Arm::bind(&model, robot, lookup)?;
        let tray = lookup(Object::Body, "mbco_tray")?;
        let tray_joint = lookup(Object::Joint, "mbco_tray_free")?;
        ensure!(
            model.jnt_type()[tray_joint] == mj::JOINT_FREE,
            "Tray must have a free joint"
        );
        let clamp = lookup(Object::Joint, "clamp_opening")?;
        let tray_geoms = (0..model.ngeom())
            .filter(|&id| model.geom_bodyid()[id] == tray as i32)
            .map(|id| (id, model.geom_contype()[id], model.geom_conaffinity()[id]))
            .collect();
        let ratings = Ratings::of(robot)?;
        let range = model.actuator_forcerange();
        let clamps = std::array::from_fn(|index| range[arm.actuators[index] * 2 + 1]);
        ratings.check(&clamps)?;
        let is_spanner = names
            .geometry
            .iter()
            .any(|name| name == "clamp_spanner_jaw_front_pad_col");
        Ok(Self {
            grasp: lookup(Object::Site, "cell_grasp")?,
            tool: lookup(Object::Body, "cell_gripper")?,
            jaw: lookup(Object::Body, "cell_upper_jaw")?,
            tray_qpos: model.jnt_qposadr()[tray_joint] as usize,
            tray_dof: model.jnt_dofadr()[tray_joint] as usize,
            clamp_qpos: model.jnt_qposadr()[clamp] as usize,
            clamp_actuator: lookup(Object::Actuator, "clamp_servo")?,
            is_spanner,
            reference: if persistent {
                Some(lookup(Object::Body, "cell_reference")?)
            } else {
                None
            },
            tray,
            tray_geoms,
            arm,
            parked: false,
            names,
            arm_geoms,
            stages: Stages::default(),
            work: 0,
            ratings,
            clamps,
            live,
            ik,
            probe,
            model,
        })
    }

    pub fn is_spanner(&self) -> bool {
        self.is_spanner
    }
    pub fn open_jaw_m(&self) -> f64 {
        if self.is_spanner {
            SPANNER_OPEN_JAW_M
        } else {
            OPEN_JAW_M
        }
    }
    pub fn closed_jaw_m(&self) -> f64 {
        if self.is_spanner {
            SPANNER_CLOSED_JAW_M
        } else {
            -0.005
        }
    }
    pub fn timestep(&self) -> f64 {
        self.model.timestep()
    }
    pub fn set_timestep(&mut self, timestep: f64) {
        self.stages.clear();
        self.model.set_timestep(timestep);
    }
    pub fn time(&self) -> f64 {
        self.live.time()
    }
    pub fn limits(&self) -> &[(f64, f64); 6] {
        &self.arm.limits
    }

    /// The solver steps this engine has computed since it was made.
    pub fn work(&self) -> u64 {
        self.work
    }

    pub fn state(&self) -> Vec<f64> {
        self.model.state(&self.live)
    }

    pub fn restore(&mut self, state: &[f64]) -> Result<()> {
        let tray_qpos = self.tray_qpos;
        restore_state(&self.model, &mut self.live, state, "", |data| {
            let quat = &data.qpos()[tray_qpos + 3..tray_qpos + 7];
            ensure!(
                (quat.iter().map(|v| v * v).sum::<f64>() - 1.).abs() < 1e-6,
                "Invalid tray quaternion"
            );
            Ok(())
        })
    }

    pub fn site(&self, name: &str) -> Result<Point> {
        let site = id(&self.model, Object::Site, name)?;
        Ok(point(self.live.site_xpos(), site))
    }

    pub fn set_start(&mut self, angles: &[f64; 6]) {
        self.arm.set_joints(&mut self.live, angles);
        self.model.forward(&mut self.live);
    }

    pub fn set_jaw(&mut self, opening: f64) {
        self.live.qpos_mut()[self.clamp_qpos] = opening;
        self.model.forward(&mut self.live);
    }

    fn write_tray(&mut self, pose: &[f64; 7]) {
        self.live.qpos_mut()[self.tray_qpos..self.tray_qpos + 7].copy_from_slice(pose);
        self.live.qvel_mut()[self.tray_dof..self.tray_dof + 6].fill(0.);
    }

    fn collide_tray(&mut self, enabled: bool) {
        self.stages.clear();
        for &(id, contype, conaffinity) in &self.tray_geoms {
            self.model.geom_contype_mut()[id] = if enabled { contype } else { 0 };
            self.model.geom_conaffinity_mut()[id] = if enabled { conaffinity } else { 0 };
        }
    }

    /// Makes the carrier body inactive: no collisions, held at its parking
    /// pose after every step. Nothing else in the world is written.
    pub fn park_tray(&mut self) {
        self.collide_tray(false);
        self.parked = true;
        self.write_tray(&PARKED_TRAY);
        self.model.forward(&mut self.live);
    }

    /// Makes the carrier body active at `pose`, at rest, with the collisions
    /// it was compiled with. Nothing else in the world is written.
    pub fn place_tray(&mut self, pose: &[f64; 7]) {
        self.collide_tray(true);
        self.parked = false;
        self.write_tray(pose);
        self.model.forward(&mut self.live);
    }

    pub fn tray_parked(&self) -> bool {
        self.parked
    }

    /// The reference body's pose and spatial velocity, in a persistent cell.
    pub fn reference(&self) -> Option<([f64; 7], [f64; 6])> {
        let body = self.reference?;
        let velocity = self.model.body_velocity(&self.live, body);
        Some((pose(&self.live, body), velocity))
    }

    pub fn joints(&self) -> [f64; 6] {
        self.arm.joints(&self.live)
    }

    /// The fastest arm joint, in rad/s.
    pub fn arm_speed(&self) -> f64 {
        self.arm.speed(&self.live)
    }

    pub fn ratings(&self) -> &Ratings {
        &self.ratings
    }

    /// The force clamp of each arm actuator, in N·m.
    pub fn clamps(&self) -> &[f64; 6] {
        &self.clamps
    }

    /// The arm's limits at the last completed step. `carrying` asks for the
    /// grip's position on the tray while the tray hangs free: no geometry
    /// but the tool's touches it.
    pub fn reading(&self, carrying: bool) -> Reading<'_> {
        let (qvel, force) = (self.live.qvel(), self.live.actuator_force());
        let body = self.model.geom_bodyid();
        let owner = |geom: i32| body[geom as usize] as usize;
        let held = |geom: i32| [self.tray, self.tool, self.jaw].contains(&owner(geom));
        let mut penetration = 0_f64;
        let mut deepest = None;
        let mut supported = false;
        for contact in self
            .live
            .contacts()
            .iter()
            .filter(|contact| contact.dist < 0.)
        {
            let (first, second) = (contact.geom1, contact.geom2);
            if (held(first) || held(second)) && -contact.dist > penetration {
                penetration = -contact.dist;
                deepest = Some([first, second]);
            }
            let tray = (owner(first) == self.tray, owner(second) == self.tray);
            supported |= (tray.0 && !held(second)) || (tray.1 && !held(first));
        }
        let carried = (carrying && !supported).then(|| {
            // The grasp site in the tray's frame. The tray's rotation matrix
            // is row-major, so its transpose maps a world vector into the
            // tray. A tray that turns about the grip keeps this point; a
            // tray that slides in the grip moves it.
            let rotation = &self.live.xmat()[self.tray * 9..self.tray * 9 + 9];
            let offset = self.grasp_site() - point(self.live.xpos(), self.tray);
            std::array::from_fn(|axis| {
                (0..3)
                    .map(|row| rotation[row * 3 + axis] * offset[row])
                    .sum()
            })
        });
        Reading {
            speeds: std::array::from_fn(|index| qvel[self.arm.velocities[index]].abs()),
            clamped: std::array::from_fn(|index| {
                force[self.arm.actuators[index]].abs() >= self.clamps[index] - 1e-9
            }),
            penetration,
            deepest: deepest
                .map(|pair| pair.map(|geom| self.names.geometry[geom as usize].as_str())),
            carried,
        }
    }

    pub fn jaw_opening(&self) -> f64 {
        self.live.qpos()[self.clamp_qpos]
    }

    pub fn tray_speed(&self) -> [f64; 6] {
        self.live.qvel()[self.tray_dof..self.tray_dof + 6]
            .try_into()
            .unwrap()
    }

    pub fn sample(&self, step: usize) -> Sample {
        Sample {
            step,
            joints: self.joints(),
            tray: pose(&self.live, self.tray),
            tool: pose(&self.live, self.tool),
            jaw: pose(&self.live, self.jaw),
        }
    }

    pub fn solve_ik(&mut self, target: Point, seed: [f64; 6]) -> Option<[f64; 6]> {
        ik::solve(
            &self.model,
            &mut self.ik,
            &self.arm,
            self.grasp,
            target,
            Orientation::World,
            seed,
            &IK,
            &mut self.work,
        )
    }

    pub fn probe_contacts(&mut self, angles: &[f64; 6], closed: bool) -> Vec<Contact<'_>> {
        self.work += 1;
        self.model.reset(&mut self.probe);
        let open_jaw = self.open_jaw_m();
        let qpos = self.probe.qpos_mut();
        for index in 0..3 {
            qpos[self.tray_qpos + index] = if index == 2 { -10. } else { 0. };
        }
        qpos[self.clamp_qpos] = if closed { 0. } else { open_jaw };
        self.arm.set_joints(&mut self.probe, angles);
        self.model.forward(&mut self.probe);
        self.contacts(&self.probe)
    }

    // probe_contacts sets this candidate pose before the gravity check.
    pub fn probe_supports_load(&self, carrying: bool) -> bool {
        let (model, probe) = (&self.model, &self.probe);
        let nv = model.nv();
        let mut jacobian = vec![0.; 3 * nv];
        if carrying {
            let site = probe.site_xpos();
            let mut center = [0.; 3];
            for axis in 0..3 {
                center[axis] = site[self.grasp * 3 + axis];
            }
            if self.is_spanner {
                center[1] += 0.005;
                center[2] -= 0.011;
            } else {
                center[0] += 0.25;
                center[2] += 0.001;
            }
            // The grasp offset locates the tray origin. Apply its actual inertial
            // offset in the live tray orientation when estimating carried weight.
            let (xmat, ipos) = (self.live.xmat(), model.body_ipos());
            for axis in 0..3 {
                for local in 0..3 {
                    center[axis] +=
                        xmat[self.tray * 9 + axis * 3 + local] * ipos[self.tray * 3 + local];
                }
            }
            model.jac_point(probe, &center, self.tool, &mut jacobian);
        }
        let (gravity, mass) = (model.gravity(), model.body_mass()[self.tray]);
        let range = model.actuator_forcerange();
        for index in 0..6 {
            let dof = self.arm.velocities[index];
            let mut torque = probe.qfrc_bias()[dof];
            if carrying {
                for axis in 0..3 {
                    torque -= jacobian[axis * nv + dof] * mass * gravity[axis];
                }
            }
            let actuator = self.arm.actuators[index];
            if torque < range[actuator * 2] || torque > range[actuator * 2 + 1] {
                return false;
            }
        }
        true
    }

    pub fn live_contacts(&self) -> Vec<Contact<'_>> {
        self.contacts(&self.live)
    }

    /// Pair identity is independent of MuJoCo's contact array ordering. Forces
    /// are normal magnitudes in newtons, summed across the pair's contact points.
    pub fn contact_pairs(&self) -> Result<Vec<ContactPair>> {
        self.names.pairs(&self.model, &self.live)
    }

    fn contacts<'a>(&'a self, data: &Data) -> Vec<Contact<'a>> {
        let body = self.model.geom_bodyid();
        GeomNames::penetrating(data)
            .map(|(first, second)| Contact {
                involves_arm: self.arm_geoms[first] || self.arm_geoms[second],
                first: &self.names.geometry[first],
                second: &self.names.geometry[second],
                first_is_tray: body[first] == self.tray as i32,
                second_is_tray: body[second] == self.tray as i32,
            })
            .collect()
    }

    /// The grasp site, by the id that the engine looked up at compilation.
    pub fn grasp_site(&self) -> Point {
        point(self.live.site_xpos(), self.grasp)
    }

    pub fn disable_grip(&mut self) {
        self.stages.clear();
        for id in 0..self.model.ngeom() {
            if self.names.geometry[id].starts_with("clamp_") {
                self.model.geom_contype_mut()[id] = 0;
                self.model.geom_conaffinity_mut()[id] = 0;
            }
        }
    }

    pub fn configure_clamp(&mut self, clamp_force_n: f64) {
        self.stages.clear();
        let limit = if self.is_spanner {
            clamp_force_n.min(SPANNER_MAX_CLAMP_N)
        } else {
            clamp_force_n
        };
        let range = self.model.actuator_forcerange_mut();
        range[self.clamp_actuator * 2] = -limit;
        range[self.clamp_actuator * 2 + 1] = limit;
        self.model.set_const(&mut self.live);
    }

    pub fn step(&mut self, angles: &[f64; 6], compensate: bool, jaw: f64) -> Result<()> {
        self.work += 1;
        let payload = compensate.then(|| Payload {
            body: self.tool,
            point: self.live.xipos()[self.tray * 3..self.tray * 3 + 3]
                .try_into()
                .unwrap(),
            mass: self.model.body_mass()[self.tray],
        });
        servo::command(&self.model, &mut self.live, &self.arm, angles, payload);
        self.live.ctrl_mut()[self.clamp_actuator] = jaw;
        self.model.step(&mut self.live, &mut self.stages);
        if self.parked {
            self.write_tray(&PARKED_TRAY);
        }
        servo::settle(
            &self.model,
            &mut self.live,
            &mut self.stages,
            "MuJoCo warning or nonfinite state",
        )
    }
}

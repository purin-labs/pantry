//! Unprivileged closed-loop RGB-D + IK + servo controller for `bakery-native`.
//!
//! Built directly on `crate::ik::solve`, `crate::servo::command`, and
//! `crate::perception`, reading ONLY deployment-visible joint positions and
//! overhead RGB-D images through the [`ClosedLoopPlant`] trait. Zero `unsafe`
//! code; compiles for both native targets and `wasm32-unknown-emscripten`.

use anyhow::{Context, Result};
use nalgebra::Vector3;
use std::path::{Path, PathBuf};

use crate::{
    artifact::BakeryTask,
    assets::Cell,
    ik::{self, Orientation},
    mj::{Data, Model, Object, Spec},
    perception::{
        CameraModel, Cloud, FaultMonitor, MBCO4_OVEN_ROOF_CENTER, MBCO4_OVEN_ROOF_ROI, PlaneCal,
        RoiBox, calibrate_table_plane, measure_ee_z_offset, perceive_fixture_target,
        perceive_table_target, perceive_tray, spanner_table_roi,
    },
    robot::Robot,
    servo::{self, Arm, Payload},
};

/// Scalar joint measurements returned on episode start and every control tick.
#[derive(Clone, Debug)]
pub struct PlantMeas {
    pub q: [f64; 6],
    pub gripper: f64,
    pub cam_timestamp: Option<f64>,
}

/// Reply from advancing the controlled plant by one control tick.
#[derive(Clone, Debug)]
pub enum PlantStep {
    Meas(PlantMeas),
    EpisodeOver,
}

/// Abstract unprivileged deployment boundary (implemented by `bakery-gauntlet`'s
/// HTTP proxy client and by in-process verification harnesses).
pub trait ClosedLoopPlant {
    fn begin(&mut self) -> Result<PlantMeas>;
    fn step(&mut self, arm_ctrl: &[f64; 6], jaw_ctrl: f64) -> Result<PlantStep>;
    fn read_rgb(&mut self) -> Result<(usize, usize, Vec<u8>)>;
    fn read_depth(&mut self) -> Result<(usize, usize, Vec<f32>)>;
    fn end(&mut self) -> Result<()>;
}

/// Configuration for one closed-loop task execution.
#[derive(Clone, Debug)]
pub struct ClosedLoopConfig {
    pub root: PathBuf,
    pub robot: Robot,
    pub cell: Cell,
    pub task: BakeryTask,
    pub ingredient_mass_kg: f64,
    pub clamp_force_n: f64,
    pub control_dt_s: f64,
}

impl ClosedLoopConfig {
    pub fn xml_rel_path(&self) -> String {
        let stem = match self.cell {
            Cell::Separate => match self.task {
                BakeryTask::Rack => "table-to-rack",
                BakeryTask::Oven | BakeryTask::Unload => "table-to-oven",
            },
            Cell::Combined => "combined",
            Cell::BlockedRack => "combined-blocked-rack",
            Cell::UnreachableRack => "combined-unreachable-rack",
            Cell::PanStaging => "pan-staging",
            Cell::SpannerOven => "spanner-oven",
            Cell::SpannerOvenCombined => "spanner-oven-combined",
            Cell::SpannerBlockedRack => "spanner-oven-blocked-rack",
            Cell::SpannerUnreachableRack => "spanner-oven-unreachable-rack",
            Cell::SpannerOvenDoor => "spanner-oven-door",
        };
        format!(
            "assets/bakery-mujoco/fr10-workcell/native/{}/{stem}-nominal.xml",
            self.robot.slug()
        )
    }

    pub fn substeps(&self) -> usize {
        (self.control_dt_s / 0.002).round().max(1.0) as usize
    }
}

/// Nominal CAD/dynamics model compiled strictly from the verified production XML.
/// Used ONLY with unprivileged measured joint angles (`q_meas`) to compute
/// `servo::command` gravity + nominal-payload feedforward and `ik::solve`.
pub struct NominalDynamics {
    pub model: Model,
    pub data: Data,
    pub ik_data: Data,
    pub arm: Arm,
    pub grasp_site: usize,
    pub handle_grasp_site: Option<usize>,
    pub tool_body: usize,
    pub clamp_qpos: usize,
    pub is_spanner: bool,
    pub open_jaw_m: f64,
    pub closed_jaw_m: f64,
    pub nominal_tray_mass: f64,
    pub nominal_tray_com_in_grasp: [f64; 3],
    pub source_site: [f64; 3],
    pub dest_site: [f64; 3],
    pub robot_mount: [f64; 3],
    pub work: u64,
}

impl NominalDynamics {
    pub fn load(cfg: &ClosedLoopConfig) -> Result<Self> {
        let xml_path = cfg.root.join(cfg.xml_rel_path());
        Self::load_from_xml(
            &xml_path,
            cfg.robot,
            cfg.task,
            cfg.ingredient_mass_kg,
            cfg.clamp_force_n,
        )
    }

    pub fn load_from_xml(
        xml_path: &Path,
        robot: Robot,
        task: BakeryTask,
        ingredient_mass_kg: f64,
        clamp_force_n: f64,
    ) -> Result<Self> {
        let mut spec = Spec::parse(xml_path)
            .with_context(|| format!("Parse nominal XML {}", xml_path.display()))?;
        if let Some(mut contents) = spec.geom(c"cold_contents") {
            contents.set_mass(ingredient_mass_kg);
            if ingredient_mass_kg == 0.0 {
                contents.set_collisions(0, 0);
            }
        }
        if let Some(mut table_top) = spec.geom(c"table_top") {
            table_top.set_contact(1, [0.004, 1.0], [0.99, 0.999, 0.001, 0.5, 2.0]);
        }
        let mut model = spec.compile()?;
        let mut data = model.make_data()?;
        let ik_data = model.make_data()?;
        let lookup = |m: &Model, kind: Object, name: &str| -> Result<usize> {
            m.id(kind, name)?
                .with_context(|| format!("Nominal model missing {kind:?} {name:?}"))
        };
        let arm = Arm::bind(&model, robot, |k, n| lookup(&model, k, n))?;
        let grasp_site = lookup(&model, Object::Site, "cell_grasp")?;
        let handle_grasp_site = model.id(Object::Site, "cell_handle_grasp")?;
        let tool_body = lookup(&model, Object::Body, "cell_gripper")?;
        let tray_body = lookup(&model, Object::Body, "mbco_tray")?;
        let clamp_jnt = lookup(&model, Object::Joint, "clamp_opening")?;
        let clamp_qpos = model.jnt_qposadr()[clamp_jnt] as usize;
        let clamp_actuator = lookup(&model, Object::Actuator, "clamp_servo")?;
        let is_spanner = model
            .id(Object::Geom, "clamp_spanner_jaw_front_pad_col")?
            .is_some();
        let open_jaw_m = if is_spanner { 0.045 } else { 0.025 };
        let closed_jaw_m = if is_spanner { -0.015 } else { -0.005 };
        let clamp_limit = if is_spanner {
            clamp_force_n.min(15.5)
        } else {
            clamp_force_n
        };
        {
            let range = model.actuator_forcerange_mut();
            range[clamp_actuator * 2] = -clamp_limit;
            range[clamp_actuator * 2 + 1] = clamp_limit;
        }
        model.set_const(&mut data);
        model.forward(&mut data);

        let nominal_tray_mass = model.body_mass()[tray_body];
        let ipos = &model.body_ipos()[tray_body * 3..tray_body * 3 + 3];
        let nominal_tray_com_in_grasp = if is_spanner {
            [ipos[0], 0.005 + ipos[1], -0.011 + ipos[2]]
        } else {
            // Nominal fork-clamp tray is rotated -90 deg about Z relative to world.
            [0.25 + ipos[1], -ipos[0], 0.001 + ipos[2]]
        };

        let site_pos = |name: &str| -> Result<[f64; 3]> {
            let sid = lookup(&model, Object::Site, name)?;
            let s = &data.site_xpos()[sid * 3..sid * 3 + 3];
            Ok([s[0], s[1], s[2]])
        };
        let source_site = site_pos("source_tray_center")?;
        let dest_site = site_pos(task.destination())?;
        let robot_mount = site_pos("robot_mount")?;

        Ok(Self {
            model,
            data,
            ik_data,
            arm,
            grasp_site,
            handle_grasp_site,
            tool_body,
            clamp_qpos,
            is_spanner,
            open_jaw_m,
            closed_jaw_m,
            nominal_tray_mass,
            nominal_tray_com_in_grasp,
            source_site,
            dest_site,
            robot_mount,
            work: 0,
        })
    }

    /// Compute actuator `ctrl` via `crate::servo::command` using ONLY
    /// unprivileged `q_meas` and the nominal model.
    pub fn servo_ctrl(&mut self, q_meas: &[f64; 6], q_cmd: &[f64; 6], carrying: bool) -> [f64; 6] {
        self.model.reset(&mut self.data);
        self.arm.set_joints(&mut self.data, q_meas);
        self.data.qpos_mut()[self.clamp_qpos] = if carrying {
            self.closed_jaw_m
        } else {
            self.open_jaw_m
        };
        self.model.forward(&mut self.data);
        let payload = carrying.then(|| {
            let site = &self.data.site_xpos()[self.grasp_site * 3..self.grasp_site * 3 + 3];
            let rot = &self.data.site_xmat()[self.grasp_site * 9..self.grasp_site * 9 + 9];
            let local = self.nominal_tray_com_in_grasp;
            let mut point = [site[0], site[1], site[2]];
            for axis in 0..3 {
                for col in 0..3 {
                    point[axis] += rot[axis * 3 + col] * local[col];
                }
            }
            Payload {
                body: self.tool_body,
                point,
                mass: self.nominal_tray_mass,
            }
        });
        servo::command(&self.model, &mut self.data, &self.arm, q_cmd, payload);
        let ctrl = self.data.ctrl();
        std::array::from_fn(|i| {
            let (lo, hi) = self.arm.limits[i];
            ctrl[self.arm.actuators[i]].clamp(lo, hi)
        })
    }

    /// Forward kinematics of `cell_grasp` on the nominal CAD model.
    pub fn fk_grasp(&mut self, q: &[f64; 6]) -> [f64; 3] {
        self.fk_site(self.grasp_site, q)
    }

    /// Forward kinematics of an arbitrary named site on the nominal CAD model.
    pub fn fk_site(&mut self, site: usize, q: &[f64; 6]) -> [f64; 3] {
        self.arm.set_joints(&mut self.ik_data, q);
        self.model.kinematics(&mut self.ik_data);
        let s = &self.ik_data.site_xpos()[site * 3..site * 3 + 3];
        [s[0], s[1], s[2]]
    }

    /// Solve 6-DOF DLS IK via `crate::ik::solve` with yaw rotation around +Z.
    pub fn solve_ik_yaw(
        &mut self,
        target: [f64; 3],
        yaw_rad: f64,
        seed: [f64; 6],
    ) -> Option<[f64; 6]> {
        let (s, c) = yaw_rad.sin_cos();
        let rot = [c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0];
        if yaw_rad.abs() < 1e-9 {
            let limits = ik::Limits {
                iterations: 350,
                tolerance: 1e-5,
                damping: 1e-4,
            };
            ik::solve(
                &self.model,
                &mut self.ik_data,
                &self.arm,
                self.grasp_site,
                Vector3::new(target[0], target[1], target[2]),
                Orientation::World,
                seed,
                &limits,
                &mut self.work,
            )
        } else {
            self.solve_ik_site_rot(self.grasp_site, target, &rot, seed)
        }
    }

    /// Solve 6-DOF DLS IK for an arbitrary site and row-major rotation matrix.
    pub fn solve_ik_site_rot(
        &mut self,
        site: usize,
        target: [f64; 3],
        rot_row_major: &[f64; 9],
        seed: [f64; 6],
    ) -> Option<[f64; 6]> {
        let limits = ik::Limits {
            iterations: 350,
            tolerance: 1e-5,
            damping: 1e-4,
        };
        ik::solve(
            &self.model,
            &mut self.ik_data,
            &self.arm,
            site,
            Vector3::new(target[0], target[1], target[2]),
            Orientation::Rows(rot_row_major),
            seed,
            &limits,
            &mut self.work,
        )
    }

    pub fn arm_joint_names(&self) -> [String; 6] {
        std::array::from_fn(|i| self.model_joint_name(i))
    }

    fn model_joint_name(&self, idx: usize) -> String {
        let adr = self.arm.positions[idx] as i32;
        for j in 0..self.model.jnt_qposadr().len() {
            if self.model.jnt_qposadr()[j] == adr {
                return self
                    .model
                    .name(Object::Joint, j)
                    .unwrap_or_default()
                    .to_owned();
            }
        }
        String::new()
    }
}

#[derive(Debug)]
pub(crate) enum EpisodeStop {
    EpisodeOver,
    Abort(&'static str),
}

pub(crate) struct ControllerState<'a, P: ClosedLoopPlant + ?Sized> {
    pub cfg: &'a ClosedLoopConfig,
    pub nom: &'a mut NominalDynamics,
    pub plant: &'a mut P,
    pub cam: CameraModel,
    pub meas: PlantMeas,
    pub last_rgb: Vec<u8>,
    pub has_camera: bool,
    pub cmd_q: [f64; 6],
    pub cmd_g: f64,
    pub carrying: bool,
    pub tick: usize,
    pub monitor: FaultMonitor,
}

impl<'a, P: ClosedLoopPlant + ?Sized> ControllerState<'a, P> {
    pub fn new(
        cfg: &'a ClosedLoopConfig,
        nom: &'a mut NominalDynamics,
        plant: &'a mut P,
        cam: CameraModel,
    ) -> Result<Self> {
        let meas0 = plant.begin()?;
        let (_, _, rgb0) = plant.read_rgb()?;
        let has_camera = !rgb0.is_empty();
        let ts0 = meas0.cam_timestamp.unwrap_or(0.0);
        let monitor = FaultMonitor::new(ts0, rgb0.clone(), meas0.q, meas0.gripper, nom.is_spanner);
        Ok(Self {
            cfg,
            nom,
            plant,
            cam,
            last_rgb: rgb0,
            has_camera,
            cmd_q: meas0.q,
            cmd_g: meas0.gripper,
            meas: meas0,
            carrying: false,
            tick: 0,
            monitor,
        })
    }

    pub fn finish(&mut self, res: Result<(), EpisodeStop>) -> (&'static str, &'static str) {
        let outcome = match res {
            Ok(()) | Err(EpisodeStop::EpisodeOver) => ("done", ""),
            Err(EpisodeStop::Abort(fault)) => {
                // When aborting unladen (e.g. `dead_gripper` right at `p_grasp`), retract
                // cleanly upward (+26 cm) so post-abort uncompensated settle never droops
                // the jaw into the stainless prep table.
                let g_hold = self.cmd_g;
                let carry = self.carrying;
                let mut q_hold = self.cmd_q;
                if !carry && fault == "dead_gripper" {
                    let cur_p = self.nom.fk_grasp(&q_hold);
                    let rot = &self.nom.ik_data.site_xmat()
                        [self.nom.grasp_site * 9..self.nom.grasp_site * 9 + 9];
                    let cur_yaw = rot[3].atan2(rot[0]);
                    let safe_p = [cur_p[0], cur_p[1], cur_p[2] + 0.26];
                    let q_safe = self.solve_ik(safe_p, cur_yaw, q_hold);
                    let steps = 24usize;
                    for i in 1..=steps {
                        let s = i as f64 / steps as f64;
                        let q_i = std::array::from_fn(|k| q_hold[k] + s * (q_safe[k] - q_hold[k]));
                        let ctrl = self.nom.servo_ctrl(&self.meas.q, &q_i, false);
                        if let Ok(PlantStep::Meas(m)) = self.plant.step(&ctrl, g_hold) {
                            self.meas = m;
                        }
                    }
                    q_hold = q_safe;
                }
                for _ in 0..3 {
                    let ctrl = self.nom.servo_ctrl(&self.meas.q, &q_hold, carry);
                    if let Ok(PlantStep::Meas(m)) = self.plant.step(&ctrl, g_hold) {
                        self.meas = m;
                    }
                }
                ("abort", fault)
            }
        };
        let _ = self.plant.end();
        outcome
    }

    pub fn step_to(
        &mut self,
        q_cmd: [f64; 6],
        g_cmd: f64,
        carrying: bool,
        check_grip: Option<&str>,
    ) -> Result<(), EpisodeStop> {
        let ctrl = self.nom.servo_ctrl(&self.meas.q, &q_cmd, carrying);
        let reply = match self.plant.step(&ctrl, g_cmd) {
            Ok(r) => r,
            Err(_) => return Err(EpisodeStop::EpisodeOver),
        };
        let next = match reply {
            PlantStep::Meas(m) => m,
            PlantStep::EpisodeOver => return Err(EpisodeStop::EpisodeOver),
        };
        self.meas = next;
        self.cmd_q = q_cmd;
        self.cmd_g = g_cmd;
        self.carrying = carrying;
        self.tick += 1;

        if self.has_camera {
            let ts = self
                .meas
                .cam_timestamp
                .unwrap_or(self.tick as f64 * self.cfg.control_dt_s);
            let rgb = match self.plant.read_rgb() {
                Ok((_, _, buf)) => buf,
                Err(_) => return Err(EpisodeStop::EpisodeOver),
            };
            let fault = self
                .monitor
                .update(ts, &rgb, &self.meas.q, self.meas.gripper, check_grip);
            self.last_rgb = rgb;
            if let Some(fault) = fault {
                return Err(EpisodeStop::Abort(fault));
            }
        }
        Ok(())
    }

    pub fn read_rgbd_cloud(&mut self) -> Result<Cloud, EpisodeStop> {
        if !self.has_camera {
            return Ok(Cloud {
                x: Vec::new(),
                y: Vec::new(),
                z: Vec::new(),
                rgb: Vec::new(),
            });
        }
        let (h, w, depth) = match self.plant.read_depth() {
            Ok(d) => d,
            Err(_) => return Err(EpisodeStop::EpisodeOver),
        };
        Ok(self.cam.deproject(&depth, &self.last_rgb, h, w))
    }

    pub fn solve_ik(&mut self, target: [f64; 3], yaw_rad: f64, q_seed: [f64; 6]) -> [f64; 6] {
        let is_fr10_spanner = self.nom.is_spanner && self.cfg.robot == Robot::FairinoFr10;
        let branch_ok = |q: &[f64; 6]| -> bool {
            if !is_fr10_spanner {
                return true;
            }
            (-2.20..=-0.35).contains(&q[1])
                && (0.35..=2.65).contains(&q[2])
                && (q[5] - std::f64::consts::FRAC_PI_2).abs() < 0.35
        };

        if let Some(q) = self.nom.solve_ik_yaw(target, yaw_rad, q_seed)
            && branch_ok(&q)
        {
            return q;
        }
        if is_fr10_spanner {
            let des_x = [-yaw_rad.sin(), yaw_rad.cos()];
            let wx = target[0] - 0.240 * des_x[0];
            let wy = target[1] - 0.240 * des_x[1];
            let dx = wx - self.nom.robot_mount[0];
            let dy = wy - self.nom.robot_mount[1];
            let j1 = (-dx).atan2(dy.max(0.05));
            let j5 = std::f64::consts::FRAC_PI_2 + j1 - yaw_rad;
            let seeds = [
                [j1, -1.15, 2.00, -0.85, j5, std::f64::consts::FRAC_PI_2],
                [j1, -0.85, 1.55, -0.70, j5, std::f64::consts::FRAC_PI_2],
                [j1, -1.45, 2.25, -0.80, j5, std::f64::consts::FRAC_PI_2],
                [
                    -50.0_f64.to_radians(),
                    -106.0_f64.to_radians(),
                    136.0_f64.to_radians(),
                    -30.0_f64.to_radians(),
                    40.0_f64.to_radians(),
                    90.0_f64.to_radians(),
                ],
            ];
            for seed in seeds {
                if let Some(q) = self.nom.solve_ik_yaw(target, yaw_rad, seed)
                    && branch_ok(&q)
                {
                    return q;
                }
            }
        }
        self.nom
            .solve_ik_yaw(target, yaw_rad, q_seed)
            .unwrap_or(q_seed)
    }

    pub fn move_joints(
        &mut self,
        q_target: [f64; 6],
        g_target: f64,
        carrying: bool,
        max_rad_per_s: f64,
        min_s: f64,
        settle_s: f64,
    ) -> Result<(), EpisodeStop> {
        let dt = self.cfg.control_dt_s;
        let q_start = self.cmd_q;
        let g_start = self.cmd_g;
        let max_d = q_target
            .iter()
            .zip(&q_start)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f64, f64::max);
        let max_step_rad = (max_rad_per_s * dt).max(0.005);
        let min_ticks = (min_s / dt).round().max(4.0) as usize;
        let n_steps = ((max_d / max_step_rad).ceil() as usize).max(min_ticks);
        for i in 1..=n_steps {
            let s = 0.5 * (1.0 - (std::f64::consts::PI * i as f64 / n_steps as f64).cos());
            let q_i = std::array::from_fn(|k| q_start[k] + s * (q_target[k] - q_start[k]));
            let g_i = g_start + s * (g_target - g_start);
            self.step_to(q_i, g_i, carrying, None)?;
        }
        let settle_ticks = (settle_s / dt).round() as usize;
        for _ in 0..settle_ticks {
            self.step_to(q_target, g_target, carrying, None)?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn move_cartesian(
        &mut self,
        p_start: [f64; 3],
        p_end: [f64; 3],
        yaw_start: f64,
        yaw_end: f64,
        g_target: f64,
        carrying: bool,
        step_m: f64,
        max_rad_per_s: f64,
        settle_s: f64,
    ) -> Result<(), EpisodeStop> {
        let dt = self.cfg.control_dt_s;
        let dist = ((p_end[0] - p_start[0]).powi(2)
            + (p_end[1] - p_start[1]).powi(2)
            + (p_end[2] - p_start[2]).powi(2))
        .sqrt();
        let n_wp = ((dist / step_m).ceil() as usize).max(2);
        let max_step_rad = (max_rad_per_s * dt).max(0.005);
        let mut q_prev = self.cmd_q;
        for k in 1..=n_wp {
            let s = 0.5 * (1.0 - (std::f64::consts::PI * k as f64 / n_wp as f64).cos());
            let p_k = [
                p_start[0] + s * (p_end[0] - p_start[0]),
                p_start[1] + s * (p_end[1] - p_start[1]),
                p_start[2] + s * (p_end[2] - p_start[2]),
            ];
            let y_k = yaw_start + s * (yaw_end - yaw_start);
            let q_k = self.solve_ik(p_k, y_k, q_prev);
            let max_dq = q_k
                .iter()
                .zip(&q_prev)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f64, f64::max);
            let sub = ((max_dq / max_step_rad).ceil() as usize).max(1);
            for j in 1..=sub {
                let frac = j as f64 / sub as f64;
                let q_j = std::array::from_fn(|idx| q_prev[idx] + frac * (q_k[idx] - q_prev[idx]));
                self.step_to(q_j, g_target, carrying, None)?;
            }
            q_prev = q_k;
        }
        let settle_ticks = (settle_s / dt).round() as usize;
        for _ in 0..settle_ticks {
            self.step_to(q_prev, g_target, carrying, None)?;
        }
        Ok(())
    }

    pub fn actuate_gripper(
        &mut self,
        g_target: f64,
        carrying: bool,
        ramp_s: f64,
        hold_s: f64,
        mode: &str,
    ) -> Result<(), EpisodeStop> {
        let dt = self.cfg.control_dt_s;
        let q_hold = self.cmd_q;
        let g_start = self.cmd_g;
        let ticks = (ramp_s / dt).round().max(8.0) as usize;
        for i in 1..=ticks {
            let s = i as f64 / ticks as f64;
            self.step_to(q_hold, g_start + s * (g_target - g_start), carrying, None)?;
        }
        let hold_ticks = if hold_s <= 0.0 {
            0
        } else if mode == "open" {
            (hold_s / dt).round().max(10.0) as usize
        } else {
            (hold_s / dt).round().max(18.0) as usize
        };
        for i in 0..hold_ticks {
            let check = (i >= 6).then_some(mode);
            self.step_to(q_hold, g_target, carrying, check)?;
        }
        Ok(())
    }

    pub fn measure_spanner_z(
        &mut self,
        cal: PlaneCal,
        target_xy: [f64; 2],
        yaw_rad: f64,
    ) -> Result<f64, EpisodeStop> {
        if !self.has_camera {
            return Ok(0.0);
        }
        let cloud = self.read_rgbd_cloud()?;
        let site_fk = self.nom.fk_grasp(&self.cmd_q);
        // Spanner beam top sits +0.064 + 0.0085 = +0.0725 m above `cell_grasp`.
        // Sample strictly the open-sky forward beam strip (`±14 mm` width, `[+0.02, +0.13]`
        // clear of both the robot wrist/forearm at `along <= 0` and the rear jaw stem at
        // `+0.155`) at the 65th percentile so neither wrist overhang nor oblique beam sides
        // bias `dz`.
        let z_beam_fk = site_fk[2] + 0.0725;
        let along = [-yaw_rad.sin(), yaw_rad.cos()];
        Ok(measure_ee_z_offset(
            &self.cam, &cloud, cal, target_xy, along, z_beam_fk, 0.014, 0.02, 0.13, 65.0,
        ))
    }

    fn measure_fork_z(
        &mut self,
        cal: PlaneCal,
        grasp_xy: [f64; 2],
        yaw_rad: f64,
    ) -> Result<f64, EpisodeStop> {
        if !self.has_camera {
            return Ok(0.0);
        }
        let cloud = self.read_rgbd_cloud()?;
        let site_fk = self.nom.fk_grasp(&self.cmd_q);
        // `clamp_bridge` rides on `cell_upper_jaw`: top is +0.045 + clamp_opening above `cell_grasp`
        let along = [yaw_rad.cos(), yaw_rad.sin()];
        let bridge_xy = [
            grasp_xy[0] - 0.095 * along[0],
            grasp_xy[1] - 0.095 * along[1],
        ];
        let z_bridge_fk = site_fk[2] + 0.045 + self.meas.gripper;
        Ok(measure_ee_z_offset(
            &self.cam,
            &cloud,
            cal,
            bridge_xy,
            along,
            z_bridge_fk,
            0.16,
            -0.022,
            0.022,
            50.0,
        ))
    }
}

struct SpannerMotionProfile {
    peek: [f64; 3],
    pull_y: f64,
    pull_min_x: f64,
    corridor_x: f64,
    corridor_y: f64,
    back: [f64; 3],
    return_home: bool,
}

impl SpannerMotionProfile {
    fn for_robot(robot: Robot) -> Self {
        match robot {
            // UR5e mounts closer to the oven (`base=(-0.06,-0.96,0.95)`, 0.85 m reach):
            // keep `grasp_y >= -0.44` (flange `>= -0.695`) across peek and corridor moves so
            // `elbow_joint` stays clear of its `-2.60 rad` upper-arm self-collision boundary.
            Robot::UniversalRobotsUr5e => Self {
                peek: [0.04, -0.38, 1.22],
                pull_y: -0.44,
                pull_min_x: 0.30,
                corridor_x: 0.04,
                corridor_y: -0.44,
                back: [0.04, -0.42, 1.22],
                return_home: false,
            },
            _ => Self {
                peek: [0.16, -0.68, 1.30],
                pull_y: -0.52,
                pull_min_x: 0.32,
                corridor_x: 0.04,
                corridor_y: -0.52,
                back: [0.16, -0.54, 1.28],
                return_home: true,
            },
        }
    }
}

fn spanner_tray_roi() -> RoiBox {
    RoiBox {
        x_min: 0.04,
        x_max: 0.82,
        y_min: -0.52,
        y_max: 0.14,
        z_min: 0.008,
        z_max: 0.050,
    }
}

struct SpannerPickup {
    dz_prep: f64,
    x_prep_cal: f64,
    tz: f64,
    end_pos: [f64; 3],
}

/// Shared closed-loop overhead spanner pickup from the prep table.
///
/// Handles table-plane calibration, T3 `push` probe + peek re-localization, gentle
/// two-stage rim touch-down, T4 `dead_gripper` verification, and T3 `slip` re-grasp
/// for both oven loading (`table-to-oven`) and cooling-rack transfer (`table-to-rack`).
#[allow(clippy::too_many_arguments)]
fn spanner_pickup<P: ClosedLoopPlant + ?Sized>(
    st: &mut ControllerState<'_, P>,
    profile: &SpannerMotionProfile,
    cal: PlaneCal,
    table_z_nom: f64,
    tray_roi: RoiBox,
    mut tx: f64,
    mut ty: f64,
    mut tz: f64,
    mut tyaw: f64,
    lift_z_floor: f64,
    clear_target_xy: [f64; 2],
    use_pull_corridor: bool,
) -> Result<SpannerPickup, EpisodeStop> {
    let open_g = st.nom.open_jaw_m;
    let close_g = st.nom.closed_jaw_m;
    let mut dz_prep = 0.0;
    let mut x_prep_cal = tx;
    let mut end_pos = [clear_target_xy[0], clear_target_xy[1], lift_z_floor];

    for attempt in 0..2 {
        let p_hover = [tx, ty, tz + 0.160];
        let cur_p = st.nom.fk_grasp(&st.cmd_q);
        if attempt == 0 && (cur_p[0] - p_hover[0]).hypot(cur_p[1] - p_hover[1]) < 0.25 {
            st.move_cartesian(cur_p, p_hover, 0.0, tyaw, open_g, false, 0.020, 1.0, 0.28)?;
        } else {
            let q_hover = st.solve_ik(p_hover, tyaw, st.cmd_q);
            st.move_joints(q_hover, open_g, false, 1.15, 0.20, 0.28)?;
        }
        dz_prep = st.measure_spanner_z(cal, [tx, ty], tyaw)?;

        // Probe with rear jaw hovering +66 mm above tray center (35 mm clear of
        // `cold_contents` and 46 mm clear of the rim even at +/-1.5 deg tilt, yet
        // rear pad sits at +71 mm < 80 mm from tray center so any T3 `push` fires
        // harmlessly underneath the jaw), then swing clear to re-perceive.
        let probe_y_axis = [-tyaw.sin(), tyaw.cos()];
        let p_probe = [
            tx - 0.155 * probe_y_axis[0],
            ty - 0.155 * probe_y_axis[1],
            tz + 0.066 - dz_prep,
        ];
        st.move_cartesian(
            p_hover, p_probe, tyaw, tyaw, open_g, false, 0.016, 1.0, 0.24,
        )?;
        st.move_cartesian(
            p_probe, p_hover, tyaw, tyaw, open_g, false, 0.020, 1.0, 0.04,
        )?;

        st.move_cartesian(
            p_hover,
            profile.peek,
            tyaw,
            0.0,
            open_g,
            false,
            0.026,
            1.2,
            0.12,
        )?;
        let cloud_re = st.read_rgbd_cloud()?;
        if let Some(p) = perceive_tray(&st.cam, &cloud_re, cal, tray_roi, table_z_nom, 0.28, true) {
            tx = p.cx;
            ty = p.cy;
            tz = p.z_table;
            tyaw = p.yaw_rad;
        }
        // +7 mm along tool +Y doubles rear-rim clearance (5 mm -> 12 mm) on high-yaw descents
        // while keeping 38 mm clearance on the open front jaw.
        let des_y = [-tyaw.sin(), tyaw.cos()];
        let gx = tx + 0.007 * des_y[0];
        let gy = ty + 0.007 * des_y[1];
        let p_hover2 = [gx, gy, tz + 0.160];
        st.move_cartesian(
            profile.peek,
            p_hover2,
            0.0,
            tyaw,
            open_g,
            false,
            0.026,
            1.2,
            0.28,
        )?;
        dz_prep = st.measure_spanner_z(cal, [gx, gy], tyaw)?;
        x_prep_cal = gx;

        // Two-stage gentle touch-down to calibrated grasp height (`+13.2 mm` above table:
        // pad bottom sits +11.7 mm above `table_top` — clear even at +/-1.5 deg tilt — while
        // engaging 8.3 mm of the 20.0 mm rim with unbiased 80th-percentile beam Z calibration).
        let p_pre_grasp = [gx, gy, tz + 0.045 - dz_prep];
        let p_grasp = [gx, gy, tz + 0.0132 - dz_prep];
        st.move_cartesian(
            p_hover2,
            p_pre_grasp,
            tyaw,
            tyaw,
            open_g,
            false,
            0.010,
            0.90,
            0.04,
        )?;
        st.move_cartesian(
            p_pre_grasp,
            p_grasp,
            tyaw,
            tyaw,
            open_g,
            false,
            0.003,
            0.50,
            0.16,
        )?;

        // Two-stage soft silicone pinch: fast free-travel to +12 mm, then slow rim
        // centering (`24.5 mm/s`) into `close_g` so sliding trays never bounce > 35 N
        // against the rear fixed jaw, followed by T4 `dead_gripper` verification.
        st.actuate_gripper(0.012, false, 0.28, 0.0, "none")?;
        st.actuate_gripper(close_g, false, 0.95, 0.36, "close")?;

        // Ultra-gentle initial breakaway lift (+42 mm) absorbs any T3 `slip` 3g jerk
        // below 35 N without rim wedging, then smooth lift clear of prep table.
        let lift_z = lift_z_floor.max(tz + 0.240) - dz_prep;
        let p_lift_init = [p_grasp[0], p_grasp[1], tz + 0.053 - dz_prep];
        let p_lifted = [p_grasp[0], p_grasp[1], lift_z];
        st.move_cartesian(
            p_grasp,
            p_lift_init,
            tyaw,
            tyaw,
            close_g,
            true,
            0.003,
            0.32,
            0.10,
        )?;
        st.move_cartesian(
            p_lift_init,
            p_lifted,
            tyaw,
            tyaw,
            close_g,
            true,
            0.010,
            0.85,
            0.16,
        )?;

        if use_pull_corridor {
            // Pull back in -Y BEFORE traversing -X so shifted trays never brush the oven corner!
            let p_pull = [p_lifted[0].max(profile.pull_min_x), profile.pull_y, lift_z];
            st.move_cartesian(
                p_lifted, p_pull, tyaw, 0.0, close_g, true, 0.016, 0.90, 0.06,
            )?;
            end_pos = [
                clear_target_xy[0],
                clear_target_xy[1],
                lift_z_floor.max(tz + 0.240) - 0.5 * dz_prep,
            ];
            st.move_cartesian(p_pull, end_pos, 0.0, 0.0, close_g, true, 0.016, 0.95, 0.12)?;
        } else {
            // Move cleanly out of the prep-table ROI toward the rack so T3 `slip` is visible.
            end_pos = [
                clear_target_xy[0],
                clear_target_xy[1],
                lift_z_floor.max(tz + 0.240) - 0.5 * dz_prep,
            ];
            st.move_cartesian(
                p_lifted, end_pos, tyaw, 0.0, close_g, true, 0.014, 0.90, 0.12,
            )?;
        }

        if attempt == 0 {
            let cloud_chk = st.read_rgbd_cloud()?;
            if let Some(left) =
                perceive_tray(&st.cam, &cloud_chk, cal, tray_roi, table_z_nom, 0.28, true)
            {
                // Tray slipped back onto prep table! Open, re-localize, and re-grasp.
                st.actuate_gripper(open_g, false, 0.32, 0.36, "open")?;
                tx = left.cx;
                ty = left.cy;
                tz = left.z_table;
                tyaw = left.yaw_rad;
                continue;
            }
        }
        break;
    }

    Ok(SpannerPickup {
        dz_prep,
        x_prep_cal,
        tz,
        end_pos,
    })
}

struct SpannerScene {
    profile: SpannerMotionProfile,
    table_z_nom: f64,
    tray_roi: RoiBox,
    cloud0: Cloud,
    cal: PlaneCal,
    tray: (f64, f64, f64, f64),
}

fn spanner_perceive_initial<P: ClosedLoopPlant + ?Sized>(
    st: &mut ControllerState<'_, P>,
    always_peek: bool,
) -> Result<SpannerScene, EpisodeStop> {
    let open_g = st.nom.open_jaw_m;
    let nom_src = st.nom.source_site;
    let table_z_nom = nom_src[2] - 0.0005;
    let profile = SpannerMotionProfile::for_robot(st.cfg.robot);
    let table_roi = spanner_table_roi(table_z_nom);
    let tray_roi = spanner_tray_roi();

    // Swing clear to `profile.peek` when starting over the prep tray (e.g. UR5e home or
    // combined rack transfer) so `cloud0` sees the bare table, full tray, and fixtures.
    let cur_p0 = st.nom.fk_grasp(&st.cmd_q);
    if always_peek || (cur_p0[0] - nom_src[0]).hypot(cur_p0[1] - nom_src[1]) < 0.22 {
        let step_m = if always_peek { 0.022 } else { 0.020 };
        st.move_cartesian(
            cur_p0,
            profile.peek,
            0.0,
            0.0,
            open_g,
            false,
            step_m,
            1.0,
            0.10,
        )?;
    } else {
        let p_clear0 = [cur_p0[0] + 0.04, cur_p0[1] - 0.04, cur_p0[2] + 0.06];
        st.move_cartesian(cur_p0, p_clear0, 0.0, 0.0, open_g, false, 0.020, 1.0, 0.04)?;
    }

    let cloud0 = st.read_rgbd_cloud()?;
    let cal = calibrate_table_plane(&cloud0, table_roi, table_z_nom);
    let tray = match perceive_tray(&st.cam, &cloud0, cal, tray_roi, table_z_nom, 0.28, true) {
        Some(p) => (p.cx, p.cy, p.z_table, p.yaw_rad),
        None => (nom_src[0], nom_src[1], table_z_nom, 0.0),
    };
    Ok(SpannerScene {
        profile,
        table_z_nom,
        tray_roi,
        cloud0,
        cal,
        tray,
    })
}

/// Hardened Maruzen MBCO-4ME spanner-oven tray loading (`table-to-oven`, all 3 arms).
pub(crate) fn run_spanner_load<P: ClosedLoopPlant + ?Sized>(
    st: &mut ControllerState<'_, P>,
    home_q: [f64; 6],
) -> Result<(), EpisodeStop> {
    let scene = spanner_perceive_initial(st, false)?;
    let (open_g, close_g, nom_dest) = (st.nom.open_jaw_m, st.nom.closed_jaw_m, st.nom.dest_site);
    let (tx, ty, tz, tyaw) = scene.tray;
    let rail2_target = perceive_fixture_target(
        &st.cam,
        &scene.cloud0,
        scene.cal,
        MBCO4_OVEN_ROOF_ROI,
        MBCO4_OVEN_ROOF_CENTER,
        nom_dest,
        0.012,
    );

    let slide_z_off = 0.042;
    let lift_floor = (rail2_target[2] + slide_z_off).max(tz + 0.30);
    let picked = spanner_pickup(
        st,
        &scene.profile,
        scene.cal,
        scene.table_z_nom,
        scene.tray_roi,
        tx,
        ty,
        tz,
        tyaw,
        lift_floor,
        [scene.profile.corridor_x, scene.profile.corridor_y],
        true,
    )?;

    // Stage 2: Align outside MBCO-4ME mouth (extra 4 mm margin to rear baffle stop)
    let rail2_grip = [
        rail2_target[0],
        rail2_target[1] - 0.009,
        rail2_target[2] + 0.011,
    ];
    let slide_z = (rail2_target[2] + slide_z_off).max(picked.tz + 0.30);
    let p_mouth_raw = [rail2_grip[0], rail2_grip[1] - 0.50, slide_z];
    let carry_speed = if st.cfg.robot == Robot::UniversalRobotsUr5e {
        0.72
    } else {
        0.95
    };
    st.move_cartesian(
        picked.end_pos,
        p_mouth_raw,
        0.0,
        0.0,
        close_g,
        true,
        0.012,
        carry_speed,
        0.26,
    )?;

    let dz_oven = st.measure_spanner_z(scene.cal, [p_mouth_raw[0], p_mouth_raw[1]], 0.0)?;
    let sin_tilt = ((picked.dz_prep - dz_oven) / (picked.x_prep_cal - p_mouth_raw[0]).max(0.4))
        .clamp(-0.04, 0.04);
    let dx_oven = (-(rail2_grip[2] - st.nom.robot_mount[2]) * sin_tilt).clamp(-0.014, 0.014);
    let p_mouth = [
        rail2_grip[0] - dx_oven,
        rail2_grip[1] - 0.48,
        slide_z - dz_oven,
    ];
    st.move_cartesian(
        p_mouth_raw,
        p_mouth,
        0.0,
        0.0,
        close_g,
        true,
        0.008,
        0.8,
        0.08,
    )?;

    // Stage 3: Linear slide insertion into MBCO-4ME Rail #2 & `transfer.rs` seating (+4 mm)
    let p_over_rail2 = [rail2_grip[0] - dx_oven, rail2_grip[1], slide_z - dz_oven];
    st.move_cartesian(
        p_mouth,
        p_over_rail2,
        0.0,
        0.0,
        close_g,
        true,
        0.010,
        0.85,
        0.12,
    )?;

    let p_seat = [
        rail2_grip[0] - dx_oven,
        rail2_grip[1],
        rail2_grip[2] + 0.004 - dz_oven,
    ];
    st.move_cartesian(
        p_over_rail2,
        p_seat,
        0.0,
        0.0,
        close_g,
        true,
        0.004,
        0.7,
        0.16,
    )?;

    // Stage 4: Release, clear rear rim (+4 mm +Y), lift inside chamber, retract cleanly
    st.actuate_gripper(open_g, false, 0.45, 0.36, "open")?;
    let p_clear_rear = [p_seat[0], p_seat[1] + 0.004, p_seat[2]];
    st.move_cartesian(
        p_seat,
        p_clear_rear,
        0.0,
        0.0,
        open_g,
        false,
        0.004,
        0.7,
        0.08,
    )?;
    let p_up = [
        p_clear_rear[0],
        p_clear_rear[1],
        rail2_grip[2] + 0.049 - dz_oven,
    ];
    st.move_cartesian(
        p_clear_rear,
        p_up,
        0.0,
        0.0,
        open_g,
        false,
        0.008,
        0.85,
        0.08,
    )?;
    let p_out = [p_up[0], rail2_grip[1] - 0.48, p_up[2]];
    st.move_cartesian(p_up, p_out, 0.0, 0.0, open_g, false, 0.016, 1.0, 0.08)?;
    if scene.profile.return_home {
        st.move_cartesian(
            p_out,
            scene.profile.back,
            0.0,
            0.0,
            open_g,
            false,
            0.022,
            1.1,
            0.04,
        )?;
        st.move_joints(home_q, open_g, false, 1.15, 0.20, 0.20)?;
    }
    Ok(())
}

/// Hardened Maruzen MBCO-4ME spanner-oven cooling-rack transfer (`table-to-rack`, all 3 arms).
fn run_spanner_rack<P: ClosedLoopPlant + ?Sized>(
    st: &mut ControllerState<'_, P>,
) -> Result<(), EpisodeStop> {
    let scene = spanner_perceive_initial(st, true)?;
    let (open_g, close_g, nom_dest) = (st.nom.open_jaw_m, st.nom.closed_jaw_m, st.nom.dest_site);
    let (tx, ty, tz, tyaw) = scene.tray;

    let rack_roi = RoiBox {
        x_min: nom_dest[0] - 0.28,
        x_max: nom_dest[0] + 0.28,
        y_min: nom_dest[1] - 0.24,
        y_max: nom_dest[1] + 0.24,
        z_min: nom_dest[2] - 0.045,
        z_max: nom_dest[2] + 0.035,
    };
    let nom_rack_feature = match st.cfg.robot {
        Robot::UniversalRobotsUr5e => [
            nom_dest[0] + 0.0155,
            nom_dest[1] + 0.0010,
            nom_dest[2] - 0.0005,
        ],
        _ => [
            nom_dest[0] + 0.0013,
            nom_dest[1] - 0.0045,
            nom_dest[2] - 0.0005,
        ],
    };
    let rack_target = perceive_fixture_target(
        &st.cam,
        &scene.cloud0,
        scene.cal,
        rack_roi,
        nom_rack_feature,
        nom_dest,
        0.015,
    );
    let rack_grip = [
        rack_target[0],
        rack_target[1] - 0.005,
        rack_target[2] + 0.011,
    ];

    let clear_z = tz.max(rack_target[2]) + 0.22;
    let picked = spanner_pickup(
        st,
        &scene.profile,
        scene.cal,
        scene.table_z_nom,
        scene.tray_roi,
        tx,
        ty,
        tz,
        tyaw,
        clear_z,
        [rack_grip[0], rack_grip[1]],
        false,
    )?;

    let p_over_rack = picked.end_pos;
    let dz_rack = st.measure_spanner_z(scene.cal, [p_over_rack[0], p_over_rack[1]], 0.0)?;
    let p_pre_place = [rack_grip[0], rack_grip[1], rack_grip[2] + 0.045 - dz_rack];
    let p_place = [rack_grip[0], rack_grip[1], rack_grip[2] + 0.004 - dz_rack];
    st.move_cartesian(
        p_over_rack,
        p_pre_place,
        0.0,
        0.0,
        close_g,
        true,
        0.010,
        0.85,
        0.06,
    )?;
    st.move_cartesian(
        p_pre_place,
        p_place,
        0.0,
        0.0,
        close_g,
        true,
        0.003,
        0.55,
        0.16,
    )?;

    st.actuate_gripper(open_g, false, 0.45, 0.36, "open")?;
    let p_clear_rear = [p_place[0], p_place[1] + 0.004, p_place[2]];
    st.move_cartesian(
        p_place,
        p_clear_rear,
        0.0,
        0.0,
        open_g,
        false,
        0.004,
        0.70,
        0.06,
    )?;
    let p_retract = [
        p_clear_rear[0],
        p_clear_rear[1],
        rack_grip[2] + 0.16 - dz_rack,
    ];
    st.move_cartesian(
        p_clear_rear,
        p_retract,
        0.0,
        0.0,
        open_g,
        false,
        0.014,
        0.90,
        0.20,
    )?;
    Ok(())
}

/// Hardened FR10 + Maruzen MBCO-4ME tray retrieval (`oven-to-table`).
fn run_spanner_unload<P: ClosedLoopPlant + ?Sized>(
    st: &mut ControllerState<'_, P>,
) -> Result<(), EpisodeStop> {
    let open_g = st.nom.open_jaw_m;
    let close_g = st.nom.closed_jaw_m;
    let nom_src_table = st.nom.source_site;
    let table_z_nom = nom_src_table[2] - 0.0005;
    let nom_rail2 = [-0.49, 0.0, 1.1155];

    let table_roi = RoiBox {
        x_min: 0.02,
        x_max: 1.06,
        y_min: -0.58,
        y_max: 0.22,
        z_min: table_z_nom - 0.06,
        z_max: table_z_nom + 0.06,
    };
    let cloud0 = st.read_rgbd_cloud()?;
    let cal = calibrate_table_plane(&cloud0, table_roi, table_z_nom);
    let rail2_pos = perceive_fixture_target(
        &st.cam,
        &cloud0,
        cal,
        MBCO4_OVEN_ROOF_ROI,
        MBCO4_OVEN_ROOF_CENTER,
        nom_rail2,
        0.012,
    );
    // Track prep-table XY/Z shifts (`dest_xy_m` on T1/T2) from bare stainless table
    let table_target = perceive_table_target(
        &st.cam,
        &cloud0,
        cal,
        table_roi,
        [0.4757, -0.1774, table_z_nom],
        nom_src_table,
    );

    // Measure beam Z offset right at starting pose outside oven mouth
    let cur_p = st.nom.fk_grasp(&st.cmd_q);
    let p_mouth = [rail2_pos[0], rail2_pos[1] - 0.48, rail2_pos[2] + 0.060];
    st.move_cartesian(cur_p, p_mouth, 0.0, 0.0, open_g, false, 0.014, 1.0, 0.24)?;
    let dz_oven = st.measure_spanner_z(cal, [p_mouth[0], p_mouth[1]], 0.0)?;
    let p_mouth_cal = [
        rail2_pos[0],
        rail2_pos[1] - 0.48,
        rail2_pos[2] + 0.060 - dz_oven,
    ];
    st.move_cartesian(
        p_mouth,
        p_mouth_cal,
        0.0,
        0.0,
        open_g,
        false,
        0.008,
        0.8,
        0.08,
    )?;

    // Enter oven above tray, lower onto rim (matches `transfer.rs:324`), clamp, lift, extract
    let p_enter = [rail2_pos[0], rail2_pos[1], rail2_pos[2] + 0.060 - dz_oven];
    st.move_cartesian(
        p_mouth_cal,
        p_enter,
        0.0,
        0.0,
        open_g,
        false,
        0.012,
        0.9,
        0.10,
    )?;
    let p_seat = [rail2_pos[0], rail2_pos[1], rail2_pos[2] + 0.011 - dz_oven];
    st.move_cartesian(p_enter, p_seat, 0.0, 0.0, open_g, false, 0.005, 0.75, 0.14)?;
    st.actuate_gripper(close_g, false, 0.65, 0.36, "close")?;

    let slide_z = rail2_pos[2] + 0.042 - dz_oven;
    let p_lift = [rail2_pos[0], rail2_pos[1], slide_z];
    st.move_cartesian(p_seat, p_lift, 0.0, 0.0, close_g, true, 0.008, 0.85, 0.16)?;
    let p_extract = [rail2_pos[0], rail2_pos[1] - 0.48, slide_z];
    st.move_cartesian(p_lift, p_extract, 0.0, 0.0, close_g, true, 0.012, 0.9, 0.10)?;

    // Carry via front corridor to prep table + re-calibrate Z before setting down
    let p_corr = [0.04, -0.48, slide_z];
    st.move_cartesian(
        p_extract, p_corr, 0.0, 0.0, close_g, true, 0.016, 0.95, 0.08,
    )?;
    let dest_grip = [
        table_target[0],
        table_target[1] - 0.005,
        table_target[2] + 0.011,
    ];
    let p_over_tbl = [dest_grip[0], dest_grip[1], slide_z];
    st.move_cartesian(
        p_corr, p_over_tbl, 0.0, 0.0, close_g, true, 0.016, 0.95, 0.24,
    )?;
    let dz_prep = st.measure_spanner_z(cal, [p_over_tbl[0], p_over_tbl[1]], 0.0)?;
    let p_place = [dest_grip[0], dest_grip[1], dest_grip[2] + 0.004 - dz_prep];
    st.move_cartesian(
        p_over_tbl, p_place, 0.0, 0.0, close_g, true, 0.006, 0.75, 0.16,
    )?;

    st.actuate_gripper(open_g, false, 0.45, 0.36, "open")?;
    let p_clear = [p_place[0], p_place[1] + 0.004, p_place[2]];
    st.move_cartesian(p_place, p_clear, 0.0, 0.0, open_g, false, 0.004, 0.7, 0.06)?;
    let p_up = [p_clear[0], p_clear[1], dest_grip[2] + 0.16 - dz_prep];
    st.move_cartesian(p_clear, p_up, 0.0, 0.0, open_g, false, 0.012, 0.9, 0.20)?;
    Ok(())
}

/// Hardened fork-clamp controller for `combined` (`table-to-oven`, `table-to-rack`),
/// `separate` (`table-to-rack`), and `pan-staging` (UR5e, CRX-10iA/L, FR10).
fn run_fork_transfer<P: ClosedLoopPlant + ?Sized>(
    st: &mut ControllerState<'_, P>,
) -> Result<(), EpisodeStop> {
    let open_g = st.nom.open_jaw_m;
    let close_g = st.nom.closed_jaw_m;
    let nom_src = st.nom.source_site;
    let nom_dest = st.nom.dest_site;
    let table_z_nom = nom_src[2] - 0.001;
    let is_oven = st.cfg.task == BakeryTask::Oven;

    let table_roi = RoiBox {
        x_min: nom_src[0] - 0.14,
        x_max: nom_src[0] + 0.56,
        y_min: nom_src[1] - 0.30,
        y_max: nom_src[1] + 0.30,
        z_min: table_z_nom - 0.06,
        z_max: table_z_nom + 0.06,
    };
    let tray_roi = RoiBox {
        x_min: nom_src[0] - 0.40,
        x_max: nom_src[0] + 0.42,
        y_min: nom_src[1] - 0.36,
        y_max: nom_src[1] + 0.33,
        z_min: 0.008,
        z_max: 0.060,
    };

    let cloud0 = st.read_rgbd_cloud()?;
    let cal = calibrate_table_plane(&cloud0, table_roi, table_z_nom);
    let (mut tx, mut ty, mut tz, mut tyaw) =
        match perceive_tray(&st.cam, &cloud0, cal, tray_roi, table_z_nom, 0.38, true) {
            Some(p) => (p.cx, p.cy, p.z_table, p.yaw_rad),
            None => (nom_src[0], nom_src[1], table_z_nom, 0.0),
        };

    let dest_target = if is_oven {
        let nom_roof = [
            nom_dest[0] + 0.038,
            nom_dest[1] - 0.064,
            nom_dest[2] + 0.348,
        ];
        let oven_roi = RoiBox {
            x_min: nom_roof[0] - 0.36,
            x_max: nom_roof[0] + 0.36,
            y_min: nom_roof[1] - 0.44,
            y_max: nom_roof[1] + 0.44,
            z_min: nom_roof[2] - 0.04,
            z_max: nom_roof[2] + 0.06,
        };
        perceive_fixture_target(&st.cam, &cloud0, cal, oven_roi, nom_roof, nom_dest, 0.020)
    } else {
        let nom_rack = if st.cfg.cell == Cell::Combined {
            [
                nom_dest[0] - 0.0042,
                nom_dest[1] + 0.0037,
                nom_dest[2] - 0.001,
            ]
        } else {
            [
                nom_dest[0] - 0.0041,
                nom_dest[1] + 0.1925,
                nom_dest[2] - 0.001,
            ]
        };
        let rack_roi = RoiBox {
            x_min: nom_dest[0] - 0.42,
            x_max: nom_dest[0] + 0.42,
            y_min: nom_dest[1] - 0.30,
            y_max: nom_dest[1] + 0.30,
            z_min: nom_dest[2] - 0.04,
            z_max: nom_dest[2] + 0.04,
        };
        perceive_fixture_target(&st.cam, &cloud0, cal, rack_roi, nom_rack, nom_dest, 0.020)
    };

    let clearance = if is_oven { 0.50 } else { 0.32 };
    let table_left_x = nom_src[0] - 0.06;
    let mut cur_p = st.nom.fk_grasp(&st.cmd_q);
    let mut dz_prep = 0.0;
    let mut seat_off = 0.25;
    let mut p_lifted = [nom_src[0] - 0.25, nom_src[1], table_z_nom + clearance];

    for attempt in 0..2 {
        let ux = tyaw.cos();
        let uy = tyaw.sin();
        let p_cal = [tx - 0.50 * ux, ty - 0.50 * uy, tz + 0.024];
        st.move_cartesian(cur_p, p_cal, 0.0, tyaw, open_g, false, 0.018, 0.85, 0.24)?;
        dz_prep = st.measure_fork_z(cal, [p_cal[0], p_cal[1]], tyaw)?;

        let p_low = [tx - 0.50 * ux, ty - 0.50 * uy, tz - 0.003 - dz_prep];
        st.move_cartesian(p_cal, p_low, tyaw, tyaw, open_g, false, 0.010, 0.80, 0.08)?;
        let p_probe = [tx - 0.40 * ux, ty - 0.40 * uy, tz - 0.003 - dz_prep];
        st.move_cartesian(p_low, p_probe, tyaw, tyaw, open_g, false, 0.012, 0.80, 0.22)?;
        st.move_cartesian(p_probe, p_low, tyaw, tyaw, open_g, false, 0.015, 0.85, 0.12)?;

        let cloud_re = st.read_rgbd_cloud()?;
        if let Some(p) = perceive_tray(&st.cam, &cloud_re, cal, tray_roi, table_z_nom, 0.38, true) {
            tx = p.cx;
            ty = p.cy;
            tz = p.z_table;
            tyaw = p.yaw_rad;
        }
        let ux = tyaw.cos();
        let uy = tyaw.sin();
        let max_tip_x_nom = (tx - 0.25 * ux) + 0.15 * ux + 0.14 * uy.abs();
        let backoff = (max_tip_x_nom - (table_left_x - 0.015)).clamp(0.0, 0.085);
        seat_off = 0.25 + backoff;
        let p_seat = [tx - seat_off * ux, ty - seat_off * uy, tz - dz_prep];
        let p_pre = [
            p_seat[0] - 0.25 * ux,
            p_seat[1] - 0.25 * uy,
            tz - 0.003 - dz_prep,
        ];
        st.move_cartesian(p_low, p_pre, tyaw, tyaw, open_g, false, 0.014, 0.85, 0.10)?;

        let p_ins = [p_seat[0], p_seat[1], tz - 0.003 - dz_prep];
        st.move_cartesian(p_pre, p_ins, tyaw, tyaw, open_g, false, 0.010, 0.75, 0.10)?;
        st.move_cartesian(p_ins, p_seat, tyaw, tyaw, open_g, false, 0.003, 0.65, 0.12)?;
        st.actuate_gripper(close_g, false, 0.55, 0.36, "close")?;

        p_lifted = [p_seat[0], p_seat[1], tz + clearance - dz_prep];
        st.move_cartesian(
            p_seat, p_lifted, tyaw, tyaw, close_g, true, 0.014, 0.75, 0.24,
        )?;

        let p_clear_src = [p_lifted[0] - 0.25, p_lifted[1], p_lifted[2]];
        st.move_cartesian(
            p_lifted,
            p_clear_src,
            tyaw,
            0.0,
            close_g,
            true,
            0.016,
            0.80,
            0.14,
        )?;
        cur_p = p_clear_src;
        p_lifted = p_clear_src;

        if attempt == 0 {
            let cloud_chk = st.read_rgbd_cloud()?;
            if let Some(left) =
                perceive_tray(&st.cam, &cloud_chk, cal, tray_roi, table_z_nom, 0.38, true)
            {
                st.actuate_gripper(open_g, false, 0.45, 0.36, "open")?;
                tx = left.cx;
                ty = left.cy;
                tz = left.z_table;
                tyaw = left.yaw_rad;
                continue;
            }
        }
        break;
    }

    let dest_grip = [
        dest_target[0] - seat_off,
        dest_target[1],
        dest_target[2] - 0.001,
    ];
    if is_oven {
        let outside_x = (nom_src[0] - 0.25) - 0.37;
        let p_trans = [
            p_lifted[0],
            dest_grip[1],
            dest_grip[2] + clearance - dz_prep,
        ];
        st.move_cartesian(
            p_lifted, p_trans, 0.0, 0.0, close_g, true, 0.016, 0.80, 0.10,
        )?;
        let p_front_hi = [outside_x, dest_grip[1], dest_grip[2] + clearance - dz_prep];
        st.move_cartesian(
            p_trans, p_front_hi, 0.0, 0.0, close_g, true, 0.016, 0.80, 0.10,
        )?;
        let p_align = [outside_x, dest_grip[1], dest_grip[2] + 0.012 - dz_prep];
        st.move_cartesian(
            p_front_hi, p_align, 0.0, 0.0, close_g, true, 0.014, 0.75, 0.24,
        )?;
        let dz_oven = st.measure_fork_z(cal, [p_align[0], p_align[1]], 0.0)?;
        let p_align_cal = [outside_x, dest_grip[1], dest_grip[2] + 0.012 - dz_oven];
        st.move_cartesian(
            p_align,
            p_align_cal,
            0.0,
            0.0,
            close_g,
            true,
            0.006,
            0.65,
            0.08,
        )?;

        let p_ins = [dest_grip[0], dest_grip[1], dest_grip[2] + 0.012 - dz_oven];
        st.move_cartesian(
            p_align_cal,
            p_ins,
            0.0,
            0.0,
            close_g,
            true,
            0.010,
            0.75,
            0.10,
        )?;
        let p_place = [dest_grip[0], dest_grip[1], dest_grip[2] - dz_oven];
        st.move_cartesian(p_ins, p_place, 0.0, 0.0, close_g, true, 0.004, 0.65, 0.14)?;
        st.actuate_gripper(open_g, false, 0.45, 0.36, "open")?;
        let p_drop_forks = [dest_grip[0], dest_grip[1], dest_grip[2] - 0.006 - dz_oven];
        st.move_cartesian(
            p_place,
            p_drop_forks,
            0.0,
            0.0,
            open_g,
            false,
            0.003,
            0.65,
            0.08,
        )?;
        let p_ret = [outside_x, dest_grip[1], dest_grip[2] - 0.006 - dz_oven];
        st.move_cartesian(
            p_drop_forks,
            p_ret,
            0.0,
            0.0,
            open_g,
            false,
            0.014,
            0.85,
            0.20,
        )?;
    } else {
        let p_over = [
            dest_grip[0],
            dest_grip[1],
            dest_grip[2] + clearance - dz_prep,
        ];
        st.move_cartesian(p_lifted, p_over, 0.0, 0.0, close_g, true, 0.016, 0.80, 0.24)?;
        let dz_rack = st.measure_fork_z(cal, [p_over[0], p_over[1]], 0.0)?;
        let p_place = [dest_grip[0], dest_grip[1], dest_grip[2] - dz_rack];
        st.move_cartesian(p_over, p_place, 0.0, 0.0, close_g, true, 0.008, 0.75, 0.14)?;
        st.actuate_gripper(open_g, false, 0.45, 0.36, "open")?;
        let p_drop_forks = [dest_grip[0], dest_grip[1], dest_grip[2] - 0.006 - dz_rack];
        st.move_cartesian(
            p_place,
            p_drop_forks,
            0.0,
            0.0,
            open_g,
            false,
            0.003,
            0.65,
            0.08,
        )?;
        let p_ret = [
            dest_grip[0] - 0.30,
            dest_grip[1],
            dest_grip[2] - 0.006 - dz_rack,
        ];
        st.move_cartesian(
            p_drop_forks,
            p_ret,
            0.0,
            0.0,
            open_g,
            false,
            0.014,
            0.85,
            0.20,
        )?;
    }
    Ok(())
}

/// Hardened fork-clamp oven retrieval (`oven-to-table` on `combined` cell).
fn run_fork_unload<P: ClosedLoopPlant + ?Sized>(
    st: &mut ControllerState<'_, P>,
) -> Result<(), EpisodeStop> {
    let open_g = st.nom.open_jaw_m;
    let close_g = st.nom.closed_jaw_m;
    let nom_src_table = st.nom.source_site;
    let table_z_nom = nom_src_table[2] - 0.001;
    let nom_oven_slot = [1.337, 0.45, 0.801];

    let table_roi = RoiBox {
        x_min: nom_src_table[0] - 0.14,
        x_max: nom_src_table[0] + 0.65,
        y_min: nom_src_table[1] - 0.34,
        y_max: nom_src_table[1] + 0.34,
        z_min: table_z_nom - 0.06,
        z_max: table_z_nom + 0.06,
    };
    let nom_roof = [
        nom_oven_slot[0] + 0.038,
        nom_oven_slot[1] - 0.064,
        nom_oven_slot[2] + 0.348,
    ];
    let oven_roi = RoiBox {
        x_min: nom_roof[0] - 0.36,
        x_max: nom_roof[0] + 0.36,
        y_min: nom_roof[1] - 0.44,
        y_max: nom_roof[1] + 0.44,
        z_min: nom_roof[2] - 0.04,
        z_max: nom_roof[2] + 0.06,
    };

    let cloud0 = st.read_rgbd_cloud()?;
    let cal = calibrate_table_plane(&cloud0, table_roi, table_z_nom);
    let slot_pos = perceive_fixture_target(
        &st.cam,
        &cloud0,
        cal,
        oven_roi,
        nom_roof,
        nom_oven_slot,
        0.020,
    );
    let table_target = perceive_table_target(
        &st.cam,
        &cloud0,
        cal,
        table_roi,
        [nom_src_table[0] + 0.2595, nom_src_table[1], table_z_nom],
        nom_src_table,
    );

    let source = [slot_pos[0] - 0.25, slot_pos[1], slot_pos[2] - 0.001];
    let destination = [
        table_target[0] - 0.25,
        table_target[1],
        table_target[2] - 0.001,
    ];
    let outside = [destination[0] - 0.37, source[1], source[2]];

    let cur_p = st.nom.fk_grasp(&st.cmd_q);
    let p_align = [outside[0], outside[1], outside[2] - 0.006];
    st.move_cartesian(cur_p, p_align, 0.0, 0.0, open_g, false, 0.012, 0.80, 0.24)?;
    let dz_oven = st.measure_fork_z(cal, [p_align[0], p_align[1]], 0.0)?;
    let p_align_cal = [outside[0], outside[1], outside[2] - 0.006 - dz_oven];
    st.move_cartesian(
        p_align,
        p_align_cal,
        0.0,
        0.0,
        open_g,
        false,
        0.006,
        0.70,
        0.08,
    )?;

    let p_ins = [source[0], source[1], source[2] - 0.006 - dz_oven];
    st.move_cartesian(
        p_align_cal,
        p_ins,
        0.0,
        0.0,
        open_g,
        false,
        0.010,
        0.75,
        0.10,
    )?;
    let p_seat = [source[0], source[1], source[2] - dz_oven];
    st.move_cartesian(p_ins, p_seat, 0.0, 0.0, open_g, false, 0.003, 0.65, 0.12)?;
    st.actuate_gripper(close_g, false, 0.55, 0.36, "close")?;

    let p_lift = [source[0], source[1], source[2] + 0.012 - dz_oven];
    st.move_cartesian(p_seat, p_lift, 0.0, 0.0, close_g, true, 0.005, 0.70, 0.12)?;
    let p_ext = [outside[0], outside[1], outside[2] + 0.012 - dz_oven];
    st.move_cartesian(p_lift, p_ext, 0.0, 0.0, close_g, true, 0.010, 0.75, 0.10)?;
    let p_clr = [outside[0], outside[1], outside[2] + 0.50 - dz_oven];
    st.move_cartesian(p_ext, p_clr, 0.0, 0.0, close_g, true, 0.016, 0.80, 0.08)?;
    let p_front = [destination[0] - 0.25, source[1], source[2] + 0.50 - dz_oven];
    st.move_cartesian(p_clr, p_front, 0.0, 0.0, close_g, true, 0.016, 0.80, 0.08)?;
    let p_trans = [
        destination[0] - 0.25,
        destination[1],
        destination[2] + 0.50 - dz_oven,
    ];
    st.move_cartesian(p_front, p_trans, 0.0, 0.0, close_g, true, 0.016, 0.80, 0.08)?;
    let p_over = [
        destination[0],
        destination[1],
        destination[2] + 0.32 - dz_oven,
    ];
    st.move_cartesian(p_trans, p_over, 0.0, 0.0, close_g, true, 0.014, 0.80, 0.24)?;
    let dz_tbl = st.measure_fork_z(cal, [p_over[0], p_over[1]], 0.0)?;
    let p_place = [destination[0], destination[1], destination[2] - dz_tbl];
    st.move_cartesian(p_over, p_place, 0.0, 0.0, close_g, true, 0.008, 0.75, 0.14)?;
    st.actuate_gripper(open_g, false, 0.45, 0.36, "open")?;
    let p_drop = [
        destination[0],
        destination[1],
        destination[2] - 0.006 - dz_tbl,
    ];
    st.move_cartesian(p_place, p_drop, 0.0, 0.0, open_g, false, 0.003, 0.65, 0.08)?;
    let p_ret = [
        destination[0] - 0.30,
        destination[1],
        destination[2] - 0.006 - dz_tbl,
    ];
    st.move_cartesian(p_drop, p_ret, 0.0, 0.0, open_g, false, 0.014, 0.85, 0.20)?;
    Ok(())
}

/// Run the hardened closed-loop Rust transfer controller on any [`ClosedLoopPlant`].
/// Returns `(status, fault)` (`("done", "")` or `("abort", "<fault>")`).
pub fn run_hardened_transfer<P: ClosedLoopPlant + ?Sized>(
    cfg: &ClosedLoopConfig,
    home_q: [f64; 6],
    cam: CameraModel,
    plant: &mut P,
) -> Result<(&'static str, &'static str)> {
    let mut nom = NominalDynamics::load(cfg)?;
    let mut st = ControllerState::new(cfg, &mut nom, plant, cam)?;
    let res = if st.nom.is_spanner {
        match cfg.task {
            BakeryTask::Oven => run_spanner_load(&mut st, home_q),
            BakeryTask::Unload => run_spanner_unload(&mut st),
            BakeryTask::Rack => run_spanner_rack(&mut st),
        }
    } else {
        match cfg.task {
            BakeryTask::Oven | BakeryTask::Rack => run_fork_transfer(&mut st),
            BakeryTask::Unload => run_fork_unload(&mut st),
        }
    };
    Ok(st.finish(res))
}

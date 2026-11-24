//! Shipped `bakery-native` controller bridge (`--mode shipped`) and nominal
//! dynamics / initialization helpers shared across modes.
//!
//! Runs the exact production `bakery_native::transfer::Operation`,
//! `bakery_native::ik::solve`, and `bakery_native::servo::command` without
//! modifying any file under `crates/bakery-native/src/`.

use anyhow::{Context, Result, bail, ensure};
use bakery_native::{
    artifact::{
        Artifact, BakeryTask, Binding, Case, Completion, Outcome, PhasePlan, Progress, Request,
        Within,
    },
    assets::{Assets, Cell},
    handoff::Handoff,
    ik::{self, Orientation},
    mj::{Data, Model, Object, Spec},
    native::Engine,
    program::{self, Preparation},
    rack,
    recording::Recording,
    robot::Robot,
    servo::{self, Arm, Payload},
    transfer::{self, Operation, Start, Stop},
};
use nalgebra::Vector3;
use serde::Serialize;
use std::path::Path;

use crate::http::{GauntletClient, StepReply};

#[derive(Clone)]
pub struct TaskConfig {
    pub root: std::path::PathBuf,
    pub robot: Robot,
    pub cell: Cell,
    pub task: BakeryTask,
    pub ingredient_mass_kg: f64,
    pub clamp_force_n: f64,
    pub control_dt_s: f64,
}

impl TaskConfig {
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
    pub fn load(cfg: &TaskConfig) -> Result<Self> {
        let xml_path = cfg.root.join(cfg.xml_rel_path());
        let mut spec = Spec::parse(&xml_path)
            .with_context(|| format!("Parse nominal XML {}", xml_path.display()))?;
        if let Some(mut contents) = spec.geom(c"cold_contents") {
            contents.set_mass(cfg.ingredient_mass_kg);
            if cfg.ingredient_mass_kg == 0.0 {
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
        let arm = Arm::bind(&model, cfg.robot, |k, n| lookup(&model, k, n))?;
        let grasp_site = lookup(&model, Object::Site, "cell_grasp")?;
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
            cfg.clamp_force_n.min(15.5)
        } else {
            cfg.clamp_force_n
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
        let dest_site = site_pos(cfg.task.destination())?;
        let robot_mount = site_pos("robot_mount")?;

        Ok(Self {
            model,
            data,
            ik_data,
            arm,
            grasp_site,
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

    /// Compute actuator `ctrl` via `bakery_native::servo::command` using ONLY
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
        self.arm.set_joints(&mut self.ik_data, q);
        self.model.kinematics(&mut self.ik_data);
        let s = &self.ik_data.site_xpos()[self.grasp_site * 3..self.grasp_site * 3 + 3];
        [s[0], s[1], s[2]]
    }

    /// Solve 6-DOF DLS IK via `bakery_native::ik::solve` with yaw rotation around +Z.
    pub fn solve_ik_yaw(
        &mut self,
        target: [f64; 3],
        yaw_rad: f64,
        seed: [f64; 6],
    ) -> Option<[f64; 6]> {
        let limits = ik::Limits {
            iterations: 350,
            tolerance: 1e-5,
            damping: 1e-4,
        };
        let pos = Vector3::new(target[0], target[1], target[2]);
        let (s, c) = yaw_rad.sin_cos();
        let rot = [c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0];
        let orient = if yaw_rad.abs() < 1e-9 {
            Orientation::World
        } else {
            Orientation::Rows(&rot)
        };
        ik::solve(
            &self.model,
            &mut self.ik_data,
            &self.arm,
            self.grasp_site,
            pos,
            orient,
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

pub struct PreparedShipped {
    pub engine: Engine,
    pub operation: Operation,
    pub start_angles: [f64; 6],
}

fn prepare_nominal_request(assets: &Assets, cfg: &TaskConfig, task: BakeryTask) -> Result<Request> {
    program::prepare(
        assets,
        &Preparation {
            robot: cfg.robot,
            ingredient_mass_kg: cfg.ingredient_mass_kg,
            ingredient_forward_mm: 0,
            ingredient_lateral_mm: 0,
            clamp_force_n: cfg.clamp_force_n,
            task,
            cell: cfg.cell,
            case: Case::Nominal,
            timestep: 0.002,
            rack_x_mm: 0,
            rack_y_mm: 0,
        },
    )
}

/// Open the exact shipped `bakery_native::transfer::Operation` at the start of
/// `cfg.task` (running any nominal preceding oven-load / unload handoff legs
/// cleanly inside `bakery_native` first).
pub fn open_shipped_operation(assets: &Assets, cfg: &TaskConfig) -> Result<PreparedShipped> {
    match (cfg.cell, cfg.task) {
        (Cell::Combined, BakeryTask::Rack) => {
            // Combined cell: table-to-oven -> oven-to-table (for rack) -> Start::Returned rack transfer.
            let load_req = prepare_nominal_request(assets, cfg, BakeryTask::Oven)?;
            let (mut engine, setup) = assets.open(&load_req)?;
            let load_binding = Binding::new(load_req, Completion::LoadingHandoff)?;
            let load_art = transfer::run(&mut engine, load_binding, None, None, Start::Prepared)?;
            let load_rec = Recording::from_result(&load_art, &setup, assets)?;
            let load_handoff = Handoff::new(load_art, load_rec, &engine)?;
            let unload_start = load_handoff.loaded_start(&engine)?;
            let (ret_stage, unload_binding) = bakery_native::handoff::Return::begin(
                load_handoff,
                assets,
                Completion::RetrievalHandoff,
            )?;
            let unload_art = transfer::run(&mut engine, unload_binding, None, None, unload_start)?;
            let ret_out = ret_stage.end(unload_art, &engine, assets)?;
            let bakery_native::handoff::ReturnArtifact::RackHandoff { handoff: rack_ho } = ret_out
            else {
                bail!("Combined unload prerequisite did not yield a rack handoff");
            };
            let (_rack_stage, rack_binding, rack_start) =
                rack::Racking::begin(*rack_ho, rack::Case::Nominal)?;
            let (operation, failed) = Operation::open(&mut engine, rack_binding, None, rack_start)?;
            ensure!(
                failed.is_none(),
                "Combined rack operation failed to open: {failed:?}"
            );
            let start_angles = operation.servo().0;
            Ok(PreparedShipped {
                engine,
                operation,
                start_angles,
            })
        }
        (_, BakeryTask::Oven | BakeryTask::Rack) => {
            let request = prepare_nominal_request(assets, cfg, cfg.task)?;
            let (mut engine, _setup) = assets.open(&request)?;
            let binding = Binding::new(request, Completion::Recording)?;
            let (operation, failed) = Operation::open(&mut engine, binding, None, Start::Prepared)?;
            ensure!(
                failed.is_none(),
                "Nominal operation failed to open: {failed:?}"
            );
            let start_angles = operation.servo().0;
            Ok(PreparedShipped {
                engine,
                operation,
                start_angles,
            })
        }
        (_, BakeryTask::Unload) => {
            let load_req = prepare_nominal_request(assets, cfg, BakeryTask::Oven)?;
            let (mut engine, setup) = assets.open(&load_req)?;
            let load_binding = Binding::new(load_req, Completion::LoadingHandoff)?;
            let load_art = transfer::run(&mut engine, load_binding, None, None, Start::Prepared)?;
            ensure!(
                matches!(
                    &load_art,
                    Artifact::BakeryNativeResult {
                        outcome: Outcome::Completed { .. },
                        ..
                    }
                ),
                "Nominal loading prerequisite did not complete"
            );
            let load_rec = Recording::from_result(&load_art, &setup, assets)?;
            let handoff = Handoff::new(load_art, load_rec, &engine)?;
            let start = handoff.loaded_start(&engine)?;
            let unload_binding = Binding::new(handoff.return_request(), Completion::Recording)?;
            let (operation, failed) = Operation::open(&mut engine, unload_binding, None, start)?;
            ensure!(
                failed.is_none(),
                "Nominal unload failed to open: {failed:?}"
            );
            let start_angles = operation.servo().0;
            Ok(PreparedShipped {
                engine,
                operation,
                start_angles,
            })
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitDump {
    pub xml_path: String,
    pub integration_state: Vec<f64>,
    pub arm_joint_names: [String; 6],
    pub arm_actuator_names: [String; 6],
    pub gripper_joint_name: String,
    pub gripper_actuator_name: String,
    pub start_angles: [f64; 6],
    pub start_jaw: f64,
    pub start_tray: [f64; 7],
    pub source_site: [f64; 3],
    pub dest_site: [f64; 3],
    pub is_spanner: bool,
    pub tray_mass_kg: f64,
    pub nominal_duration_s: f64,
    pub phases: Vec<PhasePlan>,
}

pub fn dump_init(assets: &Assets, cfg: &TaskConfig) -> Result<InitDump> {
    let prepared = open_shipped_operation(assets, cfg)?;
    let nom = NominalDynamics::load(cfg)?;
    let (phases, _progress, _within) = prepared.operation.saved();
    let sample = prepared.engine.sample(0);
    let arm_joint_names = nom.arm_joint_names();
    let arm_actuator_names = std::array::from_fn(|i| format!("{}__servo", arm_joint_names[i]));
    let nominal_duration_s: f64 = phases.iter().map(|p| p.seconds).sum();
    Ok(InitDump {
        xml_path: cfg.xml_rel_path(),
        integration_state: prepared.engine.state(),
        arm_joint_names,
        arm_actuator_names,
        gripper_joint_name: "clamp_opening".into(),
        gripper_actuator_name: "clamp_servo".into(),
        start_angles: prepared.start_angles,
        start_jaw: prepared.engine.jaw_opening(),
        start_tray: sample.tray,
        source_site: nom.source_site,
        dest_site: nom.dest_site,
        is_spanner: nom.is_spanner,
        tray_mass_kg: nom.nominal_tray_mass,
        nominal_duration_s,
        phases,
    })
}

/// Compute exact jaw command and carrying flag for the current `(phases, progress, within)`
/// matching `crates/bakery-native/src/transfer.rs` lines 1528-1619.
fn jaw_and_carrying(
    phases: &[PhasePlan],
    progress: &Progress,
    within: &Within,
    open_jaw_m: f64,
    closed_jaw_m: f64,
    dt: f64,
) -> (f64, bool) {
    if phases.is_empty() {
        return (open_jaw_m, false);
    }
    let idx = progress.next_phase.min(phases.len() - 1);
    let phase = &phases[idx];
    let prev_closed = phases[idx.saturating_sub(1)].closed;
    let prev_jaw = if prev_closed {
        closed_jaw_m
    } else {
        open_jaw_m
    };
    let target_jaw = if phase.closed {
        closed_jaw_m
    } else {
        open_jaw_m
    };
    let steps = (phase.seconds / dt).round().max(1.0) as usize;
    let step_idx = within.step.min(steps.saturating_sub(1));
    let fraction = (step_idx + 1) as f64 / steps as f64;
    let blend = fraction.powi(3) * (10.0 - 15.0 * fraction + 6.0 * fraction.powi(2));
    let jaw = prev_jaw + blend * (target_jaw - prev_jaw);
    (jaw, phase.carrying)
}

/// Run the exact shipped `bakery-native` controller over `GAUNTLET_URL`.
pub fn run_shipped(assets: &Assets, cfg: &TaskConfig, client: &GauntletClient) -> Result<()> {
    let mut prepared = open_shipped_operation(assets, cfg)?;
    let mut nom = NominalDynamics::load(cfg)?;
    let substeps = cfg.substeps();
    let dt = 0.002;
    let open_jaw_m = prepared.engine.open_jaw_m();
    let closed_jaw_m = prepared.engine.closed_jaw_m();

    let mut meas = client.begin()?;
    let mut done = false;
    while !done {
        let mut remaining = substeps;
        let mut last_jaw = open_jaw_m;
        let mut last_carrying = false;
        while remaining > 0 {
            let (phases, progress, within) = prepared.operation.saved();
            let (jaw, carrying) =
                jaw_and_carrying(&phases, &progress, &within, open_jaw_m, closed_jaw_m, dt);
            last_jaw = jaw;
            last_carrying = carrying;
            let step_before = prepared.operation.step();
            match prepared
                .operation
                .advance(&mut prepared.engine, remaining, None)?
            {
                Stop::Allowance => {
                    remaining = 0;
                }
                Stop::Event | Stop::Boundary => {
                    let advanced = prepared.operation.step().saturating_sub(step_before);
                    remaining = remaining.saturating_sub(advanced.max(1));
                }
                Stop::Terminal(_outcome) => {
                    done = true;
                    break;
                }
            }
        }
        let angles = prepared.operation.servo().0;
        let ctrl = nom.servo_ctrl(&meas.q, &angles, last_carrying);
        match client.step(&ctrl, last_jaw)? {
            StepReply::Meas(next) => meas = next,
            StepReply::EpisodeOver => break,
        }
    }
    client.end()?;
    Ok(())
}

pub fn load_assets(root: &Path) -> Result<Assets> {
    Assets::load(root).with_context(|| format!("Load bakery-native assets from {}", root.display()))
}

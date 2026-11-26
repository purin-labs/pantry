//! Shipped `bakery-native` controller bridge (`--mode shipped`) and init-state dump.
//!
//! Runs the exact production `bakery_native::transfer::Operation`,
//! `bakery_native::closed_loop::NominalDynamics`, and `bakery_native::servo::command`
//! with zero duplicated dynamics or perception code.

use anyhow::{Context, Result, bail, ensure};
use bakery_native::{
    artifact::{
        Artifact, BakeryTask, Binding, Case, Completion, Outcome, PhasePlan, Progress, Request,
        Within,
    },
    assets::{Assets, Cell},
    closed_loop::{ClosedLoopConfig, NominalDynamics},
    handoff::Handoff,
    mj::Object,
    native::Engine,
    program::{self, Preparation},
    rack,
    recording::Recording,
    transfer::{self, Operation, Start, Stop},
};
use serde::Serialize;
use std::path::Path;

use crate::http::{GauntletClient, StepReply};

pub struct PreparedShipped {
    pub engine: Engine,
    pub operation: Operation,
    pub start_angles: [f64; 6],
}

fn prepare_nominal_request(
    assets: &Assets,
    cfg: &ClosedLoopConfig,
    task: BakeryTask,
) -> Result<Request> {
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

fn run_loading_handoff(assets: &Assets, cfg: &ClosedLoopConfig) -> Result<(Engine, Handoff)> {
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
    Ok((engine, handoff))
}

/// Open the exact shipped `bakery_native::transfer::Operation` at the start of
/// `cfg.task` (running any nominal preceding oven-load / unload handoff legs
/// cleanly inside `bakery_native` first).
pub fn open_shipped_operation(assets: &Assets, cfg: &ClosedLoopConfig) -> Result<PreparedShipped> {
    match (cfg.cell, cfg.task) {
        (Cell::Combined | Cell::SpannerOvenCombined, BakeryTask::Rack) => {
            let (mut engine, load_handoff) = run_loading_handoff(assets, cfg)?;
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
            let (mut engine, handoff) = run_loading_handoff(assets, cfg)?;
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

/// Read the verified home joint angles for `cfg` (handling both standard cells
/// and articulated-door cells where `Operation::open` isn't needed).
pub fn start_angles_for(assets: &Assets, cfg: &ClosedLoopConfig) -> Result<[f64; 6]> {
    if cfg.cell == Cell::SpannerOvenDoor {
        let request = prepare_nominal_request(assets, cfg, BakeryTask::Oven)?;
        let (engine, _setup) = assets.open(&request)?;
        return Ok(engine.sample(0).joints);
    }
    Ok(open_shipped_operation(assets, cfg)?.start_angles)
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

pub fn dump_init(
    assets: &Assets,
    cfg: &ClosedLoopConfig,
    initial_door_rad: f64,
) -> Result<InitDump> {
    let nom = NominalDynamics::load(cfg)?;
    let arm_joint_names = nom.arm_joint_names();
    let arm_actuator_names = std::array::from_fn(|i| format!("{}__servo", arm_joint_names[i]));

    if cfg.cell == Cell::SpannerOvenDoor {
        let request = prepare_nominal_request(assets, cfg, BakeryTask::Oven)?;
        let (engine, _setup) = assets.open(&request)?;
        let sample = engine.sample(0);
        let mut state = engine.state();
        if initial_door_rad > 0.0
            && let Some(door_jnt) = nom.model.id(Object::Joint, "mbco4_door_hinge")?
        {
            let qadr = nom.model.jnt_qposadr()[door_jnt] as usize;
            if 1 + qadr < state.len() {
                state[1 + qadr] = initial_door_rad;
            }
        }
        return Ok(InitDump {
            xml_path: cfg.xml_rel_path(),
            integration_state: state,
            arm_joint_names,
            arm_actuator_names,
            gripper_joint_name: "clamp_opening".into(),
            gripper_actuator_name: "clamp_servo".into(),
            start_angles: sample.joints,
            start_jaw: engine.jaw_opening(),
            start_tray: sample.tray,
            source_site: nom.source_site,
            dest_site: nom.dest_site,
            is_spanner: nom.is_spanner,
            tray_mass_kg: nom.nominal_tray_mass,
            nominal_duration_s: 28.0,
            phases: Vec::new(),
        });
    }

    let prepared = open_shipped_operation(assets, cfg)?;
    let (phases, _progress, _within) = prepared.operation.saved();
    let sample = prepared.engine.sample(0);
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
/// matching `crates/bakery-native/src/transfer.rs`.
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
pub fn run_shipped(assets: &Assets, cfg: &ClosedLoopConfig, client: &GauntletClient) -> Result<()> {
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

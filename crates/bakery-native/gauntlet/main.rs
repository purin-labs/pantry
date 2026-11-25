//! Out-of-process `robosim_gauntlet` controller binary for `bakery-native` (Plan 24).
//!
//! Thin CLI + loopback HTTP proxy delegating directly to the promoted production
//! modules in `bakery_native`:
//! - `--mode shipped`: `bakery_native::transfer::Operation` (open-loop baseline)
//!   or open-loop door actuation when `--door-op` is set,
//! - `--mode hardened`: `bakery_native::closed_loop` + `bakery_native::door`
//!   (unprivileged closed-loop RGB-D perception, IK, servoing, and T3/T4 recovery).
//! - `--dump-init`: emits exact nominal initial `mjSTATE_INTEGRATION` and site poses.
#![deny(unsafe_code)]

mod http;
mod shipped;

use anyhow::{Context, Result, bail};
use bakery_native::{
    artifact::BakeryTask,
    assets::Cell,
    closed_loop::{ClosedLoopConfig, run_hardened_transfer},
    door::{DoorOp, run_door_operation},
    perception::CameraModel,
    robot::Robot,
};
use clap::{Parser, ValueEnum};
use serde_json::json;
use std::path::PathBuf;

use crate::{
    http::GauntletClient,
    shipped::{dump_init, load_assets, run_shipped, start_angles_for},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Mode {
    Shipped,
    Hardened,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum DoorOpArg {
    Open,
    Close,
    Cycle,
    NoTwist,
}

impl From<DoorOpArg> for DoorOp {
    fn from(arg: DoorOpArg) -> Self {
        match arg {
            DoorOpArg::Open => Self::Open,
            DoorOpArg::Close => Self::Close,
            DoorOpArg::Cycle => Self::ClosedOvenLoad,
            DoorOpArg::NoTwist => Self::NoTwistPull,
        }
    }
}

#[derive(Parser)]
#[command(about = "Out-of-process robosim_gauntlet controller for bakery-native")]
struct Args {
    /// Repository root holding verified bakery-native assets.
    #[arg(long, default_value = ".")]
    root: PathBuf,
    #[arg(long, value_enum, default_value = "fairino-fr10")]
    robot: Robot,
    #[arg(long, value_enum, default_value = "spanner-oven")]
    cell: Cell,
    #[arg(long, value_enum, default_value = "table-to-oven")]
    task: BakeryTask,
    #[arg(long, default_value_t = 1.0)]
    ingredient_mass_kg: f64,
    #[arg(long, default_value_t = 100.0)]
    clamp_force_n: f64,
    #[arg(long, default_value_t = 0.02)]
    control_dt_s: f64,
    #[arg(long, value_enum, default_value = "shipped")]
    mode: Mode,
    /// Optional articulated MBCO-4ME door operation (`open`, `close`, `cycle`, `no-twist`).
    #[arg(long, value_enum)]
    door_op: Option<DoorOpArg>,
    /// Initial `mbco4_door_hinge` angle in radians (used by `close` and `--dump-init`).
    #[arg(long, default_value_t = 0.0)]
    initial_door_rad: f64,
    /// Overhead camera nominal position `x,y,z` in meters (for `--mode hardened`).
    #[arg(long, default_value = "0.02,-0.02,2.72")]
    cam_pos: String,
    /// Overhead camera vertical FOV in degrees (for `--mode hardened`).
    #[arg(long, default_value_t = 56.0)]
    cam_fovy_deg: f64,
    /// Emit exact nominal starting state JSON and exit (no GAUNTLET_URL needed).
    #[arg(long)]
    dump_init: bool,
}

fn parse_vec3(raw: &str) -> Result<[f64; 3]> {
    let parts: Vec<f64> = raw
        .split(',')
        .map(|s| {
            s.trim()
                .parse::<f64>()
                .context("Invalid float in --cam-pos")
        })
        .collect::<Result<_>>()?;
    if parts.len() != 3 {
        bail!("--cam-pos expects x,y,z");
    }
    Ok([parts[0], parts[1], parts[2]])
}

fn main() -> Result<()> {
    let args = Args::parse();
    let cfg = ClosedLoopConfig {
        root: args.root.clone(),
        robot: args.robot,
        cell: args.cell,
        task: args.task,
        ingredient_mass_kg: args.ingredient_mass_kg,
        clamp_force_n: args.clamp_force_n,
        control_dt_s: args.control_dt_s,
    };
    let assets = load_assets(&cfg.root)?;
    if args.dump_init {
        let dump = dump_init(&assets, &cfg, args.initial_door_rad)?;
        println!("{}", serde_json::to_string(&dump)?);
        return Ok(());
    }

    let cam_key = match args.mode {
        Mode::Shipped => None,
        Mode::Hardened => Some("overhead_cam".to_owned()),
    };
    let mut client = GauntletClient::from_env(cam_key)?;
    let (status, fault) = if let Some(door_op) = args.door_op {
        let home_q = start_angles_for(&assets, &cfg)?;
        let cam = CameraModel {
            pos: parse_vec3(&args.cam_pos)?,
            fovy_deg: args.cam_fovy_deg,
        };
        let use_perception = args.mode == Mode::Hardened;
        run_door_operation(
            &cfg,
            home_q,
            cam,
            door_op.into(),
            use_perception,
            args.initial_door_rad,
            &mut client,
        )?
    } else {
        match args.mode {
            Mode::Shipped => {
                run_shipped(&assets, &cfg, &client)?;
                ("done", "")
            }
            Mode::Hardened => {
                let home_q = start_angles_for(&assets, &cfg)?;
                let cam = CameraModel {
                    pos: parse_vec3(&args.cam_pos)?,
                    fovy_deg: args.cam_fovy_deg,
                };
                run_hardened_transfer(&cfg, home_q, cam, &mut client)?
            }
        }
    };
    println!("{}", json!({ "status": status, "fault": fault }));
    Ok(())
}

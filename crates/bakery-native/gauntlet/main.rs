//! Out-of-process `robosim_gauntlet` controller binary for `bakery-native` (Plan 24).
//!
//! Runs either:
//! - `--mode shipped`: the exact shipped `bakery_native::transfer::Operation`
//!   + `bakery_native::servo::command` controller (open-loop baseline `v0`), or
//! - `--mode hardened`: the unprivileged closed-loop Rust RGB-D + T3/T4 controller
//!   built directly on `bakery_native::ik::solve` and `bakery_native::servo::command` (`v1`).
//!
//! Also supports `--dump-init` to emit the exact nominal initial `mjSTATE_INTEGRATION`,
//! joint/actuator names, and site poses from `bakery-native` so the Gauntlet plant starts
//! identically to production without duplicating handoff math.
#![deny(unsafe_code)]

mod hardened;
mod http;
mod perception;
mod shipped;

use anyhow::{Context, Result, bail};
use bakery_native::{artifact::BakeryTask, assets::Cell, robot::Robot};
use clap::{Parser, ValueEnum};
use serde_json::json;
use std::path::PathBuf;

use crate::{
    http::GauntletClient,
    perception::CameraModel,
    shipped::{TaskConfig, dump_init, load_assets, run_shipped},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Mode {
    Shipped,
    Hardened,
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
    let cfg = TaskConfig {
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
        let dump = dump_init(&assets, &cfg)?;
        println!("{}", serde_json::to_string(&dump)?);
        return Ok(());
    }

    let cam_key = match args.mode {
        Mode::Shipped => None,
        Mode::Hardened => Some("overhead_cam".to_owned()),
    };
    let client = GauntletClient::from_env(cam_key)?;
    let (status, fault) = match args.mode {
        Mode::Shipped => {
            run_shipped(&assets, &cfg, &client)?;
            ("done", "")
        }
        Mode::Hardened => {
            let cam = CameraModel {
                pos: parse_vec3(&args.cam_pos)?,
                fovy_deg: args.cam_fovy_deg,
            };
            hardened::run_hardened(&assets, &cfg, cam, &client)?
        }
    };
    println!("{}", json!({ "status": status, "fault": fault }));
    Ok(())
}

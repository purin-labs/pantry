//! The cobot controller simulator (Plan 24 S2). It answers on localhost like
//! the controllers of two FAIRINO FR10 arms and one deck oven: one TCP port
//! for each device and one control port. Each move gets its time, its pickup
//! and its outcome from a MuJoCo run of the FR10 oven cell. See README.md.
//!
//! The simulator has no physical dispatch authority. It is the stand-in for
//! real controllers behind the shop gateway's `cobot` adapter.
#![deny(unsafe_code)]

mod physics;
mod port;
mod sim;

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use bakery_native::assets::{Assets, Cell};
use clap::Parser;
use serde_json::json;

use crate::physics::Physics;
use crate::sim::{DEVICES, Sim};

#[derive(Parser)]
#[command(
    about = "Simulated cobot and oven controllers on localhost; no physical dispatch authority"
)]
struct Args {
    /// The repository root, which holds the verified model assets.
    #[arg(long, default_value = ".")]
    root: PathBuf,
    /// The first port: cobot-1 on PORT, cobot-2 on PORT+1, oven-1 on PORT+2
    /// and the control port on PORT+3. With 0, the system picks four free
    /// ports, and the ready line names them.
    #[arg(long, default_value_t = 47110)]
    port: u16,
    /// Device seconds for each wall second.
    #[arg(long, default_value_t = 1.0)]
    time_scale: f64,
    /// A folder for `controller-state.json`, the `state` answer after each
    /// change. Tasks do not survive a restart.
    #[arg(long)]
    state_dir: Option<PathBuf>,
    /// The FR10 oven cell fixture (`separate` or `spanner-oven`).
    #[arg(long, value_enum, default_value_t = Cell::Separate)]
    cell: Cell,
}

/// The loop that advances the devices.
const TICK: Duration = Duration::from_millis(20);

fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(
        args.time_scale > 0. && args.time_scale <= 1000.,
        "--time-scale is above 0 and at most 1000"
    );
    ensure!(
        args.port <= u16::MAX - 3,
        "--port leaves no room for four ports"
    );
    ensure!(
        matches!(args.cell, Cell::Separate | Cell::SpannerOven),
        "--cell must be separate or spanner-oven"
    );
    let assets = Assets::load(&args.root).context("Load the model assets from --root")?;
    let physics = Physics::run(&assets, args.cell)?;
    let state_file = match &args.state_dir {
        Some(dir) => {
            std::fs::create_dir_all(dir)?;
            Some(dir.join("controller-state.json"))
        }
        None => None,
    };
    let summary: Vec<_> = physics
        .all()
        .iter()
        .map(|timeline| {
            json!({
                "case": timeline.case,
                "digest": timeline.digest,
                "seconds": timeline.seconds,
                "end": timeline.end,
            })
        })
        .collect();
    let sim = Arc::new(Mutex::new(Sim::new(physics, args.time_scale, state_file)));
    let mut ports = serde_json::Map::new();
    let port = |offset: usize| match args.port {
        0 => 0,
        first => first + offset as u16,
    };
    for (index, key) in DEVICES.iter().enumerate() {
        let listener = bind(port(index))?;
        ports.insert((*key).into(), json!(listener.local_addr()?.port()));
        let sim = sim.clone();
        thread::spawn(move || serve_device(listener, index, sim));
    }
    let control = bind(port(DEVICES.len()))?;
    ports.insert("control".into(), json!(control.local_addr()?.port()));
    {
        let sim = sim.clone();
        thread::spawn(move || serve_control(control, sim));
    }
    println!(
        "{}",
        json!({
            "event": "ready",
            "ports": ports,
            "timeScale": args.time_scale,
            "physics": summary,
        })
    );
    std::io::stdout().flush()?;
    let mut last = Instant::now();
    loop {
        thread::sleep(TICK);
        let now = Instant::now();
        let wall = now.duration_since(last).as_secs_f64();
        last = now;
        lock(&sim).tick(wall);
    }
}

fn bind(port: u16) -> Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", port)).with_context(|| format!("Bind 127.0.0.1:{port}"))
}

fn lock(sim: &Mutex<Sim>) -> MutexGuard<'_, Sim> {
    sim.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn prepare(stream: &TcpStream) -> std::io::Result<()> {
    stream.set_nodelay(true)?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))
}

/// Each connection of a device port gets every event of the device.
fn serve_device(listener: TcpListener, index: usize, sim: Arc<Mutex<Sim>>) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let Ok(writer) = prepare(&stream).and_then(|()| stream.try_clone()) else {
            continue;
        };
        lock(&sim).subscribe(index, writer);
        let sim = sim.clone();
        thread::spawn(move || {
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { break };
                if !line.trim().is_empty() {
                    lock(&sim).device_op(index, &line);
                }
            }
        });
    }
}

/// One JSON line in, one line out.
fn serve_control(listener: TcpListener, sim: Arc<Mutex<Sim>>) {
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let sim = sim.clone();
        thread::spawn(move || {
            let Ok(reader) = prepare(&stream).and_then(|()| stream.try_clone()) else {
                return;
            };
            for line in BufReader::new(reader).lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let answer = lock(&sim).control(&line);
                if writeln!(stream, "{answer}").is_err() {
                    break;
                }
            }
        });
    }
}

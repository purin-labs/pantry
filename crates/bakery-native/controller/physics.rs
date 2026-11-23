//! The FR10 physics cases of the controller simulator (Plan 24 S2).
//!
//! Each distinct case runs one time, at start, with the bakery engine:
//! `program::prepare`, `Assets::open` (inside `program::first`) and the
//! transfer runner. A task of the same case replays that run's timeline at
//! the simulator's time scale. The timeline keeps what the run measured: its
//! length, its phases, the pickup step, the placement and the failure.
use anyhow::{Context, Result, bail};
use bakery_native::artifact::{BakeryTask, Case, digest};
use bakery_native::assets::{Assets, Cell};
use bakery_native::handoff::CycleDestination;
use bakery_native::program::{self, Loaded, Preparation};
use bakery_native::robot::Robot;
use cobot_protocol::CarrierAt;
use serde::Serialize;
use serde_json::Value;

/// How a physics run ended.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum End {
    Completed,
    Failed {
        /// Seconds into the run.
        at_seconds: f64,
        /// The engine's failure reason, for example `lost-grasp`.
        reason: String,
        carrier_at: CarrierAt,
    },
}

/// One physics run, as the simulator replays it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    /// For example `table-to-oven-nominal`.
    pub case: String,
    /// SHA-256 of the engine output that the timeline comes from.
    pub digest: String,
    pub steps: usize,
    pub timestep: f64,
    pub seconds: f64,
    pub pickup_seconds: f64,
    /// The arm is inside the oven door between these two times.
    pub door: (f64, f64),
    pub phases: Vec<(f64, String)>,
    pub end: End,
}

impl Timeline {
    /// The phase at `seconds` into the run.
    pub fn phase(&self, seconds: f64) -> Option<&str> {
        self.phases
            .iter()
            .rev()
            .find(|(start, _)| *start <= seconds)
            .map(|(_, label)| label.as_str())
    }

    /// Where the tray is at `seconds` into a run that has not ended: on the
    /// source before the pickup, on the tool after it.
    pub fn carrier_at(&self, seconds: f64) -> CarrierAt {
        if seconds < self.pickup_seconds {
            CarrierAt::Source
        } else if seconds < self.seconds {
            CarrierAt::Tool
        } else {
            CarrierAt::Destination
        }
    }

    pub fn in_door(&self, seconds: f64) -> bool {
        seconds >= self.door.0 && seconds < self.door.1
    }

    /// The length that a replay of this run takes before it ends.
    pub fn ends_at(&self) -> f64 {
        match &self.end {
            End::Completed => self.seconds,
            End::Failed { at_seconds, .. } => *at_seconds,
        }
    }
}

/// The four FR10 cases that the simulator replays.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Physics {
    /// `cold_rack -> oven`: the `table-to-oven` transfer.
    pub load: Timeline,
    /// `oven -> cooling_rack`: the `oven-to-table` retrieval, after a
    /// nominal loading in the same world (the engine's `cycle`).
    pub unload: Timeline,
    /// `table-to-oven` with the `slip` case: the grip is lost.
    pub load_slip: Timeline,
    /// `table-to-oven` with the `closed-door` case: the door blocks it.
    pub load_closed_door: Timeline,
}

impl Physics {
    pub fn run(assets: &Assets) -> Result<Self> {
        let cycle = run_case(assets, Case::Nominal, true)?;
        let cycle_digest = digest(&cycle);
        let cycle: Value = serde_json::from_slice(&cycle)?;
        let slip = run_case(assets, Case::Slip, false)?;
        let closed = run_case(assets, Case::ClosedDoor, false)?;
        Ok(Self {
            load: timeline(
                "table-to-oven-nominal",
                &cycle_digest,
                cycle.get("loading").context("The cycle has no loading")?,
            )?,
            unload: timeline(
                "oven-to-table-nominal",
                &cycle_digest,
                cycle
                    .get("unloading")
                    .context("The cycle has no unloading")?,
            )?,
            load_slip: timeline(
                "table-to-oven-slip",
                &digest(&slip),
                &serde_json::from_slice(&slip)?,
            )?,
            load_closed_door: timeline(
                "table-to-oven-closed-door",
                &digest(&closed),
                &serde_json::from_slice(&closed)?,
            )?,
        })
    }

    pub fn all(&self) -> [&Timeline; 4] {
        [
            &self.load,
            &self.unload,
            &self.load_slip,
            &self.load_closed_door,
        ]
    }
}

/// One engine run of the FR10 oven cell. `cycle` loads the oven and then
/// retrieves the tray in the same world.
fn run_case(assets: &Assets, case: Case, cycle: bool) -> Result<Vec<u8>> {
    let request = program::prepare(
        assets,
        &Preparation {
            robot: Robot::FairinoFr10,
            ingredient_mass_kg: 1.,
            ingredient_forward_mm: 0,
            ingredient_lateral_mm: 0,
            clamp_force_n: 100.,
            task: BakeryTask::Oven,
            cell: Cell::Separate,
            case,
            timestep: 0.002,
            rack_x_mm: 0,
            rack_y_mm: 0,
        },
    )?;
    let loaded = cycle.then_some(Loaded::Cycle(CycleDestination::Table));
    program::first(assets, request, loaded)?.to_end(assets)
}

fn timeline(case: &str, digest: &str, recording: &Value) -> Result<Timeline> {
    let timestep = recording["request"]["timestep"]
        .as_f64()
        .context("A recording has no timestep")?;
    let seconds_of = |step: &Value| step.as_u64().map(|step| step as f64 * timestep);
    let events = recording["events"]
        .as_array()
        .context("A recording has no events")?;
    let mut phases = Vec::new();
    let mut pickup = None;
    for event in events {
        let at = seconds_of(&event["step"]).context("An event has no step")?;
        match event["kind"].as_str() {
            Some("phase") => phases.push((at, event["label"].as_str().unwrap_or("").to_string())),
            Some("pickup") => pickup = Some(at),
            _ => {}
        }
    }
    let outcome = &recording["outcome"];
    let step = outcome["step"].as_u64().context("An outcome has no step")? as usize;
    let seconds = step as f64 * timestep;
    let end = match outcome["kind"].as_str() {
        Some("completed") => End::Completed,
        Some("failed") => End::Failed {
            at_seconds: seconds,
            reason: outcome["reason"].as_str().unwrap_or("failed").to_string(),
            carrier_at: match outcome["trayDisposition"].as_str() {
                Some("source") => CarrierAt::Source,
                Some("gripped") => CarrierAt::Tool,
                Some("destination") => CarrierAt::Destination,
                // A run that fails before its first step moved nothing.
                _ if step == 0 => CarrierAt::Source,
                _ => CarrierAt::Unknown,
            },
        },
        other => bail!("{case}: the engine ended with {other:?}"),
    };
    // The arm is inside the oven door from its alignment at the oven until
    // it has cleared the oven front (retrieval) or settled outside (loading).
    let start = phases
        .iter()
        .find(|(_, label)| label == "align_oven")
        .map(|(at, _)| *at);
    let door = match start {
        Some(start) => {
            let end = phases
                .iter()
                .find(|(at, label)| {
                    *at > start && (label == "clear_oven_front" || label == "settled")
                })
                .map_or(seconds, |(at, _)| *at);
            (start, end)
        }
        None => (seconds, seconds),
    };
    Ok(Timeline {
        case: case.to_string(),
        digest: digest.to_string(),
        steps: step,
        timestep,
        seconds,
        pickup_seconds: pickup.unwrap_or(seconds),
        door,
        phases,
        end,
    })
}

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

use crate::{
    artifact::*,
    limits::{Margins, Measured, Overspeed},
    native::{Contact, Engine, OPEN_JAW_M, Point},
};

const GRASP_OFFSET: [f64; 3] = [-0.25, 0., -0.001];
// Bounded proportional correction; simulated tuning, pending physical calibration.
const OVEN_CENTERING_GAIN: f64 = 0.5;
const OVEN_CENTERING_LIMIT_M: f64 = 0.015;
const GRIP: [&str; 4] = [
    "clamp_fork_left",
    "clamp_fork_right",
    "clamp_pad_left",
    "clamp_pad_right",
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Start {
    Prepared,
    Returned {
        angles: [f64; 6],
        previous_target: [f64; 3],
        tray: [f64; 7],
    },
    Loaded {
        angles: [f64; 6],
        previous_target: [f64; 3],
        tray: [f64; 7],
    },
    /// A persistent cell's arm waits at its ready pose.
    Ready {
        angles: [f64; 6],
        previous_target: [f64; 3],
    },
    /// A persistent cell's arm stayed where its last operation retracted to.
    /// The plan begins with the motion back to the source.
    Retreated {
        angles: [f64; 6],
        previous_target: [f64; 3],
    },
    Recovery {
        angles: [f64; 6],
        previous_target: [f64; 3],
        handling_steps: usize,
    },
}

pub fn validate_loading(
    engine: &Engine,
    progress: &Progress,
    samples: &[Sample],
    events: &[Event],
    outcome: &Outcome,
) -> Result<()> {
    let phases = phases(engine, BakeryTask::Oven)?;
    validate_completed(
        engine,
        progress,
        samples,
        events,
        outcome,
        &phases,
        BakeryTask::Oven,
        0.,
    )
}

pub fn validate_returned(
    engine: &Engine,
    loaded: &Engine,
    previous_target: [f64; 3],
    result: &Artifact,
) -> Result<()> {
    let Artifact::BakeryNativeResult {
        progress,
        samples,
        events,
        outcome,
        ..
    } = result
    else {
        anyhow::bail!("Pending retrieval cannot hand off");
    };
    ensure!(
        samples.first() == Some(&loaded.sample(0)),
        "Retrieval must start from the loading boundary"
    );
    let phases = unloading_phases(loaded, previous_target, loaded.sample(0).tray)?;
    validate_completed(
        engine,
        progress,
        samples,
        events,
        outcome,
        &phases,
        BakeryTask::Unload,
        loaded.time(),
    )
}

#[allow(clippy::too_many_arguments)]
fn validate_completed(
    engine: &Engine,
    progress: &Progress,
    samples: &[Sample],
    events: &[Event],
    outcome: &Outcome,
    phases: &[Phase],
    task: BakeryTask,
    origin_time: f64,
) -> Result<()> {
    let step: usize = phases
        .iter()
        .map(|phase| (phase.seconds / engine.timestep()).round() as usize)
        .sum();
    ensure!(
        progress.next_phase == phases.len()
            && progress.step == step
            && (engine.time() - origin_time - step as f64 * engine.timestep()).abs() < 1e-8,
        "Handoff must be completed operation state"
    );
    ensure!(
        progress.pickup
            && !progress.grip_disabled
            && progress.lost_steps == 0
            && engine.jaw_opening() > OPEN_JAW_M - 0.005,
        "Handoff requires released tray and open tool"
    );
    ensure!(
        progress.previous_target == <[f64; 3]>::from(phases.last().unwrap().position),
        "Handoff target differs from final retreat"
    );
    for (angle, (lower, upper)) in progress.angles.iter().zip(engine.limits()) {
        ensure!(
            angle.is_finite() && angle >= lower && angle <= upper,
            "Invalid handoff servo target"
        );
    }
    ensure!(
        samples.last() == Some(&engine.sample(step)),
        "Handoff final pose differs from recording"
    );
    let (supported, mut evidence) = placement(engine, engine.site(task.destination())?, task);
    evidence.settled_seconds = 1.;
    ensure!(
        supported
            && matches!(outcome, Outcome::Completed { step: done, evidence: found, .. }
                if *done == step && *found == evidence),
        "Handoff placement is unsupported"
    );
    ensure!(
        events.last() == Some(&Event::Placement { step }),
        "Handoff lacks placement event"
    );
    let mut expected_step = 0;
    let mut observed = events.iter().filter_map(phase_event);
    for phase in phases {
        ensure!(
            observed.next() == Some((expected_step, phase.name)),
            "Handoff phase history differs from operation"
        );
        expected_step += (phase.seconds / engine.timestep()).round() as usize;
    }
    ensure!(
        observed.next().is_none()
            && events
                .iter()
                .filter(|event| matches!(event, Event::Pickup { .. }))
                .count()
                == 1,
        "Handoff requires one pickup and the complete phase history"
    );
    Ok(())
}

fn phase_event(event: &Event) -> Option<(usize, &str)> {
    match event {
        Event::Phase { step, label } => Some((*step, label)),
        _ => None,
    }
}

fn unloading_phases(
    engine: &Engine,
    previous_target: [f64; 3],
    tray: [f64; 7],
) -> Result<Vec<Phase>> {
    let source = Point::from_column_slice(&tray[..3]) + Point::from(GRASP_OFFSET);
    let destination = engine.site("source_tray_center")? + Point::from(GRASP_OFFSET);
    let outside = Point::new(destination.x - 0.37, source.y, source.z);
    let retreat = destination + Point::new(-0.30, 0., -0.006);
    Ok(vec![
        Phase::new("settle", Point::from(previous_target), 0.5, false, false),
        Phase::new(
            "align_oven",
            outside + Point::new(0., 0., -0.006),
            1.,
            false,
            false,
        ),
        Phase::new(
            "insert_forks",
            source + Point::new(0., 0., -0.006),
            5.,
            false,
            false,
        ),
        Phase::new("seat", source, 1.5, false, false),
        Phase::new("grasp", source, 1., true, false),
        Phase::new("lift", source + Point::new(0., 0., 0.012), 1.5, true, true),
        Phase::new(
            "extract_oven",
            outside + Point::new(0., 0., 0.012),
            5.,
            true,
            true,
        ),
        Phase::new(
            "clear_oven",
            outside + Point::new(0., 0., 0.50),
            2.,
            true,
            true,
        ),
        Phase::new(
            "clear_oven_front",
            Point::new(destination.x - 0.25, source.y, source.z + 0.50),
            2.,
            true,
            true,
        ),
        Phase::new(
            "transfer",
            destination + Point::new(-0.25, 0., 0.50),
            7.,
            true,
            true,
        ),
        Phase::new(
            "align_table",
            destination + Point::new(0., 0., 0.32),
            2.,
            true,
            true,
        ),
        Phase::new("place", destination, 4., true, true),
        Phase::new("release", destination, 1., false, false),
        Phase::new(
            "clear_forks",
            destination + Point::new(0., 0., -0.006),
            1.5,
            false,
            false,
        ),
        Phase::new("retract", retreat, 3., false, false),
        Phase::new("settled", retreat, 2., false, false),
    ])
}

pub struct Phase {
    name: &'static str,
    position: Point,
    seconds: f64,
    closed: bool,
    carrying: bool,
}

impl Phase {
    fn new(
        name: &'static str,
        position: Point,
        seconds: f64,
        closed: bool,
        carrying: bool,
    ) -> Self {
        Self {
            name,
            position,
            seconds,
            closed,
            carrying,
        }
    }
}

pub fn phases(engine: &Engine, task: BakeryTask) -> Result<Vec<Phase>> {
    let source = engine.site("source_tray_center")? + Point::from(GRASP_OFFSET);
    let clearance = if task == BakeryTask::Oven { 0.50 } else { 0.32 };
    transfer_phases(engine, task, source, engine.grasp_site(), clearance, 0.30)
}

fn transfer_phases(
    engine: &Engine,
    task: BakeryTask,
    source: Point,
    initial: Point,
    clearance: f64,
    retreat_distance: f64,
) -> Result<Vec<Phase>> {
    let destination = engine.site(task.destination())? + Point::from(GRASP_OFFSET);
    let retreat = destination + Point::new(-retreat_distance, 0., -0.006);
    let mut phases = vec![
        Phase::new("settle", initial, 0.5, false, false),
        Phase::new(
            "approach",
            source + Point::new(-0.25, 0., -0.003),
            1.5,
            false,
            false,
        ),
        Phase::new(
            "insert",
            source + Point::new(0., 0., -0.003),
            3.,
            false,
            false,
        ),
        Phase::new("seat", source, 1., false, false),
        Phase::new("grasp", source, 1., true, false),
        Phase::new(
            "lift",
            source + Point::new(0., 0., clearance),
            4.,
            true,
            true,
        ),
    ];
    let retreat = if task == BakeryTask::Oven {
        let approach = Point::new(source.x - 0.37, destination.y, destination.z);
        phases.extend([
            Phase::new(
                "clear_source",
                source + Point::new(-0.25, 0., clearance),
                2.,
                true,
                true,
            ),
            Phase::new(
                "transfer",
                Point::new(source.x - 0.25, destination.y, destination.z + clearance),
                7.,
                true,
                true,
            ),
            Phase::new(
                "clear_oven_front",
                approach + Point::new(0., 0., clearance),
                2.,
                true,
                true,
            ),
            Phase::new(
                "align_oven",
                approach + Point::new(0., 0., 0.012),
                2.,
                true,
                true,
            ),
            Phase::new(
                "insert_oven",
                destination + Point::new(0., 0., 0.012),
                5.,
                true,
                true,
            ),
            Phase::new("place", destination, 1., true, true),
        ]);
        approach + Point::new(0., 0., -0.006)
    } else {
        phases.extend([
            Phase::new(
                "transfer",
                destination + Point::new(0., 0., clearance),
                7.,
                true,
                true,
            ),
            Phase::new("place", destination, 4., true, true),
        ]);
        retreat
    };
    phases.extend([
        Phase::new("release", destination, 1., false, false),
        Phase::new(
            "clear_forks",
            destination + Point::new(0., 0., -0.006),
            1.5,
            false,
            false,
        ),
        Phase::new(
            "retract",
            retreat,
            if task == BakeryTask::Oven { 4. } else { 3. },
            false,
            false,
        ),
        Phase::new("settled", retreat, 2., false, false),
    ]);
    Ok(phases)
}

fn check_contacts(contacts: &[Contact], inspect_tray: bool) -> Result<(), Failure> {
    for contact in contacts {
        let tray_contact = contact.first_is_tray || contact.second_is_tray;
        if tray_contact && !inspect_tray {
            continue;
        }
        if contact.first == "destination_obstruction" || contact.second == "destination_obstruction"
        {
            return Err(Failure::DestinationBlocked);
        }
        if contact.first.starts_with("mbco_door_") || contact.second.starts_with("mbco_door_") {
            return Err(Failure::DoorObstructed);
        }
        if contact.involves_arm {
            return Err(Failure::Collision);
        }
        if (contact.first.starts_with("clamp_") || contact.second.starts_with("clamp_"))
            && !tray_contact
        {
            return Err(Failure::Collision);
        }
        if tray_contact {
            let other = if contact.first_is_tray {
                contact.second
            } else {
                contact.first
            };
            if other != "table_top"
                && !BakeryTask::Rack.supports().contains(&other)
                && !BakeryTask::Oven.supports().contains(&other)
                && !other.starts_with("clamp_")
            {
                return Err(Failure::Collision);
            }
        }
    }
    Ok(())
}

// Geometry in contact with the carrier, and the carrier's own. Support, grip
// and pickup are facts about the carrier: another body resting on the same
// fixture must not stand in for it.
fn touched<'a>(contacts: &[Contact<'a>]) -> BTreeSet<&'a str> {
    let mut result = BTreeSet::new();
    for contact in contacts {
        if !contact.first_is_tray && !contact.second_is_tray {
            continue;
        }
        result.insert(contact.first);
        result.insert(contact.second);
    }
    result
}

fn contains_all(touched: &BTreeSet<&str>, names: &[&str]) -> bool {
    names.iter().all(|name| touched.contains(name))
}

fn orientation_error(pose: &[f64; 7]) -> f64 {
    let dot = (pose[3] * std::f64::consts::FRAC_1_SQRT_2
        - pose[6] * std::f64::consts::FRAC_1_SQRT_2)
        .abs();
    2. * dot.clamp(0., 1.).acos()
}

pub fn placement(engine: &Engine, destination: Point, task: BakeryTask) -> (bool, Evidence) {
    placement_with(engine, &touched(&engine.live_contacts()), destination, task)
}

/// Placement from the carrier contacts of a scan that the caller already made.
fn placement_with(
    engine: &Engine,
    contacts: &BTreeSet<&str>,
    destination: Point,
    task: BakeryTask,
) -> (bool, Evidence) {
    let sample = engine.sample(0);
    let speed = engine.tray_speed();
    let evidence = Evidence {
        position_error_m: (Point::from_column_slice(&sample.tray[..3]) - destination).norm(),
        orientation_error_rad: orientation_error(&sample.tray),
        linear_speed_mps: Point::from_column_slice(&speed[..3]).norm(),
        angular_speed_radps: Point::from_column_slice(&speed[3..]).norm(),
        settled_seconds: 0.,
    };
    let accepted = evidence.position_error_m < 0.01
        && evidence.orientation_error_rad < 5_f64.to_radians()
        && evidence.linear_speed_mps < 0.02
        && evidence.angular_speed_radps < 0.05
        && contains_all(contacts, task.supports())
        && !contacts.iter().any(|name| name.starts_with("clamp_"));
    (accepted, evidence)
}

fn failure(engine: &Engine, reason: Failure, step: usize, task: BakeryTask) -> Outcome {
    let scan = engine.live_contacts();
    let contacts = touched(&scan);
    eprintln!(
        "{}",
        serde_json::json!({"kind": "transfer-failure", "step": step, "reason": reason, "contacts": contacts, "tray": engine.sample(step).tray, "placement": placement(engine, engine.site(task.destination()).unwrap(), task).1})
    );
    let tray_disposition = if contains_all(&contacts, task.source_supports()) {
        Disposition::Source
    } else if contains_all(&contacts, &GRIP) {
        Disposition::Gripped
    } else if contains_all(&contacts, task.supports()) {
        Disposition::Destination
    } else {
        Disposition::Unknown
    };
    Outcome::Failed {
        step,
        reason,
        tray_disposition,
        margins: None,
    }
}

fn capture(engine: &Engine, step: usize, samples: &mut Vec<Sample>) {
    let sample = engine.sample(step);
    if samples.last().is_some_and(|last| last.step == step) {
        samples.pop();
    }
    samples.push(sample);
}

fn choose_branch(
    engine: &mut Engine,
    phases: &[Phase],
    seed: [f64; 6],
    limit: u64,
) -> Result<Result<[f64; 6], Failure>> {
    let Some(start) = engine.solve_ik(phases[0].position, seed) else {
        return Ok(Err(Failure::Unreachable));
    };
    let mut angles = start;
    let mut previous = phases[0].position;
    for phase in phases {
        for index in 0..40 {
            ensure!(
                engine.work() < limit,
                "Planning exceeded its solver-step budget"
            );
            let target = previous + (phase.position - previous) * (index as f64 / 39.);
            let Some(next) = engine.solve_ik(target, angles) else {
                return Ok(Err(Failure::Unreachable));
            };
            angles = next;
            if let Err(reason) =
                check_contacts(&engine.probe_contacts(&angles, phase.closed), false)
            {
                return Ok(Err(reason));
            }
            if !engine.probe_supports_load(phase.carrying) {
                return Ok(Err(Failure::ActuatorLimit));
            }
        }
        previous = phase.position;
    }
    Ok(Ok(start))
}

fn choose_start(
    engine: &mut Engine,
    phases: &[Phase],
    limit: u64,
) -> Result<Result<[f64; 6], Failure>> {
    let mut last = Failure::Unreachable;
    for shoulder in [-1.5, 1.5, 0.] {
        for yaw in [0., 2.5, -2.5] {
            for elbow in [-2., 2.] {
                for wrist in [-1.57, 1.57] {
                    match choose_branch(
                        engine,
                        phases,
                        [yaw, shoulder, elbow, -1.5, wrist, -1.57],
                        limit,
                    )? {
                        Ok(start) => return Ok(Ok(start)),
                        Err(reason @ (Failure::DestinationBlocked | Failure::DoorObstructed)) => {
                            return Ok(Err(reason));
                        }
                        Err(reason) => {
                            if last != Failure::ActuatorLimit {
                                last = reason;
                            }
                        }
                    }
                }
            }
        }
    }
    // Include neutral wrist seeds so non-UR wrist layouts can enter either elbow branch.
    for seed in [
        engine.joints(),
        [0.; 6],
        [0., 1.5, 2., 0., -1., 0.],
        [0., 1.5, 2., 0., 1., 0.],
    ] {
        match choose_branch(engine, phases, seed, limit)? {
            Ok(start) => return Ok(Ok(start)),
            Err(reason @ (Failure::DestinationBlocked | Failure::DoorObstructed)) => {
                return Ok(Err(reason));
            }
            Err(reason) => {
                if last != Failure::ActuatorLimit {
                    last = reason;
                }
            }
        }
    }
    Ok(Err(last))
}

fn validate_prefix(
    engine: &Engine,
    phases: &[Phase],
    prefix: &Prefix,
    timestep: f64,
    origin_time: f64,
) -> Result<()> {
    let progress = &prefix.progress;
    ensure!(
        progress.next_phase > 0 && progress.next_phase < phases.len(),
        "Checkpoint must precede a remaining phase"
    );
    let expected_step: usize = phases[..progress.next_phase]
        .iter()
        .map(|phase| (phase.seconds / timestep).round() as usize)
        .sum();
    ensure!(
        progress.step == expected_step
            && (engine.time() - origin_time - expected_step as f64 * timestep).abs() < 1e-8,
        "Checkpoint time/phase mismatch"
    );
    ensure!(
        progress.previous_target == <[f64; 3]>::from(phases[progress.next_phase - 1].position),
        "Checkpoint target mismatch"
    );
    for (angle, (lower, upper)) in progress.angles.iter().zip(engine.limits()) {
        ensure!(
            angle.is_finite() && angle >= lower && angle <= upper,
            "Invalid controller target"
        );
    }
    ensure!(
        progress.lost_steps as f64 * timestep < 0.06,
        "Checkpoint already lost grasp"
    );
    ensure!(
        !progress.grip_disabled || progress.pickup,
        "Grip mutation requires pickup"
    );
    ensure!(
        !prefix.samples.is_empty() && prefix.samples.len() <= 4096 && prefix.samples[0].step == 0,
        "Invalid recording prefix"
    );
    for pair in prefix.samples.windows(2) {
        ensure!(pair[0].step < pair[1].step, "Unordered recording prefix");
    }
    for sample in &prefix.samples {
        ensure!(
            sample.step <= progress.step
                && sample
                    .joints
                    .iter()
                    .chain(&sample.tray)
                    .chain(&sample.tool)
                    .chain(&sample.jaw)
                    .all(|v| v.is_finite()),
            "Invalid recorded sample"
        );
    }
    let mut expected_phases = Vec::new();
    let mut phase_step = 0;
    for phase in &phases[..progress.next_phase] {
        expected_phases.push((phase_step, phase.name));
        phase_step += (phase.seconds / timestep).round() as usize;
    }
    let mut observed = Vec::new();
    let mut pickups = 0;
    let mut previous_step = 0;
    for event in &prefix.events {
        let step = match event {
            Event::Phase { step, label } => {
                observed.push((*step, label.as_str()));
                *step
            }
            Event::Pickup { step } => {
                pickups += 1;
                *step
            }
            Event::Placement { .. }
            | Event::Failure { .. }
            | Event::CarrierRemoved { .. }
            | Event::RecoveryCompleted { .. } => {
                anyhow::bail!("Terminal event cannot resume")
            }
        };
        ensure!(
            step >= previous_step
                && step <= progress.step
                && prefix.samples.iter().any(|sample| sample.step == step),
            "Event lacks ordered matching sample"
        );
        previous_step = step;
    }
    ensure!(
        observed == expected_phases && pickups == usize::from(progress.pickup),
        "Checkpoint phase/pickup history mismatch"
    );
    Ok(())
}

/// The most solver steps (`Engine::work`: integration steps, inverse
/// kinematics iterations and probe poses) that one operation may compute,
/// planning included. Steps of other operations and rests between calls do
/// not count. Refactor 16 step 6E set it in place of 120 s of real time: on
/// the reference Mac (Apple M4 Pro) the costliest solver step of a transfer
/// took 12.0 µs natively and about 18 µs in Wasm, so this count is 72 s
/// natively and about 106 s in Wasm there. The largest operation of the
/// journeys computes 54,636 steps (0.9 %). Every machine gets the same limit.
const SOLVER_BUDGET: u64 = 6_000_000;

/// Why a bounded advance returned.
#[derive(Debug, PartialEq)]
pub enum Stop {
    /// The step allowance ran out at a completed integration step.
    Allowance,
    /// A pickup occurred at the last completed step.
    Event,
    /// The requested phase finished.
    Boundary,
    Terminal(Outcome),
}

/// One transfer, advanced in bounded calls. Its state between calls is
/// complete: the next call continues the same phase, targets and counters.
pub struct Operation {
    binding: Binding,
    phases: Vec<Phase>,
    progress: Progress,
    within: Within,
    samples: Vec<Sample>,
    events: Vec<Event>,
    destination: Point,
    pickup_height: f64,
    evidence: Evidence,
    /// The solver steps this operation has computed.
    work: u64,
    recovery: bool,
}

fn plan(engine: &Engine, task: BakeryTask, start: &Start) -> Result<Vec<Phase>> {
    match start {
        Start::Recovery {
            previous_target,
            handling_steps,
            ..
        } => {
            ensure!(
                (1..=150_000).contains(handling_steps),
                "Recovery handling lasts at most five minutes"
            );
            let from = Point::from(*previous_target);
            let source = engine.site("source_tray_center")? + Point::from(GRASP_OFFSET);
            let ready = source + Point::new(-0.25, 0., -0.003);
            let height = from.z.max(source.z + 0.32);
            Ok(vec![
                Phase::new(
                    "human_handling",
                    from,
                    *handling_steps as f64 * engine.timestep(),
                    false,
                    false,
                ),
                Phase::new(
                    "recovery_lift",
                    Point::new(from.x, from.y, height),
                    2.,
                    false,
                    false,
                ),
                Phase::new(
                    "recovery_traverse",
                    Point::new(ready.x, ready.y, height),
                    5.,
                    false,
                    false,
                ),
                Phase::new("recovery_lower", ready, 3., false, false),
                Phase::new("recovery_settled", ready, 2., false, false),
            ])
        }
        Start::Prepared => {
            ensure!(
                task != BakeryTask::Unload,
                "Retrieval requires loaded state"
            );
            phases(engine, task)
        }
        Start::Returned {
            previous_target,
            tray,
            ..
        } => {
            ensure!(
                task == BakeryTask::Rack,
                "Returned state requires rack transfer"
            );
            let source = Point::from_column_slice(&tray[..3]) + Point::from(GRASP_OFFSET);
            transfer_phases(
                engine,
                task,
                source,
                Point::from(*previous_target),
                0.12,
                0.20,
            )
        }
        Start::Loaded {
            previous_target,
            tray,
            ..
        } => {
            ensure!(
                task == BakeryTask::Unload,
                "Loaded state only supports retrieval"
            );
            unloading_phases(engine, *previous_target, *tray)
        }
        Start::Ready {
            previous_target, ..
        }
        | Start::Retreated {
            previous_target, ..
        } => {
            ensure!(
                matches!(task, BakeryTask::Rack | BakeryTask::Oven),
                "A ready cell supports rack transfer or oven loading"
            );
            let source = engine.site("source_tray_center")? + Point::from(GRASP_OFFSET);
            let from = Point::from(*previous_target);
            let clearance = if task == BakeryTask::Oven { 0.50 } else { 0.32 };
            let mut phases = transfer_phases(engine, task, source, from, clearance, 0.30)?;
            if matches!(start, Start::Retreated { .. }) {
                // Rise clear of the rack and cross above the fixtures before
                // the usual approach. The arm is never repositioned.
                let approach = source + Point::new(-0.25, 0., -0.003);
                phases.splice(
                    1..1,
                    [
                        Phase::new(
                            "return_lift",
                            from + Point::new(0., 0., 0.32),
                            2.,
                            false,
                            false,
                        ),
                        Phase::new(
                            "return_traverse",
                            approach + Point::new(0., 0., 0.32),
                            5.,
                            false,
                            false,
                        ),
                    ],
                );
            }
            Ok(phases)
        }
    }
}

/// Checks the whole path from the arm's current joint solution. No start
/// pose is chosen: the plan is accepted only if it continues from `angles`.
fn continue_branch(
    engine: &mut Engine,
    phases: &[Phase],
    angles: [f64; 6],
    limit: u64,
) -> Result<Result<[f64; 6], Failure>> {
    Ok(match choose_branch(engine, phases, angles, limit)? {
        Ok(start)
            if start
                .iter()
                .zip(angles)
                .all(|(found, held)| (found - held).abs() < 1e-3) =>
        {
            Ok(angles)
        }
        Ok(_) => Err(Failure::Unreachable),
        Err(reason) => Err(reason),
    })
}

/// The ready pose a prepared rack transfer starts from, and its first target.
/// The joint angles and the grasp target of a cell's ready pose.
pub type ReadyPose = ([f64; 6], [f64; 3]);

pub fn ready_pose(engine: &mut Engine, task: BakeryTask) -> Result<ReadyPose> {
    match ready_plan(engine, task)? {
        Ok(pose) => Ok(pose),
        Err(reason) => anyhow::bail!("No ready pose reaches the fixture: {reason:?}"),
    }
}

/// The ready pose, or the failed outcome when no ready pose reaches the
/// fixture: a blocked or unreachable destination.
pub fn ready_or_failure(
    engine: &mut Engine,
    task: BakeryTask,
) -> Result<Result<ReadyPose, Outcome>> {
    Ok(ready_plan(engine, task)?.map_err(|reason| failure(engine, reason, 0, task)))
}

fn ready_plan(engine: &mut Engine, task: BakeryTask) -> Result<Result<ReadyPose, Failure>> {
    let phases = phases(engine, task)?;
    Ok(
        choose_start(engine, &phases, engine.work() + SOLVER_BUDGET)?
            .map(|angles| (angles, phases[0].position.into())),
    )
}

fn phase_steps(phase: &Phase, timestep: f64) -> usize {
    (phase.seconds / timestep).round() as usize
}

fn pickup_height(engine: &Engine, task: BakeryTask) -> Result<f64> {
    Ok(match task {
        BakeryTask::Rack | BakeryTask::Oven => engine.site("source_tray_center")?.z + 0.03,
        BakeryTask::Unload => engine.site("mbco_slot_3")?.z + 0.005,
    })
}

fn validate_within(
    engine: &Engine,
    phases: &[Phase],
    progress: &Progress,
    within: &Within,
    timestep: f64,
    origin_time: f64,
) -> Result<()> {
    ensure!(
        progress.next_phase < phases.len(),
        "A terminal checkpoint cannot resume an operation"
    );
    let phase = &phases[progress.next_phase];
    let before: usize = phases[..progress.next_phase]
        .iter()
        .map(|phase| phase_steps(phase, timestep))
        .sum();
    // Steps are the clock. The solver's own time is a running sum that drifts
    // over millions of steps, so it only has to agree to within half a step.
    ensure!(
        within.step < phase_steps(phase, timestep)
            && progress.step == before + within.step
            && (engine.time() - origin_time - progress.step as f64 * timestep).abs()
                < timestep / 2.,
        "Checkpoint time/phase mismatch"
    );
    let previous = phases[progress.next_phase.saturating_sub(1)].position;
    ensure!(
        progress.previous_target == <[f64; 3]>::from(previous),
        "Checkpoint target mismatch"
    );
    for (angle, (lower, upper)) in progress.angles.iter().zip(engine.limits()) {
        ensure!(
            angle.is_finite() && angle >= lower && angle <= upper,
            "Invalid controller target"
        );
    }
    ensure!(
        progress.lost_steps as f64 * timestep < 0.06,
        "Checkpoint already lost grasp"
    );
    ensure!(
        !progress.grip_disabled || progress.pickup,
        "Grip mutation requires pickup"
    );
    ensure!(
        !progress.pickup
            || phases[..=progress.next_phase]
                .iter()
                .any(|phase| phase.carrying),
        "Pickup precedes the first carrying phase"
    );
    ensure!(
        within.release_offset.is_finite()
            && within.settled_steps <= within.step
            && (within.settled_steps == 0 || matches!(phase.name, "settled" | "recovery_settled"))
            && (within.step > 0 || within.release_offset == 0.),
        "Invalid progress inside the phase"
    );
    Ok(())
}

impl Operation {
    /// Plans a new operation or restores a phase-boundary checkpoint. A failed
    /// plan returns its outcome with the operation, which has executed nothing.
    pub fn open(
        engine: &mut Engine,
        binding: Binding,
        resume: Option<Prefix>,
        start: Start,
    ) -> Result<(Self, Option<Outcome>)> {
        let opened = engine.work();
        let task = binding.request.bakery_task_id;
        let phases = plan(engine, task, &start)?;
        let origin_time = engine.time();
        let timestep = binding.request.timestep;
        ensure!(
            engine.timestep() == timestep,
            "Model timestep differs from request"
        );
        let destination = engine.site(task.destination())?;
        let pickup_height = pickup_height(engine, task)?;
        let mut failed = None;
        let (progress, samples, events) = match resume {
            Some(prefix) => {
                if prefix.progress.grip_disabled {
                    engine.disable_grip();
                }
                engine.restore(&prefix.integration_state)?;
                validate_prefix(engine, &phases, &prefix, timestep, origin_time)?;
                (prefix.progress, prefix.samples, prefix.events)
            }
            None => {
                let planning = match start {
                    Start::Prepared => {
                        ensure!(engine.time() == 0., "Prepared operation requires time zero");
                        choose_start(engine, &phases, opened + SOLVER_BUDGET)
                    }
                    Start::Loaded { angles, .. } | Start::Returned { angles, .. } => Ok(Ok(angles)),
                    Start::Recovery { angles, .. } => {
                        // A failed arm can deviate from the controller's ideal
                        // orientation. Validate the return, but begin by holding
                        // its actual joints. The servo executes every correction.
                        choose_branch(engine, &phases, angles, opened + SOLVER_BUDGET)
                            .map(|result| result.map(|_| angles))
                    }
                    Start::Ready { angles, .. } | Start::Retreated { angles, .. } => {
                        continue_branch(engine, &phases, angles, opened + SOLVER_BUDGET)
                    }
                };
                let angles = match planning {
                    Ok(Ok(angles)) => {
                        if matches!(start, Start::Prepared) {
                            engine.set_start(&angles);
                        }
                        angles
                    }
                    Ok(Err(reason)) => {
                        failed = Some(failure(engine, reason, 0, task));
                        engine.joints()
                    }
                    Err(error) => {
                        failed = Some(Outcome::ExecutionError {
                            step: 0,
                            message: error.to_string(),
                        });
                        engine.joints()
                    }
                };
                (
                    Progress {
                        next_phase: 0,
                        step: 0,
                        angles,
                        previous_target: phases[0].position.into(),
                        lost_steps: 0,
                        pickup: false,
                        grip_disabled: false,
                        measured: Measured::default(),
                    },
                    vec![engine.sample(0)],
                    Vec::new(),
                )
            }
        };
        let evidence = placement(engine, destination, task).1;
        Ok((
            Self {
                binding,
                phases,
                progress,
                within: Within::boundary(),
                samples,
                events,
                destination,
                pickup_height,
                evidence,
                work: engine.work() - opened,
                recovery: matches!(start, Start::Recovery { .. }),
            },
            failed,
        ))
    }

    /// Resumes an operation inside a world that is already restored, such as
    /// a persistent cell's. `origin_time` is the engine time at its dispatch.
    pub fn resume(
        engine: &Engine,
        binding: Binding,
        start: &Start,
        saved: (Vec<PhasePlan>, Progress, Within),
        origin_time: f64,
    ) -> Result<Self> {
        let opened = engine.work();
        let task = binding.request.bakery_task_id;
        let phases = plan(engine, task, start)?;
        let (saved_plan, progress, within) = saved;
        ensure!(
            plan_of(&phases) == saved_plan,
            "Checkpoint plan differs from this operation"
        );
        let timestep = binding.request.timestep;
        ensure!(
            engine.timestep() == timestep,
            "Model timestep differs from request"
        );
        validate_within(engine, &phases, &progress, &within, timestep, origin_time)?;
        let destination = engine.site(task.destination())?;
        Ok(Self {
            samples: vec![engine.sample(progress.step)],
            pickup_height: pickup_height(engine, task)?,
            evidence: placement(engine, destination, task).1,
            binding,
            phases,
            progress,
            within,
            events: Vec::new(),
            destination,
            work: engine.work() - opened,
            recovery: matches!(start, Start::Recovery { .. }),
        })
    }

    /// The plan and controller progress a checkpoint saves.
    pub fn saved(&self) -> (Vec<PhasePlan>, Progress, Within) {
        (
            plan_of(&self.phases),
            self.progress.clone(),
            self.within.clone(),
        )
    }

    /// The servo targets and the grasp target the arm currently holds.
    pub fn servo(&self) -> ([f64; 6], [f64; 3]) {
        (self.progress.angles, self.progress.previous_target)
    }

    pub fn binding(&self) -> &Binding {
        &self.binding
    }

    pub fn step(&self) -> usize {
        self.progress.step
    }

    pub fn carrier_removed(&self) -> bool {
        self.recovery && self.progress.next_phase > 0
    }

    /// The index of a remaining nonterminal phase to stop after.
    pub fn boundary(&self, name: &str) -> Result<usize> {
        Ok(self
            .phases
            .iter()
            .enumerate()
            .find(|(index, phase)| {
                *index >= self.progress.next_phase
                    && *index < self.phases.len() - 1
                    && phase.name == name
            })
            .context("Choose a remaining nonterminal pause phase")?
            .0)
    }

    /// Executes at most `allowance` integration steps. Returns earlier on a
    /// pickup, the requested phase boundary, a failure or completion.
    pub fn advance(
        &mut self,
        engine: &mut Engine,
        allowance: usize,
        boundary: Option<usize>,
    ) -> Result<Stop> {
        let started = engine.work();
        let stop = self.advance_from(engine, allowance, boundary, started);
        self.work += engine.work() - started;
        self.measure_terminal(engine, stop)
    }

    /// The margins of the motion so far.
    pub fn margins(&self, engine: &Engine, overspeed: Option<Overspeed>) -> Margins {
        let request = &self.binding.request;
        self.progress.measured.report(
            engine.ratings(),
            engine.clamps(),
            request.timestep,
            request.speed_rating_scale,
            overspeed,
        )
    }

    /// A terminal outcome gets the margins of its motion.
    fn measure_terminal(&self, engine: &Engine, stop: Result<Stop>) -> Result<Stop> {
        Ok(match stop? {
            Stop::Terminal(outcome) => {
                Stop::Terminal(outcome.with_margins(self.margins(engine, None)))
            }
            other => other,
        })
    }

    /// Persistent operations retain every solver pose and contact observation.
    /// Finite sessions use their separate, bounded recording contract.
    pub fn advance_recorded(
        &mut self,
        engine: &mut Engine,
        allowance: usize,
        contacts: &mut Vec<ContactObservation>,
    ) -> Result<Stop> {
        for _ in 0..allowance {
            let started = engine.work();
            let before = self.progress.step;
            let mut stop = self.advance_from(engine, 1, None, started);
            if self.progress.step > before {
                capture(engine, self.progress.step, &mut self.samples);
                match engine.contact_pairs() {
                    Ok(pairs) => contacts.push(ContactObservation {
                        step: self.progress.step,
                        pairs,
                    }),
                    Err(error) => stop = Err(error),
                }
            }
            self.work += engine.work() - started;
            match self.measure_terminal(engine, stop)? {
                Stop::Allowance => (),
                stop => return Ok(stop),
            }
        }
        Ok(Stop::Allowance)
    }

    fn advance_from(
        &mut self,
        engine: &mut Engine,
        allowance: usize,
        boundary: Option<usize>,
        started: u64,
    ) -> Result<Stop> {
        let task = self.binding.request.bakery_task_id;
        let case = self.binding.request.case;
        let dt = self.binding.request.timestep;
        let destination = self.destination;
        let sample_stride = (1. / (30. * dt)).round() as usize;
        let control_stride = (0.01 / dt).round() as usize;
        let mut used = 0;
        while self.progress.next_phase < self.phases.len() {
            if used == allowance {
                return Ok(Stop::Allowance);
            }
            let phase_index = self.progress.next_phase;
            let name = self.phases[phase_index].name;
            let position = self.phases[phase_index].position;
            let closed = self.phases[phase_index].closed;
            let carrying = self.phases[phase_index].carrying;
            let steps = phase_steps(&self.phases[phase_index], dt);
            let previous = Point::from(self.progress.previous_target);
            let previous_jaw = if self.phases[phase_index.saturating_sub(1)].closed {
                -0.005
            } else {
                OPEN_JAW_M
            };
            if self.within.step == 0 {
                let tray_y = engine.sample(self.progress.step).tray[1];
                self.within.release_offset =
                    tray_y - engine.grasp_site().y + OVEN_CENTERING_GAIN * (tray_y - destination.y);
                capture(engine, self.progress.step, &mut self.samples);
                self.events.push(Event::Phase {
                    step: self.progress.step,
                    label: name.into(),
                });
            }
            let release_offset = self.within.release_offset;
            let mut picked = false;
            while self.within.step < steps && !picked {
                if used == allowance {
                    return Ok(Stop::Allowance);
                }
                let index = self.within.step;
                ensure!(
                    self.work + (engine.work() - started) < SOLVER_BUDGET
                        && (self.progress.step as f64 * dt)
                            < if self.recovery { 313. } else { 60. },
                    "Transfer exceeded its solver-step budget"
                );
                let fraction = (index + 1) as f64 / steps as f64;
                let blend = fraction.powi(3) * (10. - 15. * fraction + 6. * fraction.powi(2));
                if name != "human_handling" && index.is_multiple_of(control_stride) {
                    let mut target = previous + blend * (position - previous);
                    // Compensate both tray movement within the clamp and arm tracking
                    // error at the narrow opening. Keep physical contacts and bound
                    // the correction to 15 mm.
                    if task == BakeryTask::Oven {
                        let (offset, fraction) = match name {
                            "align_oven" => (
                                engine.sample(self.progress.step).tray[1] - engine.grasp_site().y,
                                blend,
                            ),
                            "insert_oven" | "place" => (
                                engine.sample(self.progress.step).tray[1] - engine.grasp_site().y,
                                1.,
                            ),
                            "release" => (release_offset, 1. - blend),
                            _ => (0., 0.),
                        };
                        let tracking = if closed {
                            OVEN_CENTERING_GAIN
                                * (engine.sample(self.progress.step).tray[1] - destination.y)
                        } else {
                            0.
                        };
                        target.y -= fraction
                            * (offset + tracking)
                                .clamp(-OVEN_CENTERING_LIMIT_M, OVEN_CENTERING_LIMIT_M);
                    } else if task == BakeryTask::Unload && matches!(name, "lift" | "extract_oven")
                    {
                        let tray_y = engine.sample(self.progress.step).tray[1];
                        let oven_y = engine.site(BakeryTask::Oven.destination())?.y;
                        let offset = tray_y - engine.grasp_site().y;
                        let fraction = if name == "lift" { blend } else { 1. };
                        target.y += fraction
                            * (oven_y
                                - position.y
                                - offset
                                - OVEN_CENTERING_GAIN * (tray_y - oven_y))
                                .clamp(-OVEN_CENTERING_LIMIT_M, OVEN_CENTERING_LIMIT_M);
                    }
                    let Some(angles) = engine.solve_ik(target, self.progress.angles) else {
                        return Ok(Stop::Terminal(failure(
                            engine,
                            Failure::Unreachable,
                            self.progress.step,
                            task,
                        )));
                    };
                    self.progress.angles = angles;
                }
                if case == Case::Slip && name == "transfer" && index as f64 * dt > 0.2 {
                    engine.disable_grip();
                    self.progress.grip_disabled = true;
                }
                let jaw = if closed { -0.005 } else { OPEN_JAW_M };
                engine.step(
                    &self.progress.angles,
                    carrying,
                    previous_jaw + blend * (jaw - previous_jaw),
                )?;
                self.progress.step += 1;
                self.within.step += 1;
                used += 1;
                let reading = engine.reading(carrying);
                let scale = self.binding.request.speed_rating_scale.unwrap_or(1.);
                let measured = &mut self.progress.measured;
                if let Some(overspeed) = measured.add(engine.ratings(), scale, &reading) {
                    let outcome = failure(engine, Failure::JointSpeed, self.progress.step, task);
                    let margins = self.margins(engine, Some(overspeed));
                    return Ok(Stop::Terminal(outcome.with_margins(margins)));
                }
                // One contact scan serves every check of this step.
                let scan = engine.live_contacts();
                let carried = touched(&scan);
                if let Err(reason) = check_contacts(&scan, true) {
                    return Ok(Stop::Terminal(failure(
                        engine,
                        reason,
                        self.progress.step,
                        task,
                    )));
                }
                for (angle, (lower, upper)) in engine.joints().iter().zip(engine.limits()) {
                    if *angle < lower - 0.002 || *angle > upper + 0.002 {
                        return Ok(Stop::Terminal(failure(
                            engine,
                            Failure::JointLimit,
                            self.progress.step,
                            task,
                        )));
                    }
                }
                if carrying {
                    let sample = engine.sample(self.progress.step);
                    let tray = Point::from_column_slice(&sample.tray[..3]);
                    let expected = engine.grasp_site() - Point::from(GRASP_OFFSET);
                    let stable = contains_all(&carried, &GRIP)
                        && (tray - expected).norm() < 0.025
                        && orientation_error(&sample.tray) < 5_f64.to_radians();
                    self.progress.lost_steps = if stable {
                        0
                    } else {
                        self.progress.lost_steps + 1
                    };
                    if self.progress.lost_steps as f64 * dt >= 0.06 {
                        return Ok(Stop::Terminal(failure(
                            engine,
                            Failure::LostGrasp,
                            self.progress.step,
                            task,
                        )));
                    }
                    if !self.progress.pickup
                        && !task
                            .source_supports()
                            .iter()
                            .any(|name| carried.contains(name))
                        && tray.z > self.pickup_height
                    {
                        self.progress.pickup = true;
                        capture(engine, self.progress.step, &mut self.samples);
                        self.events.push(Event::Pickup {
                            step: self.progress.step,
                        });
                        picked = true;
                    }
                }
                let (accepted, observation) = placement_with(engine, &carried, destination, task);
                self.evidence = observation;
                let returned = name == "recovery_settled"
                    && (engine.grasp_site() - position).norm() < 0.01
                    && engine.arm_speed() < 1e-4
                    && engine.jaw_opening() > 0.02;
                self.within.settled_steps = if (name == "settled" && accepted) || returned {
                    self.within.settled_steps + 1
                } else {
                    0
                };
                if self.progress.step.is_multiple_of(sample_stride) {
                    capture(engine, self.progress.step, &mut self.samples);
                }
            }
            if self.within.step == steps {
                self.progress.next_phase = phase_index + 1;
                self.progress.previous_target = position.into();
                self.within.step = 0;
                self.within.release_offset = 0.;
                if name == "human_handling" {
                    let arm = engine.joints();
                    let reference = engine
                        .reference()
                        .context("Recovery requires a persistent cell")?;
                    engine.park_tray();
                    ensure!(
                        engine.joints() == arm && engine.reference() == Some(reference),
                        "Human removal changed another body"
                    );
                    capture(engine, self.progress.step, &mut self.samples);
                    self.events.push(Event::CarrierRemoved {
                        step: self.progress.step,
                    });
                    return Ok(Stop::Event);
                }
                if boundary == Some(phase_index) {
                    return Ok(Stop::Boundary);
                }
            }
            if picked {
                return Ok(Stop::Event);
            }
        }
        if self.recovery && self.within.settled_steps as f64 * dt >= 1.0 {
            return Ok(Stop::Terminal(Outcome::Recovered {
                step: self.progress.step,
                margins: None,
            }));
        }
        if self.recovery || !self.progress.pickup || self.within.settled_steps as f64 * dt < 1.0 {
            return Ok(Stop::Terminal(failure(
                engine,
                Failure::PlacementFailed,
                self.progress.step,
                task,
            )));
        }
        // Record the verified minimum continuous stability interval.
        let mut evidence = self.evidence.clone();
        evidence.settled_seconds = 1.;
        Ok(Stop::Terminal(Outcome::Completed {
            step: self.progress.step,
            evidence,
            margins: None,
        }))
    }

    /// Ends a recording interval at the current step with its exact sample and
    /// returns what it recorded. The next interval starts from that sample.
    pub fn cut(&mut self, engine: &Engine) -> (Vec<Sample>, Vec<Event>) {
        capture(engine, self.progress.step, &mut self.samples);
        let next = vec![engine.sample(self.progress.step)];
        (
            std::mem::replace(&mut self.samples, next),
            std::mem::take(&mut self.events),
        )
    }

    /// Records the terminal sample and event for `outcome`.
    pub fn close(&mut self, engine: &Engine, outcome: &Outcome) {
        capture(engine, self.progress.step, &mut self.samples);
        self.events.push(match outcome {
            Outcome::Recovered { .. } => Event::RecoveryCompleted {
                step: self.progress.step,
            },
            Outcome::Completed { .. } => Event::Placement {
                step: self.progress.step,
            },
            Outcome::Failed { .. } | Outcome::ExecutionError { .. } => Event::Failure {
                step: self.progress.step,
            },
        });
    }

    /// Integration steps of the plan: the sum of its phase durations. A
    /// settle can take longer, so this is the expected length, not a limit.
    pub fn planned_steps(&self) -> usize {
        let seconds: f64 = self.phases.iter().map(|phase| phase.seconds).sum();
        (seconds / self.binding.request.timestep).round() as usize
    }

    pub fn into_result(mut self, engine: &Engine, outcome: Outcome) -> Artifact {
        self.close(engine, &outcome);
        Artifact::BakeryNativeResult {
            binding: self.binding,
            samples: self.samples,
            events: self.events,
            outcome,
            progress: self.progress,
            integration_state: engine.state(),
        }
    }
}

fn plan_of(phases: &[Phase]) -> Vec<PhasePlan> {
    phases
        .iter()
        .map(|phase| PhasePlan {
            name: phase.name.into(),
            position: phase.position.into(),
            seconds: phase.seconds,
            closed: phase.closed,
            carrying: phase.carrying,
        })
        .collect()
}

/// Runs an operation to its end or to the end of the named phase.
pub fn run(
    engine: &mut Engine,
    binding: Binding,
    resume: Option<Prefix>,
    pause_after: Option<&str>,
    start: Start,
) -> Result<Artifact> {
    let (mut operation, failed) = Operation::open(engine, binding, resume, start)?;
    if let Some(outcome) = failed {
        return Ok(operation.into_result(engine, outcome));
    }
    let boundary = match pause_after {
        Some(name) => Some(operation.boundary(name)?),
        None => None,
    };
    loop {
        match operation.advance(engine, usize::MAX, boundary) {
            Ok(Stop::Allowance | Stop::Event) => {}
            Ok(Stop::Boundary) => {
                return Artifact::checkpoint(
                    operation.binding,
                    Prefix {
                        progress: operation.progress,
                        integration_state: engine.state(),
                        samples: operation.samples,
                        events: operation.events,
                    },
                );
            }
            Ok(Stop::Terminal(outcome)) => return Ok(operation.into_result(engine, outcome)),
            Err(error) => {
                let outcome = Outcome::ExecutionError {
                    step: operation.progress.step,
                    message: error.to_string(),
                };
                return Ok(operation.into_result(engine, outcome));
            }
        }
    }
}

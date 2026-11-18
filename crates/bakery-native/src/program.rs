//! One-shot programs in the persistent host (Refactor 16, step 5). A program
//! is what the command line runs as one call (a transfer, an oven loading, a
//! cycle, a retrieval or a rack continuation), here advanced in bounded calls.
//! Between calls the host keeps its world, so a host can report the step and
//! stop at any step boundary. Each program writes the bytes that its command
//! line writes.
//!
//! The robot comparison runs as a program too. Its table-to-rack transfer
//! runs on a new persistent rack cell, the cell that a production run uses.
//! No persistent cell has the standalone oven fixture, so its table-to-oven
//! transfer stays a one-shot transfer on that fixture.
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    artifact::*,
    assets::{Assets, Cell as Fixture, Setup},
    cell::{ActionResult, Bounded, Cell, CellDefinition, CellFixture},
    handoff::{self, CycleDestination, Handoff, ReturnArtifact},
    native::Engine,
    rack,
    recording::Recording,
    robot::Robot,
    transfer::{Operation, Start, Stop},
};

/// A transfer request as `prepare` builds it. Absent fields take the
/// defaults of the command line.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Preparation {
    #[serde(default = "default_robot")]
    pub robot: Robot,
    #[serde(default = "default_mass")]
    pub ingredient_mass_kg: f64,
    #[serde(default)]
    pub ingredient_forward_mm: i32,
    #[serde(default)]
    pub ingredient_lateral_mm: i32,
    #[serde(default = "default_clamp")]
    pub clamp_force_n: f64,
    #[serde(default = "default_task")]
    pub task: BakeryTask,
    #[serde(default = "default_cell")]
    pub cell: Fixture,
    #[serde(default)]
    pub case: Case,
    #[serde(default = "default_timestep")]
    pub timestep: f64,
    #[serde(default)]
    pub rack_x_mm: i32,
    #[serde(default)]
    pub rack_y_mm: i32,
}

fn default_robot() -> Robot {
    Robot::FairinoFr10
}
fn default_mass() -> f64 {
    1.
}
fn default_clamp() -> f64 {
    100.
}
fn default_task() -> BakeryTask {
    BakeryTask::Rack
}
fn default_cell() -> Fixture {
    Fixture::Separate
}
fn default_timestep() -> f64 {
    0.002
}

/// A new run or attempt identity: the time, the process and a counter.
pub fn fresh_identity() -> Result<String> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    Ok(digest(
        format!(
            "{}-{}-{}",
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos(),
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        )
        .as_bytes(),
    ))
}

/// The request of one transfer, pinned to this runner and its assets.
pub fn prepare(assets: &Assets, preparation: &Preparation) -> Result<Request> {
    ensure!(
        preparation.task != BakeryTask::Unload,
        "Retrieval requires a completed loading handoff"
    );
    let identity = fresh_identity()?;
    let layout = Layout::rack(preparation.rack_x_mm, preparation.rack_y_mm)?;
    let request = Request {
        schema_version: 7,
        source: "local-simulation".into(),
        execution: ExecutionIdentity::current(),
        run_id: format!("run-{identity}"),
        attempt_id: format!("attempt-{identity}"),
        bakery_task_id: preparation.task,
        model_hash: assets.layout_hash(preparation.robot, preparation.cell, layout)?,
        robot: preparation.robot,
        ingredients: IngredientLoad {
            mass_kg: preparation.ingredient_mass_kg,
            forward_mm: preparation.ingredient_forward_mm,
            lateral_mm: preparation.ingredient_lateral_mm,
        },
        clamp_force_n: preparation.clamp_force_n,
        layout,
        case: preparation.case,
        timestep: preparation.timestep,
        speed_rating_scale: None,
    };
    ensure!(
        matches!(preparation.cell, Fixture::Separate | Fixture::PanStaging)
            || preparation.task == BakeryTask::Oven,
        "Combined fixture starts with oven loading"
    );
    assets.validate_request(&request)?;
    Ok(request)
}

/// What the program does with the tray after a completed oven loading.
#[derive(Clone, Copy)]
pub enum Loaded {
    /// Hand off the loaded state: `load`.
    Handoff,
    /// Retrieve in the same world: `cycle`.
    Cycle(CycleDestination),
    /// Hand off, then retrieve from the handoff: the browser's oven handoff.
    Unload,
}

/// Refuses a first transfer that its command would refuse.
pub fn check_first(assets: &Assets, request: &Request, loaded: Option<Loaded>) -> Result<()> {
    ensure!(
        serde_json::to_vec(request)?.len() <= 4096,
        "Request exceeds 4 KiB"
    );
    ensure!(
        request.bakery_task_id != BakeryTask::Unload,
        "Retrieval requires a completed loading handoff"
    );
    ensure!(
        loaded.is_none()
            || (request.bakery_task_id == BakeryTask::Oven && request.case == Case::Nominal),
        "A cold cycle requires nominal oven loading"
    );
    ensure!(
        !(assets.is_combined(request) && request.bakery_task_id == BakeryTask::Rack),
        "Combined rack transfer requires a retrieval handoff"
    );
    ensure!(
        !matches!(loaded, Some(Loaded::Cycle(CycleDestination::Rack(_))))
            || assets.is_combined(request),
        "Rack cycle requires combined fixture"
    );
    Ok(())
}

/// What a finished operation becomes.
pub enum After {
    Recording {
        setup: Box<Setup>,
    },
    Loading {
        setup: Box<Setup>,
        then: Loaded,
    },
    Return {
        stage: Box<handoff::Return>,
        rack: Option<rack::Case>,
    },
    Rack {
        stage: Box<rack::Racking>,
    },
}

/// One operation of a program in its world, with what follows it.
pub struct Transfer {
    engine: Engine,
    operation: Operation,
    after: After,
}

pub enum Stage {
    Running(Box<Transfer>),
    /// The output JSON, as the command line writes it (without the newline).
    Finished(Vec<u8>),
}

fn finished(value: &impl Serialize) -> Result<Stage> {
    let encoded = serde_json::to_vec(value)?;
    ensure!(encoded.len() <= 16 * 1024 * 1024, "Output exceeds 16 MiB");
    Ok(Stage::Finished(encoded))
}

/// Starts one operation. A plan that fails before any step ends it at once.
pub fn begin(
    assets: &Assets,
    mut engine: Engine,
    binding: Binding,
    start: Start,
    after: After,
) -> Result<Stage> {
    let (operation, failed) = Operation::open(&mut engine, binding, None, start)?;
    match failed {
        None => Ok(Stage::Running(Box::new(Transfer {
            engine,
            operation,
            after,
        }))),
        Some(outcome) => {
            let artifact = operation.into_result(&engine, outcome);
            conclude(assets, engine, after, artifact)
        }
    }
}

/// Turns the result of an operation into the output, or into the next
/// operation of the program.
pub fn conclude(
    assets: &Assets,
    engine: Engine,
    after: After,
    artifact: Artifact,
) -> Result<Stage> {
    match after {
        After::Recording { setup } => finished(&Recording::from_result(&artifact, &setup, assets)?),
        After::Loading { setup, then } => {
            let completed = matches!(
                &artifact,
                Artifact::BakeryNativeResult {
                    outcome: Outcome::Completed { .. },
                    ..
                }
            );
            let recording = Recording::from_result(&artifact, &setup, assets)?;
            if !completed {
                return finished(&recording);
            }
            let handoff = Handoff::new(artifact, recording, &engine)?;
            match then {
                Loaded::Handoff => finished(&handoff),
                Loaded::Cycle(destination) => {
                    let start = handoff.loaded_start(&engine)?;
                    let (completion, rack) = match destination {
                        CycleDestination::Table => (Completion::Recording, None),
                        CycleDestination::Rack(case) => (Completion::RetrievalHandoff, Some(case)),
                    };
                    let (stage, binding) = handoff::Return::begin(handoff, assets, completion)?;
                    begin(
                        assets,
                        engine,
                        binding,
                        start,
                        After::Return {
                            stage: Box::new(stage),
                            rack,
                        },
                    )
                }
                Loaded::Unload => unload(assets, handoff),
            }
        }
        After::Return { stage, rack } => match (rack, stage.end(artifact, &engine, assets)?) {
            (Some(case), ReturnArtifact::RackHandoff { handoff }) => {
                let (stage, binding, start) = rack::Racking::begin(*handoff, case)?;
                let stage = Box::new(stage);
                begin(assets, engine, binding, start, After::Rack { stage })
            }
            (_, returned) => finished(&returned),
        },
        After::Rack { stage } => finished(&stage.end(artifact, assets)?),
    }
}

/// A retrieval from a loading handoff, in the world the handoff restores.
fn unload(assets: &Assets, handoff: Handoff) -> Result<Stage> {
    let completion = if handoff.for_rack() {
        Completion::RetrievalHandoff
    } else {
        Completion::Recording
    };
    unload_to(assets, handoff, completion)
}

fn unload_to(assets: &Assets, handoff: Handoff, completion: Completion) -> Result<Stage> {
    let (engine, start) = handoff.restore(assets)?;
    let (stage, binding) = handoff::Return::begin(handoff, assets, completion)?;
    begin(
        assets,
        engine,
        binding,
        start,
        After::Return {
            stage: Box::new(stage),
            rack: None,
        },
    )
}

/// The first operation of a transfer, loading or cycle.
pub fn first(assets: &Assets, request: Request, loaded: Option<Loaded>) -> Result<Stage> {
    check_first(assets, &request, loaded)?;
    let (engine, setup) = assets.open(&request)?;
    let (completion, after) = match loaded {
        None => (
            Completion::Recording,
            After::Recording {
                setup: Box::new(setup),
            },
        ),
        Some(then) => (
            Completion::LoadingHandoff,
            After::Loading {
                setup: Box::new(setup),
                then,
            },
        ),
    };
    begin(
        assets,
        engine,
        Binding::new(request, completion)?,
        Start::Prepared,
        after,
    )
}

impl Transfer {
    pub fn step(&self) -> usize {
        self.operation.step()
    }

    pub fn planned(&self) -> usize {
        self.operation.planned_steps()
    }

    pub fn request(&self) -> &Request {
        &self.operation.binding().request
    }

    /// Advances at most `steps`. An execution error ends the operation, as
    /// it does for a whole-operation run.
    pub fn advance(mut self: Box<Self>, assets: &Assets, steps: usize) -> Result<Stage> {
        let outcome = match self.operation.advance(&mut self.engine, steps, None) {
            Ok(Stop::Terminal(outcome)) => outcome,
            Ok(Stop::Allowance | Stop::Event | Stop::Boundary) => return Ok(Stage::Running(self)),
            Err(error) => Outcome::ExecutionError {
                step: self.operation.step(),
                message: error.to_string(),
            },
        };
        let Transfer {
            engine,
            operation,
            after,
        } = *self;
        let artifact = operation.into_result(&engine, outcome);
        conclude(assets, engine, after, artifact)
    }
}

impl Stage {
    /// Runs the program to its end, as the command line does.
    pub fn to_end(self, assets: &Assets) -> Result<Vec<u8>> {
        let mut stage = self;
        loop {
            match stage {
                Stage::Finished(output) => return Ok(output),
                Stage::Running(transfer) => stage = transfer.advance(assets, usize::MAX)?,
            }
        }
    }
}

/// The robot comparison: one transfer on a new persistent cell, recorded
/// as a one-shot recording.
struct Comparison {
    cell: Cell,
    request: Request,
    setup: Setup,
    samples: Vec<Sample>,
    events: Vec<Event>,
}

enum Job {
    Transfer(Box<Transfer>),
    Comparison(Box<Comparison>),
}

/// The calls of a resting cell in a production run with one cell.
const REST_CALL_STEPS: usize = 32;
/// One minute of rest at most; a cell offers its hold after about one second.
const REST_CALLS: usize = 1000;

/// A run keeps a cell that offers no hold at rest until its order comes;
/// the comparison starts after one minute.
fn rest_until_hold(cell: &mut Cell) -> Result<()> {
    for _ in 0..REST_CALLS {
        if cell.hold().is_some() {
            break;
        }
        cell.bounded(REST_CALL_STEPS, false, &mut Vec::new())?;
    }
    Ok(())
}

impl Comparison {
    fn open(
        assets: &Assets,
        robot: Robot,
        task: BakeryTask,
        case: Case,
        ingredients: IngredientLoad,
    ) -> Result<Result<Self, Vec<u8>>> {
        ensure!(
            task == BakeryTask::Rack,
            "A comparison cell runs a table-to-rack transfer"
        );
        let fixture = CellFixture::Rack;
        let identity = fresh_identity()?;
        let definition = CellDefinition::with_load(
            assets,
            format!("run-{identity}"),
            "comparison".into(),
            robot,
            0.002,
            fixture,
            ingredients,
            case,
        )?;
        let attempt = format!("attempt-{identity}");
        let request = definition.request(&attempt, task);
        let setup = assets.setup(&request)?;
        // A fixture with no ready pose has no cell: its transfer fails
        // before any step, as a one-shot transfer does.
        let mut cell = match Cell::create_or_refuse(assets, definition)? {
            Ok(cell) => cell,
            Err((outcome, sample)) => {
                return Self::refused(assets, request, sample, outcome, &setup).map(Err);
            }
        };
        // As a production cell waits for its first order: the empty cell
        // rests until it offers its hold, the tray enters, and the cell
        // rests again until the hold, then the transfer starts.
        rest_until_hold(&mut cell)?;
        cell.admit("comparison-tray")?;
        rest_until_hold(&mut cell)?;
        match cell.start(&attempt, task)? {
            ActionResult::Started { .. } => Ok(Ok(Self {
                cell,
                request,
                setup,
                samples: Vec::new(),
                events: Vec::new(),
            })),
            ActionResult::Refused { outcome, .. } => {
                Self::refused(assets, request, cell.sample(), outcome, &setup).map(Err)
            }
            _ => bail!("A start reported another action"),
        }
    }

    fn refused(
        assets: &Assets,
        request: Request,
        sample: Sample,
        outcome: Outcome,
        setup: &Setup,
    ) -> Result<Vec<u8>> {
        let recording = Recording::new(
            request,
            vec![sample],
            &[Event::Failure { step: 0 }],
            outcome,
            setup,
            assets,
        );
        match finished(&recording)? {
            Stage::Finished(output) => Ok(output),
            Stage::Running(_) => bail!("A refused comparison has no operation"),
        }
    }

    fn step(&self) -> usize {
        self.cell
            .in_progress()
            .map_or(0, |operation| operation.step)
    }

    fn advance(&mut self, assets: &Assets, steps: usize) -> Result<Option<Vec<u8>>> {
        let mut segments = Vec::new();
        let bounded = self.cell.bounded(steps, false, &mut segments)?;
        // A cell keeps every step. A one-shot recording keeps the 30 Hz
        // samples, the sample of each event and the last one, so the
        // comparison keeps the same.
        let stride = (1. / (30. * self.request.timestep)).round() as usize;
        let mut last = None;
        for segment in segments {
            let events: Vec<usize> = segment.events.iter().map(Event::step).collect();
            for sample in segment.samples {
                let kept = self.samples.last().map(|kept| kept.step);
                if (sample.step.is_multiple_of(stride) || events.contains(&sample.step))
                    && kept != Some(sample.step)
                {
                    self.samples.push(sample.clone());
                }
                last = Some(sample);
            }
            self.events.extend(segment.events);
        }
        match bounded {
            Bounded::Terminal { outcome, .. } => {
                if let Some(sample) = last
                    && self.samples.last().map(|kept| kept.step) != Some(sample.step)
                {
                    self.samples.push(sample);
                }
                let recording = Recording::new(
                    self.request.clone(),
                    std::mem::take(&mut self.samples),
                    &self.events,
                    outcome,
                    &self.setup,
                    assets,
                );
                match finished(&recording)? {
                    Stage::Finished(output) => Ok(Some(output)),
                    Stage::Running(_) => bail!("A recording has no operation"),
                }
            }
            Bounded::Allowance | Bounded::Event => Ok(None),
            Bounded::Idle { .. } => bail!("The comparison cell has no operation"),
        }
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Program {
    /// `run`: one transfer to its recording.
    Run { request: Request },
    /// `load`: oven loading to its handoff.
    Load { request: Request },
    /// `cycle`: loading, then retrieval in the same world.
    Cycle {
        request: Request,
        to_rack: bool,
        #[serde(default)]
        rack_case: Option<rack::Case>,
    },
    /// Loading, then retrieval from the loading handoff.
    OvenHandoff { request: Request },
    /// `unload`: retrieval from a loading handoff file.
    Unload { file: String, for_rack: bool },
    /// `rack`: the rack transfer from a retrieval handoff file.
    Rack { file: String, case: rack::Case },
    /// The robot comparison on a persistent cell.
    Comparison {
        robot: Robot,
        task: BakeryTask,
        case: Case,
        ingredients: IngredientLoad,
    },
}

#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Prepare { preparation: Preparation },
    Open { job: String, program: Box<Program> },
    Advance { job: String, steps: usize },
    Close { job: String },
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Reply {
    Prepared {
        request: Request,
    },
    /// The job runs. `step` counts the integration steps of its present
    /// operation; `planned` is that operation's expected length.
    Running {
        job: String,
        request: Request,
        step: usize,
        planned: usize,
    },
    /// The program's output, exactly as its command line writes the file.
    Finished {
        job: String,
        output: String,
    },
    Closed {
        job: String,
    },
}

/// The programs that one host runs, by job identity.
#[derive(Default)]
pub struct Programs {
    jobs: BTreeMap<String, Job>,
}

fn output_text(mut output: Vec<u8>) -> Result<String> {
    output.push(b'\n');
    Ok(String::from_utf8(output)?)
}

impl Programs {
    fn reply(&mut self, job: String, stage: Stage) -> Result<Reply> {
        match stage {
            Stage::Finished(output) => Ok(Reply::Finished {
                job,
                output: output_text(output)?,
            }),
            Stage::Running(transfer) => {
                let reply = Reply::Running {
                    job: job.clone(),
                    request: transfer.request().clone(),
                    step: transfer.step(),
                    planned: transfer.planned(),
                };
                self.jobs.insert(job, Job::Transfer(transfer));
                Ok(reply)
            }
        }
    }

    pub fn handle(&mut self, assets: &Assets, command: Command) -> Result<Reply> {
        match command {
            Command::Prepare { preparation } => Ok(Reply::Prepared {
                request: prepare(assets, &preparation)?,
            }),
            Command::Open { job, program } => {
                ensure!(
                    !job.is_empty()
                        && job.len() <= 80
                        && job
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
                    "Invalid job identity"
                );
                ensure!(!self.jobs.contains_key(&job), "The job is already open");
                let stage = match *program {
                    Program::Run { request } => first(assets, request, None)?,
                    Program::Load { request } => first(assets, request, Some(Loaded::Handoff))?,
                    Program::Cycle {
                        request,
                        to_rack,
                        rack_case,
                    } => {
                        let destination = match (to_rack, rack_case) {
                            (true, case) => {
                                CycleDestination::Rack(case.unwrap_or(rack::Case::Nominal))
                            }
                            (false, None) => CycleDestination::Table,
                            (false, Some(_)) => bail!("A rack case requires the rack cycle"),
                        };
                        first(assets, request, Some(Loaded::Cycle(destination)))?
                    }
                    Program::OvenHandoff { request } => {
                        first(assets, request, Some(Loaded::Unload))?
                    }
                    Program::Unload { file, for_rack } => {
                        ensure!(
                            file.len() <= 16 * 1024 * 1024,
                            "JSON artifact exceeds 16 MiB"
                        );
                        unload_to(
                            assets,
                            serde_json::from_str(&file)?,
                            if for_rack {
                                Completion::RetrievalHandoff
                            } else {
                                Completion::Recording
                            },
                        )?
                    }
                    Program::Rack { file, case } => {
                        ensure!(
                            file.len() <= 16 * 1024 * 1024,
                            "JSON artifact exceeds 16 MiB"
                        );
                        let ReturnArtifact::RackHandoff { handoff } = serde_json::from_str(&file)?
                        else {
                            bail!("Rack requires completed retrieval handoff");
                        };
                        let engine = handoff.restore(assets)?;
                        let (stage, binding, start) = rack::Racking::begin(*handoff, case)?;
                        let stage = Box::new(stage);
                        begin(assets, engine, binding, start, After::Rack { stage })?
                    }
                    Program::Comparison {
                        robot,
                        task,
                        case,
                        ingredients,
                    } if task == BakeryTask::Oven => {
                        let preparation = Preparation {
                            robot,
                            ingredient_mass_kg: ingredients.mass_kg,
                            ingredient_forward_mm: ingredients.forward_mm,
                            ingredient_lateral_mm: ingredients.lateral_mm,
                            clamp_force_n: default_clamp(),
                            task,
                            cell: default_cell(),
                            case,
                            timestep: default_timestep(),
                            rack_x_mm: 0,
                            rack_y_mm: 0,
                        };
                        first(assets, prepare(assets, &preparation)?, None)?
                    }
                    Program::Comparison {
                        robot,
                        task,
                        case,
                        ingredients,
                    } => match Comparison::open(assets, robot, task, case, ingredients)? {
                        Err(output) => {
                            return Ok(Reply::Finished {
                                job,
                                output: output_text(output)?,
                            });
                        }
                        Ok(comparison) => {
                            let reply = Reply::Running {
                                job: job.clone(),
                                request: comparison.request.clone(),
                                step: 0,
                                planned: comparison.cell.planned_steps().unwrap_or(0),
                            };
                            self.jobs.insert(job, Job::Comparison(Box::new(comparison)));
                            return Ok(reply);
                        }
                    },
                };
                self.reply(job, stage)
            }
            Command::Advance { job, steps } => {
                ensure!(steps >= 1, "Advance at least one step per call");
                match self.jobs.remove(&job).context("Unknown job")? {
                    Job::Transfer(transfer) => {
                        let stage = transfer.advance(assets, steps)?;
                        self.reply(job, stage)
                    }
                    Job::Comparison(mut comparison) => match comparison.advance(assets, steps)? {
                        Some(output) => Ok(Reply::Finished {
                            job,
                            output: output_text(output)?,
                        }),
                        None => {
                            let reply = Reply::Running {
                                job: job.clone(),
                                request: comparison.request.clone(),
                                step: comparison.step(),
                                planned: comparison.cell.planned_steps().unwrap_or(0),
                            };
                            self.jobs.insert(job, Job::Comparison(comparison));
                            Ok(reply)
                        }
                    },
                }
            }
            Command::Close { job } => {
                self.jobs.remove(&job);
                Ok(Reply::Closed { job })
            }
        }
    }
}

//! Persistent espresso world for the production host. All physical behavior stays
//! in the appliance controller. This fixture starts preheated and uses guided cups.
use crate::{
    appliance_espresso::{CupPosition, Group, Model, Outlet, Power},
    appliance_motors::MotorState,
    appliance_run::{Action, Checkpoint, Controller, Initial, Lab},
    appliances::{Batch, Contents, Grinder, Program},
    artifact::{ExecutionIdentity, digest},
    host::{CheckpointRef, Executing, Stopped},
    station_reply::{self, Digested, Header, no_carrier, reference},
};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Fixture {
    #[serde(rename = "persistent-espresso/1")]
    Espresso,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Definition {
    pub schema_version: u8,
    pub fixture: Fixture,
    pub appliance: Model,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grinder: Option<Grinder>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grinder_model_hash: Option<String>,
    pub cell_id: String,
    pub run_id: String,
    pub model_hash: String,
    pub visual_hash: String,
    pub execution: ExecutionIdentity,
}
impl Definition {
    pub fn new(root: &Path, cell_id: String, run_id: String, appliance: Model) -> Result<Self> {
        Self::with_grinder(root, cell_id, run_id, appliance, None)
    }
    pub fn with_grinder(
        root: &Path,
        cell_id: String,
        run_id: String,
        appliance: Model,
        grinder: Option<Grinder>,
    ) -> Result<Self> {
        ensure!(
            appliance != Model::E1Prima,
            "Persistent espresso cells use a dual-group espresso machine"
        );
        let lab = Lab::open(
            root,
            Initial::Fresh {
                appliance: appliance.appliance(),
                contents: Contents::Empty,
            },
        )?;
        ensure!(
            (lab.timestep() - 0.002).abs() < 1e-12,
            "The production espresso model requires a 2 ms timestep"
        );
        let grinder_model_hash = match grinder {
            Some(grinder) => {
                let grinder_lab = Lab::open(
                    root,
                    Initial::Fresh {
                        appliance: grinder.appliance(),
                        contents: Contents::Empty,
                    },
                )?;
                ensure!(
                    (grinder_lab.timestep() - 0.001).abs() < 1e-12,
                    "The production grinder model requires a 1 ms timestep"
                );
                Some(grinder_lab.snapshot().model_hash)
            }
            None => None,
        };
        let value = Self {
            schema_version: 1,
            fixture: Fixture::Espresso,
            appliance,
            grinder,
            grinder_model_hash,
            cell_id,
            run_id,
            model_hash: lab.snapshot().model_hash,
            visual_hash: visual_hash(root, appliance)?,
            execution: ExecutionIdentity::current(),
        };
        value.validate()?;
        Ok(value)
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == 1 && self.execution == ExecutionIdentity::current(),
            "Espresso definition belongs to another build"
        );
        ensure!(
            self.grinder.is_some() == self.grinder_model_hash.is_some(),
            "Espresso grinder definition requires a matching model hash"
        );
        for id in [&self.cell_id, &self.run_id] {
            ensure!(
                !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
                "Invalid espresso identity"
            );
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    PlaceCup,
    Brew,
    RemoveCup,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Operation {
    Idle,
    Running {
        attempt_id: String,
        elapsed: usize,
        sequence: usize,
        phase: Phase,
        phase_steps: usize,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Saved {
    schema_version: u8,
    definition: Definition,
    steps: usize,
    operation: Operation,
    appliance: Checkpoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grinder: Option<Checkpoint>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Opening {
    Create {
        definition: Definition,
    },
    Restore {
        content: String,
        digest: String,
        sequence: usize,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Task {
    EspressoCycle,
}
#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Open {
        cell: String,
        opening: Opening,
    },
    Start {
        cell: String,
        attempt_id: String,
        task: Task,
    },
    Advance {
        cell: String,
        steps: usize,
    },
    Export {
        cell: String,
    },
    Observe {
        cell: String,
    },
    Dispose {
        cell: String,
    },
}
/// One solver step of the espresso world: the appliance and its grinder.
#[derive(Serialize)]
pub struct Sample {
    step: usize,
    appliance: crate::appliance_run::Sample,
    #[serde(skip_serializing_if = "Option::is_none")]
    grinder: Option<crate::appliance_run::Sample>,
}

/// An idle interval: its two endpoint samples.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    #[serde(flatten)]
    header: Header,
    start_step: usize,
    end_step: usize,
    samples: Vec<Sample>,
}

/// An operation interval: every sample. Espresso segments record no events.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    #[serde(flatten)]
    recording: Recording,
    attempt_id: String,
    sequence: usize,
    events: [(); 0],
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Outcome {
    Completed,
}

pub type Reply =
    station_reply::Reply<Digested<Segment>, Recording, Outcome, crate::appliance_run::Sample>;

const PLAN: &[&str] = &["place-cup", "espresso", "remove-cup"];

struct World {
    definition: Definition,
    lab: Lab,
    grinder: Option<Lab>,
    steps: usize,
    operation: Operation,
    predecessor: String,
}
impl World {
    fn saved(&self) -> Saved {
        Saved {
            schema_version: 1,
            definition: self.definition.clone(),
            steps: self.steps,
            operation: self.operation.clone(),
            appliance: self.lab.snapshot(),
            grinder: self.grinder.as_ref().map(Lab::snapshot),
        }
    }
    fn seal(&self) -> Result<(String, CheckpointRef)> {
        let content = crate::checkpoint::write(
            crate::checkpoint::Kind::EspressoCellCheckpoint,
            &self.saved(),
        )?;
        let checkpoint = reference(&content, self.steps);
        Ok((content, checkpoint))
    }
    fn sample(&self, step: usize) -> Result<Sample> {
        Ok(Sample {
            step,
            appliance: self.lab.sample()?,
            grinder: self.grinder.as_ref().map(Lab::sample).transpose()?,
        })
    }
    fn advance(&mut self, allowance: usize) -> Result<Reply> {
        ensure!((1..=32).contains(&allowance), "Use 1–32 espresso steps");
        let before = self.predecessor.clone();
        let (attempt, sequence, start) = match &self.operation {
            Operation::Idle => (None, 0, self.steps),
            Operation::Running {
                attempt_id,
                sequence,
                elapsed,
                ..
            } => (Some(attempt_id.clone()), *sequence, *elapsed),
        };
        let mut samples = vec![self.sample(start)?];
        let first_step = self.steps;
        let mut completed = false;
        for index in 0..allowance {
            self.lab.step()?;
            if let Some(grinder) = &mut self.grinder {
                grinder.step()?;
                grinder.step()?;
            }
            self.steps += 1;
            if let Operation::Running {
                elapsed,
                phase,
                phase_steps,
                ..
            } = &mut self.operation
            {
                *elapsed += 1;
                *phase_steps += 1;
                match phase {
                    Phase::PlaceCup if *phase_steps == 2300 => {
                        if let Some(grinder) = &mut self.grinder {
                            grinder.command(&Action::Purge { active: true })?;
                        }
                    }
                    Phase::PlaceCup if *phase_steps == 2450 => {
                        if let Some(grinder) = &mut self.grinder {
                            grinder.command(&Action::Purge { active: false })?;
                        }
                    }
                    Phase::PlaceCup if *phase_steps == 2500 => {
                        if let Some(grinder) = &mut self.grinder {
                            let snapshot = grinder.snapshot();
                            let Controller::Motor { motor, .. } = snapshot.controller else {
                                bail!("Missing espresso grinder state")
                            };
                            ensure!(
                                matches!(motor.state, MotorState::Complete)
                                    && motor.work_j > 0.
                                    && motor.load_work_j > 0.,
                                "Espresso grinder did not finish the dose"
                            );
                            grinder.command(&Action::RemoveContents)?;
                        }
                        self.lab.command(&Action::Start {
                            program: Program::EspressoShot {
                                group: Group::Left,
                                duration_s: 18.,
                            },
                        })?;
                        *phase = Phase::Brew;
                        *phase_steps = 0;
                    }
                    Phase::Brew if *phase_steps == 9000 => {
                        self.lab.command(&Action::MoveCup {
                            outlet: Outlet::Left,
                            position: CupPosition::Removed,
                        })?;
                        *phase = Phase::RemoveCup;
                        *phase_steps = 0;
                    }
                    Phase::RemoveCup if *phase_steps == 2500 => {
                        completed = true;
                    }
                    _ => {}
                }
            }
            if completed {
                let snapshot = self.lab.snapshot();
                let Controller::Espresso { espresso } = snapshot.controller else {
                    bail!("Missing espresso state")
                };
                ensure!(
                    espresso.complete()
                        && (espresso.cups[0].mass_g - 36.).abs() < 1e-6
                        && espresso.cups[0].travel_m >= 0.179,
                    "Espresso output is not ready for service"
                );
                self.lab.command(&Action::ServeCup {
                    outlet: Outlet::Left,
                })?;
                self.lab.command(&Action::RemoveContents)?;
            }
            // Idle periods retain their endpoints. Physics still advances every
            // timestep; active cup and extraction motion retains every sample.
            if attempt.is_some() || index + 1 == allowance || completed {
                samples.push(self.sample(start + index + 1)?);
            }
            if completed {
                break;
            }
        }
        let end = start + self.steps - first_step;
        if completed {
            self.operation = Operation::Idle;
        } else if let Operation::Running { sequence, .. } = &mut self.operation {
            *sequence += 1;
        }
        let (_, checkpoint) = self.seal()?;
        self.predecessor = checkpoint.digest.clone();
        let recording = Recording {
            header: Header::new(
                "espresso-physics-recording",
                &self.definition.cell_id,
                &self.definition.run_id,
                &self.definition.model_hash,
                before,
                checkpoint.digest.clone(),
            ),
            start_step: start,
            end_step: end,
            samples,
        };
        Ok(match attempt {
            Some(attempt_id) => Reply::Advanced {
                stop: if completed {
                    Stopped::Terminal
                } else {
                    Stopped::Allowance
                },
                segment: Digested::new(Segment {
                    recording,
                    attempt_id,
                    sequence,
                    events: [],
                })?,
                checkpoint,
                outcome: completed.then_some(Outcome::Completed),
                hold: (),
            },
            None => Reply::Rested {
                stop: Stopped::Idle,
                recording,
                checkpoint,
                hold: (),
            },
        })
    }
}

pub struct Host {
    root: PathBuf,
    cells: BTreeMap<String, World>,
}
impl Host {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            cells: BTreeMap::new(),
        }
    }
    pub fn handle(&mut self, command: Command) -> Result<Reply> {
        match command {
            Command::Open { cell, opening } => {
                ensure!(
                    !self.cells.contains_key(&cell),
                    "Espresso cell already open"
                );
                let mut world = match opening {
                    Opening::Create { definition } => {
                        definition.validate()?;
                        ensure!(
                            definition.visual_hash
                                == visual_hash(&self.root, definition.appliance)?,
                            "Espresso visual differs"
                        );
                        let mut lab = Lab::open(
                            &self.root,
                            Initial::Fresh {
                                appliance: definition.appliance.appliance(),
                                contents: Contents::Empty,
                            },
                        )?;
                        let mut baseline = lab.snapshot();
                        ensure!(
                            baseline.model_hash == definition.model_hash,
                            "Espresso model differs"
                        );
                        let Controller::Espresso { espresso } = &mut baseline.controller else {
                            bail!("Expected espresso controller")
                        };
                        // Declared service baseline, not evidence of a measured warm-up.
                        espresso.coffee_c = 93.;
                        espresso.steam_c = 125.;
                        espresso.power = Power::On {
                            coffee_c: 93.,
                            steam_c: 125.,
                        };
                        lab = Lab::open(
                            &self.root,
                            Initial::Continue {
                                checkpoint: Box::new(baseline),
                            },
                        )?;
                        lab.command(&Action::Start {
                            program: Program::EspressoWarmup {
                                coffee_c: 93.,
                                steam_c: 125.,
                            },
                        })?;
                        lab.command(&Action::MoveCup {
                            outlet: Outlet::Left,
                            position: CupPosition::Removed,
                        })?;
                        for _ in 0..2500 {
                            lab.step()?;
                        }
                        let grinder = match definition.grinder {
                            Some(grinder_model) => {
                                let mut grinder_lab = Lab::open(
                                    &self.root,
                                    Initial::Fresh {
                                        appliance: grinder_model.appliance(),
                                        contents: Contents::Empty,
                                    },
                                )?;
                                ensure!(
                                    Some(grinder_lab.snapshot().model_hash.as_str())
                                        == definition.grinder_model_hash.as_deref(),
                                    "Espresso grinder model differs"
                                );
                                grinder_lab.command(&Action::GrindDial {
                                    radians: grinder_model.espresso_dial_rad(),
                                })?;
                                for _ in 0..500 {
                                    grinder_lab.step()?;
                                }
                                Some(grinder_lab)
                            }
                            None => None,
                        };
                        World {
                            definition,
                            lab,
                            grinder,
                            steps: 0,
                            operation: Operation::Idle,
                            predecessor: String::new(),
                        }
                    }
                    Opening::Restore {
                        content,
                        digest: expected,
                        sequence,
                    } => {
                        ensure!(
                            content.len() <= 16 * 1024 * 1024
                                && digest(content.as_bytes()) == expected,
                            "Espresso checkpoint digest differs"
                        );
                        let saved: Saved = crate::checkpoint::read(
                            crate::checkpoint::Kind::EspressoCellCheckpoint,
                            content.as_bytes(),
                        )?;
                        saved.definition.validate()?;
                        ensure!(
                            saved.definition.visual_hash
                                == visual_hash(&self.root, saved.definition.appliance)?,
                            "Saved espresso visual differs"
                        );
                        ensure!(
                            saved.schema_version == 1
                                && saved.appliance.model_hash == saved.definition.model_hash
                                && saved.appliance.appliance
                                    == saved.definition.appliance.appliance()
                                && saved.grinder.is_some() == saved.definition.grinder.is_some(),
                            "Invalid espresso checkpoint"
                        );
                        if let Operation::Running {
                            sequence: current,
                            elapsed,
                            phase_steps,
                            phase,
                            ..
                        } = &saved.operation
                        {
                            let (offset, limit) = match phase {
                                Phase::PlaceCup => (0, 2500),
                                Phase::Brew => (2500, 9000),
                                Phase::RemoveCup => (11500, 2500),
                            };
                            ensure!(
                                *current == sequence
                                    && *current <= *elapsed
                                    && *elapsed == offset + *phase_steps
                                    && *phase_steps < limit
                                    && saved.steps >= *elapsed,
                                "Invalid espresso operation checkpoint"
                            );
                        } else {
                            ensure!(sequence == 0, "Idle espresso checkpoint has no sequence");
                        }
                        let grinder = match (saved.definition.grinder, saved.grinder) {
                            (Some(grinder_model), Some(checkpoint)) => {
                                ensure!(
                                    Some(checkpoint.model_hash.as_str())
                                        == saved.definition.grinder_model_hash.as_deref()
                                        && checkpoint.appliance == grinder_model.appliance(),
                                    "Invalid espresso grinder checkpoint"
                                );
                                Some(Lab::open(
                                    &self.root,
                                    Initial::Continue {
                                        checkpoint: Box::new(checkpoint),
                                    },
                                )?)
                            }
                            (None, None) => None,
                            _ => bail!("Espresso grinder checkpoint mismatch"),
                        };
                        World {
                            definition: saved.definition,
                            lab: Lab::open(
                                &self.root,
                                Initial::Continue {
                                    checkpoint: Box::new(saved.appliance),
                                },
                            )?,
                            grinder,
                            steps: saved.steps,
                            operation: saved.operation,
                            predecessor: expected,
                        }
                    }
                };
                ensure!(
                    world.definition.cell_id == cell,
                    "Espresso definition names another cell"
                );
                let (_, checkpoint) = world.seal()?;
                world.predecessor = checkpoint.digest.clone();
                let operation = match &world.operation {
                    Operation::Idle => None,
                    Operation::Running {
                        attempt_id,
                        elapsed,
                        sequence,
                        ..
                    } => Some(Executing {
                        attempt_id: attempt_id.clone(),
                        step: *elapsed,
                        sequence: *sequence,
                    }),
                };
                self.cells.insert(cell, world);
                Ok(Reply::Opened {
                    checkpoint,
                    slot: no_carrier(),
                    operation,
                })
            }
            Command::Start {
                cell,
                attempt_id,
                task: Task::EspressoCycle,
            } => {
                let world = self.cells.get_mut(&cell).context("Unknown espresso cell")?;
                ensure!(
                    matches!(world.operation, Operation::Idle),
                    "Espresso cell is busy"
                );
                ensure!(
                    !attempt_id.is_empty() && attempt_id.len() <= 128,
                    "Invalid espresso attempt"
                );
                let before = world.lab.snapshot();
                let before_grinder = world.grinder.as_ref().map(Lab::snapshot);
                if let Err(error) =
                    prepare_cycle(&mut world.lab, world.grinder.as_mut(), &attempt_id)
                {
                    world.lab = Lab::open(
                        &self.root,
                        Initial::Continue {
                            checkpoint: Box::new(before),
                        },
                    )?;
                    world.grinder = match before_grinder {
                        Some(checkpoint) => Some(Lab::open(
                            &self.root,
                            Initial::Continue {
                                checkpoint: Box::new(checkpoint),
                            },
                        )?),
                        None => None,
                    };
                    return Err(error);
                }
                world.operation = Operation::Running {
                    attempt_id: attempt_id.clone(),
                    elapsed: 0,
                    sequence: 0,
                    phase: Phase::PlaceCup,
                    phase_steps: 0,
                };
                Ok(Reply::Started {
                    attempt_id,
                    plan: PLAN,
                })
            }
            Command::Advance { cell, steps } => {
                let world = self.cells.get_mut(&cell).context("Unknown espresso cell")?;
                let before = world.saved();
                let predecessor = world.predecessor.clone();
                match world.advance(steps) {
                    Ok(reply) => Ok(reply),
                    Err(error) => {
                        world.lab = Lab::open(
                            &self.root,
                            Initial::Continue {
                                checkpoint: Box::new(before.appliance),
                            },
                        )?;
                        world.grinder = match before.grinder {
                            Some(checkpoint) => Some(Lab::open(
                                &self.root,
                                Initial::Continue {
                                    checkpoint: Box::new(checkpoint),
                                },
                            )?),
                            None => None,
                        };
                        world.steps = before.steps;
                        world.operation = before.operation;
                        world.predecessor = predecessor;
                        Err(error)
                    }
                }
            }
            Command::Observe { cell } => {
                let world = self.cells.get(&cell).context("Unknown espresso cell")?;
                Ok(Reply::Observed {
                    model_hash: world.definition.model_hash.clone(),
                    sample: world.lab.sample()?,
                    grinder_sample: world.grinder.as_ref().map(Lab::sample).transpose()?,
                })
            }
            Command::Export { cell } => {
                let world = self.cells.get(&cell).context("Unknown espresso cell")?;
                let (content, checkpoint) = world.seal()?;
                let sequence = match world.operation {
                    Operation::Idle => 0,
                    Operation::Running { sequence, .. } => sequence,
                };
                Ok(Reply::Exported {
                    content,
                    checkpoint,
                    sequence,
                })
            }
            Command::Dispose { cell } => {
                self.cells.remove(&cell).context("Unknown espresso cell")?;
                Ok(Reply::Disposed)
            }
        }
    }
}

fn prepare_cycle(lab: &mut Lab, grinder: Option<&mut Lab>, attempt_id: &str) -> Result<()> {
    if let Some(grinder) = grinder {
        grinder.command(&Action::RemoveContents)?;
        grinder.command(&Action::Reset)?;
        grinder.command(&Action::SetContents {
            contents: Contents::Loaded {
                batch: Batch::coffee_dose(format!("{attempt_id}-beans"), 18., 0.2),
            },
        })?;
        grinder.command(&Action::Start {
            program: Program::Grind { duration_s: 4.5 },
        })?;
    }
    lab.command(&Action::RemoveContents)?;
    lab.command(&Action::SetContents {
        contents: Contents::Loaded {
            batch: Batch::espresso_dose(attempt_id.to_owned()),
        },
    })?;

    lab.command(&Action::MoveCup {
        outlet: Outlet::Left,
        position: CupPosition::Placed,
    })?;
    Ok(())
}

fn visual_hash(root: &Path, appliance: Model) -> Result<String> {
    let files: BTreeMap<String, String> = crate::artifact::read_json(
        &root.join("assets/bakery-mujoco/fr10-workcell/native/assets.json"),
    )?;
    files
        .get(&format!(
            "assets/bakery-mujoco/{0}/{0}.glb",
            appliance.appliance().folder()
        ))
        .cloned()
        .context("Espresso visual identity is missing")
}

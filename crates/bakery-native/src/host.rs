//! Live cells as a factory host addresses them: one command in, one reply
//! out. A cell stays resident between commands, so yielding to the host never
//! replans an operation or rebuilds a world.
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::{
    artifact::{Outcome, Segment},
    assets::Assets,
    cell::{
        ActionResult, Bounded, Cell, CellCheckpoint, CellDefinition, CellFixture, CellMotion,
        CellRecording, HoldOffer, Observation, Slot,
    },
    program::{self, Programs},
    robot::Robot,
};

/// A cell definition in the field order the command line writes.
#[derive(Serialize)]
#[serde(untagged)]
pub enum Defined {
    Robot(CellDefinition),
    Espresso(crate::espresso_cell::Definition),
    PourOver(crate::pour_over_cell::Definition),
}

/// A new cell definition, pinned to this runner. The host names its run.
#[derive(Deserialize)]
#[serde(
    tag = "fixture",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Definition {
    Rack {
        cell: String,
        robot: Robot,
    },
    OvenRack {
        cell: String,
        robot: Robot,
    },
    PanStaging {
        cell: String,
        robot: Robot,
    },
    Espresso {
        cell: String,
        appliance: crate::appliance_espresso::Model,
        #[serde(default)]
        grinder: Option<crate::appliances::Grinder>,
    },
    PourOver {
        cell: String,
        kettle_water_g: u32,
        drainage: crate::pour_over_cell::Drainage,
        fault: crate::pour_over_cell::Fault,
        #[serde(default)]
        grinder: Option<crate::appliances::Grinder>,
    },
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Opening {
    Create {
        definition: CellDefinition,
    },
    /// `content` is the exact checkpoint bytes that `digest` names.
    Restore {
        content: String,
        digest: String,
        /// Numbers the next recording segment of an operation in progress.
        sequence: usize,
    },
}

/// A carrier entering or leaving the cell.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Change {
    Admission { carrier: String },
    Removal { carrier: String },
}

#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    /// A one-shot program, advanced in bounded calls.
    Program {
        command: program::Command,
    },
    Define {
        definition: Definition,
    },
    /// One appliance request to its recording, as `appliance` writes it.
    Appliance {
        request: crate::appliance_run::Request,
    },
    Espresso {
        command: crate::espresso_cell::Command,
    },
    PourOver {
        command: crate::pour_over_cell::Command,
    },
    Open {
        cell: String,
        opening: Opening,
    },
    /// Applies a boundary change to the live world and keeps the state
    /// before it, so the change can still be discarded.
    Prepare {
        cell: String,
        boundary: String,
        change: Change,
    },
    Commit {
        cell: String,
        boundary: String,
    },
    Discard {
        cell: String,
        boundary: String,
    },
    Start {
        cell: String,
        attempt_id: String,
        task: crate::artifact::BakeryTask,
    },
    Recover {
        cell: String,
        attempt_id: String,
        carrier: String,
        handling_steps: usize,
        predecessor: String,
    },
    /// Advances the running operation, or the idle world, by at most `steps`.
    /// With `stop_at_hold`, an idle cell stops at the step where its hold
    /// qualifies.
    Advance {
        cell: String,
        steps: usize,
        #[serde(default)]
        stop_at_hold: bool,
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

/// A checkpoint by the digest and length of its stored content.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRef {
    pub digest: String,
    pub byte_length: usize,
    /// Integration steps since the cell was created.
    pub step: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Executing {
    pub attempt_id: String,
    pub step: usize,
    pub sequence: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stopped {
    Idle,
    Allowance,
    Event,
    Terminal,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Reply {
    Program {
        reply: program::Reply,
    },
    Defined {
        definition: Defined,
    },
    /// The recording file, exactly as the command line writes it.
    Appliance {
        file: String,
    },
    /// A station reply keeps its keys in sorted order (`station_reply`).
    Espresso {
        #[serde(serialize_with = "crate::station_reply::sorted")]
        reply: crate::espresso_cell::Reply,
    },
    PourOver {
        #[serde(serialize_with = "crate::station_reply::sorted")]
        reply: crate::pour_over_cell::Reply,
    },
    Opened {
        checkpoint: CheckpointRef,
        slot: Slot,
        operation: Option<Executing>,
    },
    Prepared {
        boundary: String,
        predecessor: String,
        checkpoint: CheckpointRef,
        slot: Slot,
        observation: Observation,
        recording: CellRecording,
    },
    Committed {
        checkpoint: CheckpointRef,
    },
    Discarded {
        checkpoint: CheckpointRef,
    },
    Started {
        attempt_id: String,
        plan: Vec<String>,
    },
    /// The plan failed before any step; the cell is unchanged.
    Refused {
        attempt_id: String,
        outcome: Outcome,
    },
    Advanced {
        stop: Stopped,
        /// Present whenever an operation advanced.
        segment: Option<Segment>,
        /// Present for an idle advance, with exact samples and both endpoints.
        recording: Option<CellRecording>,
        outcome: Option<Outcome>,
        /// The settled hold a rested, idle cell may enter instead of stepping.
        hold: Option<HoldOffer>,
        checkpoint: CheckpointRef,
    },
    Exported {
        content: String,
        checkpoint: CheckpointRef,
        sequence: usize,
    },
    Observed {
        observation: Observation,
    },
    Disposed,
}

struct Prepared {
    boundary: String,
    before: CellCheckpoint,
}

struct Live {
    cell: Cell,
    prepared: Option<Prepared>,
}

pub struct Host {
    espresso: crate::espresso_cell::Host,
    pour_over: crate::pour_over_cell::Host,
    programs: Programs,
    assets: Assets,
    cells: BTreeMap<String, Live>,
}

fn reference(cell: &mut Cell) -> Result<CheckpointRef> {
    let seal = cell.seal()?;
    Ok(CheckpointRef {
        digest: seal.digest,
        byte_length: seal.byte_length,
        step: seal.steps,
    })
}

impl Host {
    pub fn new(assets: Assets) -> Self {
        Self {
            espresso: crate::espresso_cell::Host::new(assets.root()),
            pour_over: crate::pour_over_cell::Host::default(),
            programs: Programs::default(),
            assets,
            cells: BTreeMap::new(),
        }
    }

    /// A cell with no boundary change awaiting its commit.
    fn settled(&mut self, cell: &str) -> Result<&mut Cell> {
        let live = self.cells.get_mut(cell).context("Unknown cell")?;
        ensure!(
            live.prepared.is_none(),
            "A prepared boundary awaits commit or discard"
        );
        Ok(&mut live.cell)
    }

    fn open(&mut self, id: String, opening: Opening) -> Result<Reply> {
        ensure!(!self.cells.contains_key(&id), "The cell is already open");
        let mut cell = match opening {
            Opening::Create { definition } => Cell::create(&self.assets, definition)?,
            Opening::Restore {
                content,
                digest,
                sequence,
            } => Cell::restore(
                &self.assets,
                CellCheckpoint::from_content(content.as_bytes(), &digest)?,
                sequence,
            )?,
        };
        ensure!(
            cell.definition().cell_id == id,
            "The definition names another cell"
        );
        let reply = Reply::Opened {
            checkpoint: reference(&mut cell)?,
            slot: cell.slot().clone(),
            operation: cell.in_progress().map(|operation| Executing {
                attempt_id: operation.attempt_id.into(),
                step: operation.step,
                sequence: operation.sequence,
            }),
        };
        self.cells.insert(
            id,
            Live {
                cell,
                prepared: None,
            },
        );
        Ok(reply)
    }

    fn prepare(&mut self, id: &str, boundary: String, change: Change) -> Result<Reply> {
        let before = self.settled(id)?.checkpoint()?;
        let live = self.cells.get_mut(id).context("Unknown cell")?;
        let before_sample = live.cell.sample();
        let before_slot = live.cell.slot().clone();
        let changed = match &change {
            Change::Admission { carrier } => live.cell.admit(carrier),
            Change::Removal { carrier } => live.cell.remove(carrier),
        };
        let observation = match changed {
            Ok(ActionResult::Admitted { observation, .. })
            | Ok(ActionResult::Removed { observation, .. }) => observation,
            Ok(_) => bail!("A boundary change reported another action"),
            // A change can be refused after it wrote the carrier body.
            Err(error) => {
                live.cell = Cell::restore(&self.assets, before, 0)?;
                return Err(error);
            }
        };
        let motion = match change {
            Change::Admission { .. } => CellMotion::Admission {
                step: before.steps,
                before: before_sample,
                after: live.cell.sample(),
                before_slot,
                after_slot: live.cell.slot().clone(),
            },
            Change::Removal { .. } => CellMotion::Removal {
                step: before.steps,
                before: before_sample,
                after: live.cell.sample(),
                before_slot,
                after_slot: live.cell.slot().clone(),
            },
        };
        let reply = Reply::Prepared {
            boundary: boundary.clone(),
            predecessor: before.digest.clone(),
            checkpoint: reference(&mut live.cell)?,
            slot: live.cell.slot().clone(),
            observation,
            recording: live.cell.recording(before.digest.clone(), motion)?,
        };
        live.prepared = Some(Prepared { boundary, before });
        Ok(reply)
    }

    /// Ends a prepared change: `keep` makes it the cell's state, otherwise
    /// the state before it returns.
    fn conclude(&mut self, id: &str, boundary: &str, keep: bool) -> Result<Reply> {
        let live = self.cells.get_mut(id).context("Unknown cell")?;
        let prepared = live.prepared.take().context("No boundary is prepared")?;
        if prepared.boundary != boundary {
            live.prepared = Some(prepared);
            bail!("Another boundary is prepared");
        }
        if keep {
            return Ok(Reply::Committed {
                checkpoint: reference(&mut live.cell)?,
            });
        }
        live.cell = Cell::restore(&self.assets, prepared.before, 0)?;
        Ok(Reply::Discarded {
            checkpoint: reference(&mut live.cell)?,
        })
    }

    /// Answers one JSON command with one JSON reply. A refused command
    /// leaves its cell unchanged and replies with the reason, so every
    /// transport carries the same exchange.
    pub fn answer(&mut self, input: &[u8]) -> Result<Vec<u8>> {
        let handled = serde_json::from_slice::<Command>(input)
            .map_err(anyhow::Error::from)
            .and_then(|command| self.handle(command));
        Ok(match handled {
            Ok(reply) => serde_json::to_vec(&reply)?,
            // A missing model file names its path, so that the browser
            // worker can mount its pack and send the command again.
            Err(error) => serde_json::to_vec(&match crate::assets::missing(&error) {
                Some(path) => serde_json::json!({
                    "kind": "failed",
                    "message": error.to_string(),
                    "missing": path,
                }),
                None => serde_json::json!({ "kind": "failed", "message": error.to_string() }),
            })?,
        })
    }

    fn define(&self, definition: Definition) -> Result<Defined> {
        let run = || -> Result<String> { Ok(format!("run-{}", program::fresh_identity()?)) };
        let robot = |fixture: CellFixture, cell: String, robot: Robot| -> Result<_> {
            Ok(Defined::Robot(CellDefinition::new(
                &self.assets,
                run()?,
                cell,
                robot,
                0.002,
                fixture,
            )?))
        };
        match definition {
            Definition::Rack { cell, robot: model } => robot(CellFixture::Rack, cell, model),
            Definition::OvenRack { cell, robot: model } => {
                robot(CellFixture::OvenRack, cell, model)
            }
            Definition::PanStaging { cell, robot: model } => {
                robot(CellFixture::PanStaging, cell, model)
            }
            Definition::Espresso {
                cell,
                appliance,
                grinder,
            } => Ok(Defined::Espresso(
                crate::espresso_cell::Definition::with_grinder(
                    self.assets.root(),
                    cell,
                    "espresso-service".into(),
                    appliance,
                    grinder,
                )?,
            )),
            Definition::PourOver {
                cell,
                kettle_water_g,
                drainage,
                fault,
                grinder,
            } => Ok(Defined::PourOver(crate::pour_over_cell::Definition::new(
                &self.assets,
                cell,
                "pour-over-service".into(),
                crate::pour_over_cell::Station {
                    kettle_water_g,
                    kettle_water_c: 93.,
                    coffee_g: 27,
                    drainage,
                    fault,
                    grinder,
                },
            )?)),
        }
    }

    pub fn handle(&mut self, command: Command) -> Result<Reply> {
        match command {
            Command::Program { command } => Ok(Reply::Program {
                reply: self.programs.handle(&self.assets, command)?,
            }),
            Command::Define { definition } => Ok(Reply::Defined {
                definition: self.define(definition)?,
            }),
            Command::Appliance { request } => {
                let mut file =
                    serde_json::to_vec(&crate::appliance_run::run(self.assets.root(), request)?)?;
                ensure!(file.len() <= 16 * 1024 * 1024, "Output exceeds 16 MiB");
                file.push(b'\n');
                Ok(Reply::Appliance {
                    file: String::from_utf8(file)?,
                })
            }
            Command::Espresso { command } => Ok(Reply::Espresso {
                reply: self.espresso.handle(command)?,
            }),
            Command::PourOver { command } => Ok(Reply::PourOver {
                reply: self.pour_over.handle(&self.assets, command)?,
            }),
            Command::Open { cell, opening } => self.open(cell, opening),
            Command::Prepare {
                cell,
                boundary,
                change,
            } => self.prepare(&cell, boundary, change),
            Command::Commit { cell, boundary } => self.conclude(&cell, &boundary, true),
            Command::Discard { cell, boundary } => self.conclude(&cell, &boundary, false),
            Command::Start {
                cell,
                attempt_id,
                task,
            } => match self.settled(&cell)?.start(&attempt_id, task)? {
                ActionResult::Started { attempt_id, plan } => {
                    Ok(Reply::Started { attempt_id, plan })
                }
                ActionResult::Refused {
                    attempt_id,
                    outcome,
                } => Ok(Reply::Refused {
                    attempt_id,
                    outcome,
                }),
                _ => bail!("A start reported another action"),
            },
            Command::Recover {
                cell,
                attempt_id,
                carrier,
                handling_steps,
                predecessor,
            } => {
                let cell = self.settled(&cell)?;
                ensure!(
                    cell.seal()?.digest == predecessor,
                    "Recovery names another checkpoint"
                );
                match cell.recover(&attempt_id, &carrier, handling_steps)? {
                    ActionResult::Started { attempt_id, plan } => {
                        Ok(Reply::Started { attempt_id, plan })
                    }
                    ActionResult::Refused {
                        attempt_id,
                        outcome,
                    } => Ok(Reply::Refused {
                        attempt_id,
                        outcome,
                    }),
                    _ => bail!("Recovery reported another action"),
                }
            }
            Command::Advance {
                cell,
                steps,
                stop_at_hold,
            } => {
                let cell = self.settled(&cell)?;
                let mut segments = Vec::new();
                let (stop, outcome, recording) =
                    match cell.bounded(steps, stop_at_hold, &mut segments)? {
                        Bounded::Idle { recording } => (Stopped::Idle, None, Some(recording)),
                        Bounded::Allowance => (Stopped::Allowance, None, None),
                        Bounded::Event => (Stopped::Event, None, None),
                        Bounded::Terminal { outcome, .. } => {
                            (Stopped::Terminal, Some(outcome), None)
                        }
                    };
                ensure!(segments.len() <= 1, "One advance ends one segment");
                Ok(Reply::Advanced {
                    stop,
                    segment: segments.pop(),
                    recording,
                    outcome,
                    hold: cell.hold(),
                    checkpoint: reference(cell)?,
                })
            }
            Command::Export { cell } => {
                let cell = self.settled(&cell)?;
                let (checkpoint, byte_length) = cell.sealed()?;
                Ok(Reply::Exported {
                    content: String::from_utf8(checkpoint.content()?)?,
                    checkpoint: CheckpointRef {
                        digest: checkpoint.digest,
                        byte_length,
                        step: checkpoint.steps,
                    },
                    sequence: cell.in_progress().map_or(0, |operation| operation.sequence),
                })
            }
            Command::Observe { cell } => Ok(Reply::Observed {
                observation: self
                    .cells
                    .get(&cell)
                    .context("Unknown cell")?
                    .cell
                    .observe(),
            }),
            Command::Dispose { cell } => {
                self.cells.remove(&cell).context("Unknown cell")?;
                Ok(Reply::Disposed)
            }
        }
    }
}

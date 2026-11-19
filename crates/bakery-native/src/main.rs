//! The command line and the browser entry points of the bakery engine.
//! Only the C interface of `browser` uses `unsafe`.
#![deny(unsafe_code)]

#[cfg(target_os = "emscripten")]
#[allow(unsafe_code)]
mod browser;

/// The browser module has no command line (Refactor 16, step 11). Its worker
/// speaks only the host protocol of `browser`; the module never calls `main`.
#[cfg(target_os = "emscripten")]
fn main() {}

#[cfg(not(target_os = "emscripten"))]
fn main() -> anyhow::Result<()> {
    cli::main()
}

/// The native command line. The Node journeys reach the same host through
/// `serve`, and the browser through `browser`.
#[cfg(not(target_os = "emscripten"))]
mod cli {
    use anyhow::{Result, ensure};
    use bakery_native::artifact::{
        Artifact, BakeryTask, Binding, Case, Completion, Request, read_json,
    };
    use bakery_native::assets::{Assets, Cell};
    use bakery_native::cell::CellDefinition;
    use bakery_native::host::Host;
    use bakery_native::program::{self, After, Loaded, Preparation};
    use bakery_native::robot::Robot;
    use bakery_native::{handoff, rack, transfer};
    use clap::{Parser, Subcommand};
    use handoff::{CycleDestination, ReturnArtifact};
    use serde::Serialize;
    use std::{
        fs::OpenOptions,
        io::{BufRead, BufWriter, Write},
        path::{Path, PathBuf},
    };

    #[derive(Parser)]
    #[command(about = "Native cold-tray simulation; no physical dispatch authority")]
    struct Cli {
        #[arg(long, default_value = ".")]
        root: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long)]
        pause_after: Option<String>,
        #[command(subcommand)]
        mode: Mode,
    }

    #[derive(Subcommand)]
    enum Mode {
        PrepareEspressoCell {
            #[arg(long, value_enum)]
            appliance: bakery_native::appliance_espresso::Model,
            #[arg(long, default_value = "espresso-cell")]
            cell: String,
            #[arg(long, value_enum)]
            grinder: Option<bakery_native::appliances::Grinder>,
        },
        /// Write a pour-over station definition pinned to this runner.
        PreparePourOverCell {
            #[arg(long, default_value = "pour-over-cell")]
            cell: String,
            #[arg(long, default_value_t = 500)]
            kettle_water_g: u32,
            #[arg(long, value_enum, default_value = "nominal")]
            drainage: bakery_native::pour_over_cell::Drainage,
            #[arg(long, value_enum, default_value = "none")]
            fault: bakery_native::pour_over_cell::Fault,
            #[arg(long, value_enum)]
            grinder: Option<bakery_native::appliances::Grinder>,
        },
        Appliance {
            request: PathBuf,
        },
        Prepare {
            #[arg(long, value_enum, default_value = "fairino-fr10")]
            robot: Robot,
            #[arg(long, default_value_t = 1.0)]
            ingredient_mass_kg: f64,
            #[arg(long, default_value_t = 0, allow_hyphen_values = true)]
            ingredient_forward_mm: i32,
            #[arg(long, default_value_t = 0, allow_hyphen_values = true)]
            ingredient_lateral_mm: i32,
            #[arg(long, default_value_t = 100.0)]
            clamp_force_n: f64,
            #[arg(long, value_enum, default_value = "table-to-rack")]
            task: BakeryTask,
            #[arg(long, value_enum, default_value = "separate")]
            cell: Cell,
            #[arg(long, default_value = "nominal")]
            case: String,
            #[arg(long, default_value_t = 0.002)]
            timestep: f64,
            #[arg(long, default_value_t = 0, allow_hyphen_values = true)]
            rack_x_mm: i32,
            #[arg(long, default_value_t = 0, allow_hyphen_values = true)]
            rack_y_mm: i32,
        },
        Run {
            request: PathBuf,
        },
        Resume {
            checkpoint: PathBuf,
        },
        Load {
            request: PathBuf,
        },
        Unload {
            handoff: PathBuf,
            #[arg(long)]
            for_rack: bool,
        },
        Rack {
            handoff: PathBuf,
            #[arg(long, value_enum, default_value = "nominal")]
            case: rack::Case,
        },
        Cycle {
            request: PathBuf,
            #[arg(long)]
            to_rack: bool,
            #[arg(long, value_enum, default_value = "nominal", requires = "to_rack")]
            rack_case: rack::Case,
        },
        /// Write a persistent cell definition pinned to this runner.
        PrepareCell {
            #[arg(long, value_enum, default_value = "rack")]
            fixture: bakery_native::cell::CellFixture,
            #[arg(long, value_enum, default_value = "fairino-fr10")]
            robot: Robot,
            #[arg(long, default_value = "cold-cell-1")]
            cell: String,
            #[arg(long, default_value_t = 0.002)]
            timestep: f64,
        },
        /// Apply carrier boundary changes and bounded operations to a persistent
        /// cell. The output holds the checkpoint envelope and its digest.
        Cell {
            request: PathBuf,
            /// Integration steps per advance call.
            #[arg(long, default_value_t = 32)]
            allowance: usize,
        },
        /// Keep cells resident and answer one host command per input line.
        Serve,
    }

    fn write_new(path: &Path, encoded: &[u8]) -> Result<()> {
        ensure!(encoded.len() <= 16 * 1024 * 1024, "Output exceeds 16 MiB");
        write_artifact(path, encoded)
    }

    fn write_artifact(path: &Path, encoded: &[u8]) -> Result<()> {
        let mut writer =
            BufWriter::new(OpenOptions::new().write(true).create_new(true).open(path)?);
        writer.write_all(encoded)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        Ok(())
    }

    fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
        write_new(path, &serde_json::to_vec(value)?)
    }

    /// Answers host commands from standard input, one JSON value per line, until
    /// the input closes. A refused command leaves its cell unchanged and replies
    /// with the reason. The output file records the commands handled.
    fn serve(assets: Assets, output: &Path) -> Result<()> {
        #[derive(Serialize)]
        #[serde(tag = "kind", rename_all = "kebab-case")]
        enum Closing {
            BakeryNativeServe { commands: usize },
        }
        let mut host = Host::new(assets);
        let mut replies = std::io::stdout().lock();
        let mut commands = 0;
        for line in std::io::stdin().lock().lines() {
            let line = line?;
            if line.is_empty() {
                continue;
            }
            commands += 1;
            replies.write_all(&host.answer(line.as_bytes())?)?;
            replies.write_all(b"\n")?;
            replies.flush()?;
        }
        write_json(output, &Closing::BakeryNativeServe { commands })
    }

    pub fn main() -> Result<()> {
        let cli = Cli::parse();
        ensure!(
            !cli.output.exists(),
            "Choose a new output path; existing artifacts are preserved"
        );
        if let Mode::Appliance { request } = &cli.mode {
            ensure!(
                cli.pause_after.is_none(),
                "Appliance commands preserve a continuation after every job"
            );
            let _assets = Assets::load(&cli.root)?;
            let request = read_json(request)?;
            return write_json(
                &cli.output,
                &bakery_native::appliance_run::run(&cli.root, request)?,
            );
        }
        if let Mode::PrepareCell {
            fixture,
            robot,
            cell,
            timestep,
        } = &cli.mode
        {
            ensure!(
                cli.pause_after.is_none(),
                "Preparation does not execute phases"
            );
            let assets = Assets::load(&cli.root)?;
            return write_json(
                &cli.output,
                &CellDefinition::new(
                    &assets,
                    format!("run-{}", program::fresh_identity()?),
                    cell.clone(),
                    *robot,
                    *timestep,
                    *fixture,
                )?,
            );
        }
        if let Mode::PrepareEspressoCell {
            cell,
            appliance,
            grinder,
        } = &cli.mode
        {
            let _assets = Assets::load(&cli.root)?;
            let definition = bakery_native::espresso_cell::Definition::with_grinder(
                &cli.root,
                cell.clone(),
                "espresso-service".into(),
                *appliance,
                *grinder,
            )?;
            return write_json(&cli.output, &definition);
        }
        if let Mode::PreparePourOverCell {
            cell,
            kettle_water_g,
            drainage,
            fault,
            grinder,
        } = &cli.mode
        {
            let assets = Assets::load(&cli.root)?;
            let definition = bakery_native::pour_over_cell::Definition::new(
                &assets,
                cell.clone(),
                "pour-over-service".into(),
                bakery_native::pour_over_cell::Station {
                    kettle_water_g: *kettle_water_g,
                    kettle_water_c: 93.,
                    coffee_g: 27,
                    drainage: *drainage,
                    fault: *fault,
                    grinder: *grinder,
                },
            )?;
            return write_json(&cli.output, &definition);
        }
        if let Mode::Cell { request, allowance } = &cli.mode {
            ensure!(
                cli.pause_after.is_none(),
                "A cell pauses at a step, not after a phase"
            );
            let assets = Assets::load(&cli.root)?;
            let result = bakery_native::cell::run(&assets, read_json(request)?, *allowance)?;
            let encoded = serde_json::to_vec(&result)?;
            // A persistent-cell CLI journey contains several dense operations.
            // Individual session outputs retain their separate 16 MiB limit.
            ensure!(
                encoded.len() <= 128 * 1024 * 1024,
                "Cell journey exceeds 128 MiB"
            );
            return write_artifact(&cli.output, &encoded);
        }
        if let Mode::Serve = &cli.mode {
            ensure!(
                cli.pause_after.is_none(),
                "A cell pauses at a step, not after a phase"
            );
            return serve(Assets::load(&cli.root)?, &cli.output);
        }
        let assets = Assets::load(&cli.root)?;
        let mut loading = matches!(cli.mode, Mode::Load { .. });
        let cycle = matches!(cli.mode, Mode::Cycle { .. });
        let destination = match &cli.mode {
            Mode::Cycle {
                to_rack: true,
                rack_case,
                ..
            } => CycleDestination::Rack(*rack_case),
            _ => CycleDestination::Table,
        };
        ensure!(
            !cycle || cli.pause_after.is_none(),
            "Pause individual load/unload commands; cycle runs both continuously"
        );
        let mut loaded = if cycle {
            Some(Loaded::Cycle(destination))
        } else if loading {
            Some(Loaded::Handoff)
        } else {
            None
        };
        let (request, resume) = match cli.mode {
            Mode::Appliance { .. }
            | Mode::PrepareCell { .. }
            | Mode::PrepareEspressoCell { .. }
            | Mode::PreparePourOverCell { .. }
            | Mode::Serve
            | Mode::Cell { .. } => {
                unreachable!("Appliance, preparation, cell and serve commands are handled above")
            }
            Mode::Prepare {
                robot,
                ingredient_mass_kg,
                ingredient_forward_mm,
                ingredient_lateral_mm,
                clamp_force_n,
                task,
                cell,
                case,
                timestep,
                rack_x_mm,
                rack_y_mm,
            } => {
                ensure!(
                    cli.pause_after.is_none(),
                    "Preparation does not execute phases"
                );
                let request = program::prepare(
                    &assets,
                    &Preparation {
                        robot,
                        ingredient_mass_kg,
                        ingredient_forward_mm,
                        ingredient_lateral_mm,
                        clamp_force_n,
                        task,
                        cell,
                        case: serde_json::from_value::<Case>(serde_json::Value::String(case))?,
                        timestep,
                        rack_x_mm,
                        rack_y_mm,
                    },
                )?;
                return write_json(&cli.output, &request);
            }
            Mode::Run { request } | Mode::Load { request } | Mode::Cycle { request, .. } => {
                ensure!(
                    std::fs::metadata(&request)?.len() <= 4096,
                    "Request exceeds 4 KiB"
                );
                let request: Request = read_json(&request)?;
                program::check_first(&assets, &request, loaded)?;
                (request, None)
            }
            Mode::Resume { checkpoint } => {
                let raw: serde_json::Value = read_json(&checkpoint)?;
                if raw.get("kind").and_then(serde_json::Value::as_str)
                    == Some("bakery-native-return-checkpoint")
                {
                    let ReturnArtifact::PendingReturn {
                        schema_version,
                        handoff,
                        pending,
                    } = serde_json::from_value(raw)?
                    else {
                        anyhow::bail!("Choose a pending return checkpoint");
                    };
                    ensure!(schema_version == 2, "Unsupported return checkpoint version");
                    let Artifact::BakeryNativeCheckpoint {
                        binding: pending_binding,
                        ..
                    } = &*pending
                    else {
                        anyhow::bail!("Choose a pending return checkpoint");
                    };
                    let completion = pending_binding.completion;
                    let binding = Binding::new(handoff.return_request(), completion)?;
                    let prefix = Artifact::validate_checkpoint(*pending, &binding)?;
                    return write_json(
                        &cli.output,
                        &handoff::unload(
                            *handoff,
                            &assets,
                            Some(prefix),
                            cli.pause_after.as_deref(),
                            completion,
                        )?,
                    );
                }
                if raw.get("kind").and_then(serde_json::Value::as_str)
                    == Some("bakery-native-rack-checkpoint")
                {
                    let rack::ArtifactOutput::BakeryNativeRackCheckpoint {
                        schema_version,
                        handoff,
                        pending,
                    } = serde_json::from_value(raw)?
                    else {
                        anyhow::bail!("Choose a pending rack checkpoint");
                    };
                    ensure!(schema_version == 2, "Unsupported rack checkpoint version");
                    let Artifact::BakeryNativeCheckpoint {
                        binding: pending_binding,
                        ..
                    } = &*pending
                    else {
                        anyhow::bail!("Choose a pending rack checkpoint");
                    };
                    let case = rack::Case::parse(pending_binding.request.case)?;
                    let binding = Binding::new(handoff.request(case), Completion::Recording)?;
                    let prefix = Artifact::validate_checkpoint(*pending, &binding)?;
                    return write_json(
                        &cli.output,
                        &rack::rack(
                            *handoff,
                            &assets,
                            case,
                            Some(prefix),
                            cli.pause_after.as_deref(),
                        )?,
                    );
                }
                let artifact: Artifact = read_json(&checkpoint)?;
                let Artifact::BakeryNativeCheckpoint { binding, .. } = artifact else {
                    anyhow::bail!("Choose a pending native checkpoint");
                };
                let expected = Binding::new(binding.request.clone(), binding.completion)?;
                loading = binding.completion == Completion::LoadingHandoff;
                // A paused `load` finishes as `load` does: with its handoff.
                if loading {
                    loaded = Some(Loaded::Handoff);
                }
                let prefix = Artifact::read_checkpoint(&checkpoint, &expected)?;
                (binding.request, Some(prefix))
            }
            Mode::Rack { handoff, case } => {
                let ReturnArtifact::RackHandoff { handoff } = read_json(&handoff)? else {
                    anyhow::bail!("Rack requires completed retrieval handoff");
                };
                return write_json(
                    &cli.output,
                    &rack::rack(*handoff, &assets, case, None, cli.pause_after.as_deref())?,
                );
            }
            Mode::Unload { handoff, for_rack } => {
                return write_json(
                    &cli.output,
                    &handoff::unload(
                        read_json(&handoff)?,
                        &assets,
                        None,
                        cli.pause_after.as_deref(),
                        if for_rack {
                            Completion::RetrievalHandoff
                        } else {
                            Completion::Recording
                        },
                    )?,
                );
            }
        };
        let (mut engine, setup) = assets.open(&request)?;
        let artifact = transfer::run(
            &mut engine,
            Binding::new(
                request,
                if loading || cycle {
                    Completion::LoadingHandoff
                } else {
                    Completion::Recording
                },
            )?,
            resume,
            cli.pause_after.as_deref(),
            transfer::Start::Prepared,
        )?;
        if let Artifact::BakeryNativeCheckpoint { .. } = &artifact {
            return write_json(&cli.output, &artifact);
        }
        // The command line and a host program finish an operation alike.
        let after = match loaded {
            None => After::Recording {
                setup: Box::new(setup),
            },
            Some(then) => After::Loading {
                setup: Box::new(setup),
                then,
            },
        };
        let output = program::conclude(&assets, engine, after, artifact)?.to_end(&assets)?;
        write_new(&cli.output, &output)
    }
}

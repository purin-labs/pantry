use crate::{artifact::*, assets::Assets, handoff, native::Engine, recording::Recording, transfer};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize, clap::ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Case {
    Nominal,
    Slip,
}

impl Case {
    pub fn parse(case: crate::artifact::Case) -> Result<Self> {
        match case {
            crate::artifact::Case::Nominal => Ok(Self::Nominal),
            crate::artifact::Case::Slip => Ok(Self::Slip),
            _ => bail!("Rack continuation supports nominal or injected slip"),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Handoff {
    schema_version: u32,
    loading: handoff::Handoff,
    result: Artifact,
    recording: Recording,
    digest: String,
}

impl Handoff {
    pub fn new(
        loading: handoff::Handoff,
        result: Artifact,
        recording: Recording,
        engine: &Engine,
        assets: &Assets,
    ) -> Result<Self> {
        let (loaded, start) = loading.restore(assets)?;
        let transfer::Start::Loaded {
            previous_target, ..
        } = start
        else {
            bail!("Rack continuation requires loaded prefix");
        };
        transfer::validate_returned(engine, &loaded, previous_target, &result)?;
        let digest = digest(&serde_json::to_vec(&(&loading, &result, &recording))?);
        Ok(Self {
            schema_version: 2,
            loading,
            result,
            recording,
            digest,
        })
    }

    pub fn request(&self, case: Case) -> Request {
        let previous = &self.recording.request;
        Request {
            schema_version: 7,
            source: "local-simulation".into(),
            execution: previous.execution.clone(),
            run_id: previous.run_id.clone(),
            bakery_task_id: BakeryTask::Rack,
            attempt_id: digest(
                &serde_json::to_vec(&("rack", case, &self.digest))
                    .expect("Serialize rack identity"),
            ),
            model_hash: previous.model_hash.clone(),
            robot: previous.robot,
            ingredients: previous.ingredients,
            clamp_force_n: previous.clamp_force_n,
            layout: previous.layout,
            case: match case {
                Case::Nominal => crate::artifact::Case::Nominal,
                Case::Slip => crate::artifact::Case::Slip,
            },
            timestep: previous.timestep,
            speed_rating_scale: previous.speed_rating_scale,
        }
    }

    fn start(&self) -> Result<transfer::Start> {
        let Artifact::BakeryNativeResult {
            progress, samples, ..
        } = &self.result
        else {
            bail!("Pending retrieval cannot continue");
        };
        Ok(transfer::Start::Returned {
            angles: progress.angles,
            previous_target: progress.previous_target,
            tray: samples
                .last()
                .context("Retrieval has no final observation")?
                .tray,
        })
    }

    pub fn restore(&self, assets: &Assets) -> Result<Engine> {
        ensure!(self.schema_version == 2, "Unsupported rack handoff version");
        ensure!(
            digest(&serde_json::to_vec(&(
                &self.loading,
                &self.result,
                &self.recording
            ))?) == self.digest,
            "Rack handoff digest mismatch"
        );
        let (loaded, start) = self.loading.restore(assets)?;
        let transfer::Start::Loaded {
            previous_target, ..
        } = start
        else {
            bail!("Rack continuation requires loaded prefix");
        };
        let Artifact::BakeryNativeResult {
            binding,
            integration_state,
            ..
        } = &self.result
        else {
            bail!("Pending retrieval cannot continue");
        };
        ensure!(
            assets.is_combined(&binding.request),
            "Rack continuation requires combined fixture"
        );
        ensure!(
            *binding == Binding::new(self.loading.return_request(), Completion::RetrievalHandoff)?,
            "Retrieval binding differs from loading handoff"
        );
        let (mut engine, setup) = assets.open(&binding.request)?;
        ensure!(
            Recording::from_result(&self.result, &setup, assets)? == self.recording,
            "Retrieval recording differs from native state"
        );
        engine.restore(integration_state)?;
        transfer::validate_returned(&engine, &loaded, previous_target, &self.result)?;
        Ok(engine)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ArtifactOutput {
    BakeryNativeRackCheckpoint {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        handoff: Box<Handoff>,
        pending: Box<Artifact>,
    },
    BakeryPhysicsRackSequence {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "loadingHandoffDigest")]
        loading_handoff_digest: String,
        loading: Box<Recording>,
        unloading: Box<Recording>,
        #[serde(rename = "handoffDigest")]
        handoff_digest: String,
        racking: Box<Recording>,
    },
}

fn sequence(handoff: Handoff, recording: Recording) -> ArtifactOutput {
    ArtifactOutput::BakeryPhysicsRackSequence {
        schema_version: 2,
        loading_handoff_digest: handoff.loading.digest,
        loading: Box::new(handoff.loading.recording),
        unloading: Box::new(handoff.recording),
        handoff_digest: handoff.digest,
        racking: Box::new(recording),
    }
}

pub fn rack(
    handoff: Handoff,
    assets: &Assets,
    case: Case,
    resume: Option<Prefix>,
    pause: Option<&str>,
) -> Result<ArtifactOutput> {
    let mut engine = handoff.restore(assets)?;
    finish(handoff, assets, &mut engine, case, resume, pause)
}

pub fn continue_returned(
    handoff: Handoff,
    assets: &Assets,
    engine: &mut Engine,
    case: Case,
) -> Result<ArtifactOutput> {
    finish(handoff, assets, engine, case, None, None)
}

fn finish(
    handoff: Handoff,
    assets: &Assets,
    engine: &mut Engine,
    case: Case,
    resume: Option<Prefix>,
    pause: Option<&str>,
) -> Result<ArtifactOutput> {
    let (stage, binding, start) = Racking::begin(handoff, case)?;
    let result = transfer::run(engine, binding, resume, pause, start)?;
    stage.end(result, assets)
}

/// The rack transfer that a retrieval handoff starts, before and after its
/// operation runs.
pub struct Racking {
    handoff: Handoff,
    case: Case,
}

impl Racking {
    pub fn begin(handoff: Handoff, case: Case) -> Result<(Self, Binding, transfer::Start)> {
        let binding = Binding::new(handoff.request(case), Completion::Recording)?;
        let start = handoff.start()?;
        Ok((Self { handoff, case }, binding, start))
    }

    pub fn end(self, result: Artifact, assets: &Assets) -> Result<ArtifactOutput> {
        let Self { handoff, case } = self;
        match &result {
            Artifact::BakeryNativeCheckpoint { .. } => {
                Ok(ArtifactOutput::BakeryNativeRackCheckpoint {
                    schema_version: 2,
                    handoff: Box::new(handoff),
                    pending: Box::new(result),
                })
            }
            Artifact::BakeryNativeResult { .. } => {
                let setup = assets.setup(&handoff.request(case))?;
                let recording = Recording::from_result(&result, &setup, assets)?;
                Ok(sequence(handoff, recording))
            }
        }
    }
}

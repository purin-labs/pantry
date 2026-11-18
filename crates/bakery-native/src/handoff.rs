use crate::{
    artifact::*,
    assets::{Assets, Fixture, Setup},
    native::Engine,
    recording::Recording,
    transfer,
};
use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Handoff {
    schema_version: u32,
    kind: String,
    pub recording: Recording,
    result: Artifact,
    pub digest: String,
}

impl Handoff {
    pub fn new(result: Artifact, recording: Recording, engine: &Engine) -> Result<Self> {
        let Artifact::BakeryNativeResult {
            binding,
            samples,
            events,
            outcome,
            progress,
            ..
        } = &result
        else {
            bail!("Pending loading cannot hand off");
        };
        ensure!(
            binding.request.bakery_task_id == BakeryTask::Oven
                && binding.request.case == Case::Nominal,
            "Only nominal loading can hand off"
        );
        transfer::validate_loading(engine, progress, samples, events, outcome)?;
        let digest = digest(&serde_json::to_vec(&(&recording, &result))?);
        Ok(Self {
            schema_version: 3,
            kind: "bakery-physics-handoff".into(),
            recording,
            result,
            digest,
        })
    }

    pub fn restore(&self, assets: &Assets) -> Result<(Engine, transfer::Start)> {
        ensure!(
            self.schema_version == 3 && self.kind == "bakery-physics-handoff",
            "Unsupported native handoff"
        );
        ensure!(
            digest(&serde_json::to_vec(&(&self.recording, &self.result))?) == self.digest,
            "Handoff digest mismatch"
        );
        let Artifact::BakeryNativeResult {
            binding,
            samples,
            events,
            outcome,
            progress,
            integration_state,
        } = &self.result
        else {
            bail!("Pending loading cannot hand off");
        };
        ensure!(
            *binding == Binding::new(binding.request.clone(), Completion::LoadingHandoff)?,
            "Handoff controller/runtime mismatch"
        );
        ensure!(
            binding.request.bakery_task_id == BakeryTask::Oven
                && binding.request.case == Case::Nominal,
            "Only nominal loading can hand off"
        );
        let (mut engine, setup) = assets.open(&binding.request)?;
        ensure!(
            Recording::from_result(&self.result, &setup, assets)? == self.recording,
            "Handoff recording differs from native result"
        );
        engine.restore(integration_state)?;
        transfer::validate_loading(&engine, progress, samples, events, outcome)?;
        let tray = engine.sample(0).tray;
        Ok((
            engine,
            transfer::Start::Loaded {
                angles: progress.angles,
                previous_target: progress.previous_target,
                tray,
            },
        ))
    }

    /// The start of the retrieval in the live world that loaded the tray.
    pub fn loaded_start(&self, engine: &Engine) -> Result<transfer::Start> {
        let Artifact::BakeryNativeResult { progress, .. } = &self.result else {
            bail!("Pending loading cannot continue");
        };
        Ok(transfer::Start::Loaded {
            angles: progress.angles,
            previous_target: progress.previous_target,
            tray: engine.sample(0).tray,
        })
    }

    /// The loading ran in the cell with the oven and the rack, so the
    /// retrieval hands off to the rack.
    pub fn for_rack(&self) -> bool {
        matches!(self.recording.fixture, Fixture::OvenAndRack { .. })
    }

    pub fn return_request(&self) -> Request {
        let loading = &self.recording.request;
        Request {
            schema_version: 7,
            source: "local-simulation".into(),
            execution: loading.execution.clone(),
            run_id: loading.run_id.clone(),
            bakery_task_id: BakeryTask::Unload,
            attempt_id: digest(format!("unload:{}", self.digest).as_bytes()),
            model_hash: loading.model_hash.clone(),
            robot: loading.robot,
            ingredients: loading.ingredients,
            clamp_force_n: loading.clamp_force_n,
            layout: loading.layout,
            case: Case::Nominal,
            timestep: loading.timestep,
            speed_rating_scale: loading.speed_rating_scale,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ReturnArtifact {
    #[serde(rename = "bakery-native-return-checkpoint")]
    PendingReturn {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        handoff: Box<Handoff>,
        pending: Box<Artifact>,
    },
    #[serde(rename = "bakery-native-rack-handoff")]
    RackHandoff { handoff: Box<crate::rack::Handoff> },
    #[serde(rename = "bakery-physics-sequence")]
    Sequence {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "handoffDigest")]
        handoff_digest: String,
        loading: Box<Recording>,
        unloading: Box<Recording>,
    },
}

pub fn unload(
    handoff: Handoff,
    assets: &Assets,
    resume: Option<Prefix>,
    pause: Option<&str>,
    completion: Completion,
) -> Result<ReturnArtifact> {
    let (mut engine, start) = handoff.restore(assets)?;
    run_return(
        handoff,
        assets,
        &mut engine,
        start,
        resume,
        pause,
        completion,
    )
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum CycleOutput {
    Return(ReturnArtifact),
    Rack(crate::rack::ArtifactOutput),
}

#[derive(Clone, Copy)]
pub enum CycleDestination {
    Table,
    Rack(crate::rack::Case),
}

pub fn continue_loaded(
    handoff: Handoff,
    assets: &Assets,
    mut engine: Engine,
    destination: CycleDestination,
) -> Result<CycleOutput> {
    let start = handoff.loaded_start(&engine)?;
    let returned = run_return(
        handoff,
        assets,
        &mut engine,
        start,
        None,
        None,
        match destination {
            CycleDestination::Table => Completion::Recording,
            CycleDestination::Rack(_) => Completion::RetrievalHandoff,
        },
    )?;
    match (destination, returned) {
        (CycleDestination::Rack(case), ReturnArtifact::RackHandoff { handoff }) => {
            Ok(CycleOutput::Rack(crate::rack::continue_returned(
                *handoff,
                assets,
                &mut engine,
                case,
            )?))
        }
        (_, returned) => Ok(CycleOutput::Return(returned)),
    }
}

#[allow(clippy::too_many_arguments)]
fn run_return(
    handoff: Handoff,
    assets: &Assets,
    engine: &mut Engine,
    start: transfer::Start,
    resume: Option<Prefix>,
    pause: Option<&str>,
    completion: Completion,
) -> Result<ReturnArtifact> {
    let (stage, binding) = Return::begin(handoff, assets, completion)?;
    let artifact = transfer::run(engine, binding, resume, pause, start)?;
    stage.end(artifact, engine, assets)
}

/// The retrieval that a loading handoff starts: what its operation needs
/// before it runs, and what its result becomes after it.
pub struct Return {
    handoff: Handoff,
    setup: Setup,
    completion: Completion,
}

impl Return {
    pub fn begin(
        handoff: Handoff,
        assets: &Assets,
        completion: Completion,
    ) -> Result<(Self, Binding)> {
        ensure!(
            matches!(
                completion,
                Completion::Recording | Completion::RetrievalHandoff
            ),
            "Invalid retrieval completion"
        );
        ensure!(
            completion != Completion::RetrievalHandoff
                || assets.is_combined(&handoff.recording.request),
            "Rack continuation requires combined fixture"
        );
        let request = handoff.return_request();
        let setup = assets.setup(&request)?;
        let binding = Binding::new(request, completion)?;
        Ok((
            Self {
                handoff,
                setup,
                completion,
            },
            binding,
        ))
    }

    pub fn end(
        self,
        artifact: Artifact,
        engine: &Engine,
        assets: &Assets,
    ) -> Result<ReturnArtifact> {
        let Self {
            handoff,
            setup,
            completion,
        } = self;
        match &artifact {
            Artifact::BakeryNativeCheckpoint { .. } => Ok(ReturnArtifact::PendingReturn {
                schema_version: 2,
                handoff: Box::new(handoff),
                pending: Box::new(artifact),
            }),
            Artifact::BakeryNativeResult {
                outcome: Outcome::Completed { .. },
                ..
            } if completion == Completion::RetrievalHandoff => {
                let recording = Recording::from_result(&artifact, &setup, assets)?;
                Ok(ReturnArtifact::RackHandoff {
                    handoff: Box::new(crate::rack::Handoff::new(
                        handoff, artifact, recording, engine, assets,
                    )?),
                })
            }
            Artifact::BakeryNativeResult { .. } => Ok(ReturnArtifact::Sequence {
                schema_version: 2,
                handoff_digest: handoff.digest,
                loading: Box::new(handoff.recording),
                unloading: Box::new(Recording::from_result(&artifact, &setup, assets)?),
            }),
        }
    }
}

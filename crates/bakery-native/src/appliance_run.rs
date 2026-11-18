//! Appliance commands execute through the same Rust entry point on native and Wasm.
use crate::{
    appliance_espresso::{CupPosition, DoseSlot, Espresso, Group, Outlet, PortafilterPosition},
    appliance_motors::{MotorController, MotorState},
    appliance_pastry::{PastryBench, PastryState},
    appliance_services::{Dishwasher, RackPosition, Scale, WashPart, WashPhase},
    appliance_thermal::{Cooling, Hob, HobState, IceMaker, Oven, OvenState, Refrigerator},
    appliances::{
        Contents, Hand, Name, Program, Vessel, apply_pose_wrench, load_engine, range,
        rotation_error,
    },
    artifact::{ExecutionIdentity, digest},
    native::{ApplianceEngine, ApplianceModelState, FlexMeshSample},
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MixerPart {
    Bowl,
    Beater,
    Whip,
}
impl MixerPart {
    fn label(self) -> &'static str {
        match self {
            Self::Bowl => "bowl",
            Self::Beater => "beater",
            Self::Whip => "whip",
        }
    }
    fn body(self, name: Name) -> &'static str {
        match (name, self) {
            (Name::Aicoh, Self::Bowl) => "ms_bowl",
            (Name::Aicoh, Self::Beater) => "ms_beater",
            (Name::Aicoh, Self::Whip) => "ms_whip",
            (_, Self::Bowl) => "hl_bowl",
            (_, Self::Beater) => "hl_beater",
            (_, Self::Whip) => "hl_whip",
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum HeldPart {
    Vessel,
    Washer { part: WashPart },
}
impl HeldPart {
    fn body(self, name: Name) -> &'static str {
        match self {
            Self::Vessel => name.port().body,
            Self::Washer { part } => part.body(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Controller {
    Espresso {
        espresso: Espresso,
    },
    Motor {
        motor: MotorController,
        vessel: Vessel,
    },
    Milk {
        motor: MotorController,
        vessel: Vessel,
        program: Option<Program>,
        jug_c: f64,
        heater_w: f64,
        input_j: f64,
        loss_j: f64,
        exchange_j: f64,
    },
    Hob {
        hob: Hob,
    },
    Oven {
        oven: Oven,
    },
    Refrigerator {
        refrigerator: Refrigerator,
    },
    IceMaker {
        ice_maker: IceMaker,
    },
    Scale {
        scale: Scale,
    },
    Dishwasher {
        dishwasher: Dishwasher,
    },
    Pastry {
        pastry: PastryBench,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub schema_version: u8,
    pub execution: ExecutionIdentity,
    pub appliance: Name,
    pub model_hash: String,
    pub controller: Controller,
    pub contents: Contents,
    pub hand: Hand,
    pub held_part: HeldPart,
    pub attachment_holds: BTreeMap<MixerPart, ([f64; 3], [f64; 4])>,
    pub state: Vec<f64>,
    pub parameters: ApplianceModelState,
}
pub enum Initial {
    Fresh { appliance: Name, contents: Contents },
    Continue { checkpoint: Box<Checkpoint> },
}
/// How a request opens its appliance: fresh, or from the continuation
/// envelope (`checkpoint.rs`) of an earlier recording of this engine.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Opening {
    Fresh {
        appliance: Name,
        contents: Contents,
    },
    Continue {
        checkpoint: Box<crate::checkpoint::Envelope>,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub schema_version: u8,
    pub run_id: String,
    pub attempt_id: String,
    pub initial: Opening,
    pub actions: Vec<Action>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum StorageSlot {
    Oven { level: u8 },
    Refrigerator { right: bool, level: u8 },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequiredState {
    Ready,
    Complete,
    Stable,
    Stopped,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Action {
    Inspect,
    MoveCup {
        outlet: Outlet,
        position: CupPosition,
    },
    EmptyCup {
        outlet: Outlet,
    },
    ServeCup {
        outlet: Outlet,
    },
    SetShotDose {
        group: Group,
        slot: DoseSlot,
        duration_s: f64,
    },
    SetHotWaterDose {
        duration_s: f64,
    },
    StopHotWater,
    StopShot {
        group: Group,
    },
    SteamWand {
        group: Group,
        angle_degrees: f64,
    },
    Portafilter {
        group: Group,
        position: PortafilterPosition,
    },
    Steam {
        group: Group,
        open: bool,
    },
    WaterSupply {
        available: bool,
    },
    Require {
        state: RequiredState,
    },
    MoveToSlot {
        slot: StorageSlot,
    },
    Advance {
        seconds: f64,
    },
    Start {
        program: Program,
    },
    Stop,
    Reset,
    Resume,
    Cooldown,
    SetContents {
        contents: Contents,
    },
    RemoveContents,
    Door {
        open: bool,
        right: bool,
    },
    Lid {
        open: bool,
    },
    Guard {
        open: bool,
    },
    BowlLift {
        raised: bool,
    },
    Rack {
        extended: bool,
    },
    Grasp,
    GraspAttachment {
        part: MixerPart,
    },
    MoveAttachment {
        part: MixerPart,
        position: [f64; 3],
        quaternion: [f64; 4],
    },
    ReleaseAttachment {
        part: MixerPart,
    },
    EngageAttachment {
        part: MixerPart,
        parking: bool,
    },
    MoveToAttachment {
        part: MixerPart,
        parking: bool,
    },
    Move {
        position: [f64; 3],
        quaternion: [f64; 4],
    },
    Release,
    Engage,
    Tare,
    Zero,
    PrepareWash,
    DrainBlocked {
        blocked: bool,
    },
    LoadPart {
        part: WashPart,
    },
    UnloadPart {
        part: WashPart,
    },
    GraspPart {
        part: WashPart,
    },
    GrindDial {
        radians: f64,
    },
    Purge {
        active: bool,
    },
    BenchFlour {
        dusted: bool,
    },
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Event {
    Accepted {
        index: usize,
        time_s: f64,
        action: Action,
    },
    Rejected {
        index: usize,
        time_s: f64,
        action: Action,
        message: String,
    },
}
#[derive(Serialize)]
pub struct Display {
    name: String,
    text: String,
    lamp: bool,
    pose: [f64; 7],
    width: f64,
    height: f64,
    color: [f64; 3],
}
fn clock_text(seconds: f64) -> String {
    let seconds = seconds.max(0.).ceil() as u64;
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}
#[derive(Serialize)]
#[serde(deny_unknown_fields)]
pub struct Sample {
    pub time_s: f64,
    pub contents: Contents,
    pub bodies: BTreeMap<String, [f64; 7]>,
    pub controller: serde_json::Value,
    pub displays: Vec<Display>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub flex_meshes: Vec<FlexMeshSample>,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Outcome {
    Completed,
    Rejected { action: usize, message: String },
}
#[derive(Serialize)]
#[serde(deny_unknown_fields)]
pub struct Recording {
    pub kind: &'static str,
    pub schema_version: u8,
    pub run_id: String,
    pub attempt_id: String,
    pub appliance: Name,
    pub execution: ExecutionIdentity,
    pub model_hash: String,
    pub outcome: Outcome,
    pub events: Vec<Event>,
    pub samples: Vec<Sample>,
    /// The checkpoint to continue from, sealed with its digest.
    pub continuation: crate::checkpoint::Envelope,
    pub transferred: Vec<crate::appliances::Batch>,
}

pub(crate) struct Lab {
    name: Name,
    engine: ApplianceEngine,
    controller: Controller,
    contents: Contents,
    hand: Hand,
    held_part: HeldPart,
    attachment_holds: BTreeMap<MixerPart, ([f64; 3], [f64; 4])>,
    model_hash: String,
}
impl Lab {
    pub(crate) fn timestep(&self) -> f64 {
        self.engine.timestep()
    }
    pub(crate) fn open(root: &Path, initial: Initial) -> Result<Self> {
        let name = match &initial {
            Initial::Fresh { appliance, .. } => *appliance,
            Initial::Continue { checkpoint } => checkpoint.appliance,
        };
        let mut engine = load_engine(root, name)?;
        let model_hash = digest(&std::fs::read(
            root.join("assets/bakery-mujoco")
                .join(name.folder())
                .join("native.xml"),
        )?);
        match initial {
            Initial::Fresh { contents, .. } => {
                contents.apply(name, &mut engine)?;
                let controller = match name {
                    Name::EagleOne => Controller::Espresso {
                        espresso: Espresso::new(crate::appliance_espresso::Model::EagleOne),
                    },
                    Name::E1Prima => Controller::Espresso {
                        espresso: Espresso::new(crate::appliance_espresso::Model::E1Prima),
                    },
                    Name::Linea => Controller::Espresso {
                        espresso: Espresso::new(crate::appliance_espresso::Model::Linea),
                    },
                    Name::Aicoh
                    | Name::Hobart
                    | Name::Vitamix
                    | Name::Waring
                    | Name::LagomCasa
                    | Name::Bricks01s
                    | Name::FellowOpus2
                    | Name::Df64Gen2 => Controller::Motor {
                        motor: MotorController::new(name, &mut engine)?,
                        vessel: Vessel::initial(),
                    },
                    Name::Severin => Controller::Milk {
                        motor: MotorController::new(name, &mut engine)?,
                        vessel: Vessel::initial(),
                        program: None,
                        jug_c: 20.,
                        heater_w: 0.,
                        input_j: 0.,
                        loss_j: 0.,
                        exchange_j: 0.,
                    },
                    Name::MaruzenHob
                    | Name::Vollrath
                    | Name::PanasonicKzCk1402
                    | Name::RinnaiRsb150pj => Controller::Hob { hob: Hob::new() },
                    Name::Oven => Controller::Oven { oven: Oven::new() },
                    Name::Refrigerator => Controller::Refrigerator {
                        refrigerator: Refrigerator::new(),
                    },
                    Name::IceMaker => Controller::IceMaker {
                        ice_maker: IceMaker::new(),
                    },
                    Name::Scale => Controller::Scale {
                        scale: Scale::new(),
                    },
                    Name::Dishwasher => Controller::Dishwasher {
                        dishwasher: Dishwasher::new(),
                    },
                    Name::PastryBench => Controller::Pastry {
                        pastry: PastryBench::new(),
                    },
                };
                Ok(Self {
                    name,
                    engine,
                    controller,
                    contents,
                    hand: Hand::Released,
                    held_part: HeldPart::Vessel,
                    attachment_holds: BTreeMap::new(),
                    model_hash,
                })
            }
            Initial::Continue { checkpoint } => {
                ensure!(
                    checkpoint.schema_version == 1
                        && checkpoint.execution == ExecutionIdentity::current()
                        && checkpoint.model_hash == model_hash,
                    "Continuation belongs to another model or controller build"
                );
                checkpoint.contents.validate(name)?;
                validate_hand(&checkpoint.hand)?;
                ensure!(
                    checkpoint.attachment_holds.is_empty()
                        || matches!(name, Name::Aicoh | Name::Hobart),
                    "Attachment holds require a mixer"
                );
                for (position, quaternion) in checkpoint.attachment_holds.values() {
                    validate_hand(&Hand::Holding {
                        position: *position,
                        quaternion: *quaternion,
                    })?;
                }
                validate_controller(name, &checkpoint.controller)?;
                engine.restore_model(&checkpoint.parameters)?;
                engine.restore_state(&checkpoint.state)?;
                Ok(Self {
                    name,
                    engine,
                    controller: checkpoint.controller,
                    contents: checkpoint.contents,
                    hand: checkpoint.hand,
                    held_part: checkpoint.held_part,
                    attachment_holds: checkpoint.attachment_holds,
                    model_hash,
                })
            }
        }
    }
    fn busy(&self) -> Result<bool> {
        Ok(match &self.controller {
            Controller::Espresso { espresso } => espresso.busy(),
            Controller::Motor { motor, .. } | Controller::Milk { motor, .. } => {
                motor.busy(self.name, &self.engine)?
            }
            Controller::Hob { hob } => matches!(hob.state, HobState::Running { .. }),
            Controller::Oven { oven } => matches!(oven.state, OvenState::Baking { .. }),
            Controller::Dishwasher { dishwasher } => dishwasher.active(),
            Controller::Pastry { pastry } => pastry.busy(),
            Controller::Refrigerator { .. }
            | Controller::IceMaker { .. }
            | Controller::Scale { .. } => false,
        })
    }
    pub(crate) fn command(&mut self, action: &Action) -> Result<()> {
        match action {
            Action::Inspect => {}
            Action::MoveCup { outlet, position } => {
                let Controller::Espresso { espresso } = &mut self.controller else {
                    anyhow::bail!("Cup controls require the espresso machine")
                };
                espresso.move_cup(*outlet, *position)?;
            }
            Action::EmptyCup { outlet } => {
                let Controller::Espresso { espresso } = &mut self.controller else {
                    anyhow::bail!("Cup controls require the espresso machine")
                };
                espresso.empty_cup(*outlet, &mut self.engine)?;
            }
            Action::ServeCup { outlet } => {
                let Controller::Espresso { espresso } = &mut self.controller else {
                    anyhow::bail!("Serving requires an espresso machine")
                };
                espresso.serve_cup(*outlet, &mut self.engine)?;
            }
            Action::SetShotDose {
                group,
                slot,
                duration_s,
            } => {
                let Controller::Espresso { espresso } = &mut self.controller else {
                    anyhow::bail!("Dose controls require the espresso machine")
                };
                espresso.set_shot_dose(*group, *slot, *duration_s)?;
            }
            Action::SetHotWaterDose { duration_s } => {
                let Controller::Espresso { espresso } = &mut self.controller else {
                    anyhow::bail!("Dose controls require the espresso machine")
                };
                espresso.set_hot_water_dose(*duration_s)?;
            }
            Action::StopHotWater => {
                let Controller::Espresso { espresso } = &mut self.controller else {
                    anyhow::bail!("Hot-water controls require the espresso machine")
                };
                espresso.stop_hot_water(&mut self.engine)?;
            }
            Action::StopShot { group } => {
                let Controller::Espresso { espresso } = &mut self.controller else {
                    anyhow::bail!("Shot controls require the espresso machine")
                };
                espresso.stop_shot(*group, &mut self.engine)?;
            }
            Action::SteamWand {
                group,
                angle_degrees,
            } => {
                let Controller::Espresso { espresso } = &self.controller else {
                    anyhow::bail!("Wand controls require the espresso machine")
                };
                espresso.wand(*group, *angle_degrees, &mut self.engine)?;
            }
            Action::Portafilter { group, position } => {
                ensure!(
                    matches!(self.hand, Hand::Released),
                    "Release the held portafilter before guided locking"
                );
                let Controller::Espresso { espresso } = &mut self.controller else {
                    anyhow::bail!("Portafilter controls require the espresso machine")
                };
                espresso.portafilter(*group, *position, &mut self.engine)?;
            }
            Action::Steam { group, open } => {
                let Controller::Espresso { espresso } = &mut self.controller else {
                    anyhow::bail!("Steam controls require the espresso machine")
                };
                espresso.steam(*group, *open, &mut self.engine)?;
            }
            Action::WaterSupply { available } => {
                let Controller::Espresso { espresso } = &mut self.controller else {
                    anyhow::bail!("Water-supply controls require the espresso machine")
                };
                espresso.water(*available, &mut self.engine)?;
            }
            Action::Require { state } => {
                let accepted = match state {
                    RequiredState::Stopped => !self.busy()?,
                    RequiredState::Stable => {
                        matches!(&self.controller, Controller::Scale { scale } if scale.state == crate::appliance_services::Reading::Stable)
                    }
                    RequiredState::Ready => match &self.controller {
                        Controller::Espresso { espresso } => espresso.ready(),
                        Controller::Oven { oven } => matches!(oven.state, OvenState::Ready { .. }),
                        Controller::Dishwasher { dishwasher } => {
                            dishwasher.phase == WashPhase::Ready
                        }
                        Controller::Pastry { pastry } => {
                            pastry.bench_floured
                                && !matches!(pastry.state, PastryState::Fault { .. })
                        }
                        _ => false,
                    },
                    RequiredState::Complete => match &self.controller {
                        Controller::Espresso { espresso } => espresso.complete(),
                        Controller::Motor { motor, .. } | Controller::Milk { motor, .. } => {
                            matches!(motor.state, MotorState::Complete)
                        }
                        Controller::Hob { hob } => matches!(hob.state, HobState::Complete),
                        Controller::Oven { oven } => matches!(oven.state, OvenState::Complete),
                        Controller::Dishwasher { dishwasher } => {
                            dishwasher.phase == WashPhase::Complete
                        }
                        Controller::Pastry { pastry } => {
                            matches!(pastry.state, PastryState::Complete)
                        }
                        _ => false,
                    },
                };
                ensure!(
                    accepted,
                    "The appliance has not reached the required {:?} state",
                    state
                );
            }
            Action::MoveToSlot { slot } => {
                self.require_handling()?;
                ensure!(
                    matches!(self.hand, Hand::Holding { .. }),
                    "Grasp the carrier before placement"
                );
                let (site, half) = match (self.name, slot) {
                    (Name::Oven, StorageSlot::Oven { level }) => {
                        ensure!((1..=5).contains(level), "Select oven slot 1–5");
                        (format!("mbco_slot_{level}"), [0.2, 0.3, 0.02])
                    }
                    (Name::Refrigerator, StorageSlot::Refrigerator { right, level }) => {
                        ensure!((1..=2).contains(level), "Select refrigerator shelf 1–2");
                        let side = if *right { "right" } else { "left" };
                        ensure!(
                            self.engine.joint(&format!("rt_{side}_hinge"))?.0
                                >= 90_f64.to_radians(),
                            "Open the selected compartment before placement"
                        );
                        (format!("rt_{side}_{level}_storage"), [0.073, 0.113, 0.048])
                    }
                    _ => anyhow::bail!("Storage slot does not belong to this appliance"),
                };
                let target = self.engine.site(&site)?;
                let (low, high) = self.engine.collision_bounds("storage_occupant")?;
                ensure!(
                    !(0..3).all(|axis| target[axis] - half[axis] < high[axis]
                        && target[axis] + half[axis] > low[axis]),
                    "The selected storage slot is occupied"
                );
                self.hand = Hand::Holding {
                    position: target,
                    quaternion: [1., 0., 0., 0.],
                };
            }
            Action::Advance { .. } => anyhow::bail!("Advance is executed by the step loop"),
            Action::Start { program } => {
                ensure!(
                    self.attachment_holds.is_empty(),
                    "Release or couple held attachments before starting"
                );
                if matches!(
                    program,
                    Program::EspressoShot { .. } | Program::EspressoShotPreset { .. }
                ) {
                    ensure!(
                        matches!(self.hand, Hand::Released),
                        "Release the held portafilter before dispensing"
                    );
                }
                program.validate(self.name)?;
                match &mut self.controller {
                    Controller::Espresso { espresso } => {
                        espresso.start(program, &mut self.engine)?
                    }
                    Controller::Motor { motor, vessel } => {
                        motor.start(self.name, program, &self.engine, vessel, &self.contents)?
                    }
                    Controller::Milk {
                        motor,
                        vessel,
                        program: active,
                        ..
                    } => {
                        motor.start(self.name, program, &self.engine, vessel, &self.contents)?;
                        *active = Some(program.clone());
                    }
                    Controller::Hob { hob } => hob.start(self.name, program)?,
                    Controller::Oven { oven } => oven.start(program, &self.engine)?,
                    Controller::Refrigerator { refrigerator } => {
                        refrigerator.cooling = Cooling::Holding
                    }
                    Controller::IceMaker { ice_maker } => ice_maker.start(&mut self.engine)?,
                    Controller::Scale { .. } => {}
                    Controller::Dishwasher { dishwasher } => dishwasher.start(&self.engine)?,
                    Controller::Pastry { pastry } => {
                        pastry.start(program, &self.contents, &mut self.engine)?
                    }
                }
            }
            Action::Stop => match &mut self.controller {
                Controller::Espresso { espresso } => espresso.stop(&mut self.engine)?,
                Controller::Motor { motor, .. } | Controller::Milk { motor, .. } => {
                    motor.stop(self.name, &mut self.engine)?
                }
                Controller::Hob { hob } => {
                    if matches!(hob.state, HobState::Running { .. }) {
                        hob.state = HobState::Off;
                    }
                    hob.heater_w = 0.;
                }
                Controller::Oven { oven } => oven.stop(false),
                Controller::Refrigerator { refrigerator } => {
                    refrigerator.cooling = Cooling::Off;
                    refrigerator.cooling_w = 0.;
                }
                Controller::IceMaker { ice_maker } => ice_maker.stop(&mut self.engine)?,
                Controller::Scale { .. } => {}
                Controller::Dishwasher { dishwasher } => {
                    dishwasher.transition(WashPhase::Off);
                    dishwasher.heater_w = 0.;
                    dishwasher.spray(&mut self.engine)?;
                }
                Controller::Pastry { pastry } => pastry.stop(&mut self.engine)?,
            },
            Action::Reset => match &mut self.controller {
                Controller::Motor { motor, vessel } | Controller::Milk { motor, vessel, .. } => {
                    motor.reset(self.name, &self.engine, vessel)?
                }
                Controller::Hob { hob } => hob.reset(&self.contents)?,
                Controller::Pastry { pastry } => pastry.reset(&mut self.engine)?,
                _ => anyhow::bail!("This appliance has no reset command"),
            },
            Action::Resume => match &mut self.controller {
                Controller::Motor { motor, vessel } => {
                    motor.resume(self.name, &self.engine, vessel)?
                }
                Controller::Oven { oven } => oven.resume(&self.engine)?,
                _ => anyhow::bail!("This appliance has no paused program"),
            },
            Action::Cooldown => {
                let Controller::Oven { oven } = &mut self.controller else {
                    anyhow::bail!("Cooldown requires the oven")
                };
                oven.stop(true);
            }
            Action::SetContents { contents } => {
                ensure!(
                    !self.busy()? && matches!(self.contents, Contents::Empty),
                    "Stop and empty the appliance before receiving a batch"
                );
                contents.apply(self.name, &mut self.engine)?;
                if self.name == Name::PastryBench && matches!(contents, Contents::Loaded { .. }) {
                    self.engine.reset_flex("pastry_sheet")?;
                }
                self.contents = contents.clone();
            }
            Action::RemoveContents => {
                ensure!(!self.busy()?, "Stop before transferring contents");
                Contents::Empty.apply(self.name, &mut self.engine)?;
                self.contents = Contents::Empty;
            }
            Action::Door { open, right } => match &mut self.controller {
                Controller::Refrigerator { refrigerator } => {
                    refrigerator.door(&mut self.engine, *right, *open)?
                }
                Controller::IceMaker { ice_maker } => ice_maker.door(&mut self.engine, *open)?,
                Controller::Oven { .. } => {
                    self.engine.control(
                        "mbco_door_demo",
                        if *open { 110_f64.to_radians() } else { 0. },
                    )?;
                    self.engine
                        .control("mbco_handle_demo", if *open { 0.35 } else { 0. })?;
                }
                Controller::Dishwasher { .. } => self.engine.control(
                    "ucl_door_fixture",
                    if *open {
                        std::f64::consts::FRAC_PI_2
                    } else {
                        0.
                    },
                )?,
                Controller::Motor { .. } if self.name == Name::Vitamix => self.engine.control(
                    "tqo_door_fixture",
                    if *open { -105_f64.to_radians() } else { 0. },
                )?,
                _ => anyhow::bail!("This appliance has no selectable door"),
            },
            Action::Lid { open } => {
                let (name, target) = match self.name {
                    Name::Vitamix => ("tqo_lid_fixture", 0.075),
                    Name::Waring => ("wsg_cover_fixture", 0.16),
                    Name::Severin => ("sm3587_lid_fixture", 0.08),
                    Name::LagomCasa => ("casa_hopper_lift_control", 0.06),
                    Name::Bricks01s => ("bricks_lid_lift_control", 0.06),
                    Name::FellowOpus2 => ("opus_lid_lift_control", 0.08),
                    Name::Df64Gen2 => ("df64_lid_control", 0.08),
                    Name::E1Prima => ("e1p_tank_lid_actuator", 0.95),
                    _ => anyhow::bail!("This appliance has no removable lid"),
                };
                if self.name == Name::Waring {
                    self.engine
                        .control("wsg_unlock_fixture", if *open { 0.32 } else { 0. })?;
                }
                self.engine.control(name, if *open { target } else { 0. })?;
            }
            Action::Guard { open } => {
                ensure!(
                    matches!(self.name, Name::Aicoh | Name::Hobart),
                    "Guard requires a planetary mixer"
                );
                self.engine.control(
                    "mix_guard_fixture",
                    if *open {
                        if self.name == Name::Hobart {
                            -100_f64.to_radians()
                        } else {
                            100_f64.to_radians()
                        }
                    } else {
                        0.
                    },
                )?;
            }
            Action::BowlLift { raised } => {
                ensure!(
                    matches!(self.name, Name::Aicoh | Name::Hobart),
                    "Bowl lift requires a planetary mixer"
                );
                self.engine.control(
                    "mix_lift_fixture",
                    if *raised {
                        0.
                    } else if self.name == Name::Hobart {
                        -0.02
                    } else {
                        -0.12
                    },
                )?;
            }
            Action::Rack { extended } => match &mut self.controller {
                Controller::Dishwasher { dishwasher } => {
                    ensure!(
                        matches!(self.hand, Hand::Released),
                        "Release the held part before moving the rack"
                    );
                    dishwasher.rack_target = if *extended {
                        RackPosition::Extended
                    } else {
                        RackPosition::Inserted
                    };
                }
                Controller::Espresso { espresso } if self.name == Name::E1Prima => {
                    ensure!(
                        !espresso.busy(),
                        "Stop dispensing before sliding the drip tray"
                    );
                    self.engine
                        .control("e1p_drip_tray_actuator", if *extended { 0.14 } else { 0. })?;
                }
                _ => anyhow::bail!("Rack command requires the dishwasher"),
            },
            Action::MoveAttachment {
                part,
                position,
                quaternion,
            } => {
                self.require_mixer_access()?;
                ensure!(
                    self.attachment_holds.contains_key(part),
                    "Grasp this attachment first"
                );
                validate_hand(&Hand::Holding {
                    position: *position,
                    quaternion: *quaternion,
                })?;
                self.attachment_holds
                    .insert(*part, (*position, *quaternion));
            }
            Action::ReleaseAttachment { part } => {
                self.require_mixer_access()?;
                self.attachment_holds.remove(part);
                self.engine.apply_force(part.body(self.name), [0.; 6])?;
            }
            Action::GraspAttachment { part } => {
                self.require_mixer_access()?;
                ensure!(
                    !self.attachment_holds.contains_key(part),
                    "The attachment is already held"
                );
                let (position, quaternion) = self.engine.body_pose(part.body(self.name))?;
                self.engine
                    .set_coupling(&format!("mix_{}_coupling", part.label()), false)?;
                if !matches!(part, MixerPart::Bowl) {
                    self.engine
                        .set_coupling(&format!("mix_{}_parking", part.label()), false)?;
                }
                self.attachment_holds.insert(*part, (position, quaternion));
            }
            Action::MoveToAttachment { part, parking } => {
                self.require_mixer_access()?;
                ensure!(
                    self.attachment_holds.contains_key(part),
                    "Grasp this attachment first"
                );
                let (position, quaternion) = self.attachment_target(*part, *parking)?;
                self.attachment_holds.insert(*part, (position, quaternion));
            }
            Action::EngageAttachment { part, parking } => {
                self.require_mixer_access()?;
                let (target, orientation) = self.attachment_target(*part, *parking)?;
                let body = part.body(self.name);
                let (position, quaternion) = self.engine.body_pose(body)?;
                let distance = position
                    .iter()
                    .zip(target)
                    .map(|(a, b)| (a - b).powi(2))
                    .sum::<f64>()
                    .sqrt();
                let angle = rotation_error(orientation, quaternion)
                    .iter()
                    .map(|v| v * v)
                    .sum::<f64>()
                    .sqrt();
                let speed = self
                    .engine
                    .body_velocity(body)?
                    .iter()
                    .map(|v| v * v)
                    .sum::<f64>()
                    .sqrt();
                ensure!(
                    distance <= 0.003 && angle <= 0.03 && speed <= 0.04,
                    "Align and settle the attachment before coupling"
                );
                if !parking && !matches!(part, MixerPart::Bowl) {
                    let other = if matches!(part, MixerPart::Beater) {
                        "whip"
                    } else {
                        "beater"
                    };
                    ensure!(
                        !self.engine.coupling(&format!("mix_{other}_coupling"))?,
                        "Remove the installed tool first"
                    );
                }
                let suffix = if *parking { "parking" } else { "coupling" };
                self.engine
                    .set_coupling(&format!("mix_{}_{suffix}", part.label()), true)?;
                self.engine.apply_force(body, [0.; 6])?;
                self.attachment_holds.remove(part);
            }
            Action::Grasp => {
                self.require_handling()?;
                ensure!(
                    !matches!(self.name, Name::Aicoh | Name::Hobart),
                    "Select a planetary attachment"
                );
                self.held_part = HeldPart::Vessel;
                let (position, quaternion) = self.engine.body_pose(self.name.port().body)?;
                if let Controller::Motor { vessel, .. } | Controller::Milk { vessel, .. } =
                    &mut self.controller
                {
                    vessel.coupled = false;
                    vessel.hand = Hand::Holding {
                        position,
                        quaternion,
                    };
                } else {
                    if let Controller::Espresso { espresso } = &mut self.controller {
                        espresso.filters[0].target = PortafilterPosition::Locked;
                    }
                    self.hand = Hand::Holding {
                        position,
                        quaternion,
                    };
                }
            }
            Action::Move {
                position,
                quaternion,
            } => {
                self.require_handling()?;
                let target = Hand::Holding {
                    position: *position,
                    quaternion: *quaternion,
                };
                validate_hand(&target)?;
                let hand = match &mut self.controller {
                    Controller::Motor { vessel, .. } | Controller::Milk { vessel, .. }
                        if !matches!(self.name, Name::Aicoh | Name::Hobart) =>
                    {
                        &mut vessel.hand
                    }
                    _ => &mut self.hand,
                };
                ensure!(
                    matches!(hand, Hand::Holding { .. }),
                    "Grasp before moving the vessel"
                );
                *hand = target;
            }
            Action::Release => {
                let body = self.held_part.body(self.name);
                match &mut self.controller {
                    Controller::Motor { vessel, .. } | Controller::Milk { vessel, .. }
                        if !matches!(self.name, Name::Aicoh | Name::Hobart) =>
                    {
                        vessel.hand = Hand::Released
                    }
                    _ => self.hand = Hand::Released,
                };
                self.engine.apply_force(body, [0.; 6])?;
            }
            Action::Engage => {
                self.require_handling()?;
                let (Controller::Motor { vessel, .. } | Controller::Milk { vessel, .. }) =
                    &mut self.controller
                else {
                    anyhow::bail!("This vessel has no drive coupling")
                };
                let (distance, angle, speed) = vessel.errors(self.name, &self.engine)?;
                let foot = match self.name {
                    Name::Vitamix => "tqo_jar_foot",
                    Name::Waring => "wsg_foot",
                    Name::Severin => "sm3587_jug_floor",
                    Name::LagomCasa => "casa_cup_foot",
                    Name::Bricks01s => "bricks_cup_foot",
                    Name::FellowOpus2 => "opus_cup_foot",
                    Name::Df64Gen2 => "df64_cup_foot",
                    _ => anyhow::bail!("Use planetary part couplings"),
                };
                ensure!(
                    distance <= 0.003
                        && angle <= 0.03
                        && speed <= 0.04
                        && self.engine.support_force(foot)?
                            >= self.engine.body_mass(self.name.port().body)? * 9.81 * 0.5,
                    "Align, support and settle the vessel before coupling"
                );
                vessel.hand = Hand::Released;
                vessel.coupled = true;
            }
            Action::Tare => {
                let Controller::Scale { scale } = &mut self.controller else {
                    anyhow::bail!("Tare requires the scale")
                };
                scale.tare()?;
            }
            Action::Zero => {
                let Controller::Scale { scale } = &mut self.controller else {
                    anyhow::bail!("Zero requires the scale")
                };
                scale.zero()?;
            }
            Action::PrepareWash => {
                let Controller::Dishwasher { dishwasher } = &mut self.controller else {
                    anyhow::bail!("Prepare requires the dishwasher")
                };
                dishwasher.prepare(&self.engine)?;
            }
            Action::DrainBlocked { blocked } => {
                let Controller::Dishwasher { dishwasher } = &mut self.controller else {
                    anyhow::bail!("Drain fault requires the dishwasher")
                };
                dishwasher.drain_blocked = *blocked;
            }
            Action::LoadPart { part } => {
                let Controller::Dishwasher { dishwasher } = &mut self.controller else {
                    anyhow::bail!("Rack loading requires the dishwasher")
                };
                dishwasher.load(&self.engine, *part)?;
                self.hand = Hand::Released;
                self.engine.apply_force(part.body(), [0.; 6])?;
            }
            Action::UnloadPart { part } => {
                let Controller::Dishwasher { dishwasher } = &mut self.controller else {
                    anyhow::bail!("Rack unloading requires the dishwasher")
                };
                dishwasher.unload(&self.engine, *part)?;
            }
            Action::GraspPart { part } => {
                let Controller::Dishwasher { dishwasher } = &self.controller else {
                    anyhow::bail!("Part handling requires the dishwasher")
                };
                dishwasher.require_access(&self.engine)?;
                ensure!(
                    matches!(self.hand, Hand::Released) && !dishwasher.parts[part.index()].loaded,
                    "Release the held part and unload rack custody before grasping"
                );
                let (position, quaternion) = self.engine.body_pose(part.body())?;
                self.held_part = HeldPart::Washer { part: *part };
                self.hand = Hand::Holding {
                    position,
                    quaternion,
                };
            }
            Action::GrindDial { radians } => {
                ensure!(!self.busy()?, "Stop the grinder before adjusting the dial");
                match self.name {
                    Name::LagomCasa => {
                        range(*radians, -6.28319, 6.28319)?;
                        self.engine.control("casa_hopper_dial_control", *radians)?;
                    }
                    Name::Bricks01s => {
                        range(*radians, -9.42478, 9.42478)?;
                        self.engine
                            .control("bricks_hopper_dial_control", *radians)?;
                    }
                    Name::FellowOpus2 => {
                        range(*radians, -9.42478, 9.42478)?;
                        self.engine.control("opus_knob_control", *radians)?;
                        self.engine.control(
                            "opus_scale_control",
                            (*radians / 6.).clamp(-1.5708, 1.5708),
                        )?;
                    }
                    Name::Df64Gen2 => {
                        range(*radians, -2.35619, 2.35619)?;
                        self.engine.control("df64_dial_control", *radians)?;
                    }
                    _ => anyhow::bail!("Grind dial requires a burr grinder"),
                }
            }
            Action::Purge { active } => match self.name {
                Name::LagomCasa => {
                    self.engine
                        .control("casa_clicker_actuator", if *active { 0.0055 } else { 0. })?;
                }
                Name::Bricks01s => {
                    self.engine
                        .control("bricks_knocker_actuator", if *active { 1.25 } else { 0. })?;
                }
                Name::FellowOpus2 => {
                    self.engine
                        .control("opus_lid_lift_control", if *active { 0.002 } else { 0. })?;
                }
                Name::Df64Gen2 => {
                    self.engine
                        .control("df64_bellows_control", if *active { -0.012 } else { 0. })?;
                }
                _ => anyhow::bail!("Purge requires a burr grinder"),
            },
            Action::BenchFlour { dusted } => {
                let Controller::Pastry { pastry } = &mut self.controller else {
                    anyhow::bail!("Bench flour control requires the pastry bench")
                };
                pastry.set_bench_flour(*dusted, &mut self.engine)?;
            }
        }
        self.engine.forward();
        Ok(())
    }
    fn require_mixer_access(&self) -> Result<()> {
        ensure!(
            matches!(self.name, Name::Aicoh | Name::Hobart),
            "Select a planetary mixer"
        );
        ensure!(!self.busy()?, "Stop the drive before handling attachments");
        ensure!(
            self.engine.joint("mix_guard")?.0.abs() >= 100_f64.to_radians() - 0.05,
            "Fully open the guard"
        );
        let travel = if self.name == Name::Hobart {
            0.02
        } else {
            0.12
        };
        ensure!(
            self.engine.joint("mix_lift")?.0 <= -travel + 0.003,
            "Lower the bowl before handling attachments"
        );
        Ok(())
    }
    fn attachment_target(&self, part: MixerPart, parking: bool) -> Result<([f64; 3], [f64; 4])> {
        ensure!(
            !parking || !matches!(part, MixerPart::Bowl),
            "The bowl rests on a bench"
        );
        if parking {
            return self.engine.body_pose(&format!("mix_{}_rack", part.label()));
        }
        let prefix = if self.name == Name::Aicoh { "ms" } else { "hl" };
        if matches!(part, MixerPart::Bowl) {
            Ok((
                self.engine.site("mix_bowl_mount")?,
                self.engine.body_pose(&format!("{prefix}_bowl_lift"))?.1,
            ))
        } else {
            self.engine.body_pose(&format!("{prefix}_tool_axis"))
        }
    }
    fn require_handling(&self) -> Result<()> {
        ensure!(!self.busy()?, "Stop heating and mixing before handling");
        match self.name {
            Name::Vitamix => ensure!(
                self.engine.joint("tqo_door")?.0 <= -90_f64.to_radians(),
                "Open the enclosure before handling"
            ),
            Name::Waring => ensure!(
                self.engine.joint("wsg_cover_lift")?.0 >= 0.14,
                "Raise the cover before handling"
            ),
            Name::Severin
            | Name::MaruzenHob
            | Name::Vollrath
            | Name::PanasonicKzCk1402
            | Name::RinnaiRsb150pj
            | Name::LagomCasa
            | Name::Bricks01s
            | Name::FellowOpus2
            | Name::Df64Gen2
            | Name::PastryBench => {}
            Name::E1Prima => {
                if let Controller::Espresso { espresso } = &self.controller {
                    ensure!(
                        espresso.brew_pressure_bar[0] < 0.2,
                        "Wait for group pressure to decay before handling"
                    );
                }
            }
            Name::Aicoh | Name::Hobart => self.require_mixer_access()?,
            Name::Oven => ensure!(
                self.engine.joint("mbco_door_hinge")?.0 >= 90_f64.to_radians(),
                "Open the oven before handling"
            ),
            Name::Refrigerator => ensure!(
                self.engine.joint("rt_left_hinge")?.0 >= 90_f64.to_radians()
                    || self.engine.joint("rt_right_hinge")?.0 >= 90_f64.to_radians(),
                "Open a refrigerator door before handling"
            ),
            Name::IceMaker => ensure!(
                self.engine.joint("im_door_hinge")?.0 >= 45_f64.to_radians(),
                "Open the ice bin door before handling the scoop"
            ),
            Name::Dishwasher => {
                let Controller::Dishwasher { dishwasher } = &self.controller else {
                    unreachable!()
                };
                dishwasher.require_access(&self.engine)?;
            }
            _ => anyhow::bail!("This command does not handle this appliance's vessel"),
        }
        Ok(())
    }
    pub(crate) fn step(&mut self) -> Result<()> {
        match &mut self.controller {
            Controller::Espresso { espresso } => {
                espresso.before_step(&self.hand, &mut self.engine)?
            }
            Controller::Dishwasher { dishwasher } => dishwasher.move_rack(&mut self.engine)?,
            Controller::Pastry { pastry } => pastry.before_step(&mut self.engine)?,
            Controller::Motor { motor, vessel } | Controller::Milk { motor, vessel, .. } => {
                if matches!(
                    self.name,
                    Name::Vitamix
                        | Name::Waring
                        | Name::Severin
                        | Name::LagomCasa
                        | Name::Bricks01s
                        | Name::FellowOpus2
                        | Name::Df64Gen2
                ) {
                    vessel.apply(self.name, &mut self.engine)?;
                }
                motor.before_step(self.name, &mut self.engine, vessel, &self.contents)?;
            }
            _ => {}
        }
        if let Hand::Holding {
            position,
            quaternion,
        } = self.hand
        {
            let body = self.held_part.body(self.name);
            apply_pose_wrench(&mut self.engine, body, position, quaternion)?;
        }
        for (part, (position, quaternion)) in &self.attachment_holds {
            apply_pose_wrench(
                &mut self.engine,
                part.body(self.name),
                *position,
                *quaternion,
            )?;
        }
        self.engine.step()?;
        let dt = self.engine.timestep();
        match &mut self.controller {
            Controller::Espresso { espresso } => {
                espresso.step(&mut self.engine, &mut self.contents)?
            }
            Controller::Motor { motor, vessel } => {
                motor.after_step(self.name, &mut self.engine, vessel, &mut self.contents)?
            }
            Controller::Milk {
                motor,
                vessel,
                program,
                jug_c,
                heater_w,
                input_j,
                loss_j,
                exchange_j,
            } => {
                let was_running = matches!(motor.state, MotorState::Running { .. });
                motor.after_step(self.name, &mut self.engine, vessel, &mut self.contents)?;
                let running = matches!(motor.state, MotorState::Running { .. });
                *heater_w = if running && matches!(program, Some(Program::HeatedMix { .. })) {
                    500.
                } else {
                    0.
                };
                let input = *heater_w * 0.8;
                let loss = 1.2 * (*jug_c - 20.);
                *jug_c += (input - loss) * dt / 190.;
                *input_j += input * dt;
                *loss_j += loss * dt;
                *exchange_j += self.contents.exchange(jug_c, 190., 80., dt)?;
                if let Some(Program::HeatedMix { target_c }) = program {
                    if was_running
                        && matches!(motor.state, MotorState::Complete)
                        && !self
                            .contents
                            .batch()
                            .is_some_and(|batch| batch.temperature() >= *target_c)
                    {
                        motor.state = MotorState::Fault {
                            reason: "Heating did not reach the target before the time limit".into(),
                        };
                        motor.disable(self.name, &mut self.engine)?;
                    }
                    if running
                        && self
                            .contents
                            .batch()
                            .is_some_and(|batch| batch.temperature() >= *target_c)
                    {
                        motor.state = MotorState::Complete;
                        *heater_w = 0.;
                        motor.disable(self.name, &mut self.engine)?;
                    }
                }
            }
            Controller::Hob { hob } => hob.step(self.name, &self.engine, &mut self.contents)?,
            Controller::Oven { oven } => oven.step(&self.engine, &mut self.contents)?,
            Controller::Refrigerator { refrigerator } => {
                refrigerator.step(&mut self.engine, &mut self.contents)?
            }
            Controller::IceMaker { ice_maker } => {
                ice_maker.step(&mut self.engine, &mut self.contents)?
            }
            Controller::Scale { scale } => scale.step(&self.engine)?,
            Controller::Dishwasher { dishwasher } => {
                dishwasher.step(&mut self.engine, &mut self.contents)?
            }
            Controller::Pastry { pastry } => {
                pastry.after_step(&mut self.engine, &mut self.contents)?
            }
        }
        if matches!(
            self.name,
            Name::Aicoh
                | Name::Hobart
                | Name::Vitamix
                | Name::Waring
                | Name::LagomCasa
                | Name::Bricks01s
                | Name::FellowOpus2
                | Name::Df64Gen2
                | Name::Scale
        ) {
            if let Contents::Loaded { batch } = &mut self.contents {
                let heat = (20. - batch.temperature())
                    * batch.capacity()
                    * -(-0.6 * dt / batch.capacity()).exp_m1();
                batch.add_heat(heat)?;
            }
        }
        Ok(())
    }
    pub(crate) fn snapshot(&self) -> Checkpoint {
        Checkpoint {
            schema_version: 1,
            execution: ExecutionIdentity::current(),
            appliance: self.name,
            model_hash: self.model_hash.clone(),
            controller: self.controller.clone(),
            contents: self.contents.clone(),
            hand: self.hand.clone(),
            held_part: self.held_part,
            attachment_holds: self.attachment_holds.clone(),
            state: self.engine.state(),
            parameters: self.engine.model_state(),
        }
    }
    fn displays(&self) -> Result<Vec<Display>> {
        let mut values: Vec<(&str, String)> = Vec::new();
        let mut color = if matches!(
            self.name,
            Name::Oven | Name::Aicoh | Name::Hobart | Name::Scale
        ) {
            [0.95, 0.09, 0.025]
        } else if self.name == Name::PanasonicKzCk1402 {
            [0.92, 0.65, 0.22]
        } else if self.name == Name::RinnaiRsb150pj {
            [0.18, 0.62, 0.98]
        } else {
            [0.15, 0.75, 0.8]
        };
        match &self.controller {
            Controller::Oven { oven } => {
                let remaining = match oven.state {
                    OvenState::Baking { remaining_s, .. }
                    | OvenState::Paused { remaining_s, .. } => remaining_s,
                    _ => 0.,
                };
                values.push(("temperature", format!("{:.0}", oven.chamber_c)));
                values.push(("timer", clock_text(remaining)));
                values.push((
                    "program",
                    if matches!(
                        oven.state,
                        OvenState::Off | OvenState::Cooling | OvenState::Complete
                    ) {
                        "OFF"
                    } else {
                        "1"
                    }
                    .into(),
                ));
            }
            Controller::Motor { motor, .. } => {
                if !matches!(
                    self.name,
                    Name::Waring
                        | Name::LagomCasa
                        | Name::Bricks01s
                        | Name::FellowOpus2
                        | Name::Df64Gen2
                ) {
                    let text = match motor.state {
                        MotorState::Running { remaining_s, .. } => clock_text(remaining_s),
                        MotorState::Paused { remaining_s, .. } => {
                            color = [0.9, 0.48, 0.035];
                            clock_text(remaining_s)
                        }
                        MotorState::Fault { .. } => {
                            color = [0.95, 0.09, 0.025];
                            "Err".into()
                        }
                        _ => clock_text(0.),
                    };
                    values.push(("timer", text));
                }
            }
            Controller::Milk { motor, jug_c, .. } => {
                let text = if matches!(motor.state, MotorState::Fault { .. }) {
                    "Err".into()
                } else {
                    format!(
                        "{:.0}",
                        match &self.contents {
                            Contents::Loaded { batch } => batch.temperature(),
                            Contents::Empty => *jug_c,
                        }
                    )
                };
                values.push(("temperature", text));
            }
            Controller::Refrigerator { refrigerator } => values.push((
                "temperature",
                if matches!(refrigerator.cooling, Cooling::Off) {
                    "OFF".into()
                } else {
                    format!("{:04.1}", refrigerator.cabinet_c)
                },
            )),
            Controller::Hob { hob } => {
                if matches!(
                    self.name,
                    Name::Vollrath | Name::PanasonicKzCk1402 | Name::RinnaiRsb150pj
                ) {
                    let text = match &hob.state {
                        HobState::Running {
                            program: Program::HobPower { percent, .. },
                            ..
                        } => format!("{percent:.0}"),
                        HobState::Running {
                            program: Program::HobTemperature { target_c, .. },
                            ..
                        } => format!("{target_c:.0}"),
                        HobState::Fault { .. } => "Err".into(),
                        _ => "OFF".into(),
                    };
                    values.push(("setting", text));
                }
            }
            Controller::Scale { scale } => {
                use crate::appliance_services::Reading;
                let grams = scale.grams();
                values.push((
                    "weight",
                    if scale.state == Reading::Overload {
                        "Err".into()
                    } else {
                        format!("{grams:.1}")
                    },
                ));
                values.push(("unit", "g".into()));
                values.push((
                    "zero",
                    if scale.state == Reading::Stable && grams == 0. {
                        "0"
                    } else {
                        " "
                    }
                    .into(),
                ));
                if scale.state != Reading::Stable {
                    color = [0.3, 0.03, 0.01];
                }
            }
            Controller::Espresso { espresso } => {
                if espresso.model.has_live_timers() {
                    values.push(("left_timer", espresso.timer_text(Group::Left)));
                    values.push(("right_timer", espresso.timer_text(Group::Right)));
                }
            }
            Controller::Dishwasher { dishwasher } => values.push((
                "temperature",
                match dishwasher.phase {
                    WashPhase::Off => "OFF".into(),
                    WashPhase::DoorFault | WashPhase::RackFault | WashPhase::DrainFault => {
                        "Err".into()
                    }
                    _ => format!("{:02.0}:{:02.0}", dishwasher.tank_c, dishwasher.boiler_c),
                },
            )),
            Controller::IceMaker { .. } => {}
            Controller::Pastry { pastry } => {
                let text = match &pastry.state {
                    PastryState::Fault { .. } => {
                        color = [0.95, 0.09, 0.025];
                        "Err".into()
                    }
                    PastryState::PressingDough { .. } => {
                        format!("{:.1}mm", pastry.dough_block_height_mm)
                    }
                    PastryState::Draping { .. } => {
                        format!("{:.0}N", pastry.rim_crimp_force_n.max(1.0))
                    }
                    _ => format!("{:.1}mm", pastry.sheet_thickness_mm),
                };
                values.push(("gauge", text));
            }
        }
        let mut displays = Vec::new();
        for (name, text) in values {
            let (p, q) = self.engine.body_pose(&format!("live_{name}"))?;
            let size = self.engine.geom_size(&format!("live_{name}_back"))?;
            displays.push(Display {
                name: name.into(),
                text,
                lamp: false,
                pose: [p[0], p[1], p[2], q[0], q[1], q[2], q[3]],
                width: size[0] * 2.,
                height: size[1] * 2.,
                color,
            });
        }
        let mut lamps: Vec<(&str, bool)> = Vec::new();
        match &self.controller {
            Controller::Hob { hob } if self.name == Name::MaruzenHob => {
                lamps.push((
                    "live_power_lamp",
                    matches!(hob.state, HobState::Running { .. }),
                ));
                lamps.push((
                    "live_hold_lamp",
                    matches!(
                        hob.state,
                        HobState::Running {
                            program: Program::HobTemperature { .. },
                            ..
                        }
                    ),
                ));
            }
            Controller::Hob { hob }
                if matches!(
                    self.name,
                    Name::Vollrath | Name::PanasonicKzCk1402 | Name::RinnaiRsb150pj
                ) =>
            {
                lamps.push((
                    "live_temperature_mode",
                    matches!(
                        hob.state,
                        HobState::Running {
                            program: Program::HobTemperature { .. },
                            ..
                        }
                    ),
                ))
            }
            Controller::Scale { scale } => {
                let stable = scale.state == crate::appliance_services::Reading::Stable;
                lamps.extend([
                    ("live_stable_0", stable),
                    ("live_stable_1", stable),
                    ("live_stable_2", stable),
                ]);
            }
            Controller::Pastry { pastry } => {
                lamps.push(("live_flour_lamp", pastry.bench_floured));
            }
            _ => {}
        }
        for (name, active) in lamps {
            let (p, q) = self.engine.geom_pose(name)?;
            let size = self.engine.geom_size(name)?;
            displays.push(Display {
                name: name.into(),
                text: String::new(),
                lamp: true,
                pose: [p[0], p[1], p[2], q[0], q[1], q[2], q[3]],
                width: size[0] * 2.,
                height: size[1].max(size[0]) * 2.,
                color: if active { color } else { [0.02, 0.02, 0.02] },
            });
        }
        Ok(displays)
    }
    pub(crate) fn sample(&self) -> Result<Sample> {
        let mut controller = serde_json::to_value(&self.controller)?;
        if let Some(scale) = controller
            .get_mut("scale")
            .and_then(serde_json::Value::as_object_mut)
        {
            scale.remove("history");
        }
        Ok(Sample {
            time_s: self.engine.time(),
            contents: self.contents.clone(),
            bodies: self.engine.body_poses()?,
            controller,
            displays: self.displays()?,
            flex_meshes: self.engine.flex_meshes()?,
        })
    }
}

fn validate_hand(hand: &Hand) -> Result<()> {
    if let Hand::Holding {
        position,
        quaternion,
    } = hand
    {
        ensure!(
            position.iter().all(|x| x.is_finite() && x.abs() <= 5.)
                && quaternion.iter().all(|x| x.is_finite())
                && (quaternion.iter().map(|x| x * x).sum::<f64>() - 1.).abs() < 1e-6,
            "Supply a bounded position and unit quaternion"
        );
    }
    Ok(())
}
fn validate_controller(name: Name, controller: &Controller) -> Result<()> {
    ensure!(
        matches!(
            (name, controller),
            (
                Name::Aicoh
                    | Name::Hobart
                    | Name::Vitamix
                    | Name::Waring
                    | Name::LagomCasa
                    | Name::Bricks01s
                    | Name::FellowOpus2
                    | Name::Df64Gen2,
                Controller::Motor { .. }
            ) | (Name::Severin, Controller::Milk { .. })
                | (
                    Name::MaruzenHob
                        | Name::Vollrath
                        | Name::PanasonicKzCk1402
                        | Name::RinnaiRsb150pj,
                    Controller::Hob { .. }
                )
                | (Name::Oven, Controller::Oven { .. })
                | (Name::Refrigerator, Controller::Refrigerator { .. })
                | (Name::IceMaker, Controller::IceMaker { .. })
                | (Name::Scale, Controller::Scale { .. })
                | (Name::Dishwasher, Controller::Dishwasher { .. })
                | (Name::PastryBench, Controller::Pastry { .. })
                | (
                    Name::Linea | Name::EagleOne | Name::E1Prima,
                    Controller::Espresso { .. }
                )
        ),
        "Controller does not belong to the selected appliance"
    );
    if let Controller::Pastry { pastry } = controller {
        pastry.validate()?;
    }
    if let Controller::Motor { vessel, .. } | Controller::Milk { vessel, .. } = controller {
        validate_hand(&vessel.hand)?;
        ensure!(
            !vessel.coupled || matches!(vessel.hand, Hand::Released),
            "A held vessel cannot be coupled"
        );
    }
    if let Controller::Espresso { espresso } = controller {
        ensure!(
            espresso.model.appliance() == name,
            "Espresso model does not match checkpoint appliance"
        );
        espresso.validate()?;
    }
    if let Controller::Dishwasher { dishwasher } = controller {
        range(dishwasher.rack_setpoint_m, -0.52, 0.)?;
    }
    Ok(())
}

pub fn run(root: &Path, request: Request) -> Result<Recording> {
    ensure!(
        request.schema_version == 1,
        "Unsupported appliance request version"
    );
    for identity in [&request.run_id, &request.attempt_id] {
        ensure!(
            !identity.is_empty()
                && identity.len() <= 128
                && identity
                    .bytes()
                    .all(|x| x.is_ascii_alphanumeric() || x == b'-'),
            "Supply a bounded run and attempt identity"
        );
    }
    ensure!(
        !request.actions.is_empty() && request.actions.len() <= 256,
        "Use 1–256 appliance actions"
    );
    let mut seconds = 0.;
    for action in &request.actions {
        if let Action::Advance { seconds: duration } = action {
            range(*duration, 0.0005, 600.)?;
            seconds += duration;
        }
    }
    ensure!(
        seconds <= 600.,
        "Each browser job advances at most 600 simulation seconds"
    );
    let initial = match request.initial {
        Opening::Fresh {
            appliance,
            contents,
        } => Initial::Fresh {
            appliance,
            contents,
        },
        Opening::Continue { checkpoint } => Initial::Continue {
            checkpoint: Box::new(checkpoint.open(crate::checkpoint::Kind::ApplianceCheckpoint)?),
        },
    };
    let mut lab = Lab::open(root, initial)?;
    ensure!(
        seconds / lab.engine.timestep() <= 1_200_000.,
        "The job exceeds its native step budget"
    );
    let mut samples = vec![lab.sample()?];
    let mut events = Vec::new();
    let mut transferred = Vec::new();
    let mut outcome = Outcome::Completed;
    let mut next_sample = lab.engine.time() + 0.2;
    for (index, action) in request.actions.into_iter().enumerate() {
        let previous_contents = lab.contents.clone();
        if let Action::Advance { seconds } = action {
            let count = seconds / lab.engine.timestep();
            ensure!(
                count >= 1. && (count - count.round()).abs() < 1e-6,
                "Advance must contain a whole number of native steps"
            );
            let steps = count.round() as usize;
            for _ in 0..steps {
                lab.step()?;
                if lab.engine.time() + 1e-9 >= next_sample {
                    samples.push(lab.sample()?);
                    next_sample += 0.2;
                }
            }
        } else if let Err(error) = lab.command(&action) {
            let message = error.to_string();
            outcome = Outcome::Rejected {
                action: index,
                message: message.clone(),
            };
            events.push(Event::Rejected {
                index,
                time_s: lab.engine.time(),
                action,
                message,
            });
            break;
        }
        if matches!(action, Action::RemoveContents) {
            if let Contents::Loaded { batch } = previous_contents {
                transferred.push(batch);
            }
        }
        events.push(Event::Accepted {
            index,
            time_s: lab.engine.time(),
            action,
        });
    }
    let final_sample = lab.sample()?;
    if samples
        .last()
        .is_some_and(|sample| sample.time_s == final_sample.time_s)
    {
        samples.pop();
    }
    samples.push(final_sample);
    Ok(Recording {
        kind: "bakery-appliance-recording",
        schema_version: 1,
        run_id: request.run_id,
        attempt_id: request.attempt_id,
        appliance: lab.name,
        execution: ExecutionIdentity::current(),
        model_hash: lab.model_hash.clone(),
        outcome,
        events,
        samples,
        continuation: crate::checkpoint::Envelope::seal(
            crate::checkpoint::Kind::ApplianceCheckpoint,
            &lab.snapshot(),
        )?,
        transferred,
    })
}

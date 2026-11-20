//! The JSON lines of the controller protocol (Plan 24 protocol, part B).
//! The shop gateway's `cobot` adapter speaks the other side of it.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Station {
    ColdRack,
    Oven,
    CoolingRack,
}

impl Station {
    /// The shelves of the default layout.
    pub fn shelves(self) -> u8 {
        match self {
            Station::ColdRack | Station::CoolingRack => 12,
            Station::Oven => 4,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Place {
    pub station: Station,
    pub shelf: u8,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CobotTask {
    MoveMouldGroup {
        mould_group: u8,
        from: Place,
        to: Place,
    },
    Bake {
        program_seconds: u32,
        temperature_c: u32,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Accepted,
    Running,
    Completed,
    Rejected,
    Indeterminate,
}

impl TaskState {
    pub fn is_open(self) -> bool {
        matches!(self, TaskState::Accepted | TaskState::Running)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CarrierAt {
    Source,
    Tool,
    Destination,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Idle,
    Busy,
    Paused,
    Stopped,
    Estop,
}

/// What the gateway sends on a device connection.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DeviceOp {
    Hello,
    Submit { task_id: String, task: CobotTask },
    Status { task_id: String },
    Pause,
    Resume,
    Stop,
}

impl DeviceOp {
    pub fn name(&self) -> &'static str {
        match self {
            DeviceOp::Hello => "hello",
            DeviceOp::Submit { .. } => "submit",
            DeviceOp::Status { .. } => "status",
            DeviceOp::Pause => "pause",
            DeviceOp::Resume => "resume",
            DeviceOp::Stop => "stop",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Fault {
    GripLost,
    DoorBlocked,
    ArmStop,
    Estop,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FaultCode {
    Estop,
    ArmStop,
    GripLost,
    DoorBlocked,
    DoorConflict,
}

impl FaultCode {
    pub fn text(self) -> &'static str {
        match self {
            FaultCode::Estop => "The local emergency stop is pressed.",
            FaultCode::ArmStop => "The arm stopped. A person must check it.",
            FaultCode::GripLost => "The gripper lost the mould group.",
            FaultCode::DoorBlocked => "The oven door blocks the arm.",
            FaultCode::DoorConflict => "Two arms are inside the oven door at the same time.",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptMove {
    pub move_id: String,
    pub task: CobotTask,
    pub after_ms: u64,
}

/// One line on the control port, for people and journeys.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ControlOp {
    Inject {
        device: String,
        fault: Fault,
        #[serde(default)]
        at_progress: Option<f64>,
    },
    Clear {
        device: String,
    },
    Stale {
        device: String,
    },
    Freeze {
        device: String,
    },
    Script {
        device: String,
        moves: Vec<ScriptMove>,
    },
    State,
    Reset,
}
